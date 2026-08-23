import { ApiError } from '../errors';
import { normalizeStrategyDocument } from '../strategy/migrations';
import {
  buildStrategyPlanTaskSpecs,
  buildStrategyPlanningResult,
  deriveRequiredNetBuyAmount,
} from '../strategy/planner';
import { buildStrategyPriceCurveReview } from '../strategy/priceCurve';
import {
  strategyEngineDurableObjectNameFor,
} from '../strategy/strategyEngineDO';
import { parseJsonBody } from '../workerSchema';
import { dbCreateTradableToken, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import { dbAddAuditLog, dbLoadSettings, dbSaveSettings } from '../userStore';
import { fetchSolanaMintDecimals, jsonResponse, normalizePubkey, parseJsonText } from '../workerCore';
import { SOLANA_USDC_MINT, type Env, type TokenMarketSnapshot } from '../workerShared';
import { requireAdmin } from '../services/accessControl';
import { dbCreateHistoricalSetupSnapshot } from '../services/historyMetricsService';
import {
  buildStrategyTaskExecutionContext,
  StrategyAutomationService,
} from '../services/strategyAutomationService';
import type {
  StrategyRecordConfig,
  StrategyReviewedPlan,
  StrategyVersionDocument,
} from '../strategy/types';
import {
  buildStrategyRecordConfigFromDocument,
  dbDeletePreviousStrategyVersions,
  dbGetActiveStrategyVersion,
  removePendingStrategy,
  dbSaveActiveStrategyVersionDocument,
  mapStrategyDocumentToSettingsUpdate,
} from '../services/strategyStore';
import { loadStoredMarketSnapshotByContractAddress } from '../services/tokenMarketService';
import { listManagedAccountsWithStoredBalances, type ManagedAccountBalanceRecord } from '../userStore';

const strategyAutomationService = new StrategyAutomationService();
const DEFAULT_STRATEGY_DEPLOY_BUY_AMOUNT = 300;

type StrategyPlanPreviewAllocation = {
  accountId: number;
  label: string;
  walletAddress: string;
  plannedVolumeUsd: number;
  quoteAvailableAmount: number;
  baseTokenAmount: number;
  solBalance: number;
  accountBuyOverAllocated: boolean;
  accountBuyOverAllocationUsd: number;
};

type StrategyPlanPreviewTask = {
  taskId: string;
  side: 'buy' | 'sell';
  pulse: string | null;
  orderIndex: number;
  totalOrders: number;
  scheduledAt: number;
  totalVolumeUsd: number;
  unallocatedVolumeUsd: number;
  allocations: StrategyPlanPreviewAllocation[];
};

type StrategyPlanPreviewAccount = {
  accountId: number;
  label: string;
  walletAddress: string;
  quoteAvailableAmount: number;
  baseTokenAmount: number;
  solBalance: number;
  plannedBuyVolumeUsd: number;
  plannedSellVolumeUsd: number;
  buyOverAllocationUsd: number;
  buyRemainingQuoteUsd: number;
  isBuyOverAllocated: boolean;
  pairCompatible: boolean;
  eligibleForBuy: boolean;
  eligibleForSell: boolean;
};

type StrategyPlanPreviewResponse = {
  generatedAt: number;
  documentSignature: string;
  pair: {
    baseTokenAddress: string;
    quoteTokenAddress: string;
  };
  macroObjective: 'shakeout' | 'distribution' | 'accumulation';
  accountCyclingEnabled: boolean;
  quoteLabel: string;
  requiredBuyAmount: number;
  availableBuyAmount: number;
  enabledAccountCount: number;
  eligibleTradingAccountCount: number;
  eligibleAccountCount: number;
  skippedForCapabilityCount: number;
  skippedForNoPairAssetCount: number;
  skippedForSolReserveCount: number;
  sufficientBuyCapacity: boolean;
  requestedTaskCount: number;
  plannedTaskCount: number;
  unallocatedVolumeUsd: number;
  isExecutable: boolean;
  volatilityReview: ReturnType<typeof buildStrategyPriceCurveReview>;
  tasks: StrategyPlanPreviewTask[];
  accounts: StrategyPlanPreviewAccount[];
};

function buildPlanningDocumentSignature(document: StrategyVersionDocument): string {
  return JSON.stringify({
    parameters: document.parameters,
    targets: document.targets,
    riskControls: document.riskControls,
    execution: document.execution,
  });
}

function deriveRequiredStrategyBuyAmount(document: StrategyVersionDocument): number {
  return deriveRequiredNetBuyAmount(
    document,
    DEFAULT_STRATEGY_DEPLOY_BUY_AMOUNT,
  );
}

function deriveRequiredImmediateBuyAmount(
  document: StrategyVersionDocument,
  config: StrategyRecordConfig,
): number {
  const configuredNetTargetAmount = deriveRequiredStrategyBuyAmount(document);
  if (config.macroObjective !== 'distribution') {
    return configuredNetTargetAmount;
  }
  return buildStrategyPlanTaskSpecs(config, configuredNetTargetAmount).reduce(
    (sum, spec) => sum + (spec.side === 'buy' ? spec.totalVolumeUsd : 0),
    0,
  );
}

function validateReviewedPlan(input: {
  rawPlan: unknown;
  document: StrategyVersionDocument;
  config: StrategyRecordConfig;
  accounts: ManagedAccountBalanceRecord[];
  baseTokenPriceUsd: number | null;
  liquidityUsd: number | null;
}): StrategyReviewedPlan {
  if (!input.rawPlan || typeof input.rawPlan !== 'object' || Array.isArray(input.rawPlan)) {
    throw new ApiError(400, 'An executable reviewed plan is required for deployment');
  }
  const rawPlan = input.rawPlan as Record<string, unknown>;
  const generatedAt = Number(rawPlan.generatedAt);
  const documentSignature = rawPlan.documentSignature;
  const rawTasks = rawPlan.tasks;
  if (
    !Number.isFinite(generatedAt) ||
    documentSignature !== buildPlanningDocumentSignature(input.document) ||
    !Array.isArray(rawTasks)
  ) {
    throw new ApiError(400, 'Reviewed plan metadata is invalid');
  }
  if (
    rawTasks.length < input.config.baseOrderCount ||
    rawTasks.length > input.config.maxOrderCount
  ) {
    throw new ApiError(
      409,
      `Reviewed plan must contain ${input.config.baseOrderCount}-${input.config.maxOrderCount} tasks`,
    );
  }

  const accountsById = new Map(input.accounts.map((account) => [account.id, account]));
  const quoteByAccountId = new Map(
    input.accounts.map((account) => [account.id, account.quoteAvailableAmount]),
  );
  const baseUsdByAccountId = new Map(
    input.accounts.map((account) => [
      account.id,
      input.baseTokenPriceUsd != null && input.baseTokenPriceUsd > 0
        ? account.baseTokenAmount * input.baseTokenPriceUsd
        : 0,
    ]),
  );
  const tasks: StrategyReviewedPlan['tasks'] = [];
  let buyVolumeUsd = 0;
  let sellVolumeUsd = 0;
  let previousScheduledAt = generatedAt;

  for (const [index, rawTask] of rawTasks.entries()) {
    if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
      throw new ApiError(400, `Reviewed task ${index + 1} is invalid`);
    }
    const task = rawTask as Record<string, unknown>;
    const side = task.side;
    const totalVolumeUsd = Number(task.totalVolumeUsd);
    const scheduledAt = Number(task.scheduledAt);
    const rawAllocations = task.allocations;
    if (
      (side !== 'buy' && side !== 'sell') ||
      !Number.isFinite(totalVolumeUsd) ||
      totalVolumeUsd < input.config.minOrderUsd ||
      totalVolumeUsd > input.config.maxOrderUsd ||
      !Number.isFinite(scheduledAt) ||
      scheduledAt < previousScheduledAt ||
      !Array.isArray(rawAllocations) ||
      rawAllocations.length !== 1
    ) {
      throw new ApiError(409, `Reviewed task ${index + 1} violates order constraints`);
    }
    const rawAllocation = rawAllocations[0];
    if (!rawAllocation || typeof rawAllocation !== 'object' || Array.isArray(rawAllocation)) {
      throw new ApiError(400, `Reviewed task ${index + 1} allocation is invalid`);
    }
    const allocationInput = rawAllocation as Record<string, unknown>;
    const accountId = Number(allocationInput.accountId);
    const account = accountsById.get(accountId);
    if (!Number.isInteger(accountId) || !account?.pairCompatible) {
      throw new ApiError(409, `Reviewed task ${index + 1} account is no longer eligible`);
    }

    if (side === 'buy') {
      const quoteAvailable = quoteByAccountId.get(accountId) ?? 0;
      if (quoteAvailable < totalVolumeUsd) {
        throw new ApiError(409, `Reviewed task ${index + 1} no longer has enough quote balance`);
      }
      quoteByAccountId.set(accountId, quoteAvailable - totalVolumeUsd);
      baseUsdByAccountId.set(accountId, (baseUsdByAccountId.get(accountId) ?? 0) + totalVolumeUsd);
      buyVolumeUsd += totalVolumeUsd;
    } else {
      const baseAvailableUsd = baseUsdByAccountId.get(accountId) ?? 0;
      if (baseAvailableUsd < totalVolumeUsd) {
        throw new ApiError(409, `Reviewed task ${index + 1} no longer has enough base balance`);
      }
      baseUsdByAccountId.set(accountId, baseAvailableUsd - totalVolumeUsd);
      quoteByAccountId.set(accountId, (quoteByAccountId.get(accountId) ?? 0) + totalVolumeUsd);
      sellVolumeUsd += totalVolumeUsd;
    }
    previousScheduledAt = scheduledAt;
    tasks.push({
      taskId: typeof task.taskId === 'string' ? task.taskId : `reviewed-${index + 1}`,
      side,
      pulse: typeof task.pulse === 'string' ? task.pulse : null,
      orderIndex: Number.isInteger(Number(task.orderIndex)) ? Number(task.orderIndex) : index + 1,
      totalOrders: Number.isInteger(Number(task.totalOrders)) ? Number(task.totalOrders) : rawTasks.length,
      scheduledAt,
      totalVolumeUsd,
      allocations: [{
        accountId: account.id,
        label: account.label,
        walletAddress: account.address,
        plannedVolumeUsd: totalVolumeUsd,
        quoteAvailableAmount: account.quoteAvailableAmount,
        baseTokenAmount: account.baseTokenAmount,
        solBalance: Number.parseFloat(account.walletBalance.sol) || 0,
        accountBuyOverAllocated: false,
        accountBuyOverAllocationUsd: 0,
      }],
    });
  }

  const expectedSpecs = buildStrategyPlanTaskSpecs(
    input.config,
    deriveRequiredStrategyBuyAmount(input.document),
  );
  const expectedBuyVolumeUsd = expectedSpecs.reduce(
    (sum, spec) => sum + (spec.side === 'buy' ? spec.totalVolumeUsd : 0),
    0,
  );
  const expectedSellVolumeUsd = expectedSpecs.reduce(
    (sum, spec) => sum + (spec.side === 'sell' ? spec.totalVolumeUsd : 0),
    0,
  );
  if (
    Number(buyVolumeUsd.toFixed(6)) !== Number(expectedBuyVolumeUsd.toFixed(6)) ||
    Number(sellVolumeUsd.toFixed(6)) !== Number(expectedSellVolumeUsd.toFixed(6))
  ) {
    throw new ApiError(409, 'Reviewed plan volume or net buy-in no longer matches the strategy');
  }
  return {
    generatedAt,
    documentSignature,
    volatilityReview: buildStrategyPriceCurveReview({
      tasks,
      targetVolatilityPct: input.document.targets.volatilityPctMin,
      priceUsd: input.baseTokenPriceUsd,
      liquidityUsd: input.liquidityUsd,
    }),
    tasks,
  };
}

