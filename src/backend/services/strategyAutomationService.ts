import { ApiError } from '../errors';
import {
  buildJupiterSwapTransactionWithTrace,
  fetchJupiterTokenMetadata,
  fetchJupiterSwapQuote,
} from '../jupiter';
import {
  strategyEngineDurableObjectNameFor,
  type StrategyEngineDurableObjectConfigureRequest,
  type StrategyEngineDurableObjectDebugSimulateRequest,
  type StrategyEngineDurableObjectMetrics,
  type StrategyEngineDurableObjectStatus,
} from '../strategy/strategyEngineDO';
import { StrategyStatus } from '../strategy/types';
import type {
  ExecutionReport,
  StrategyRecord,
  StrategyReviewedPlan,
  StrategyExecutionTaskPayload,
  StrategyVersionRecord,
} from '../strategy/types';
import { nowTs } from '../time';
import {
  accountCapabilityMatchesMintPair,
  dbAddAuditLog,
  dbGetManagedAccountByAddress,
  dbGetManagedAccountById,
  dbLoadManagedKeypairBytes,
  dbLoadManagedKeypairBytesByAccountId,
  dbLoadSettings,
  getAvailableAccount,
  dbListManagedAccountAddresses,
} from '../userStore';
import { dbGetLatestTokenMarketSnapshot, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import type { Env } from '../workerShared';
import {
  executeTradeTask,
  fetchSolanaMintDecimals,
  normalizePubkey,
  registerTradeTaskExecutor,
  readNonEmptyString,
  type StrategyTaskExecutionContext,
  type StrategyTaskExecutionResult,
} from '../workerCore';
import { SOLANA_USDC_MINT } from '../workerShared';
import { dbComputeManagedTradeLogProfit, dbGetLatestHistoricalSetupId } from './historyMetricsService';
import { sendSolanaTransaction, signSolanaTransaction } from './solanaTradeService';
import {
  addStrategy,
  buildStrategyRecordConfigFromVersion,
  createStrategyExecutionRunId,
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

interface StrategyEngineDurableObjectDebugSimulateResponse {
  ok: boolean;
  simulated: boolean;
  state: StrategyEngineDurableObjectMetricsResponse;
}

interface ResolvedExecutionPair {
  targetMint: string;
  baseMint: string;
  quoteMint: string;
}

interface ResolvedExecutionDecimals {
  baseTokenDecimals: number;
  quoteTokenDecimals: number;
}

interface TradeExecutionTrace {
  executionMode: 'default' | 'controlled_jupiter_acceptance';
  task: StrategyExecutionTaskPayload;
  walletAddress: string;
  accountId: number | null;
  pair: {
    baseMint: string;
    quoteMint: string;
  };
  decimals: {
    baseTokenDecimals: number;
    quoteTokenDecimals: number;
  };
  accountCapability: {
    requestBaseMint: string | null;
    requestQuoteMint: string | null;
  };
  quoteResponse?: unknown;
  swapRequestPayload?: unknown;
  swapTransactionBase64?: string;
  txSignature?: string;
  failureReason?: string;
}

function isControlledExecutionMode(
  task: StrategyExecutionTaskPayload,
): boolean {
  return task.executionMode === 'controlled_jupiter_acceptance';
}

function assertManagedAccountCapabilityMatchesTaskPair(
  account: {
    capabilityBaseMint?: string | null;
    capabilityQuoteMint?: string | null;
  },
  pair: ResolvedExecutionPair,
  task: StrategyExecutionTaskPayload,
): void {
  const hasStoredCapability =
    (account.capabilityBaseMint?.trim().length ?? 0) > 0 &&
    (account.capabilityQuoteMint?.trim().length ?? 0) > 0;
  if (isControlledExecutionMode(task) && !hasStoredCapability) {
    throw new ApiError(
      409,
      'Controlled execution requires the managed account to have a stored capability baseMint/quoteMint pair',
    );
  }
  if (!accountCapabilityMatchesMintPair(account, pair.baseMint, pair.quoteMint)) {
    throw new ApiError(
      409,
      'Managed account capability mint pair does not match the task baseMint/quoteMint pair',
    );
  }
}

export interface StrategyQueueSnapshot {
  active: StrategyRecord | null;
  pending: StrategyRecord[];
  history: StrategyRecord[];
  paused: boolean;
  currentEngineState: string | null;
  currentMetrics: StrategyEngineMetrics | null;
}

function validateTaskTokenDecimals(
  value: number | null | undefined,
  label: string,
): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new ApiError(400, `${label} must be an integer between 0 and 255`);
  }
  return value;
}

