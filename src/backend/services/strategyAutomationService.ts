import { ApiError } from '../errors';
import {
  buildJupiterSwapTransaction,
  fetchJupiterSwapQuote,
} from '../jupiter';
import {
  strategyEngineDurableObjectNameFor,
  type StrategyEngineDurableObjectConfigureRequest,
  type StrategyEngineDurableObjectMetrics,
  type StrategyEngineDurableObjectStatus,
} from '../strategy/strategyEngineDO';
import { StrategyStatus } from '../strategy/types';
import type {
  ExecutionReport,
  StrategyRecord,
  StrategyExecutionTaskPayload,
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
  normalizePubkey,
  registerTradeTaskExecutor,
  type StrategyTaskExecutionContext,
  type StrategyTaskExecutionResult,
} from '../workerCore';
import { parseJsonBody } from '../workerSchema';
import { SOLANA_USDC_MINT } from '../workerShared';
import { dbGetLatestHistoricalSetupId } from './historyMetricsService';
import { sendSolanaTransaction, signSolanaTransaction } from './solanaTradeService';
import {
  addStrategy,
  buildStrategyRecordConfigFromVersion,
  findStrategyRecordByStrategyVersionId,
  getAllStrategies,
  getActiveStrategy,
  getNextPendingStrategy,
  updateStrategyStatus,
} from './strategyStore';

interface StrategyEngineMetrics {
  actualTotalVolume: number;
  actualNetInflow: number;
  tacticsTriggeredCount: number;
  pnl: number;
  startTime?: number | null;
}

interface StrategyEngineDurableObjectMetricsResponse {
  status: StrategyEngineDurableObjectStatus;
  metrics: StrategyEngineDurableObjectMetrics;
  currentEngineState: string | null;
  nextExecutionTime: number | null;
}

export interface StrategyQueueSnapshot {
  active: StrategyRecord | null;
  pending: StrategyRecord[];
  history: StrategyRecord[];
  paused: boolean;
  currentEngineState: string | null;
  currentMetrics: StrategyEngineMetrics | null;
}

export class StrategyAutomationService {
  public async isBusy(env: Env): Promise<boolean> {
    return (await getActiveStrategy(env)) != null;
  }

  public async enqueueStrategyVersion(
    env: Env,
    userId: number,
    version: StrategyVersionRecord,
  ): Promise<StrategyRecord> {
    const existing = await findStrategyRecordByStrategyVersionId(env, version.id);
    if (existing) {
      return existing;
    }
    return addStrategy(
      env,
      `strategy-${version.id}`,
      buildStrategyRecordConfigFromVersion(version, userId),
    );
  }

  public async getActiveStrategyStub(
    env: Env,
  ): Promise<{ record: StrategyRecord; stub: DurableObjectStub } | null> {
    await this.reconcileActiveStrategy(env);
    const activeRecord = await getActiveStrategy(env);
    if (!activeRecord) {
      return null;
    }
    return {
      record: activeRecord,
      stub: this.resolveStrategyEngineStub(env, activeRecord),
    };
  }

  public async getQueueSnapshot(env: Env): Promise<StrategyQueueSnapshot> {
    await this.reconcileActiveStrategy(env);
    const grouped = await getAllStrategies(env);
    const currentMetrics = await this.getCurrentMetrics(env);
    return {
      active: grouped.active[0] ?? null,
      pending: grouped.pending,
      history: grouped.history,
      paused: grouped.paused,
      currentEngineState: currentMetrics?.currentEngineState ?? null,
      currentMetrics: currentMetrics?.metrics ?? null,
    };
  }

  public async startNextStrategy(
    env: Env,
    options?: { force?: boolean },
  ): Promise<StrategyRecord | null> {
    const currentlyRunning = await this.reconcileActiveStrategy(env);
    if (currentlyRunning) {
      return currentlyRunning;
    }

    const grouped = await getAllStrategies(env);
    if (grouped.paused && !options?.force) {
      return null;
    }

    const pendingRecord = await getNextPendingStrategy(env);
    if (!pendingRecord) {
      return null;
    }

    const runningRecord = await updateStrategyStatus(
      env,
      pendingRecord.versionId,
      StrategyStatus.Running,
    );
    if (!runningRecord) {
      throw new ApiError(
        500,
        `Failed to promote strategy ${pendingRecord.versionId} to running`,
      );
    }

    const engineStub = this.resolveStrategyEngineStub(env, runningRecord);

    try {
      await this.fetchStrategyEngineJson(engineStub, '/start', {
        method: 'POST',
        body: JSON.stringify(this.buildConfigureRequest(runningRecord)),
      });
      return runningRecord;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const report = this.buildExecutionReport(runningRecord, null, {
        endTime: Date.now(),
        abortReason: `Failed to start strategy engine: ${message}`,
      });
      await updateStrategyStatus(
        env,
        runningRecord.versionId,
        StrategyStatus.Failed,
        report,
      );
      throw error instanceof ApiError
        ? error
        : new ApiError(500, `Failed to start strategy ${runningRecord.versionId}: ${message}`);
    }
  }