function formatQuoteLabel(quoteMint: string): string {
  if (quoteMint === SOLANA_USDC_MINT) {
    return 'USDC';
  }
  if (quoteMint.length <= 12) {
    return quoteMint;
  }
  return `${quoteMint.slice(0, 6)}...${quoteMint.slice(-4)}`;
}

function buildStrategyPlanPreview(
  document: StrategyVersionDocument,
  config: StrategyRecordConfig,
  accounts: Awaited<ReturnType<typeof listManagedAccountsWithStoredBalances>>,
  requiredBuyAmount: number,
  marketSnapshot: TokenMarketSnapshot | null,
): StrategyPlanPreviewResponse {
  const generatedAt = Date.now();
  const quoteLabel = formatQuoteLabel(config.quoteTokenAddress);
  const taskSpecs = buildStrategyPlanTaskSpecs(config, requiredBuyAmount);
  const plannedBuyVolumeUsd = taskSpecs.reduce(
    (sum, spec) => sum + (spec.side === 'buy' ? spec.totalVolumeUsd : 0),
    0,
  );
  const effectiveRequiredBuyAmount = config.macroObjective === 'distribution'
    ? plannedBuyVolumeUsd
    : requiredBuyAmount;
  const planning = buildStrategyPlanningResult({
    document,
    config,
    accounts,
    taskSpecs,
    startTime: generatedAt + 1_000,
    baseTokenPriceUsd: marketSnapshot?.priceUsd ?? null,
    seedContext: `preview:${crypto.randomUUID()}`,
  });

  return {
    generatedAt,
    documentSignature: buildPlanningDocumentSignature(document),
    pair: {
      baseTokenAddress: config.baseTokenAddress,
      quoteTokenAddress: config.quoteTokenAddress,
    },
    macroObjective: config.macroObjective,
    accountCyclingEnabled: document.execution.accountCyclingEnabled,
    quoteLabel,
    requiredBuyAmount: effectiveRequiredBuyAmount,
    availableBuyAmount: planning.availableBuyAmount,
    enabledAccountCount: planning.accounts.length,
    eligibleTradingAccountCount: planning.eligibleTradingAccountCount,
    eligibleAccountCount: planning.eligibleBuyAccountCount,
    skippedForCapabilityCount: planning.skippedForCapabilityCount,
    skippedForNoPairAssetCount: planning.skippedForNoPairAssetCount,
    skippedForSolReserveCount: planning.lowSolWarningCount,
    sufficientBuyCapacity: planning.availableBuyAmount >= effectiveRequiredBuyAmount,
    requestedTaskCount: planning.requestedTaskCount,
    plannedTaskCount: planning.plannedTaskCount,
    unallocatedVolumeUsd: planning.unallocatedVolumeUsd,
    isExecutable: planning.isExecutable,
    volatilityReview: buildStrategyPriceCurveReview({
      tasks: planning.tasks,
      targetVolatilityPct: document.targets.volatilityPctMin,
      priceUsd: marketSnapshot?.priceUsd ?? null,
      liquidityUsd: marketSnapshot?.liquidityUsd ?? null,
    }),
    tasks: planning.tasks,
    accounts: planning.accounts,
  };
}