function resolveExecutionPair(
  task: StrategyExecutionTaskPayload,
  settingsContractAddress: string,
): ResolvedExecutionPair {
  const explicitBaseMint = readNonEmptyString(task.baseMint);
  const explicitQuoteMint = readNonEmptyString(task.quoteMint);
  const explicitBaseTokenAddress = readNonEmptyString(task.baseTokenAddress);

  const baseMint = normalizePubkey(
    explicitBaseMint ?? explicitBaseTokenAddress ?? settingsContractAddress,
  );
  const quoteMint = normalizePubkey(explicitQuoteMint ?? SOLANA_USDC_MINT);
  if (baseMint === quoteMint) {
    throw new ApiError(400, 'baseMint and quoteMint must be different Solana mint addresses');
  }
  if (explicitBaseTokenAddress && normalizePubkey(explicitBaseTokenAddress) !== baseMint) {
    throw new ApiError(400, 'baseTokenAddress must match baseMint when both are provided');
  }

  return {
    targetMint: baseMint,
    baseMint,
    quoteMint,
  };
}

async function resolveMintDecimals(
  env: Env,
  userId: number,
  mint: string,
  fallbackDecimals: number | null,
): Promise<number> {
  if (fallbackDecimals != null) {
    return fallbackDecimals;
  }

  const tokenRecord = await env.TRADINGBOT_DB
    .prepare(
      'SELECT decimals FROM tradable_tokens WHERE network = ?1 AND base_token_address = ?2 LIMIT 1',
    )
    .bind('solana', mint)
    .first<{ decimals: number | null }>();
  if (tokenRecord?.decimals != null) {
    return tokenRecord.decimals;
  }

  const jupiterMeta = await fetchJupiterTokenMetadata(mint);
  if (jupiterMeta?.decimals != null) {
    return jupiterMeta.decimals;
  }

  const rpcUrls = await dbResolveSolanaRpcUrls(
    env.TRADINGBOT_DB,
    userId,
    env.SOLANA_RPC_URL,
  );
  return fetchSolanaMintDecimals(rpcUrls, mint);
}

async function resolveAndValidateExecutionDecimals(
  env: Env,
  userId: number,
  pair: ResolvedExecutionPair,
  task: StrategyExecutionTaskPayload,
): Promise<ResolvedExecutionDecimals> {
  const requestedBaseDecimals = validateTaskTokenDecimals(
    task.baseTokenDecimals,
    'baseTokenDecimals',
  );
  const requestedQuoteDecimals = validateTaskTokenDecimals(
    task.quoteTokenDecimals,
    'quoteTokenDecimals',
  );

  const [baseTokenDecimals, quoteTokenDecimals] = await Promise.all([
    resolveMintDecimals(env, userId, pair.baseMint, requestedBaseDecimals),
    resolveMintDecimals(
      env,
      userId,
      pair.quoteMint,
      requestedQuoteDecimals ?? (pair.quoteMint === SOLANA_USDC_MINT ? 6 : null),
    ),
  ]);

  validateTaskTokenDecimals(baseTokenDecimals, 'resolved base token decimals');
  validateTaskTokenDecimals(quoteTokenDecimals, 'resolved quote token decimals');

  if (requestedBaseDecimals != null && requestedBaseDecimals !== baseTokenDecimals) {
    throw new ApiError(
      409,
      `baseTokenDecimals ${requestedBaseDecimals} does not match resolved mint decimals ${baseTokenDecimals}`,
    );
  }
  if (requestedQuoteDecimals != null && requestedQuoteDecimals !== quoteTokenDecimals) {
    throw new ApiError(
      409,
      `quoteTokenDecimals ${requestedQuoteDecimals} does not match resolved mint decimals ${quoteTokenDecimals}`,
    );
  }

  return {
    baseTokenDecimals,
    quoteTokenDecimals,
  };
}

async function updateTradeLogExecutionTrace(
  db: D1Database,
  tradeLogId: number,
  trace: TradeExecutionTrace,
): Promise<void> {
  await db
    .prepare(
      `UPDATE trade_logs
       SET execution_trace_json = ?2, updated_at = ?3
       WHERE id = ?1`,
    )
    .bind(tradeLogId, JSON.stringify(trace), nowTs())
    .run();
}

export class StrategyAutomationService {
  public async consumeExecutionTask(
    task: StrategyExecutionTaskPayload,
    context: StrategyTaskExecutionContext,
  ): Promise<StrategyTaskExecutionResult> {
    return executeTradeTask(task, context);
  }

  public async isBusy(env: Env): Promise<boolean> {
    return (await getActiveStrategy(env)) != null;
  }

