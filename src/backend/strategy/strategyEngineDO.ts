import { ApiError } from '../errors';
import { fetchJupiterTokenMetadata, fetchJupiterTokenPrice } from '../jupiter';
import { dbFindTradableTokenByPair, dbGetLatestTokenMarketSnapshot, dbResolveTradableTokenId } from '../tokenStore';
import { fetchSolanaMintDecimals, normalizePubkey } from '../workerCore';
import { SOLANA_USDC_MINT, type Env } from '../workerShared';
import { buildRandomizedTwapPlan, type EngineState, type MacroObjective } from './engine';
import { normalizeStrategyDocument } from './migrations';
import type { ExecutionReport, StrategyExecutionConfig, StrategyVersionDocument } from './types';
import type { ExternalTradeEvent } from './triggers';
import { initializeAllSchemas } from '../services/dbSetup';
import { executeSwap } from '../services/jupiterSwapService';
import { getActiveAccounts } from '../services/accountPoolService';
import { allocateVolumeAcrossAccountCaps } from '../services/tradeMath';
import { analyzeTradeDirection } from '../services/webhookParser';
import { listManagedAccountsWithBalances } from '../userStore';

const STORAGE_KEY = 'strategy-engine-state';
const MAX_DEDUPED_TX_HASHES = 256;
const DEFAULT_STRATEGY_TASK_BASE_VOLUME_USD = 300;
const DEFAULT_DISTRIBUTION_CHUNK_COUNT = 3;
const DEFAULT_DISTRIBUTION_DELAY_JITTER_MS = 2_000;
const INITIAL_EXECUTION_DELAY_MS = 1_000;

export type StrategyEngineDurableObjectStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'aborted';

export interface StrategyEngineDurableObjectMetrics {
  actualTotalVolumeUsd: number;
  actualNetInflowUsd: number;
  tacticsTriggeredCount: number;
  startTime: number;
  endTime: number | null;
}

export interface StrategyEngineDurableObjectConfig {
  userId: number;
  versionId: number;
  baseTokenAddress: string;
  macroObjective: MacroObjective;
  targetTotalVolumeUsd: number;
  baseOrderCount: number;
  baseDurationMs: number;
  distributionChunkCount: number;
  distributionChunkDelayJitterMs: number;
  triggerThresholdUsd: number;
  execution: StrategyExecutionConfig;
  strategyDocument: StrategyVersionDocument;
}

export interface StrategyEngineDurableObjectTask {
  id: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  scheduledAt: number;
  source: 'base' | 'tactic';
  metadata?: Record<string, unknown>;
}

export interface StrategyEngineDurableObjectConfigureRequest {
  userId: number;
  versionId: number;
  strategyDocument: StrategyVersionDocument;
}

export interface StrategyEngineDurableObjectEventRequest
  extends StrategyEngineDurableObjectConfigureRequest {
  event: ExternalTradeEvent;
}

export interface StrategyEngineDurableObjectDebugSimulateRequest {
  action: 'hold' | 'fill' | 'complete';
  executedVolumeUsd?: number;
  actualNetInflowUsd?: number;
  tacticsTriggeredCount?: number;
  clearPendingTasks?: boolean;
}

export interface PersistedStrategyEngineState {
  config: StrategyEngineDurableObjectConfig | null;
  status: StrategyEngineDurableObjectStatus;
  metrics: StrategyEngineDurableObjectMetrics;
  currentEngineState: EngineState | null;
  pendingTasks: StrategyEngineDurableObjectTask[];
  dedupedTxHashes: string[];
  allocationRotationOffsets: Record<'buy' | 'sell', number>;
  updatedAt: number;
}

function createEmptyAllocationRotationOffsets(): Record<'buy' | 'sell', number> {
  return {
    buy: 0,
    sell: 0,
  };
}

function buildDurableObjectName(userId: number, baseTokenAddress: string): string {
  return `${userId}:${baseTokenAddress}`;
}

