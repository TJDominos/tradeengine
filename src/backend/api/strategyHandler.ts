import { ApiError } from '../errors';
import { buildRandomizedTwapPlan } from '../strategy/engine';
import { normalizeStrategyDocument } from '../strategy/migrations';
import {
  strategyEngineDurableObjectNameFor,
  type StrategyEngineDurableObjectConfigureRequest,
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
import { allocateVolumeAcrossAccountCaps } from '../services/tradeMath';
import type {
  StrategyRecordConfig,
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
import {
  getManagedBuyCapacitySummary,
  listManagedAccountsWithStoredBalances,
  type ManagedAccountBalanceRecord,
} from '../userStore';
import { splitBasePlannedTransactionCount } from '../strategy/plannedTransactions';

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
  eligibleAccountCount: number;
  skippedForCapabilityCount: number;
  skippedForSolReserveCount: number;
  sufficientBuyCapacity: boolean;
  tasks: StrategyPlanPreviewTask[];
  accounts: StrategyPlanPreviewAccount[];
};

type StrategyPlanTaskSpec = {
  side: 'buy' | 'sell';
  pulse: string;
  totalVolumeUsd: number;
  orderCount: number;
  durationMs: number;
  scheduledOffsetMs: number;
};

function deriveRequiredStrategyBuyAmount(document: StrategyVersionDocument): number {
  if (
    document.riskControls.maxPositionUsd != null &&
    Number.isFinite(document.riskControls.maxPositionUsd) &&
    document.riskControls.maxPositionUsd > 0
  ) {
    return document.riskControls.maxPositionUsd;
  }
  if (
    Number.isFinite(document.targets.volumeUsdMin) &&
    document.targets.volumeUsdMin > 0
  ) {
    return document.targets.volumeUsdMin;
  }
  return DEFAULT_STRATEGY_DEPLOY_BUY_AMOUNT;
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

function createDeterministicRandom(seedText: string): () => number {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6D2B79F5;
    let next = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStrategyPlanTaskSpecs(
  config: StrategyRecordConfig,
): StrategyPlanTaskSpec[] {
  const { buyCount, sellCount } = splitBasePlannedTransactionCount(
    config.macroObjective,
    config.baseOrderCount,
  );

  switch (config.macroObjective) {
    case 'distribution':
      return [
        {
          side: 'buy',
          pulse: 'wash_buy',
          totalVolumeUsd: config.baseTotalVolumeUsd / 2,
          orderCount: buyCount,
          durationMs: config.baseDurationMs,
          scheduledOffsetMs: 0,
        },
        {
          side: 'sell',
          pulse: 'wash_sell',
          totalVolumeUsd: config.baseTotalVolumeUsd / 2,
          orderCount: sellCount,
          durationMs: config.baseDurationMs,
          scheduledOffsetMs: 750,
        },
      ];
    case 'accumulation':
      return [
        {
          side: 'buy',
          pulse: 'slow_buy',
          totalVolumeUsd: config.baseTotalVolumeUsd,
          orderCount: buyCount,
          durationMs: Math.round(config.baseDurationMs * 1.5),
          scheduledOffsetMs: 0,
        },
      ];
    case 'shakeout':
    default:
      return [
        {
          side: 'buy',
          pulse: 'trend',
          totalVolumeUsd: config.baseTotalVolumeUsd,
          orderCount: config.baseOrderCount,
          durationMs: config.baseDurationMs,
          scheduledOffsetMs: 0,
        },
      ];
  }
}

function buildStrategyPlanPreview(
  document: StrategyVersionDocument,
  config: StrategyRecordConfig,
  accounts: ManagedAccountBalanceRecord[],
  requiredBuyAmount: number,
): StrategyPlanPreviewResponse {
  const generatedAt = Date.now();
  const random = createDeterministicRandom(JSON.stringify(document));
  const quoteLabel = formatQuoteLabel(config.quoteTokenAddress);
  const accountSummaries = new Map<number, StrategyPlanPreviewAccount>();
  const rotationOffsets: Record<'buy' | 'sell', number> = {
    buy: 0,
    sell: 0,
  };

  for (const account of accounts) {
    const solBalance = Number.parseFloat(account.walletBalance.sol) || 0;
    accountSummaries.set(account.id, {
      accountId: account.id,
      label: account.label,
      walletAddress: account.address,
      quoteAvailableAmount: account.quoteAvailableAmount,
      baseTokenAmount: account.baseTokenAmount,
      solBalance,
      plannedBuyVolumeUsd: 0,
      plannedSellVolumeUsd: 0,
      buyOverAllocationUsd: 0,
      buyRemainingQuoteUsd: account.quoteAvailableAmount,
      isBuyOverAllocated: false,
      pairCompatible: account.pairCompatible,
      eligibleForBuy: account.pairCompatible && account.hasSolReserve && account.quoteAvailableAmount > 0,
      eligibleForSell: account.pairCompatible && account.hasSolReserve && account.baseTokenAmount > 0,
    });
  }

  const planStartTime = generatedAt + 1_000;
  const tasks: StrategyPlanPreviewTask[] = [];
  for (const spec of buildStrategyPlanTaskSpecs(config)) {
    const plan = buildRandomizedTwapPlan(config.execution, {
      side: spec.side,
      totalVolume: spec.totalVolumeUsd,
      orderCount: spec.orderCount,
      durationMs: spec.durationMs,
      startTime: planStartTime,
      baseTokenAddress: config.baseTokenAddress,
      random,
    });

    for (const slice of plan.slices) {
      const eligibleAccounts = [...accountSummaries.values()].filter((account) =>
        spec.side === 'buy' ? account.eligibleForBuy : account.eligibleForSell,
      );
      const eligibleAccountsById = new Map(
        eligibleAccounts.map((account) => [account.accountId, account]),
      );
      const allocationPlan = allocateVolumeAcrossAccountCaps(
        slice.targetVolume,
        eligibleAccounts.map((account) => ({
          accountId: account.accountId,
          maxVolumeUsd: null,
          existingVolumeUsd:
            spec.side === 'buy'
              ? account.plannedBuyVolumeUsd
              : account.plannedSellVolumeUsd,
        })),
        {
          random,
          accountCyclingEnabled: document.execution.accountCyclingEnabled,
          rotationOffset: rotationOffsets[spec.side],
          accountDispersionStrength: document.execution.accountDispersionStrength,
        },
      );
      rotationOffsets[spec.side] = allocationPlan.nextRotationOffset;
      const allocations = allocationPlan.allocations
        .map((allocationPlanEntry) => {
          const account = eligibleAccountsById.get(allocationPlanEntry.accountId);
          if (!account) {
            return null;
          }
          const plannedVolumeUsd = allocationPlanEntry.volumeUsd;
          const summary = accountSummaries.get(account.accountId);
          if (summary) {
            if (spec.side === 'buy') {
              summary.plannedBuyVolumeUsd = Number((summary.plannedBuyVolumeUsd + plannedVolumeUsd).toFixed(6));
            } else {
              summary.plannedSellVolumeUsd = Number((summary.plannedSellVolumeUsd + plannedVolumeUsd).toFixed(6));
            }
          }
          return {
            accountId: account.accountId,
            label: account.label,
            walletAddress: account.walletAddress,
            plannedVolumeUsd: Number(plannedVolumeUsd.toFixed(6)),
            quoteAvailableAmount: account.quoteAvailableAmount,
            baseTokenAmount: account.baseTokenAmount,
            solBalance: account.solBalance,
            accountBuyOverAllocated: false,
            accountBuyOverAllocationUsd: 0,
          };
        })
        .filter((allocation): allocation is StrategyPlanPreviewAllocation => allocation != null);

      tasks.push({
        taskId: `${spec.pulse}-${slice.orderIndex}-${slice.scheduledAt + spec.scheduledOffsetMs}`,
        side: spec.side,
        pulse: spec.pulse,
        orderIndex: slice.orderIndex,
        totalOrders: plan.orderCount,
        scheduledAt: slice.scheduledAt + spec.scheduledOffsetMs,
        totalVolumeUsd: Number(slice.targetVolume.toFixed(6)),
        unallocatedVolumeUsd: Number(allocationPlan.unallocatedVolumeUsd.toFixed(6)),
        allocations,
      });
    }
  }

  const accountList = [...accountSummaries.values()].sort((left, right) => {
    const leftTotal = left.plannedBuyVolumeUsd + left.plannedSellVolumeUsd;
    const rightTotal = right.plannedBuyVolumeUsd + right.plannedSellVolumeUsd;
    if (rightTotal !== leftTotal) {
      return rightTotal - leftTotal;
    }
    return left.label.localeCompare(right.label) || left.walletAddress.localeCompare(right.walletAddress);
  });

  for (const account of accountList) {
    account.buyOverAllocationUsd = Number(
      Math.max(0, account.plannedBuyVolumeUsd - account.quoteAvailableAmount).toFixed(6),
    );
    account.buyRemainingQuoteUsd = Number(
      Math.max(0, account.quoteAvailableAmount - account.plannedBuyVolumeUsd).toFixed(6),
    );
    account.isBuyOverAllocated = account.buyOverAllocationUsd > 0;
  }

  const overAllocatedByAccountId = new Map(
    accountList.map((account) => [
      account.accountId,
      {
        isBuyOverAllocated: account.isBuyOverAllocated,
        buyOverAllocationUsd: account.buyOverAllocationUsd,
      },
    ]),
  );
  for (const task of tasks) {
    for (const allocation of task.allocations) {
      const status = overAllocatedByAccountId.get(allocation.accountId);
      allocation.accountBuyOverAllocated = status?.isBuyOverAllocated ?? false;
      allocation.accountBuyOverAllocationUsd = status?.buyOverAllocationUsd ?? 0;
    }
  }

  const eligibleBuyAccounts = accountList.filter((account) => account.eligibleForBuy);
  const availableBuyAmount = Number(
    eligibleBuyAccounts
      .reduce((sum, account) => sum + account.quoteAvailableAmount, 0)
      .toFixed(6),
  );

  return {
    generatedAt,
    pair: {
      baseTokenAddress: config.baseTokenAddress,
      quoteTokenAddress: config.quoteTokenAddress,
    },
    macroObjective: config.macroObjective,
    accountCyclingEnabled: document.execution.accountCyclingEnabled,
    quoteLabel,
    requiredBuyAmount,
    availableBuyAmount,
    enabledAccountCount: accountList.length,
    eligibleAccountCount: eligibleBuyAccounts.length,
    skippedForCapabilityCount: accountList.filter((account) => !account.pairCompatible).length,
    skippedForSolReserveCount: accountList.filter((account) => account.pairCompatible && account.solBalance < 0.01).length,
    sufficientBuyCapacity: availableBuyAmount >= requiredBuyAmount,
    tasks: tasks.sort((left, right) => left.scheduledAt - right.scheduledAt || left.taskId.localeCompare(right.taskId)),
    accounts: accountList,
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
      ),
    );
  }

  if (method === 'POST' && pathname === '/api/strategy/active') {
    const user = await requireAdmin(request, env);
    const previousActiveStrategyVersion = await dbGetActiveStrategyVersion(
      env.TRADINGBOT_DB,
      user.id,
    );
    const document = normalizeStrategyDocument(
      await parseJsonBody<unknown>(request),
    );

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

    const requiredBuyAmount = deriveRequiredStrategyBuyAmount(normalizedDocument);
    const deploymentValidation = await getManagedBuyCapacitySummary(
      env.TRADINGBOT_DB,
      user.id,
      {
        envRpcUrl: env.SOLANA_RPC_URL,
        pair: {
          baseMint: normalizedBaseTokenAddress,
          quoteMint: normalizedQuoteTokenAddress,
        },
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

    if (normalizedBaseTokenAddress) {
      const stubId = env.STRATEGY_ENGINE_DO.idFromName(
        strategyEngineDurableObjectNameFor(user.id, normalizedBaseTokenAddress),
      );
      const stub = env.STRATEGY_ENGINE_DO.get(stubId);
      const doRequest: StrategyEngineDurableObjectConfigureRequest = {
        userId: user.id,
        versionId: strategySave.version.id,
        strategyDocument: normalizedDocument,
      };
      await stub.fetch('https://strategy-engine/configure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(doRequest),
      });
    }

    if (
      previousContractAddress &&
      previousContractAddress !== normalizedBaseTokenAddress
    ) {
      const previousStubId = env.STRATEGY_ENGINE_DO.idFromName(
        strategyEngineDurableObjectNameFor(user.id, previousContractAddress),
      );
      const previousStub = env.STRATEGY_ENGINE_DO.get(previousStubId);
      await previousStub.fetch('https://strategy-engine/clear', {
        method: 'POST',
      });
    }

    let marketSnapshot: TokenMarketSnapshot | null = null;
    if (normalizedBaseTokenAddress) {
      const rpcUrls = await dbResolveSolanaRpcUrls(
        env.TRADINGBOT_DB,
        user.id,
        env.SOLANA_RPC_URL,
      );

      const existingTokenId = await dbResolveTradableTokenId(
        env.TRADINGBOT_DB,
        normalizedBaseTokenAddress,
        normalizedQuoteTokenAddress,
      );
      if (!existingTokenId) {
        try {
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
        } catch (err: unknown) {
          console.warn(
            `Failed to ensure tracked token metadata for strategy base token ${normalizedBaseTokenAddress}:`,
            err,
          );
        }
      }
      marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
        env.TRADINGBOT_DB,
        normalizedBaseTokenAddress,
        normalizedQuoteTokenAddress,
      );
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

    const queuedStrategy = await strategyAutomationService.enqueueStrategyVersion(
      env,
      user.id,
      strategySave.version,
    );
    await strategyAutomationService.startNextStrategy(env);

    return jsonResponse({
      activeStrategyVersion: strategySave.version,
      settings: updatedSettings,
      marketSnapshot,
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

  if (method === 'POST' && pathname === '/api/strategy/resume') {
    const user = await requireAdmin(request, env);
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