type StrategyExecutionConsumeRequest = {
  action: 'BUY' | 'SELL';
  requestedAmount: number;
  accountId: number | null;
  walletAddress: string | null;
};

function parseStrategyExecutionConsumeRequest(
  body: unknown,
): StrategyExecutionConsumeRequest {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Strategy execution consume request must be a JSON object');
  }

  const raw = body as Record<string, unknown>;
  const actionText = typeof raw.action === 'string' ? raw.action.trim().toUpperCase() : '';
  if (actionText !== 'BUY' && actionText !== 'SELL') {
    throw new ApiError(400, 'action must be BUY or SELL');
  }

  const requestedAmount = raw.requestedAmount;
  if (
    typeof requestedAmount !== 'number' ||
    !Number.isFinite(requestedAmount) ||
    requestedAmount <= 0
  ) {
    throw new ApiError(400, 'requestedAmount must be a positive number');
  }

  const accountId =
    typeof raw.accountId === 'number' && Number.isInteger(raw.accountId) && raw.accountId > 0
      ? raw.accountId
      : null;
  const walletAddress =
    typeof raw.walletAddress === 'string' && raw.walletAddress.trim().length > 0
      ? normalizePubkey(raw.walletAddress)
      : null;
  if ((accountId == null && walletAddress == null) || (accountId != null && walletAddress != null)) {
    throw new ApiError(
      400,
      'Exactly one of accountId or walletAddress is required for controlled strategy execution',
    );
  }

  return {
    action: actionText,
    requestedAmount,
    accountId,
    walletAddress,
  };
}