  public async completeCurrentStrategy(
    env: Env,
    metricsResponse?: StrategyEngineDurableObjectMetricsResponse,
  ): Promise<StrategyRecord | null> {
    const activeRecord = await getActiveStrategy(env);
    if (!activeRecord) {
      return null;
    }

    const versionId = activeRecord.versionId;
    const currentMetricsResponse =
      metricsResponse ?? (await this.fetchCurrentMetricsResponse(env, activeRecord));
    const report = this.buildExecutionReport(activeRecord, currentMetricsResponse?.metrics ?? null, {
      endTime: currentMetricsResponse?.metrics.endTime ?? Date.now(),
    });
    const completedRecord = await updateStrategyStatus(
      env,
      versionId,
      StrategyStatus.Completed,
      report,
    );

    await this.startNextStrategy(env);
    return completedRecord;
  }

  public async abortCurrentStrategy(
    env: Env,
    reason: string,
  ): Promise<StrategyRecord | null> {
    const activeRecord = await getActiveStrategy(env);
    if (!activeRecord) {
      return null;
    }

    const engineStub = this.resolveStrategyEngineStub(env, activeRecord);
    const abortResponse = await this.fetchStrategyEngineJson<{
      ok: boolean;
      status: StrategyEngineDurableObjectStatus;
      report: ExecutionReport;
    }>(engineStub, '/abort', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    const failedRecord = await updateStrategyStatus(
      env,
      activeRecord.versionId,
      StrategyStatus.Aborted,
      abortResponse.report,
    );
    return failedRecord;
  }

  public async getCurrentMetrics(
    env: Env,
  ): Promise<{
    status: StrategyEngineDurableObjectStatus;
    metrics: StrategyEngineMetrics;
    currentEngineState: string | null;
    nextExecutionTime: number | null;
  } | null> {
    const activeRecord = await getActiveStrategy(env);
    if (!activeRecord) {
      return null;
    }

    const response = await this.fetchCurrentMetricsResponse(env, activeRecord);
    if (!response) {
      return null;
    }

    if (response.status === 'completed') {
      await this.completeCurrentStrategy(env, response);
      return null;
    }

    if (response.status === 'aborted') {
      await updateStrategyStatus(
        env,
        activeRecord.versionId,
        StrategyStatus.Aborted,
        this.buildExecutionReport(activeRecord, response.metrics, {
          endTime: response.metrics.endTime ?? Date.now(),
          abortReason: 'Strategy aborted by durable object',
        }),
      );
      return null;
    }

    return {
      status: response.status,
      currentEngineState: response.currentEngineState,
      nextExecutionTime: response.nextExecutionTime,
      metrics: this.mapMetricsResponse(response.metrics),
    };
  }

  private async reconcileActiveStrategy(env: Env): Promise<StrategyRecord | null> {
    const activeRecord = await getActiveStrategy(env);
    if (!activeRecord) {
      return null;
    }
    await this.getCurrentMetrics(env);
    return getActiveStrategy(env);
  }

  private buildExecutionReport(
    activeRecord: StrategyRecord | null,
    metrics: StrategyEngineDurableObjectMetrics | null,
    options: {
      endTime: number;
      abortReason?: string;
    },
  ): ExecutionReport {
    return {
      actualTotalVolume: metrics?.actualTotalVolumeUsd ?? 0,
      actualNetInflow: metrics?.actualNetInflowUsd ?? 0,
      tacticsTriggeredCount: metrics?.tacticsTriggeredCount ?? 0,
      pnl: metrics?.actualNetInflowUsd ?? 0,
      startTime:
        metrics?.startTime ??
        activeRecord?.startedAt ??
        activeRecord?.updatedAt ??
        options.endTime,
      endTime: options.endTime,
      ...(options.abortReason
        ? {
            abortReason: options.abortReason,
          }
        : {}),
    };
  }

  private buildConfigureRequest(
    record: StrategyRecord,
  ): StrategyEngineDurableObjectConfigureRequest {
    if (record.config.strategyVersionId == null) {
      throw new ApiError(
        500,
        `Queued strategy ${record.versionId} is missing strategyVersionId`,
      );
    }
    return {
      userId: record.config.userId,
      versionId: record.config.strategyVersionId,
      strategyDocument: record.config.document,
    };
  }

  private resolveStrategyEngineStub(
    env: Env,
    record: StrategyRecord,
  ): DurableObjectStub {
    const stubId = env.STRATEGY_ENGINE_DO.idFromName(
      strategyEngineDurableObjectNameFor(
        record.config.userId,
        record.config.contractAddress,
      ),
    );
    return env.STRATEGY_ENGINE_DO.get(stubId);
  }

  private async fetchCurrentMetricsResponse(
    env: Env,
    record: StrategyRecord,
  ): Promise<StrategyEngineDurableObjectMetricsResponse | null> {
    const stub = this.resolveStrategyEngineStub(env, record);
    return this.fetchStrategyEngineJson<StrategyEngineDurableObjectMetricsResponse>(
      stub,
      '/metrics',
      { method: 'GET' },
    );
  }

  private mapMetricsResponse(
    metrics: StrategyEngineDurableObjectMetrics,
  ): StrategyEngineMetrics {
    return {
      actualTotalVolume: metrics.actualTotalVolumeUsd,
      actualNetInflow: metrics.actualNetInflowUsd,
      tacticsTriggeredCount: metrics.tacticsTriggeredCount,
      pnl: metrics.actualNetInflowUsd,
      startTime: metrics.startTime,
    };
  }

  private async fetchStrategyEngineJson<T>(
    stub: DurableObjectStub,
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await stub.fetch(`https://strategy-engine${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      ...init,
    });
    if (!response.ok) {
      const message = await response.text();
      throw new ApiError(
        response.status,
        message || `Strategy engine durable object request failed for ${path}`,
      );
    }
    return response.json<T>();
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