function buildInitialStateForObjective(objective: MacroObjective): EngineState {
  switch (objective) {
    case 'shakeout':
      return 'BUILDING_TREND';
    case 'distribution':
      return 'DISTRIBUTING';
    case 'accumulation':
    default:
      return 'ACCUMULATING';
  }
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

function createTaskId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `strategy-do-task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createEmptyMetrics(startTime = 0): StrategyEngineDurableObjectMetrics {
  return {
    actualTotalVolumeUsd: 0,
    actualNetInflowUsd: 0,
    tacticsTriggeredCount: 0,
    startTime,
    endTime: null,
  };
}

function createIdleState(): PersistedStrategyEngineState {
  return {
    config: null,
    status: 'idle',
    metrics: createEmptyMetrics(0),
    currentEngineState: null,
    pendingTasks: [],
    dedupedTxHashes: [],
    allocationRotationOffsets: createEmptyAllocationRotationOffsets(),
    updatedAt: Date.now(),
  };
}

function clampPositiveNumber(value: number, fallback = 0): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function buildExecutionReportFromMetrics(
  metrics: StrategyEngineDurableObjectMetrics,
  abortReason?: string,
): ExecutionReport {
  return {
    actualTotalVolume: metrics.actualTotalVolumeUsd,
    actualNetInflow: metrics.actualNetInflowUsd,
    tacticsTriggeredCount: metrics.tacticsTriggeredCount,
    pnl: metrics.actualNetInflowUsd,
    startTime: metrics.startTime,
    endTime: metrics.endTime ?? Date.now(),
    ...(abortReason ? { abortReason } : {}),
  };
}

export function strategyEngineDurableObjectNameFor(
  userId: number,
  baseTokenAddress: string,
): string {
  return buildDurableObjectName(userId, baseTokenAddress);
}

export class StrategyEngineDurableObject {
  private persistedState: PersistedStrategyEngineState = createIdleState();

  private hydrated = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
  }

  public async fetch(request: Request): Promise<Response> {
    await initializeAllSchemas(this.env);
    const url = new URL(request.url);
    await this.ensureHydrated();

    if (request.method === 'GET' && (url.pathname === '/metrics' || url.pathname === '/state')) {
      return Response.json(this.buildMetricsResponse());
    }

    if (request.method === 'POST' && url.pathname === '/configure') {
      const body = await request.json<StrategyEngineDurableObjectConfigureRequest>();
      await this.configure(body);
      return Response.json({ ok: true, configured: true, state: this.buildMetricsResponse() });
    }

    if (request.method === 'POST' && url.pathname === '/start') {
      const body = await request.json<StrategyEngineDurableObjectConfigureRequest>();
      await this.start(body);
      return Response.json({ ok: true, started: true, state: this.buildMetricsResponse() });
    }

    if (request.method === 'POST' && url.pathname === '/abort') {
      const body = await this.readOptionalJsonObject(request);
      const reason =
        typeof body?.reason === 'string' && body.reason.trim().length > 0
          ? body.reason.trim()
          : 'Manual user abort';
      const report = await this.abort(reason);
      return Response.json({ ok: true, status: this.persistedState.status, report });
    }

    if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/event')) {
      const body = await request.json<StrategyEngineDurableObjectEventRequest>();
      await this.configure(body);
      const duplicate = await this.handleWebhookEvent(body.event);
      return Response.json({
        ok: true,
        duplicate,
        status: this.persistedState.status,
        metrics: this.persistedState.metrics,
      });
    }

    if (request.method === 'POST' && url.pathname === '/debug/simulate') {
      const body = await request.json<StrategyEngineDurableObjectDebugSimulateRequest>();
      await this.debugSimulate(body);
      return Response.json({ ok: true, simulated: true, state: this.buildMetricsResponse() });
    }

    if (request.method === 'POST' && url.pathname === '/clear') {
      await this.clear();
      return Response.json({ ok: true, cleared: true, state: this.buildMetricsResponse() });
    }

    return new Response('Not found', { status: 404 });
  }

  public async alarm(): Promise<void> {
    await initializeAllSchemas(this.env);
    await this.ensureHydrated();
    const state = this.persistedState;
    const config = state.config;
    if (!config || state.status !== 'running') {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    if (state.metrics.actualTotalVolumeUsd >= config.targetTotalVolumeUsd) {
      await this.markCompleted();
      return;
    }

    if (state.pendingTasks.length === 0) {
      this.ensureBasePlanIfNeeded(Date.now());
    }

    const now = Date.now();
    const nextTask = this.popNextDueTask(now);
    if (!nextTask) {
      await this.persistState();
      return;
    }

    try {
      const execution = await this.executeDueTask(nextTask);
      if (execution.executedVolumeUsd > 0) {
        this.applyExecutedTask(nextTask, execution.executedVolumeUsd);
      }
      if (execution.retryVolumeUsd > 0) {
        this.scheduleTaskRetry(
          {
            ...nextTask,
            amountUsd: execution.retryVolumeUsd,
          },
          now,
        );
      }
    } catch (error: unknown) {
      if (
        error instanceof ApiError &&
        error.message === 'No active managed accounts available for strategy execution'
      ) {
        await this.abort(error.message);
        return;
      }
      console.error(
        `[StrategyEngineDO] Swap execution failed for ${nextTask.side} ${nextTask.amountUsd} on ${config.baseTokenAddress}:`,
        error,
      );
      this.scheduleTaskRetry(nextTask, now);
      await this.persistState();
      return;
    }

    if (state.metrics.actualTotalVolumeUsd >= config.targetTotalVolumeUsd) {
      await this.markCompleted();
      return;
    }

    if (state.pendingTasks.length === 0) {
      this.ensureBasePlanIfNeeded(Date.now());
    }

    await this.persistState();
  }

  private async start(input: StrategyEngineDurableObjectConfigureRequest): Promise<void> {
    await this.configure(input);
    const state = this.persistedState;
    if (!state.config) {
      throw new ApiError(409, 'Strategy engine durable object could not be configured');
    }
    const startTime = Date.now();
    const planStartTime = startTime + INITIAL_EXECUTION_DELAY_MS;
    state.status = 'running';
    state.metrics = createEmptyMetrics(startTime);
    state.currentEngineState = buildInitialStateForObjective(state.config.macroObjective);
    state.pendingTasks = [];
    state.dedupedTxHashes = [];
    state.allocationRotationOffsets = createEmptyAllocationRotationOffsets();
    this.ensureBasePlanIfNeeded(planStartTime);
    await this.persistState();
    await this.ctx.storage.setAlarm(planStartTime);
  }

  private async abort(reason: string): Promise<ExecutionReport> {
    const now = Date.now();
    this.persistedState.status = 'aborted';
    this.persistedState.metrics.endTime = now;
    this.persistedState.pendingTasks = [];
    await this.ctx.storage.deleteAlarm();
    await this.persistState({ scheduleAlarm: false });
    return buildExecutionReportFromMetrics(this.persistedState.metrics, reason);
  }

  private async clear(): Promise<void> {
    this.persistedState = createIdleState();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put(STORAGE_KEY, this.persistedState);
  }

  private async configure(
    input: StrategyEngineDurableObjectConfigureRequest,
  ): Promise<void> {
    const normalizedDocument = normalizeStrategyDocument(input.strategyDocument);
    const baseTokenAddress = normalizePubkey(normalizedDocument.parameters.baseTokenAddress);
    const nextConfig: StrategyEngineDurableObjectConfig = {
      userId: input.userId,
      versionId: input.versionId,
      baseTokenAddress,
      macroObjective: normalizedDocument.execution.macroObjective,
      targetTotalVolumeUsd: clampPositiveNumber(
        normalizedDocument.riskControls.maxPositionUsd ?? normalizedDocument.targets.volumeUsdMin,
        DEFAULT_STRATEGY_TASK_BASE_VOLUME_USD,
      ),
      baseOrderCount: Math.max(
        1,
        Math.min(12, Math.max(3, normalizedDocument.riskControls.maxConcurrentOrders * 3)),
      ),
      baseDurationMs: parseTimeRangeTargetToDurationMs(
        normalizedDocument.parameters.timeRangeTarget,
      ),
      distributionChunkCount: DEFAULT_DISTRIBUTION_CHUNK_COUNT,
      distributionChunkDelayJitterMs: DEFAULT_DISTRIBUTION_DELAY_JITTER_MS,
      triggerThresholdUsd: Math.max(0, normalizedDocument.triggers.triggerThresholdUsd),
      execution: normalizedDocument.execution,
      strategyDocument: normalizedDocument,
    };

    const previousConfig = this.persistedState.config;
    const configChanged =
      !previousConfig ||
      previousConfig.versionId !== nextConfig.versionId ||
      previousConfig.baseTokenAddress !== nextConfig.baseTokenAddress ||
      previousConfig.macroObjective !== nextConfig.macroObjective;

    this.persistedState.config = nextConfig;
    if (configChanged && this.persistedState.status !== 'running') {
      this.persistedState.currentEngineState = buildInitialStateForObjective(nextConfig.macroObjective);
      this.persistedState.pendingTasks = [];
      this.persistedState.dedupedTxHashes = [];
      this.persistedState.allocationRotationOffsets = createEmptyAllocationRotationOffsets();
    }
    await this.persistState({ scheduleAlarm: this.persistedState.status === 'running' });
  }

  private async handleWebhookEvent(event: ExternalTradeEvent): Promise<boolean> {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }
    if (this.persistedState.status !== 'running') {
      return false;
    }

    const normalizedContractAddress = normalizePubkey(event.contractAddress);
    if (normalizedContractAddress !== config.baseTokenAddress) {
      return false;
    }

    if (this.persistedState.dedupedTxHashes.includes(event.txHash)) {
      return true;
    }
    this.persistedState.dedupedTxHashes = [
      ...this.persistedState.dedupedTxHashes,
      event.txHash,
    ].slice(-MAX_DEDUPED_TX_HASHES);

    const amountUsd = clampPositiveNumber(event.amount, 0);
    if (amountUsd < config.triggerThresholdUsd) {
      await this.persistState();
      return false;
    }

    let payloadDirection: 'BUY' | 'SELL' | 'UNKNOWN' = 'UNKNOWN';
    if (event.payloadJson) {
      try {
        const trackedPair = await dbFindTradableTokenByPair(
          this.env.TRADINGBOT_DB,
          config.strategyDocument.parameters.baseTokenAddress,
          config.strategyDocument.parameters.quoteTokenAddress,
        );
        payloadDirection = analyzeTradeDirection(
          JSON.parse(event.payloadJson),
          {
            baseTokenAddress: config.strategyDocument.parameters.baseTokenAddress,
            ammPoolAddress:
              trackedPair?.ammPoolAddress ??
              config.strategyDocument.parameters.ammPoolAddress,
          },
        );
      } catch {
        payloadDirection = 'UNKNOWN';
      }
    }

    if (event.payloadJson && payloadDirection === 'UNKNOWN') {
      await this.persistState();
      return false;
    }

    const normalizedDirection = payloadDirection !== 'UNKNOWN'
      ? payloadDirection
      : event.type === 'whale_buy'
        ? 'BUY'
        : 'SELL';

    let triggered = false;
    const now = Date.now();
    if (normalizedDirection === 'BUY') {
      if (config.macroObjective === 'shakeout') {
        this.persistedState.currentEngineState = 'WAITING_FOR_LOSS_CUT';
        this.enqueueTask({
          side: 'sell',
          amountUsd: amountUsd * config.execution.tactics.dumpRatio,
          scheduledAt: now,
          source: 'tactic',
          metadata: { tactic: 'dump', txHash: event.txHash },
        });
        triggered = true;
      } else if (config.macroObjective === 'distribution') {
        this.persistedState.currentEngineState = 'DISTRIBUTING';
        const chunkCount = Math.max(1, config.distributionChunkCount);
        const totalSellUsd = amountUsd * config.execution.tactics.followSellRatio;
        for (let index = 0; index < chunkCount; index += 1) {
          this.enqueueTask({
            side: 'sell',
            amountUsd: totalSellUsd / chunkCount,
            scheduledAt:
              now + Math.round(Math.random() * config.distributionChunkDelayJitterMs),
            source: 'tactic',
            metadata: {
              tactic: 'follow_sell',
              txHash: event.txHash,
              chunkIndex: index + 1,
              chunkCount,
            },
          });
        }
        triggered = true;
      }
    }

    if (normalizedDirection === 'SELL' && config.macroObjective === 'accumulation') {
      this.persistedState.currentEngineState = 'ACCUMULATING';
      this.enqueueTask({
        side: 'buy',
        amountUsd: amountUsd * config.execution.tactics.absorbRatio,
        scheduledAt: now,
        source: 'tactic',
        metadata: { tactic: 'absorb', txHash: event.txHash },
      });
      triggered = true;
    }

    if (event.is_loss_cut && config.macroObjective === 'shakeout') {
      this.persistedState.currentEngineState = 'BUILDING_TREND';
      this.enqueueTask({
        side: 'buy',
        amountUsd,
        scheduledAt: now,
        source: 'tactic',
        metadata: { tactic: 'scoop', txHash: event.txHash },
      });
      triggered = true;
    }

    if (triggered) {
      this.persistedState.metrics.tacticsTriggeredCount += 1;
      await this.ctx.storage.setAlarm(now);
    }

    await this.persistState();
    return false;
  }

  private async debugSimulate(
    input: StrategyEngineDurableObjectDebugSimulateRequest,
  ): Promise<void> {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    const now = Date.now();
    if (this.persistedState.status !== 'running' && input.action !== 'complete') {
      this.persistedState.status = 'running';
      this.persistedState.metrics.endTime = null;
    }
    if (!this.persistedState.metrics.startTime) {
      this.persistedState.metrics.startTime = now;
    }
    if (!this.persistedState.currentEngineState) {
      this.persistedState.currentEngineState = buildInitialStateForObjective(
        config.macroObjective,
      );
    }

    const executedVolumeUsd = clampPositiveNumber(input.executedVolumeUsd ?? 0, 0);
    const actualNetInflowUsd =
      typeof input.actualNetInflowUsd === 'number' && Number.isFinite(input.actualNetInflowUsd)
        ? input.actualNetInflowUsd
        : 0;
    const tacticsTriggeredCount =
      typeof input.tacticsTriggeredCount === 'number' && Number.isFinite(input.tacticsTriggeredCount)
        ? Math.max(0, Math.round(input.tacticsTriggeredCount))
        : 0;

    this.persistedState.metrics.actualTotalVolumeUsd += executedVolumeUsd;
    this.persistedState.metrics.actualNetInflowUsd += actualNetInflowUsd;
    this.persistedState.metrics.tacticsTriggeredCount += tacticsTriggeredCount;

    if (input.action === 'complete') {
      if (this.persistedState.metrics.actualTotalVolumeUsd < config.targetTotalVolumeUsd) {
        this.persistedState.metrics.actualTotalVolumeUsd = config.targetTotalVolumeUsd;
      }
      await this.markCompleted();
      return;
    }

    if (input.clearPendingTasks ?? true) {
      this.persistedState.pendingTasks = [];
      await this.ctx.storage.deleteAlarm();
      await this.persistState({ scheduleAlarm: false });
      return;
    }

    await this.persistState();
  }

  private applyExecutedTask(
    task: StrategyEngineDurableObjectTask,
    executedVolumeUsd: number,
  ): void {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    const executableUsd = Math.max(
      0,
      Math.min(
        executedVolumeUsd,
        config.targetTotalVolumeUsd - this.persistedState.metrics.actualTotalVolumeUsd,
      ),
    );
    if (executableUsd <= 0) {
      return;
    }

    this.persistedState.metrics.actualTotalVolumeUsd += executableUsd;
    this.persistedState.metrics.actualNetInflowUsd +=
      task.side === 'sell' ? executableUsd : -executableUsd;

    if (task.source === 'base') {
      this.persistedState.currentEngineState = buildInitialStateForObjective(
        config.macroObjective,
      );
    }
  }

  private async executeDueTask(
    task: StrategyEngineDurableObjectTask,
  ): Promise<{ executedVolumeUsd: number; retryVolumeUsd: number }> {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    const activeAccounts = await getActiveAccounts(this.env, config.userId, {
      baseMint: config.strategyDocument.parameters.baseTokenAddress.trim(),
      quoteMint: config.strategyDocument.parameters.quoteTokenAddress.trim(),
    });
    if (activeAccounts.length === 0) {
      throw new ApiError(
        409,
        'No active managed accounts available for strategy execution',
      );
    }

    const fundedAccounts = await listManagedAccountsWithBalances(
      this.env.TRADINGBOT_DB,
      config.userId,
      {
        envRpcUrl: this.env.SOLANA_RPC_URL,
        pair: {
          baseMint: config.strategyDocument.parameters.baseTokenAddress.trim(),
          quoteMint: config.strategyDocument.parameters.quoteTokenAddress.trim(),
        },
      },
    );
    const activeAccountsByAddress = new Map(
      activeAccounts.map((account) => [account.publicKey, account]),
    );
    const executableAccounts = fundedAccounts
      .filter((account) =>
        account.pairCompatible &&
        account.hasSolReserve &&
        (task.side === 'buy'
          ? account.quoteAvailableAmount > 0
          : account.baseTokenAmount > 0),
      )
      .flatMap((account) => {
        const signingAccount = activeAccountsByAddress.get(account.address);
        return signingAccount ? [{ balance: account, signingAccount }] : [];
      });
    if (executableAccounts.length === 0) {
      throw new ApiError(
        409,
        'No active managed accounts available for strategy execution',
      );
    }

    const allocationPlan = allocateVolumeAcrossAccountCaps(
      task.amountUsd,
      executableAccounts.map(({ balance }) => ({
        accountId: balance.id,
        maxVolumeUsd: null,
        existingVolumeUsd: 0,
      })),
      {
        accountCyclingEnabled: config.execution.accountCyclingEnabled,
        rotationOffset: this.persistedState.allocationRotationOffsets[task.side],
        accountDispersionStrength: config.execution.accountDispersionStrength,
      },
    );
    this.persistedState.allocationRotationOffsets[task.side] =
      allocationPlan.nextRotationOffset;
    if (allocationPlan.allocations.length === 0) {
      throw new ApiError(
        409,
        'No active managed accounts available for strategy execution',
      );
    }

    const allocatedVolumeByAccountId = new Map(
      allocationPlan.allocations.map((allocation) => [allocation.accountId, allocation.volumeUsd]),
    );
    let executedVolumeUsd = 0;
    let retryVolumeUsd = allocationPlan.unallocatedVolumeUsd;

    for (const executableAccount of executableAccounts) {
      const sliceVolumeUsd = allocatedVolumeByAccountId.get(executableAccount.balance.id) ?? 0;
      if (!Number.isFinite(sliceVolumeUsd) || sliceVolumeUsd <= 0) {
        continue;
      }

      try {
        const swapInput = await this.resolveSwapInput(task.side, sliceVolumeUsd);
        const swap = await executeSwap(
          this.env,
          {
            publicKey: executableAccount.signingAccount.publicKey,
            privateKey: executableAccount.signingAccount.privateKeyBytes,
          },
          swapInput.amountAtomic,
          task.side,
          swapInput.baseToken,
          swapInput.quoteToken,
          {
            slippageBps: Math.max(1, config.strategyDocument.parameters.maxSlippageBps),
            commitment: config.execution.commitment,
          },
        );
        executedVolumeUsd += swap.executedVolumeUsd;
      } catch (error: unknown) {
        retryVolumeUsd += sliceVolumeUsd;
        console.error(
          `[StrategyEngineDO] Account ${executableAccount.signingAccount.publicKey} failed ${task.side} slice ${sliceVolumeUsd} on ${config.baseTokenAddress}:`,
          error,
        );
      }
    }

    return {
      executedVolumeUsd,
      retryVolumeUsd: Number(retryVolumeUsd.toFixed(6)),
    };
  }

  private async resolveSwapInput(
    side: 'buy' | 'sell',
    volumeUsd: number,
  ): Promise<{
    amountAtomic: string;
    baseToken: string;
    quoteToken: string;
  }> {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    const baseToken = config.strategyDocument.parameters.baseTokenAddress.trim();
    const quoteToken = config.strategyDocument.parameters.quoteTokenAddress.trim();

    if (!baseToken || !quoteToken) {
      throw new ApiError(409, 'Strategy trading pair is not fully configured');
    }

    if (side === 'buy') {
      return {
        amountAtomic: String(Math.max(1, Math.round(volumeUsd * 1_000_000))),
        baseToken,
        quoteToken,
      };
    }

    const tokenRow = await this.env.TRADINGBOT_DB
      .prepare(
        'SELECT decimals FROM tradable_tokens WHERE network = ?1 AND base_token_address = ?2 LIMIT 1',
      )
      .bind('solana', baseToken)
      .first<{ decimals: number | null }>();

    const tokenId = await dbResolveTradableTokenId(
      this.env.TRADINGBOT_DB,
      baseToken,
    );
    const marketSnapshot = tokenId
      ? await dbGetLatestTokenMarketSnapshot(this.env.TRADINGBOT_DB, tokenId)
      : null;
    const jupiterMeta = await fetchJupiterTokenMetadata(baseToken);
    const tokenPriceUsd =
      marketSnapshot?.priceUsd ??
      jupiterMeta?.usdPrice ??
      (await fetchJupiterTokenPrice(baseToken));
    const tokenDecimals =
      tokenRow?.decimals ??
      jupiterMeta?.decimals ??
      (await fetchSolanaMintDecimals(
        this.env.RPC_URL?.trim() || this.env.SOLANA_RPC_URL?.trim() || '',
        baseToken,
      ));

    if (
      tokenPriceUsd == null ||
      !Number.isFinite(tokenPriceUsd) ||
      tokenPriceUsd <= 0
    ) {
      throw new ApiError(
        503,
        `Cannot resolve a positive USD price for ${baseToken}`,
      );
    }
    if (tokenDecimals == null || !Number.isFinite(tokenDecimals) || tokenDecimals < 0) {
      throw new ApiError(
        503,
        `Cannot resolve token decimals for ${baseToken}`,
      );
    }

    const tokenAmount = volumeUsd / tokenPriceUsd;
    const amountAtomic = Math.max(1, Math.round(tokenAmount * 10 ** tokenDecimals));
    return {
      amountAtomic: String(amountAtomic),
      baseToken,
      quoteToken,
    };
  }

  private scheduleTaskRetry(
    task: StrategyEngineDurableObjectTask,
    now: number,
  ): void {
    this.enqueueTask({
      ...task,
      scheduledAt: now + this.buildRetryDelayMs(),
      metadata: {
        ...task.metadata,
        lastRetryAt: now,
      },
    });
  }

  private buildRetryDelayMs(): number {
    const config = this.persistedState.config;
    if (!config) {
      return 5_000;
    }
    const baseIntervalMs = Math.max(
      1_000,
      Math.round(config.baseDurationMs / Math.max(1, config.baseOrderCount)),
    );
    const jitterRatio = Math.max(0, Math.min(0.5, config.execution.timeJitterRatio));
    const jitterMultiplier = 1 + ((Math.random() * 2) - 1) * jitterRatio;
    return Math.max(1_000, Math.round(baseIntervalMs * jitterMultiplier));
  }

  private ensureBasePlanIfNeeded(startTime: number): void {
    const config = this.persistedState.config;
    if (!config || this.persistedState.status !== 'running') {
      return;
    }

    const hasBaseTasks = this.persistedState.pendingTasks.some(
      (task) => task.source === 'base',
    );
    if (hasBaseTasks) {
      return;
    }

    switch (config.macroObjective) {
      case 'distribution': {
        this.enqueuePlan(
          'buy',
          config.targetTotalVolumeUsd / 2,
          Math.max(1, Math.floor(config.baseOrderCount / 2)),
          config.baseDurationMs,
          'base',
          startTime,
          { pulse: 'wash_buy' },
        );
        this.enqueuePlan(
          'sell',
          config.targetTotalVolumeUsd / 2,
          Math.max(1, Math.floor(config.baseOrderCount / 2)),
          config.baseDurationMs,
          'base',
          startTime,
          { pulse: 'wash_sell' },
          750,
        );
        break;
      }
      case 'accumulation': {
        this.enqueuePlan(
          'buy',
          config.targetTotalVolumeUsd,
          Math.max(1, Math.ceil(config.baseOrderCount / 2)),
          Math.round(config.baseDurationMs * 1.5),
          'base',
          startTime,
          { pulse: 'slow_buy' },
        );
        break;
      }
      case 'shakeout':
      default: {
        this.enqueuePlan(
          'buy',
          config.targetTotalVolumeUsd,
          config.baseOrderCount,
          config.baseDurationMs,
          'base',
          startTime,
          { pulse: 'trend' },
        );
        break;
      }
    }
  }

  private enqueuePlan(
    side: 'buy' | 'sell',
    totalVolumeUsd: number,
    orderCount: number,
    durationMs: number,
    source: StrategyEngineDurableObjectTask['source'],
    startTime: number,
    metadata?: Record<string, unknown>,
    scheduledOffsetMs = 0,
  ): void {
    const config = this.persistedState.config;
    if (!config) {
      return;
    }
    const normalizedVolume = clampPositiveNumber(totalVolumeUsd, 0);
    if (normalizedVolume <= 0) {
      return;
    }

    const plan = buildRandomizedTwapPlan(config.execution, {
      side,
      totalVolume: normalizedVolume,
      orderCount: Math.max(1, Math.floor(orderCount)),
      durationMs: Math.max(1_000, Math.round(durationMs)),
      startTime,
      baseTokenAddress: config.baseTokenAddress,
    });

    for (const slice of plan.slices) {
      this.enqueueTask({
        id: `${source}-${slice.orderIndex}-${slice.scheduledAt}`,
        side,
        amountUsd: slice.targetVolume,
        scheduledAt: slice.scheduledAt + scheduledOffsetMs,
        source,
        metadata: {
          orderIndex: slice.orderIndex,
          totalOrders: plan.orderCount,
          ...metadata,
        },
      });
    }
  }

  private enqueueTask(task: Omit<StrategyEngineDurableObjectTask, 'id'> & { id?: string }): void {
    const amountUsd = clampPositiveNumber(task.amountUsd, 0);
    if (amountUsd <= 0) {
      return;
    }
    this.persistedState.pendingTasks.push({
      id: task.id ?? createTaskId(),
      side: task.side,
      amountUsd,
      scheduledAt: Math.max(Date.now(), Math.round(task.scheduledAt)),
      source: task.source,
      metadata: task.metadata,
    });
    this.persistedState.pendingTasks.sort(
      (left, right) => left.scheduledAt - right.scheduledAt || left.id.localeCompare(right.id),
    );
  }

  private popNextDueTask(now: number): StrategyEngineDurableObjectTask | null {
    const nextTask = this.persistedState.pendingTasks[0] ?? null;
    if (!nextTask) {
      return null;
    }
    if (nextTask.scheduledAt > now) {
      return null;
    }
    return this.persistedState.pendingTasks.shift() ?? null;
  }

  private async markCompleted(): Promise<void> {
    this.persistedState.status = 'completed';
    this.persistedState.metrics.endTime = Date.now();
    this.persistedState.pendingTasks = [];
    await this.ctx.storage.deleteAlarm();
    await this.persistState({ scheduleAlarm: false });
  }

  private buildMetricsResponse() {
    return {
      status: this.persistedState.status,
      metrics: this.persistedState.metrics,
      currentEngineState: this.persistedState.currentEngineState,
      config: this.persistedState.config,
      nextExecutionTime: this.persistedState.pendingTasks[0]?.scheduledAt ?? null,
    };
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.hydrated) {
        return;
      }
      const stored = await this.ctx.storage.get<PersistedStrategyEngineState>(STORAGE_KEY);
      const idleState = createIdleState();
      this.persistedState = stored
        ? {
            ...idleState,
            ...stored,
            allocationRotationOffsets: {
              ...idleState.allocationRotationOffsets,
              ...(stored.allocationRotationOffsets ?? {}),
            },
          }
        : idleState;
      this.hydrated = true;
    });
  }

  private async persistState(options?: { scheduleAlarm?: boolean }): Promise<void> {
    this.persistedState.updatedAt = Date.now();
    await this.ctx.storage.put(STORAGE_KEY, this.persistedState);
    if (options?.scheduleAlarm === false) {
      return;
    }
    await this.syncAlarmFromState();
  }

  private async syncAlarmFromState(): Promise<void> {
    if (this.persistedState.status !== 'running' || this.persistedState.pendingTasks.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const nextExecutionTime = this.persistedState.pendingTasks[0]?.scheduledAt ?? Date.now();
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm == null || currentAlarm !== nextExecutionTime) {
      await this.ctx.storage.setAlarm(nextExecutionTime);
    }
  }

  private async readOptionalJsonObject(request: Request): Promise<Record<string, unknown> | null> {
    const rawBody = await request.text();
    if (!rawBody.trim()) {
      return null;
    }
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ApiError(400, 'Request body must be a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(400, 'Request body must be valid JSON');
    }
  }
}