function parseAbortRequestBody(body: unknown): { reason: string } {
  if (body == null) {
    return { reason: 'Manual user abort' };
  }
  if (typeof body !== 'object') {
    throw new ApiError(400, 'Abort request body must be a JSON object');
  }
  const { reason } = body as { reason?: unknown };
  if (reason == null) {
    return { reason: 'Manual user abort' };
  }
  if (typeof reason !== 'string') {
    throw new ApiError(400, 'Abort reason must be a string');
  }
  return {
    reason: reason.trim() || 'Manual user abort',
  };
}

async function parseOptionalJsonObject(request: Request): Promise<unknown | null> {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return null;
  }
  return parseJsonText<unknown>(rawBody);
}

export async function handleStrategyRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (method === 'POST' && pathname === '/api/strategy/execution/consume') {
    const user = await requireAdmin(request, env);
    const body = parseStrategyExecutionConsumeRequest(
      await parseJsonBody<unknown>(request),
    );
    const activeStrategyVersion = await dbGetActiveStrategyVersion(
      env.TRADINGBOT_DB,
      user.id,
    );
    if (!activeStrategyVersion) {
      throw new ApiError(409, 'No active strategy is configured for controlled execution');
    }

    const strategyBaseMint = activeStrategyVersion.document.parameters.baseTokenAddress.trim()
      ? normalizePubkey(activeStrategyVersion.document.parameters.baseTokenAddress)
      : '';
    const strategyQuoteMint = activeStrategyVersion.document.parameters.quoteTokenAddress.trim()
      ? normalizePubkey(activeStrategyVersion.document.parameters.quoteTokenAddress)
      : SOLANA_USDC_MINT;

    if (!strategyBaseMint) {
      throw new ApiError(409, 'Active strategy base token is not configured');
    }
    if (strategyBaseMint === strategyQuoteMint) {
      throw new ApiError(
        409,
        'Active strategy base and quote token addresses must be different',
      );
    }

    const result = await strategyAutomationService.consumeExecutionTask(
      {
        action: body.action,
        accountId: body.accountId,
        walletAddress: body.walletAddress,
        baseTokenAddress: strategyBaseMint,
        baseMint: strategyBaseMint,
        quoteMint: strategyQuoteMint,
        requireExplicitAccount: true,
        executionMode: 'controlled_jupiter_acceptance',
        requestedAmount: body.requestedAmount,
        scheduledAt: Date.now(),
      },
      buildStrategyTaskExecutionContext(env, user.id, user.username),
    );
    return jsonResponse(result);
  }

  if (method === 'POST' && pathname === '/api/strategy/plan-preview') {
    const user = await requireAdmin(request, env);
    const document = normalizeStrategyDocument(
      await parseJsonBody<unknown>(request),
    );

    const normalizedBaseTokenAddress = document.parameters.baseTokenAddress.trim()
      ? normalizePubkey(document.parameters.baseTokenAddress)
      : '';
    const normalizedQuoteTokenAddress = document.parameters.quoteTokenAddress.trim()
      ? normalizePubkey(document.parameters.quoteTokenAddress)
      : SOLANA_USDC_MINT;

    if (!normalizedBaseTokenAddress) {
      throw new ApiError(400, 'Strategy base token is not configured');
    }
    if (normalizedBaseTokenAddress === normalizedQuoteTokenAddress) {
      throw new ApiError(400, 'Strategy base and quote token addresses must be different');
    }

    const normalizedDocument = normalizeStrategyDocument({
      ...document,
      parameters: {
        ...document.parameters,
        baseTokenAddress: normalizedBaseTokenAddress,
        quoteTokenAddress: normalizedQuoteTokenAddress,
      },
    });

    const config = buildStrategyRecordConfigFromDocument(
      normalizedDocument,
      user.id,
    );
    const requiredBuyAmount = deriveRequiredStrategyBuyAmount(normalizedDocument);
    const marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
      env.TRADINGBOT_DB,
      normalizedBaseTokenAddress,
    );
    const accounts = await listManagedAccountsWithStoredBalances(
      env.TRADINGBOT_DB,
      user.id,
      {
        pair: {
          baseMint: normalizedBaseTokenAddress,
          quoteMint: normalizedQuoteTokenAddress,
        },
      },
    );

    return jsonResponse(
      buildStrategyPlanPreview(
        normalizedDocument,
        config,
        accounts,
        requiredBuyAmount,
        marketSnapshot,
      ),
    );
  }

  if (method === 'POST' && pathname === '/api/strategy/active') {
    const user = await requireAdmin(request, env);
    const previousActiveStrategyVersion = await dbGetActiveStrategyVersion(
      env.TRADINGBOT_DB,
      user.id,
    );
    const requestBody = await parseJsonBody<unknown>(request);
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      throw new ApiError(400, 'Strategy deployment request is invalid');
    }
    const deploymentRequest = requestBody as Record<string, unknown>;
    const document = normalizeStrategyDocument(deploymentRequest.document);

    const normalizedBaseTokenAddress = document.parameters.baseTokenAddress.trim()
      ? normalizePubkey(document.parameters.baseTokenAddress)
      : '';
    const normalizedQuoteTokenAddress = document.parameters.quoteTokenAddress.trim()
      ? normalizePubkey(document.parameters.quoteTokenAddress)
      : SOLANA_USDC_MINT;
    const normalizedDocument = normalizeStrategyDocument({
      ...document,
      parameters: {
        ...document.parameters,
        baseTokenAddress: normalizedBaseTokenAddress,
        quoteTokenAddress: normalizedQuoteTokenAddress,
      },
      metadata: {
        ...document.metadata,
        author: user.username,
        changeNote:
          document.metadata.changeNote ||
          document.parameters.notes ||
          'Strategy document updated',
        origin: 'manual',
      },
    });

    const strategyConfig = buildStrategyRecordConfigFromDocument(
      normalizedDocument,
      user.id,
    );
    const requiredBuyAmount = deriveRequiredImmediateBuyAmount(
      normalizedDocument,
      strategyConfig,
    );
    const [planningAccounts, deploymentMarketSnapshot] = await Promise.all([
      listManagedAccountsWithStoredBalances(env.TRADINGBOT_DB, user.id, {
        pair: {
          baseMint: normalizedBaseTokenAddress,
          quoteMint: normalizedQuoteTokenAddress,
        },
      }),
      loadStoredMarketSnapshotByContractAddress(
        env.TRADINGBOT_DB,
        normalizedBaseTokenAddress,
        normalizedQuoteTokenAddress,
      ),
    ]);
    const deploymentValidation = planningAccounts.reduce(
      (summary, account) => {
        if (!account.pairCompatible) {
          summary.skippedForCapabilityCount += 1;
        } else if (account.quoteAvailableAmount > 0) {
          summary.eligibleAccountCount += 1;
          summary.availableQuoteAmount += account.quoteAvailableAmount;
          if (!account.hasSolReserve) {
            summary.skippedForSolReserveCount += 1;
          }
        }
        return summary;
      },
      {
        enabledAccountCount: planningAccounts.length,
        eligibleAccountCount: 0,
        skippedForCapabilityCount: 0,
        skippedForSolReserveCount: 0,
        availableQuoteAmount: 0,
      },
    );
    const quoteLabel = formatQuoteLabel(normalizedQuoteTokenAddress);

    if (deploymentValidation.enabledAccountCount === 0) {
      throw new ApiError(409, 'No enabled managed accounts are available for strategy deployment');
    }
    if (deploymentValidation.availableQuoteAmount < requiredBuyAmount) {
      throw new ApiError(
        409,
        `Enabled managed accounts only provide ${deploymentValidation.availableQuoteAmount.toFixed(2)} ${quoteLabel} of immediate buy balance across ${deploymentValidation.eligibleAccountCount}/${deploymentValidation.enabledAccountCount} eligible accounts, below required ${requiredBuyAmount.toFixed(2)} ${quoteLabel}`,
      );
    }

    const reviewedPlan = validateReviewedPlan({
      rawPlan: deploymentRequest.reviewedPlan,
      document: normalizedDocument,
      config: strategyConfig,
      accounts: planningAccounts,
      baseTokenPriceUsd: deploymentMarketSnapshot?.priceUsd ?? null,
      liquidityUsd: deploymentMarketSnapshot?.liquidityUsd ?? null,
    });

    const strategySave = await dbSaveActiveStrategyVersionDocument(
      env.TRADINGBOT_DB,
      user.id,
      normalizedDocument,
      {
        changeNote:
          normalizedDocument.metadata.changeNote ||
          normalizedDocument.parameters.notes ||
          'Strategy document updated',
      },
    );

    const settingsUpdate = mapStrategyDocumentToSettingsUpdate(normalizedDocument);
    await dbSaveSettings(env.TRADINGBOT_DB, user.id, settingsUpdate);
    const updatedSettings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    await dbCreateHistoricalSetupSnapshot(
      env.TRADINGBOT_DB,
      user.id,
      updatedSettings,
    );

    const previousContractAddress = previousActiveStrategyVersion?.document.parameters.baseTokenAddress.trim()
      ? normalizePubkey(previousActiveStrategyVersion.document.parameters.baseTokenAddress)
      : null;

    const queuedStrategy = await strategyAutomationService.enqueueStrategyVersion(
      env,
      user.id,
      strategySave.version,
      reviewedPlan,
    );
    ctx.waitUntil((async () => {
      try {
        await strategyAutomationService.startNextStrategy(env);

        if (previousContractAddress && previousContractAddress !== normalizedBaseTokenAddress) {
          const previousStubId = env.STRATEGY_ENGINE_DO.idFromName(
            strategyEngineDurableObjectNameFor(user.id, previousContractAddress),
          );
          await env.STRATEGY_ENGINE_DO.get(previousStubId).fetch(
            'https://strategy-engine/clear',
            { method: 'POST' },
          );
        }

        if (normalizedBaseTokenAddress) {
          const existingTokenId = await dbResolveTradableTokenId(
            env.TRADINGBOT_DB,
            normalizedBaseTokenAddress,
            normalizedQuoteTokenAddress,
          );
          if (!existingTokenId) {
            const rpcUrls = await dbResolveSolanaRpcUrls(
              env.TRADINGBOT_DB,
              user.id,
              env.SOLANA_RPC_URL,
            );
            const decimals = await fetchSolanaMintDecimals(
              rpcUrls,
              normalizedBaseTokenAddress,
            ).catch(() => null);
            await dbCreateTradableToken(
              env.TRADINGBOT_DB,
              {
                network: 'solana',
                baseTokenAddress: normalizedBaseTokenAddress,
                quoteTokenAddress: normalizedQuoteTokenAddress,
              },
              decimals,
            );
          }
        }

        await dbAddAuditLog(
          env.TRADINGBOT_DB,
          user.id,
          'strategy.version_activated',
          normalizedBaseTokenAddress || 'none',
          strategySave.created
            ? `Activated strategy version v${strategySave.version.versionNo}.`
            : `Strategy version v${strategySave.version.versionNo} remains active.`,
        );
      } catch (err: unknown) {
        console.error('Strategy post-deployment startup failed:', err);
      }
    })());

    return jsonResponse({
      activeStrategyVersion: strategySave.version,
      settings: updatedSettings,
      marketSnapshot: deploymentMarketSnapshot as TokenMarketSnapshot | null,
      queuedStrategy,
      deploymentValidation: {
        requiredBuyAmount,
        availableBuyAmount: deploymentValidation.availableQuoteAmount,
        quoteLabel,
        enabledAccountCount: deploymentValidation.enabledAccountCount,
        eligibleAccountCount: deploymentValidation.eligibleAccountCount,
      },
    });
  }

  if (method === 'GET' && pathname === '/api/strategy/current') {
    await requireAdmin(request, env);
    const queueSnapshot = await strategyAutomationService.getQueueSnapshot(env);
    return jsonResponse(queueSnapshot);
  }

  if (method === 'POST' && pathname === '/api/strategy/abort') {
    const user = await requireAdmin(request, env);
    const body = await parseOptionalJsonObject(request);
    const { reason } = parseAbortRequestBody(body);
    const abortedStrategy = await strategyAutomationService.abortCurrentStrategy(env, reason);

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.abort_requested',
      abortedStrategy?.versionId ?? 'strategy-queue',
      abortedStrategy
        ? `Aborted queued strategy ${abortedStrategy.versionId}. Reason: ${reason}`
        : `Abort requested but no active strategy was running. Reason: ${reason}`,
    );

    return jsonResponse({
      aborted: abortedStrategy != null,
      reason,
      strategy: abortedStrategy,
      report: abortedStrategy?.report ?? null,
    });
  }

  if (method === 'POST' && pathname === '/api/strategy/pause') {
    const user = await requireAdmin(request, env);
    const pausedStrategy = await strategyAutomationService.pauseCurrentStrategy(env);

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.pause_requested',
      pausedStrategy?.versionId ?? 'strategy-queue',
      pausedStrategy
        ? `Paused strategy queue for ${pausedStrategy.versionId}.`
        : 'Pause requested but no active strategy was running.',
    );

    return jsonResponse({
      paused: pausedStrategy != null,
      strategy: pausedStrategy,
    });
  }

  if (method === 'POST' && pathname === '/api/strategy/resume') {
    const user = await requireAdmin(request, env);
    const resumedStrategy = await strategyAutomationService.resumeCurrentStrategy(env);
    if (resumedStrategy) {
      await dbAddAuditLog(
        env.TRADINGBOT_DB,
        user.id,
        'strategy.resume_requested',
        resumedStrategy.versionId,
        `Resumed paused strategy queue for ${resumedStrategy.versionId}.`,
      );
      return jsonResponse({
        started: false,
        resumed: true,
        queueEmpty: false,
        alreadyRunning: false,
        strategy: resumedStrategy,
      });
    }
    const wasBusy = (await strategyAutomationService.getActiveStrategyStub(env)) != null;
    const startedStrategy = await strategyAutomationService.startNextStrategy(env, {
      force: true,
    });
    const started = !wasBusy && startedStrategy != null;

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.resume_requested',
      startedStrategy?.versionId ?? 'strategy-queue',
      started
        ? `Manually resumed queue and started strategy ${startedStrategy?.versionId}.`
        : wasBusy
          ? 'Resume requested while a strategy is already running.'
          : 'Resume requested but the strategy queue is empty.',
    );

    return jsonResponse({
      started,
      queueEmpty: !wasBusy && startedStrategy == null,
      alreadyRunning: wasBusy,
      strategy: startedStrategy,
    });
  }

  if (
    method === 'POST' &&
    pathname.startsWith('/api/strategy/pending/') &&
    pathname.endsWith('/cancel')
  ) {
    const user = await requireAdmin(request, env);
    const versionId = decodeURIComponent(
      pathname.slice('/api/strategy/pending/'.length, -'/cancel'.length),
    ).trim();
    if (!versionId) {
      throw new ApiError(400, 'Pending strategy versionId is required');
    }

    const removedStrategy = await removePendingStrategy(env, versionId);
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.pending_removed',
      removedStrategy?.versionId ?? versionId,
      removedStrategy
        ? `Removed pending strategy ${removedStrategy.versionId} from the serial queue.`
        : `Pending strategy ${versionId} was not found in the serial queue.`,
    );

    return jsonResponse({
      removed: removedStrategy != null,
      strategy: removedStrategy,
    });
  }

  if (method === 'POST' && pathname === '/api/strategy/versions/cleanup') {
    const user = await requireAdmin(request, env);
    const cleanup = await dbDeletePreviousStrategyVersions(
      env.TRADINGBOT_DB,
      user.id,
    );

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.versions_cleaned',
      cleanup.keptVersion?.document.parameters.baseTokenAddress || 'strategy',
      cleanup.keptVersion
        ? `Deleted ${cleanup.deletedVersions} automatic strategy version(s) and ${cleanup.deletedEvaluations} related evaluation(s). Kept manual v${cleanup.keptVersion.versionNo} active.`
        : `Deleted ${cleanup.deletedVersions} automatic strategy version(s) and ${cleanup.deletedEvaluations} related evaluation(s). No manual strategy version remains active.`,
    );

    return jsonResponse({
      deletedVersions: cleanup.deletedVersions,
      deletedEvaluations: cleanup.deletedEvaluations,
      activeStrategyVersion: cleanup.keptVersion,
    });
  }

  return null;
}
