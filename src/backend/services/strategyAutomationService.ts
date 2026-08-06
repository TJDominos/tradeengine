import { ApiError } from '../errors';
import {
  buildJupiterSwapTransaction,
  fetchJupiterSwapQuote,
} from '../jupiter';
import {
  DEFAULT_STRATEGY_TYPE,
  PRIMARY_STRATEGY_NAME,
} from '../strategy/config';
import { StrategyEngine } from '../strategy/engine';
import {
  buildStrategyDocumentFromSettings,
  runStrategyRuntime,
} from '../strategy/runtime';
import {
  type ExternalTradeEvent,
  TriggerHandler,
} from '../strategy/triggers';
import type {
  StrategyDefinitionRecord,
  StrategyExecutionTaskPayload,
  StrategyRuntimeResult,
  StrategySettingsInput,
  StrategyTriggerEvent,
  StrategyVersionDocument,
  StrategyVersionRecord,
} from '../strategy/types';
import { nowTs } from '../time';
import {
  dbAddAuditLog,
  dbGetManagedAccountById,
  dbLoadManagedKeypairBytes,
  dbLoadManagedKeypairBytesByAccountId,
  dbLoadSettings,
  getAvailableAccount,
  dbListManagedAccountAddresses,
} from '../userStore';
import { dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import type { Env } from '../workerShared';
import {
  executeTradeTask,
  isRecord,
  normalizePubkey,
  readNonEmptyString,
  registerTradeTaskExecutor,
  type StrategyTaskExecutionContext,
  type StrategyTaskExecutionResult,
} from '../workerCore';
import { parseJsonBody } from '../workerSchema';
import { SOLANA_USDC_MINT } from '../workerShared';
import { dbGetLatestHistoricalSetupId } from './historyMetricsService';
import { sendSolanaTransaction, signSolanaTransaction } from './solanaTradeService';
import { dbGetActiveStrategyVersion } from './strategyStore';

function buildStrategyRuntimeRegistryKey(
  userId: number,
  contractAddress: string,
): string {
  return `${userId}:${contractAddress}`;
}

function parseTimeRangeTargetToDurationMs(timeRangeTarget: string): number {
  switch (timeRangeTarget) {
    case '1h':
      return 60 * 60 * 1000;
    case '6h':
      return 6 * 60 * 60 * 1000;
    case '12h':
      return 12 * 60 * 60 * 1000;
    case '3d':
      return 3 * 24 * 60 * 60 * 1000;
    case '1w':
      return 7 * 24 * 60 * 60 * 1000;
    case '24h':
    default:
      return 24 * 60 * 60 * 1000;
  }
}

async function executeManagedTradeTask(
  task: StrategyExecutionTaskPayload,
  context: StrategyTaskExecutionContext,
): Promise<StrategyTaskExecutionResult> {
  const { env, userId } = context;

  if (!env.PRIVATE_KEY_ENCRYPTION_KEY) {
    throw new ApiError(
      503,
      'PRIVATE_KEY_ENCRYPTION_KEY is not configured — cannot decrypt signing key',
    );
  }

  const action = task.action;
  if (action !== 'BUY' && action !== 'SELL') {
    throw new ApiError(400, 'action must be BUY or SELL');
  }
  if (!Number.isFinite(task.requestedAmount) || task.requestedAmount <= 0) {
    throw new ApiError(400, 'requestedAmount must be a positive number');
  }

  const settings = await dbLoadSettings(env.TRADINGBOT_DB, userId);
  const targetMint = normalizePubkey(
    typeof task.contractAddress === 'string' && task.contractAddress.trim().length > 0
      ? task.contractAddress
      : settings.contractAddress,
  );
  if (!targetMint) {
    throw new ApiError(400, 'No active trading token configured');
  }

  let resolvedAccountId: number | null =
    typeof task.accountId === 'number' && Number.isInteger(task.accountId) && task.accountId > 0
      ? task.accountId
      : null;
  let resolvedSignerAddress =
    typeof task.walletAddress === 'string' && task.walletAddress.trim().length > 0
      ? normalizePubkey(task.walletAddress)
      : '';

  if (resolvedAccountId != null) {
    const managedAccount = await dbGetManagedAccountById(
      env.TRADINGBOT_DB,
      userId,
      resolvedAccountId,
    );
    resolvedSignerAddress = managedAccount.address;
  }

  if (!resolvedSignerAddress) {
    const allocatedAccount = await getAvailableAccount(
      env.TRADINGBOT_DB,
      userId,
      action === 'BUY' ? 'buy' : 'sell',
      task.requestedAmount,
      {
        envRpcUrl: env.SOLANA_RPC_URL,
      },
    );
    if (!allocatedAccount) {
      throw new ApiError(
        400,
        `No active managed wallet satisfied ${action} amount ${task.requestedAmount}`,
      );
    }
    resolvedAccountId = allocatedAccount.id;
    resolvedSignerAddress = allocatedAccount.address;
  }

  if (!resolvedSignerAddress) {
    const managed = await dbListManagedAccountAddresses(env.TRADINGBOT_DB, userId);
    if (managed.length === 0) {
      throw new ApiError(400, 'No managed wallet imported — import a private key first');
    }
    resolvedSignerAddress = managed[0];
  }

  const keypairBytes =
    resolvedAccountId != null
      ? await dbLoadManagedKeypairBytesByAccountId(
          env.TRADINGBOT_DB,
          userId,
          resolvedAccountId,
          env.PRIVATE_KEY_ENCRYPTION_KEY,
        )
      : await dbLoadManagedKeypairBytes(
          env.TRADINGBOT_DB,
          userId,
          resolvedSignerAddress,
          env.PRIVATE_KEY_ENCRYPTION_KEY,
        );

  const tokenRecord = await env.TRADINGBOT_DB
    .prepare('SELECT decimals FROM tradable_tokens WHERE network = ?1 AND contract_address = ?2')
    .bind('solana', targetMint)
    .first<{ decimals: number | null }>();
  const tokenDecimals = tokenRecord?.decimals ?? 6;

  const USDC_DECIMALS = 6;
  let inputMint: string;
  let outputMint: string;
  let amountAtomicUnits: string;

  if (action === 'BUY') {
    inputMint = SOLANA_USDC_MINT;
    outputMint = targetMint;
    amountAtomicUnits = String(
      Math.round(task.requestedAmount * 10 ** USDC_DECIMALS),
    );
  } else {
    inputMint = targetMint;
    outputMint = SOLANA_USDC_MINT;
    amountAtomicUnits = String(
      Math.round(task.requestedAmount * 10 ** tokenDecimals),
    );
  }

  const slippageBps = Math.round(settings.maxSlippage * 100);
  const tokenId = await dbResolveTradableTokenId(env.TRADINGBOT_DB, targetMint);
  const setupId = await dbGetLatestHistoricalSetupId(env.TRADINGBOT_DB, userId);

  let tradeLogId: number | null = null;
  if (tokenId) {
    const logRow = await env.TRADINGBOT_DB
      .prepare(
        `INSERT INTO trade_logs (
           token_id, setup_id, wallet_address, action,
           requested_amount, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', ?6, ?6)
         RETURNING id`,
      )
      .bind(tokenId, setupId, resolvedSignerAddress, action, task.requestedAmount, nowTs())
      .first<{ id: number }>();
    tradeLogId = logRow?.id ?? null;
  }

  try {
    const quote = await fetchJupiterSwapQuote(
      inputMint,
      outputMint,
      amountAtomicUnits,
      slippageBps,
    );
    const unsignedTxBytes = await buildJupiterSwapTransaction(
      quote,
      resolvedSignerAddress,
    );
    const signedTxBytes = signSolanaTransaction(unsignedTxBytes, keypairBytes);
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      userId,
      env.SOLANA_RPC_URL,
    );
    const txSignature = await sendSolanaTransaction(rpcUrls, signedTxBytes);

    const executedAmountRaw = Number(action === 'BUY' ? quote.outAmount : quote.inAmount);
    const executedDecimals = action === 'BUY' ? tokenDecimals : USDC_DECIMALS;
    const executedAmount = executedAmountRaw / 10 ** executedDecimals;

    if (tradeLogId != null) {
      await env.TRADINGBOT_DB
        .prepare(
          `UPDATE trade_logs
           SET status = 'PENDING', tx_signature = ?2, executed_amount = ?3, updated_at = ?4
           WHERE id = ?1`,
        )
        .bind(tradeLogId, txSignature, executedAmount, nowTs())
        .run();
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      userId,
      'trade.submitted',
      txSignature,
      `${action} ${task.requestedAmount} (${action === 'BUY' ? 'USDC → ' + targetMint : targetMint + ' → USDC'}) via Jupiter. Tx: ${txSignature}`,
    );

    return {
      txSignature,
      accountId: resolvedAccountId,
      walletAddress: resolvedSignerAddress,
      action,
      inputMint,
      outputMint,
      requestedAmount: task.requestedAmount,
      executedAmount,
      slippageBps,
      status: 'PENDING',
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (tradeLogId != null) {
      await env.TRADINGBOT_DB
        .prepare(
          `UPDATE trade_logs SET status = 'FAILED', error_message = ?2, updated_at = ?3 WHERE id = ?1`,
        )
        .bind(tradeLogId, errorMessage, nowTs())
        .run();
    }
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      userId,
      'trade.failed',
      targetMint,
      `${action} trade failed: ${errorMessage}`,
    );
    throw err instanceof ApiError ? err : new ApiError(502, `Trade failed: ${errorMessage}`);
  }
}