  public async enqueueStrategyVersion(
    env: Env,
    userId: number,
    version: StrategyVersionRecord,
    reviewedPlan?: StrategyReviewedPlan,
  ): Promise<StrategyRecord> {
    const existing = await findStrategyRecordByStrategyVersionId(env, version.id);
    if (
      existing?.status === StrategyStatus.Pending ||
      existing?.status === StrategyStatus.Running ||
      existing?.status === StrategyStatus.Paused
    ) {
      return existing;
    }
    return addStrategy(
      env,
      createStrategyExecutionRunId(version.id),
      {
        ...buildStrategyRecordConfigFromVersion(version, userId),
        reviewedPlan,
      },
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
    await this.attachRunProfit(env, activeRecord, report);
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
      await this.attachRunProfit(env, activeRecord, abortResponse.report),
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
      const report = this.buildExecutionReport(activeRecord, response.metrics, {
        endTime: response.metrics.endTime ?? Date.now(),
        abortReason: 'Strategy aborted by durable object',
      });
      await updateStrategyStatus(
        env,
        activeRecord.versionId,
        StrategyStatus.Aborted,
        await this.attachRunProfit(env, activeRecord, report),
      );
      return null;
    }

    return {
      status: response.status,
      currentEngineState: response.currentEngineState,
      nextExecutionTime: response.nextExecutionTime,
      metrics: await this.mapMetricsResponse(env, activeRecord, response.metrics),
    };
  }

  public async simulateActiveStrategy(
    env: Env,
    request: StrategyEngineDurableObjectDebugSimulateRequest,
  ): Promise<{
    record: StrategyRecord;
    state: StrategyEngineDurableObjectMetricsResponse;
  } | null> {
    const activeRecord = await getActiveStrategy(env);
    if (!activeRecord) {
      return null;
    }

    const stub = this.resolveStrategyEngineStub(env, activeRecord);
    const response = await this.fetchStrategyEngineJson<StrategyEngineDurableObjectDebugSimulateResponse>(
      stub,
      '/debug/simulate',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
    );

    return {
      record: activeRecord,
      state: response.state,
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
      pnl: 0,
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
      runId: record.versionId,
      versionId: record.config.strategyVersionId,
      strategyDocument: record.config.document,
      reviewedPlan: record.config.reviewedPlan,
    };
  }