registerTradeTaskExecutor(async (task, context) =>
  executeManagedTradeTask(task, context),
);

export function buildStrategyTaskExecutionContext(
  env: Env,
  userId: number,
  username?: string | null,
): StrategyTaskExecutionContext {
  return {
    env,
    userId,
    username: username ?? null,
  };
}

async function getOrCreateStrategyRuntimeForUser(
  env: Env,
  userId: number,
  contractAddress: string,
): Promise<StrategyRuntimeRegistryEntry | null> {
  const activeVersion = await dbGetActiveStrategyVersion(env.TRADINGBOT_DB, userId);
  if (!activeVersion) {
    return null;
  }

  const strategyContractAddress = activeVersion.document.parameters.contractAddress.trim()
    ? normalizePubkey(activeVersion.document.parameters.contractAddress)
    : '';
  if (!strategyContractAddress || strategyContractAddress !== contractAddress) {
    return null;
  }
  if (!activeVersion.document.execution.enabled || activeVersion.document.riskControls.dryRun) {
    return null;
  }

  const registryKey = buildStrategyRuntimeRegistryKey(userId, strategyContractAddress);
  const existing = strategyRuntimeRegistry.get(registryKey);
  if (existing && existing.versionId === activeVersion.id) {
    return existing;
  }

  if (existing) {
    existing.engine.queue.clear();
  }
  for (const [key, entry] of strategyRuntimeRegistry.entries()) {
    if (entry.userId === userId && key !== registryKey) {
      entry.engine.queue.clear();
      strategyRuntimeRegistry.delete(key);
    }
  }

  const engine = new StrategyEngine({
    macroObjective: activeVersion.document.execution.macroObjective,
    contractAddress: strategyContractAddress,
    tactics: activeVersion.document.execution.tactics,
    baseOrderCount: Math.max(
      1,
      Math.min(12, Math.max(3, activeVersion.document.riskControls.maxConcurrentOrders * 3)),
    ),
    baseTotalVolumeUsd:
      activeVersion.document.riskControls.maxPositionUsd ??
      DEFAULT_STRATEGY_TASK_BASE_VOLUME_USD,
    baseDurationMs: parseTimeRangeTargetToDurationMs(
      activeVersion.document.parameters.timeRangeTarget,
    ),
    distributionChunkCount: 3,
    distributionChunkDelayJitterMs: 2_000,
    execution: {
      enabled: activeVersion.document.execution.enabled,
      route: activeVersion.document.execution.route,
      commitment: activeVersion.document.execution.commitment,
      timeJitterRatio: activeVersion.document.execution.timeJitterRatio,
      volumeJitterRatio: activeVersion.document.execution.volumeJitterRatio,
    },
    dispatchContext: buildStrategyTaskExecutionContext(env, userId),
    allocateAccount: async (input) => {
      const account = await getAvailableAccount(
        env.TRADINGBOT_DB,
        userId,
        input.action,
        input.estimatedAmount,
        {
          envRpcUrl: env.SOLANA_RPC_URL,
        },
      );
      return account
        ? {
            accountId: account.id,
            walletAddress: account.address,
          }
        : null;
    },
    onTaskError: async (task, error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[strategy-queue] user ${userId} task ${task.id} failed: ${errorMessage}`,
        error,
      );
      try {
        await dbAddAuditLog(
          env.TRADINGBOT_DB,
          userId,
          'strategy.task.failed',
          task.contractAddress ?? strategyContractAddress,
          `${task.action} ${task.requestedAmount} failed: ${errorMessage}`,
        );
      } catch (auditError: unknown) {
        console.error('Failed to persist strategy task failure audit log:', auditError);
      }
    },
  });
  const triggerHandler = new TriggerHandler(
    engine,
    activeVersion.document.triggers.triggerThresholdUsd,
  );

  const entry: StrategyRuntimeRegistryEntry = {
    userId,
    versionId: activeVersion.id,
    contractAddress: strategyContractAddress,
    engine,
    triggerHandler,
  };
  strategyRuntimeRegistry.set(registryKey, entry);
  return entry;
}

function parseExternalTradeWebhookPayload(
  payload: unknown,
  url: URL,
): {
  contractAddress: string;
  event: ExternalTradeEvent;
} {
  if (!isRecord(payload)) {
    throw new ApiError(400, 'Webhook body must be a JSON object');
  }

  const eventType = readNonEmptyString(payload.type);
  if (eventType !== 'whale_buy' && eventType !== 'whale_sell') {
    throw new ApiError(400, 'Webhook type must be whale_buy or whale_sell');
  }

  const amount = typeof payload.amount === 'number' ? payload.amount : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ApiError(400, 'Webhook amount must be a finite non-negative number');
  }

  const walletAddressRaw =
    readNonEmptyString(payload.wallet_address) ??
    readNonEmptyString(payload.walletAddress);
  if (!walletAddressRaw) {
    throw new ApiError(400, 'Webhook wallet_address is required');
  }

  const isLossCutValue =
    typeof payload.is_loss_cut === 'boolean'
      ? payload.is_loss_cut
      : typeof payload.isLossCut === 'boolean'
        ? payload.isLossCut
        : null;
  if (isLossCutValue == null) {
    throw new ApiError(400, 'Webhook is_loss_cut must be a boolean');
  }

  const contractAddress =
    tryNormalizeSolanaPubkey(payload.contract_address) ??
    tryNormalizeSolanaPubkey(payload.contractAddress) ??
    tryNormalizeSolanaPubkey(url.searchParams.get('contractAddress'));
  if (!contractAddress) {
    throw new ApiError(
      400,
      'Webhook contractAddress is required either in the payload or query string',
    );
  }

  const txHash =
    readNonEmptyString(payload.txHash) ??
    readNonEmptyString(payload.tx_hash) ??
    readNonEmptyString(payload.signature) ??
    readNonEmptyString(payload.txSignature);
  if (!txHash) {
    throw new ApiError(400, 'Webhook txHash is required for deduplication');
  }

  return {
    contractAddress,
    event: {
      type: eventType,
      amount,
      contractAddress,
      txHash,
      wallet_address: normalizePubkey(walletAddressRaw),
      is_loss_cut: isLossCutValue,
    },
  };
}

export async function handleStrategyExternalTradeWebhook(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const payload = await parseJsonBody<unknown>(request);
  const { contractAddress, event } = parseExternalTradeWebhookPayload(payload, url);
  const userIds = await dbListUserIdsByActiveContractAddress(
    env.TRADINGBOT_DB,
    contractAddress,
  );

  ctx.waitUntil(
    (async () => {
      let dispatchedCount = 0;
      for (const userId of userIds) {
        try {
          const activeVersion = await dbGetActiveStrategyVersion(
            env.TRADINGBOT_DB,
            userId,
          );
          if (!activeVersion) {
            continue;
          }

          const strategyContractAddress = activeVersion.document.parameters.contractAddress.trim()
            ? normalizePubkey(activeVersion.document.parameters.contractAddress)
            : '';
          if (
            !strategyContractAddress ||
            strategyContractAddress !== contractAddress ||
            !activeVersion.document.execution.enabled ||
            activeVersion.document.riskControls.dryRun
          ) {
            continue;
          }

          const stubId = env.STRATEGY_ENGINE_DO.idFromName(
            strategyEngineDurableObjectNameFor(userId, contractAddress),
          );
          const stub = env.STRATEGY_ENGINE_DO.get(stubId);
          const doRequest: StrategyEngineDurableObjectEventRequest = {
            userId,
            versionId: activeVersion.id,
            strategyDocument: activeVersion.document,
            event,
          };
          dispatchedCount += 1;
          await stub.fetch('https://strategy-engine/event', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(doRequest),
          });
        } catch (error: unknown) {
          console.error(
            `[strategy-webhook] Failed to dispatch event for user ${userId} on ${contractAddress}:`,
            error,
          );
        }
      }
      console.log(
        `[strategy-webhook] Accepted ${event.type} ${event.amount} for ${contractAddress}; routed to ${dispatchedCount}/${userIds.length} active strategy runtime(s).`,
      );
    })(),
  );

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      contractAddress,
      candidateUsers: userIds.length,
    },
    200,
  );
}
const MARKET_REFRESH_RUNNING_STALE_AFTER_SEC = 15 * 60;

interface HeliusDasTokenAccountsResult {
  total?: number;
  limit?: number;
  cursor?: unknown;
  token_accounts?: Array<{
    owner?: unknown;
    amount?: unknown;
  }>;
}