  private resolveStrategyEngineStub(
    env: Env,
    record: StrategyRecord,
  ): DurableObjectStub {
    const stubId = env.STRATEGY_ENGINE_DO.idFromName(
      strategyEngineDurableObjectNameFor(
        record.config.userId,
        record.config.baseTokenAddress,
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

  private async attachRunProfit(
    env: Env,
    record: StrategyRecord,
    report: ExecutionReport,
  ): Promise<ExecutionReport> {
    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      record.config.baseTokenAddress,
      record.config.quoteTokenAddress,
    );
    const snapshot = tokenId
      ? await dbGetLatestTokenMarketSnapshot(env.TRADINGBOT_DB, tokenId)
      : null;
    const profit = await dbComputeManagedTradeLogProfit(
      env.TRADINGBOT_DB,
      record.config.userId,
      record.config.baseTokenAddress,
      snapshot?.priceUsd ?? null,
      record.versionId,
    );
    return {
      ...report,
      pnl: profit.totalPnlUsdc,
      realizedPnl: profit.realizedPnlUsdc,
      unrealizedPnl: profit.unrealizedPnlUsdc,
    };
  }

  private async mapMetricsResponse(
    env: Env,
    record: StrategyRecord,
    metrics: StrategyEngineDurableObjectMetrics,
  ): Promise<StrategyEngineMetrics> {
    const report = await this.attachRunProfit(env, record, {
      actualTotalVolume: metrics.actualTotalVolumeUsd,
      actualNetInflow: metrics.actualNetInflowUsd,
      tacticsTriggeredCount: metrics.tacticsTriggeredCount,
      pnl: 0,
      startTime: metrics.startTime,
      endTime: metrics.endTime ?? Date.now(),
    });
    return report;
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
  const pair = resolveExecutionPair(task, settings.baseTokenAddress);
  const targetMint = pair.targetMint;
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

  if (task.requireExplicitAccount && resolvedAccountId == null && !resolvedSignerAddress) {
    throw new ApiError(
      400,
      'controlled execution requires exactly one explicit managed wallet via accountId or walletAddress',
    );
  }

  if (resolvedAccountId != null) {
    const managedAccount = await dbGetManagedAccountById(
      env.TRADINGBOT_DB,
      userId,
      resolvedAccountId,
    );
    assertManagedAccountCapabilityMatchesTaskPair(managedAccount, pair, task);
    resolvedSignerAddress = managedAccount.address;
  }

  if (resolvedSignerAddress) {
    const managedAccount = await dbGetManagedAccountByAddress(
      env.TRADINGBOT_DB,
      userId,
      resolvedSignerAddress,
    );
    assertManagedAccountCapabilityMatchesTaskPair(managedAccount, pair, task);
    resolvedAccountId ??= managedAccount.id;
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
        pair: {
          baseMint: pair.baseMint,
          quoteMint: pair.quoteMint,
        },
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
    const managed = await dbListManagedAccountAddresses(env.TRADINGBOT_DB, userId, {
      activeOnly: true,
    });
    if (managed.length === 0) {
      throw new ApiError(400, 'No enabled managed wallet available — import and enable a private key first');
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

  const { baseTokenDecimals, quoteTokenDecimals } =
    await resolveAndValidateExecutionDecimals(env, userId, pair, task);

  let inputMint: string;
  let outputMint: string;
  let amountAtomicUnits: string;

  if (action === 'BUY') {
    inputMint = pair.quoteMint;
    outputMint = pair.baseMint;
    amountAtomicUnits = String(
      Math.round(task.requestedAmount * 10 ** quoteTokenDecimals),
    );
  } else {
    inputMint = pair.baseMint;
    outputMint = pair.quoteMint;
    amountAtomicUnits = String(
      Math.round(task.requestedAmount * 10 ** baseTokenDecimals),
    );
  }

  const slippageBps = Math.round(settings.maxSlippage * 100);
  const tokenId = await dbResolveTradableTokenId(env.TRADINGBOT_DB, targetMint);
  const setupId = await dbGetLatestHistoricalSetupId(env.TRADINGBOT_DB, userId);
  const executionTrace: TradeExecutionTrace = {
    executionMode: task.executionMode ?? 'default',
    task,
    walletAddress: resolvedSignerAddress,
    accountId: resolvedAccountId,
    pair: {
      baseMint: pair.baseMint,
      quoteMint: pair.quoteMint,
    },
    decimals: {
      baseTokenDecimals,
      quoteTokenDecimals,
    },
    accountCapability: {
      requestBaseMint: task.accountCapabilityBaseMint ?? null,
      requestQuoteMint: task.accountCapabilityQuoteMint ?? null,
    },
  };

  let tradeLogId: number | null = null;
  if (tokenId) {
    const logRow = await env.TRADINGBOT_DB
      .prepare(
        `INSERT INTO trade_logs (
           token_id, setup_id, wallet_address, action,
           requested_amount, execution_trace_json, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PENDING', ?7, ?7)
         RETURNING id`,
      )
      .bind(
        tokenId,
        setupId,
        resolvedSignerAddress,
        action,
        task.requestedAmount,
        JSON.stringify(executionTrace),
        nowTs(),
      )
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
    executionTrace.quoteResponse = quote;
    const swapBuild = await buildJupiterSwapTransactionWithTrace(
      quote,
      resolvedSignerAddress,
    );
    executionTrace.swapRequestPayload = swapBuild.requestPayload;
    executionTrace.swapTransactionBase64 = swapBuild.swapTransactionBase64;
    if (tradeLogId != null) {
      await updateTradeLogExecutionTrace(env.TRADINGBOT_DB, tradeLogId, executionTrace);
    }

    const signedTxBytes = signSolanaTransaction(
      swapBuild.swapTransactionBytes,
      keypairBytes,
    );
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      userId,
      env.SOLANA_RPC_URL,
    );
    const txSignature = await sendSolanaTransaction(rpcUrls, signedTxBytes);
    executionTrace.txSignature = txSignature;

    const executedAmountRaw = Number(action === 'BUY' ? quote.outAmount : quote.inAmount);
    const executedDecimals = action === 'BUY' ? baseTokenDecimals : quoteTokenDecimals;
    const executedAmount = executedAmountRaw / 10 ** executedDecimals;

    if (tradeLogId != null) {
      await env.TRADINGBOT_DB
        .prepare(
          `UPDATE trade_logs
           SET status = 'PENDING', tx_signature = ?2, executed_amount = ?3, execution_trace_json = ?4, updated_at = ?5
           WHERE id = ?1`,
        )
        .bind(
          tradeLogId,
          txSignature,
          executedAmount,
          JSON.stringify(executionTrace),
          nowTs(),
        )
        .run();
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      userId,
      'trade.submitted',
      txSignature,
      `${action} ${task.requestedAmount} (${action === 'BUY' ? `${pair.quoteMint} → ${targetMint}` : `${targetMint} → ${pair.quoteMint}`}) via Jupiter. Tx: ${txSignature}`,
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
    executionTrace.failureReason = errorMessage;
    if (tradeLogId != null) {
      await env.TRADINGBOT_DB
        .prepare(
          `UPDATE trade_logs
           SET status = 'FAILED', error_message = ?2, execution_trace_json = ?3, updated_at = ?4
           WHERE id = ?1`,
        )
        .bind(
          tradeLogId,
          errorMessage,
          JSON.stringify(executionTrace),
          nowTs(),
        )
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

