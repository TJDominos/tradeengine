import { ApiError } from '../errors';
import { fetchJupiterTokenMetadata, fetchJupiterTokenPrice } from '../jupiter';
import { dbFindTradableTokenByPair, dbGetLatestTokenMarketSnapshot, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import { fetchSolanaMintDecimals, normalizePubkey } from '../workerCore';
import type { Env } from '../workerShared';
import type { EngineState, MacroObjective } from './engine';
import { normalizeStrategyDocument } from './migrations';
import {
  buildPlanningVolumeMapsFromTasks,
  buildStrategyPlanTaskSpecs,
  buildStrategyPlanningResult,
  deriveRequiredNetBuyAmount,
  type StrategyPlannerConfig,
  type StrategyPlannerTask,
  type StrategyPlannerTaskAllocation,
  type StrategyPlannerTaskSpec,
} from './planner';
import {
  calculateFeasibleTradeCounts,
  calculateRemainingPlanVolumes,
} from './plannerMath';
import {
  resolveBasePlannedTransactionCount,
} from './plannedTransactions';
import type {
  ExecutionReport,
  StrategyExecutionConfig,
  StrategyExecutionTaskSnapshot,
  StrategyReviewedPlan,
  StrategyVersionDocument,
} from './types';
import type { ExternalTradeEvent } from './triggers';
import { executeSwap, type JupiterSwapExecutionResult } from '../services/jupiterSwapService';
import { getActiveAccounts } from '../services/accountPoolService';
import { fetchSolanaTransactionChainTimeMs } from '../services/signalStore';
import { analyzeTradeDirection } from '../services/webhookParser';
import {
  listManagedAccountsWithStoredBalances,
  refreshManagedAccountWalletBalanceSnapshot,
} from '../userStore';

const STORAGE_KEY = 'strategy-engine-state';
const MAX_DEDUPED_TX_HASHES = 256;
const DEFAULT_STRATEGY_TASK_BASE_VOLUME_USD = 300;
const DEFAULT_DISTRIBUTION_CHUNK_COUNT = 3;
const DEFAULT_DISTRIBUTION_DELAY_JITTER_MS = 2_000;
const INITIAL_EXECUTION_DELAY_MS = 1_000;
const FIRST_TASK_RETRY_DELAY_MS = 30_000;

export type StrategyEngineDurableObjectStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'aborted';

export type StrategyEngineTaskStatus = 'done' | 'pending' | 'failed' | 'superseded';

export type StrategyEngineTaskSnapshot = StrategyExecutionTaskSnapshot;

export function resolveStrategyTaskFailureTransition(
  failureCount: number,
  now: number,
  nextTaskScheduledAt: number | null,
): { pause: boolean; retryAt: number | null } {
  if (failureCount >= 3) {
    return { pause: true, retryAt: null };
  }
  if (failureCount === 1) {
    return { pause: false, retryAt: now + FIRST_TASK_RETRY_DELAY_MS };
  }
  return {
    pause: false,
    retryAt: nextTaskScheduledAt ?? now + FIRST_TASK_RETRY_DELAY_MS,
  };
}

function readRetryExcludedAccountIds(metadata: Record<string, unknown> | undefined): number[] {
  const rawValue = metadata?.retryExcludedAccountIds;
  if (!Array.isArray(rawValue)) {
    return [];
  }
  return [...new Set(
    rawValue.filter(
      (value): value is number => Number.isInteger(value) && value > 0,
    ),
  )].sort((left, right) => left - right);
}

function appendRetryExcludedAccountIds(
  metadata: Record<string, unknown> | undefined,
  accountIds: Array<number | null | undefined>,
): number[] {
  const excludedAccountIds = new Set(readRetryExcludedAccountIds(metadata));
  for (const accountId of accountIds) {
    if (typeof accountId === 'number' && Number.isInteger(accountId) && accountId > 0) {
      excludedAccountIds.add(accountId);
    }
  }
  return [...excludedAccountIds].sort((left, right) => left - right);
}

function readRetryAttempt(metadata: Record<string, unknown> | undefined): number {
  const rawValue = metadata?.retryAttempt;
  return typeof rawValue === 'number' && Number.isInteger(rawValue) && rawValue >= 0
    ? rawValue
    : 0;
}

export interface StrategyEngineDurableObjectMetrics {
  actualTotalVolumeUsd: number;
  actualNetInflowUsd: number;
  tacticsTriggeredCount: number;
  startTime: number;
  endTime: number | null;
}

export interface StrategyEngineDurableObjectConfig {
  userId: number;
  runId: string | null;
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
  reviewedPlan?: StrategyReviewedPlan;
}

export interface StrategyEngineDurableObjectTask {
  id: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  scheduledAt: number;
  source: 'base' | 'tactic';
  allocations?: StrategyPlannerTaskAllocation[];
  metadata?: Record<string, unknown>;
}

export interface StrategyEngineDurableObjectConfigureRequest {
  userId: number;
  runId?: string | null;
  versionId: number;
  strategyDocument: StrategyVersionDocument;
  reviewedPlan?: StrategyReviewedPlan;
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
  taskSnapshots: StrategyEngineTaskSnapshot[];
  pausedTask: StrategyEngineDurableObjectTask | null;
  observedOrders: StrategyObservedOrder[];
  pendingReplanTxHash: string | null;
  dedupedTxHashes: string[];
  allocationRotationOffsets: Record<'buy' | 'sell', number>;
  updatedAt: number;
}

interface StrategyObservedOrder {
  id: string;
  side: 'buy' | 'sell';
  volumeUsd: number;
  source: 'managed' | 'external';
  accountId: number | null;
  occurredAt: number;
  responseBuyVolumeUsd?: number;
  responseSellVolumeUsd?: number;
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
    taskSnapshots: [],
    pausedTask: null,
    observedOrders: [],
    pendingReplanTxHash: null,
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
    pnl: 0,
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
      const report = {
        ...await this.abort(reason),
        tasks: this.persistedState.taskSnapshots,
      };
      return Response.json({ ok: true, status: this.persistedState.status, report });
    }

    if (request.method === 'POST' && url.pathname === '/pause') {
      await this.pause();
      return Response.json({ ok: true, status: this.persistedState.status });
    }

    if (request.method === 'POST' && url.pathname === '/resume') {
      await this.resume();
      return Response.json({ ok: true, status: this.persistedState.status });
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
    await this.ensureHydrated();
    const state = this.persistedState;
    const config = state.config;
    if (!config || state.status !== 'running') {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    if (state.pendingReplanTxHash) {
      const txHash = state.pendingReplanTxHash;
      await this.replanAfterExternalEvent(txHash);
      state.pendingReplanTxHash = null;
    }

    if (state.metrics.actualTotalVolumeUsd >= this.getManagedTargetTotalVolumeUsd()) {
      await this.markCompleted();
      return;
    }

    if (state.pendingTasks.length === 0) {
      if (config.reviewedPlan) {
        await this.markCompleted();
        return;
      }
      await this.ensureBasePlanIfNeeded(Date.now());
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
        this.applyExecutedTask(nextTask, execution.fills);
        this.addTaskExecutedVolume(nextTask.id, execution.executedVolumeUsd);
      }
      if (execution.retryVolumeUsd > 0) {
        await this.handleTaskFailure(
          {
            ...nextTask,
            amountUsd: execution.retryVolumeUsd,
          },
          now,
          execution.lastError ?? 'Task volume could not be fully executed',
          execution.failedAccountIds,
        );
        if (this.persistedState.status === 'paused') {
          return;
        }
      } else {
        this.markTaskDone(nextTask.id, now);
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
      await this.handleTaskFailure(
        nextTask,
        now,
        error instanceof Error ? error.message : String(error),
      );
      await this.persistState();
      return;
    }

    if (state.metrics.actualTotalVolumeUsd >= this.getManagedTargetTotalVolumeUsd()) {
      await this.markCompleted();
      return;
    }

    if (state.pendingTasks.length === 0) {
      if (config.reviewedPlan) {
        await this.markCompleted();
        return;
      }
      await this.ensureBasePlanIfNeeded(Date.now());
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
    state.taskSnapshots = [];
    state.pausedTask = null;
    state.observedOrders = [];
    state.pendingReplanTxHash = null;
    state.dedupedTxHashes = [];
    state.allocationRotationOffsets = createEmptyAllocationRotationOffsets();
    if (state.config.reviewedPlan) {
      this.enqueueReviewedPlan(state.config.reviewedPlan, planStartTime);
    } else {
      await this.ensureBasePlanIfNeeded(planStartTime);
    }
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

  private async pause(): Promise<void> {
    if (!this.persistedState.config || this.persistedState.status !== 'running') {
      throw new ApiError(409, 'Only a running strategy queue can be paused');
    }
    this.persistedState.status = 'paused';
    await this.ctx.storage.deleteAlarm();
    await this.persistState({ scheduleAlarm: false });
  }

  private async resume(): Promise<void> {
    if (!this.persistedState.config || this.persistedState.status !== 'paused') {
      throw new ApiError(409, 'Only a paused strategy queue can be resumed');
    }
    this.persistedState.status = 'running';
    const pausedTask = this.persistedState.pausedTask;
    this.persistedState.pausedTask = null;
    if (pausedTask) {
      const pausedTaskSnapshot = this.persistedState.taskSnapshots.find(
        (candidate) => candidate.id === pausedTask.id,
      );
      const retryExcludedAccountIds = appendRetryExcludedAccountIds(
        pausedTask.metadata,
        [
          pausedTaskSnapshot?.accountId,
          ...(pausedTask.allocations?.map((allocation) => allocation.accountId) ?? []),
        ],
      );
      this.enqueueTask({
        ...pausedTask,
        allocations: undefined,
        scheduledAt: Date.now(),
        metadata: {
          ...pausedTask.metadata,
          retryPriority: true,
          retryAttempt: readRetryAttempt(pausedTask.metadata) + 1,
          retryExcludedAccountIds,
        },
      });
      this.updateTaskSnapshot(pausedTask.id, {
        status: 'pending',
        nextExecutionTime: Date.now(),
        accountAddress: null,
        walletAddress: null,
        accountId: null,
      });
    }
    await this.persistState();
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
    const basePlannedTransactionCount = resolveBasePlannedTransactionCount(normalizedDocument);
    const nextConfig: StrategyEngineDurableObjectConfig = {
      userId: input.userId,
      runId: input.runId ?? null,
      versionId: input.versionId,
      baseTokenAddress,
      macroObjective: normalizedDocument.execution.macroObjective,
      targetTotalVolumeUsd: clampPositiveNumber(
        normalizedDocument.riskControls.maxPositionUsd ?? normalizedDocument.targets.volumeUsdMin,
        DEFAULT_STRATEGY_TASK_BASE_VOLUME_USD,
      ),
      baseOrderCount: basePlannedTransactionCount,
      baseDurationMs: parseTimeRangeTargetToDurationMs(
        normalizedDocument.parameters.timeRangeTarget,
      ),
      distributionChunkCount: DEFAULT_DISTRIBUTION_CHUNK_COUNT,
      distributionChunkDelayJitterMs: DEFAULT_DISTRIBUTION_DELAY_JITTER_MS,
      triggerThresholdUsd: Math.max(0, normalizedDocument.triggers.triggerThresholdUsd),
      execution: normalizedDocument.execution,
      strategyDocument: normalizedDocument,
      reviewedPlan: input.reviewedPlan,
    };

    const previousConfig = this.persistedState.config;
    const configChanged =
      !previousConfig ||
      previousConfig.runId !== nextConfig.runId ||
      previousConfig.versionId !== nextConfig.versionId ||
      previousConfig.baseTokenAddress !== nextConfig.baseTokenAddress ||
      previousConfig.macroObjective !== nextConfig.macroObjective;

    this.persistedState.config = nextConfig;
    if (configChanged && this.persistedState.status !== 'running') {
      this.persistedState.currentEngineState = buildInitialStateForObjective(nextConfig.macroObjective);
      this.persistedState.pendingTasks = [];
      this.persistedState.observedOrders = [];
      this.persistedState.pendingReplanTxHash = null;
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

    let responseBuyVolumeUsd = 0;
    let responseSellVolumeUsd = 0;
    if (normalizedDirection === 'BUY') {
      if (config.macroObjective === 'shakeout') {
        this.persistedState.currentEngineState = 'WAITING_FOR_LOSS_CUT';
        responseSellVolumeUsd = amountUsd * config.execution.tactics.dumpRatio;
      } else if (config.macroObjective === 'distribution') {
        this.persistedState.currentEngineState = 'DISTRIBUTING';
        responseSellVolumeUsd = amountUsd * config.execution.tactics.followSellRatio;
      }
    }

    if (normalizedDirection === 'SELL' && config.macroObjective === 'accumulation') {
      this.persistedState.currentEngineState = 'ACCUMULATING';
      responseBuyVolumeUsd += amountUsd * config.execution.tactics.absorbRatio;
    }

    if (event.is_loss_cut && config.macroObjective === 'shakeout') {
      this.persistedState.currentEngineState = 'BUILDING_TREND';
      responseBuyVolumeUsd += amountUsd;
    }

    const triggered = responseBuyVolumeUsd > 0 || responseSellVolumeUsd > 0;
    if (triggered) {
      this.persistedState.observedOrders.push({
        id: event.txHash,
        side: normalizedDirection.toLowerCase() as 'buy' | 'sell',
        volumeUsd: amountUsd,
        source: 'external',
        accountId: null,
        occurredAt: Date.now(),
        responseBuyVolumeUsd,
        responseSellVolumeUsd,
      });
      this.persistedState.metrics.tacticsTriggeredCount += 1;
      this.supersedePendingTaskSnapshots(event.txHash);
      this.persistedState.pendingTasks = [];
      this.persistedState.pendingReplanTxHash = event.txHash;
      await this.persistState({ scheduleAlarm: false });
      await this.ctx.storage.setAlarm(Date.now());
      return false;
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
      this.supersedePendingTaskSnapshots('debug-simulation');
      this.persistedState.pendingTasks = [];
      await this.ctx.storage.deleteAlarm();
      await this.persistState({ scheduleAlarm: false });
      return;
    }

    await this.persistState();
  }

  private applyExecutedTask(
    task: StrategyEngineDurableObjectTask,
    fills: Array<{ accountId: number; executedVolumeUsd: number }>,
  ): void {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    const remainingTargetUsd = Math.max(
      0,
      this.getManagedTargetTotalVolumeUsd() - this.persistedState.metrics.actualTotalVolumeUsd,
    );
    const executableUsd = Math.min(
      remainingTargetUsd,
      fills.reduce((sum, fill) => sum + fill.executedVolumeUsd, 0),
    );
    if (executableUsd <= 0) {
      return;
    }

    this.persistedState.metrics.actualTotalVolumeUsd += executableUsd;
    this.persistedState.metrics.actualNetInflowUsd +=
      task.side === 'sell' ? executableUsd : -executableUsd;
    let recordedVolumeUsd = 0;
    for (const [index, fill] of fills.entries()) {
      const volumeUsd = Math.min(
        fill.executedVolumeUsd,
        Math.max(0, executableUsd - recordedVolumeUsd),
      );
      if (volumeUsd <= 0) {
        continue;
      }
      this.persistedState.observedOrders.push({
        id: `${task.id}:${index}`,
        side: task.side,
        volumeUsd,
        source: 'managed',
        accountId: fill.accountId,
        occurredAt: Date.now(),
      });
      recordedVolumeUsd += volumeUsd;
    }

    if (task.source === 'base') {
      this.persistedState.currentEngineState = buildInitialStateForObjective(
        config.macroObjective,
      );
    }
  }

  private buildExistingPlannedVolumes() {
    return buildPlanningVolumeMapsFromTasks(this.persistedState.pendingTasks);
  }

  private buildObservedManagedVolumes() {
    const buy = new Map<number, number>();
    const sell = new Map<number, number>();
    for (const order of this.persistedState.observedOrders) {
      if (order.source !== 'managed' || order.accountId == null) {
        continue;
      }
      const volumes = order.side === 'buy' ? buy : sell;
      volumes.set(order.accountId, (volumes.get(order.accountId) ?? 0) + order.volumeUsd);
    }
    return { buy, sell };
  }

  private buildObservedOrdersForReplanning(): StrategyObservedOrder[] {
    const observedOrders = [...this.persistedState.observedOrders];
    const recordedManagedBuyUsd = observedOrders.reduce(
      (total, order) => total + (order.source === 'managed' && order.side === 'buy' ? order.volumeUsd : 0),
      0,
    );
    const recordedManagedSellUsd = observedOrders.reduce(
      (total, order) => total + (order.source === 'managed' && order.side === 'sell' ? order.volumeUsd : 0),
      0,
    );
    const metricBuyUsd = Math.max(
      0,
      (this.persistedState.metrics.actualTotalVolumeUsd - this.persistedState.metrics.actualNetInflowUsd) / 2,
    );
    const metricSellUsd = Math.max(
      0,
      (this.persistedState.metrics.actualTotalVolumeUsd + this.persistedState.metrics.actualNetInflowUsd) / 2,
    );
    const unrecordedBuyUsd = Math.max(0, metricBuyUsd - recordedManagedBuyUsd);
    const unrecordedSellUsd = Math.max(0, metricSellUsd - recordedManagedSellUsd);
    if (unrecordedBuyUsd > 0.000001) {
      observedOrders.push({
        id: 'aggregate-metrics:buy',
        side: 'buy',
        volumeUsd: unrecordedBuyUsd,
        source: 'managed',
        accountId: null,
        occurredAt: this.persistedState.updatedAt,
      });
    }
    if (unrecordedSellUsd > 0.000001) {
      observedOrders.push({
        id: 'aggregate-metrics:sell',
        side: 'sell',
        volumeUsd: unrecordedSellUsd,
        source: 'managed',
        accountId: null,
        occurredAt: this.persistedState.updatedAt,
      });
    }
    return observedOrders;
  }

  private getManagedTargetTotalVolumeUsd(): number {
    const config = this.persistedState.config;
    if (!config) {
      return 0;
    }
    return this.persistedState.observedOrders.reduce(
      (total, order) => total + (order.responseBuyVolumeUsd ?? 0) + (order.responseSellVolumeUsd ?? 0),
      config.targetTotalVolumeUsd,
    );
  }

  private async replanAfterExternalEvent(txHash: string): Promise<void> {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }
    const baseSpecs = config.reviewedPlan
      ? config.reviewedPlan.tasks.map((task) => ({ side: task.side, totalVolumeUsd: task.totalVolumeUsd }))
      : buildStrategyPlanTaskSpecs(
          this.buildPlannerConfig(),
          deriveRequiredNetBuyAmount(config.strategyDocument, config.targetTotalVolumeUsd),
        );
    const baseBuyVolumeUsd = baseSpecs.reduce(
      (total, task) => total + (task.side === 'buy' ? task.totalVolumeUsd : 0),
      0,
    );
    const baseSellVolumeUsd = baseSpecs.reduce(
      (total, task) => total + (task.side === 'sell' ? task.totalVolumeUsd : 0),
      0,
    );
    const managedOrders = this.persistedState.observedOrders.filter(
      (order) => order.source === 'managed',
    );
    const { remainingBuyVolumeUsd, remainingSellVolumeUsd } = calculateRemainingPlanVolumes(
      baseBuyVolumeUsd,
      baseSellVolumeUsd,
      this.buildObservedOrdersForReplanning(),
    );
    const remainingTotalVolumeUsd = remainingBuyVolumeUsd + remainingSellVolumeUsd;
    if (remainingTotalVolumeUsd <= 0.000001) {
      await this.markCompleted();
      return;
    }

    const remainingMaximumOrders = Math.max(
      1,
      config.strategyDocument.parameters.maxTransactions - managedOrders.length,
    );
    const remainingPreferredOrders = Math.max(
      1,
      config.baseOrderCount - managedOrders.length,
    );
    const counts = calculateFeasibleTradeCounts(
      remainingPreferredOrders,
      remainingMaximumOrders,
      remainingBuyVolumeUsd,
      remainingSellVolumeUsd,
      config.strategyDocument.parameters.minOrderUsd,
      config.strategyDocument.parameters.maxOrderUsd,
    );
    if (!counts) {
      throw new ApiError(409, 'External event left no feasible remaining plan within the configured order limits');
    }
    const durationMs = Math.max(
      0,
      Math.round(config.baseDurationMs * remainingTotalVolumeUsd / Math.max(1, config.targetTotalVolumeUsd)),
    );
    const taskSpecs: StrategyPlannerTaskSpec[] = [];
    if (remainingSellVolumeUsd > 0) {
      taskSpecs.push({
        side: 'sell',
        pulse: 'event_replan_sell',
        totalVolumeUsd: remainingSellVolumeUsd,
        orderCount: counts.sellCount,
        durationMs,
        scheduledOffsetMs: 0,
      });
    }
    if (remainingBuyVolumeUsd > 0) {
      taskSpecs.push({
        side: 'buy',
        pulse: 'event_replan_buy',
        totalVolumeUsd: remainingBuyVolumeUsd,
        orderCount: counts.buyCount,
        durationMs,
        scheduledOffsetMs: 750,
      });
    }
    await this.enqueuePlannedTaskSpecs(
      taskSpecs,
      Date.now(),
      'tactic',
      `event-replan:${txHash}:${this.persistedState.observedOrders.length}`,
      (task) => ({
        tactic: 'event_replan',
        txHash,
        planRevision: this.persistedState.observedOrders.length,
        pulse: task.pulse,
        orderIndex: task.orderIndex,
        totalOrders: task.totalOrders,
      }),
      this.buildObservedManagedVolumes(),
      true,
    );
  }

  private buildPlannerConfig(): StrategyPlannerConfig {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    return {
      macroObjective: config.macroObjective,
      baseOrderCount: config.baseOrderCount,
      maxOrderCount: config.strategyDocument.parameters.maxTransactions,
      baseTotalVolumeUsd: config.targetTotalVolumeUsd,
      baseDurationMs: config.baseDurationMs,
      targetPullbackPct: config.strategyDocument.targets.pullbackPctMax,
      targetVolatilityPct: config.strategyDocument.targets.volatilityPctMin,
      minOrderUsd: config.strategyDocument.parameters.minOrderUsd,
      maxOrderUsd: config.strategyDocument.parameters.maxOrderUsd,
      execution: config.execution,
      baseTokenAddress: config.baseTokenAddress,
      quoteTokenAddress: config.strategyDocument.parameters.quoteTokenAddress.trim(),
    };
  }

  private async loadPlanningInputs(): Promise<{
    accounts: Awaited<ReturnType<typeof listManagedAccountsWithStoredBalances>>;
    baseTokenPriceUsd: number | null;
  }> {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    const [accounts, tokenId] = await Promise.all([
      listManagedAccountsWithStoredBalances(
        this.env.TRADINGBOT_DB,
        config.userId,
        {
          pair: {
            baseMint: config.strategyDocument.parameters.baseTokenAddress.trim(),
            quoteMint: config.strategyDocument.parameters.quoteTokenAddress.trim(),
          },
        },
      ),
      dbResolveTradableTokenId(
        this.env.TRADINGBOT_DB,
        config.strategyDocument.parameters.baseTokenAddress.trim(),
      ),
    ]);

    const marketSnapshot = tokenId
      ? await dbGetLatestTokenMarketSnapshot(this.env.TRADINGBOT_DB, tokenId)
      : null;

    return {
      accounts,
      baseTokenPriceUsd: marketSnapshot?.priceUsd ?? null,
    };
  }

  private async enqueuePlannedTaskSpecs(
    taskSpecs: StrategyPlannerTaskSpec[],
    startTime: number,
    source: StrategyEngineDurableObjectTask['source'],
    seedContext: string,
    metadataFactory?: (task: StrategyPlannerTask) => Record<string, unknown>,
    existingPlannedVolumes = this.buildExistingPlannedVolumes(),
    replacePendingTasks = false,
  ): Promise<void> {
    const config = this.persistedState.config;
    if (!config || this.persistedState.status !== 'running') {
      return;
    }

    const { accounts, baseTokenPriceUsd } = await this.loadPlanningInputs();
    const planning = buildStrategyPlanningResult({
      document: config.strategyDocument,
      config: this.buildPlannerConfig(),
      accounts,
      taskSpecs,
      startTime,
      baseTokenPriceUsd,
      existingPlannedVolumes,
      seedContext,
    });

    if (!planning.isExecutable) {
      throw new ApiError(
        409,
        `Planner could only allocate ${planning.plannedTaskCount}/${planning.requestedTaskCount} tasks with ${planning.unallocatedVolumeUsd.toFixed(2)} USD unallocated`,
      );
    }

    if (replacePendingTasks) {
      this.persistedState.pendingTasks = [];
    }

    for (const task of planning.tasks) {
      this.enqueueTask({
        id: `${source}:${seedContext}:${task.taskId}:${Math.round(task.scheduledAt)}`,
        side: task.side,
        amountUsd: task.totalVolumeUsd,
        scheduledAt: task.scheduledAt,
        source,
        allocations: task.allocations,
        metadata: {
          pulse: task.pulse,
          orderIndex: task.orderIndex,
          totalOrders: task.totalOrders,
          ...(metadataFactory ? metadataFactory(task) : {}),
        },
      });
    }
  }

  private async resolveTaskAllocations(
    task: StrategyEngineDurableObjectTask,
  ): Promise<StrategyPlannerTaskAllocation[]> {
    if (task.allocations && task.allocations.length > 0) {
      return task.allocations;
    }

    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    const { accounts, baseTokenPriceUsd } = await this.loadPlanningInputs();
    const retryExcludedAccountIds = readRetryExcludedAccountIds(task.metadata);
    const retryExcludedAccountIdSet = new Set(retryExcludedAccountIds);
    const planningAccounts = retryExcludedAccountIdSet.size > 0
      ? accounts.filter((account) => !retryExcludedAccountIdSet.has(account.id))
      : accounts;
    const planning = buildStrategyPlanningResult({
      document: config.strategyDocument,
      config: this.buildPlannerConfig(),
      accounts: planningAccounts,
      taskSpecs: [
        {
          side: task.side,
          pulse:
            typeof task.metadata?.pulse === 'string' ? task.metadata.pulse : null,
          totalVolumeUsd: task.amountUsd,
          orderCount: 1,
          durationMs: 0,
          scheduledOffsetMs: 0,
        },
      ],
      startTime: task.scheduledAt,
      baseTokenPriceUsd,
      existingPlannedVolumes: this.buildExistingPlannedVolumes(),
      seedContext: `retry:${task.id}:${readRetryAttempt(task.metadata)}:${retryExcludedAccountIds.join(',')}`,
    });
    return planning.tasks[0]?.allocations ?? [];
  }

  private async executeDueTask(
    task: StrategyEngineDurableObjectTask,
  ): Promise<{
    executedVolumeUsd: number;
    retryVolumeUsd: number;
    fills: Array<{ accountId: number; executedVolumeUsd: number }>;
    lastError: string | null;
    failedAccountIds: number[];
  }> {
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
    const activeAccountsByAddress = new Map(
      activeAccounts.map((account) => [account.publicKey, account]),
    );
    const taskAllocations = await this.resolveTaskAllocations(task);
    const primaryAllocation = taskAllocations[0];
    if (primaryAllocation) {
      this.updateTaskSnapshot(task.id, {
        accountAddress: primaryAllocation.walletAddress,
        walletAddress: primaryAllocation.walletAddress,
        accountId: primaryAllocation.accountId,
      });
    }
    const executableAccounts = taskAllocations.flatMap((allocation) => {
      const signingAccount = activeAccountsByAddress.get(allocation.walletAddress);
      return signingAccount ? [{ allocation, signingAccount }] : [];
    });
    if (executableAccounts.length === 0) {
      throw new ApiError(
        409,
        'No active managed accounts available for strategy execution',
      );
    }
    let executedVolumeUsd = 0;
    const fills: Array<{ accountId: number; executedVolumeUsd: number }> = [];
    const failedAccountIds = new Set<number>();
    const executablePlannedVolumeUsd = executableAccounts.reduce(
      (sum, executableAccount) => sum + executableAccount.allocation.plannedVolumeUsd,
      0,
    );
    let retryVolumeUsd = Number(
      Math.max(0, task.amountUsd - executablePlannedVolumeUsd).toFixed(6),
    );
    let lastError: string | null = retryVolumeUsd > 0
      ? 'Task volume could not be allocated to an active account'
      : null;
    for (const executableAccount of executableAccounts) {
      const sliceVolumeUsd = executableAccount.allocation.plannedVolumeUsd;
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
        );
        await this.persistSwapTradeLog(
          task,
          executableAccount.allocation,
          swap,
        );
        this.ctx.waitUntil(
          refreshManagedAccountWalletBalanceSnapshot(
            this.env.TRADINGBOT_DB,
            config.userId,
            executableAccount.signingAccount.publicKey,
            this.env.SOLANA_RPC_URL,
          ).catch((error: unknown) => {
            console.warn(
              `[StrategyEngineDO] Failed to refresh balance snapshot for ${executableAccount.signingAccount.publicKey}:`,
              error,
            );
          }),
        );
        executedVolumeUsd += swap.executedVolumeUsd;
        fills.push({
          accountId: executableAccount.allocation.accountId,
          executedVolumeUsd: swap.executedVolumeUsd,
        });
      } catch (error: unknown) {
        retryVolumeUsd += sliceVolumeUsd;
        lastError = error instanceof Error ? error.message : String(error);
        failedAccountIds.add(executableAccount.allocation.accountId);
        await this.persistFailedTradeLog(
          task,
          executableAccount.allocation,
          error,
        );
        console.error(
          `[StrategyEngineDO] Account ${executableAccount.signingAccount.publicKey} failed ${task.side} slice ${sliceVolumeUsd} on ${config.baseTokenAddress}:`,
          error,
        );
      }
    }

    return {
      executedVolumeUsd,
      retryVolumeUsd: Number(retryVolumeUsd.toFixed(6)),
      fills,
      lastError,
      failedAccountIds: [...failedAccountIds],
    };
  }

  private async persistSwapTradeLog(
    task: StrategyEngineDurableObjectTask,
    allocation: StrategyPlannerTaskAllocation,
    swap: JupiterSwapExecutionResult,
  ): Promise<void> {
    const config = this.persistedState.config;
    if (!config?.runId) {
      return;
    }
    const tokenId = await dbResolveTradableTokenId(
      this.env.TRADINGBOT_DB,
      config.baseTokenAddress,
    );
    if (!tokenId) {
      throw new ApiError(500, 'Cannot persist strategy trade without a tracked token');
    }
    const tokenRow = await this.env.TRADINGBOT_DB
      .prepare('SELECT decimals FROM tradable_tokens WHERE id = ?1')
      .bind(tokenId)
      .first<{ decimals: number | null }>();
    const decimals = tokenRow?.decimals;
    if (decimals == null) {
      throw new ApiError(500, 'Cannot persist strategy trade without token decimals');
    }
    const baseAmountAtomic = task.side === 'buy'
      ? swap.outputAmountAtomic
      : swap.inputAmountAtomic;
    const baseAmount = Number(baseAmountAtomic) / 10 ** decimals;
    const executedPrice = baseAmount > 0
      ? swap.executedVolumeUsd / baseAmount
      : null;
    const executedAmount = task.side === 'buy'
      ? baseAmount
      : swap.executedVolumeUsd;
    const rpcUrls = await dbResolveSolanaRpcUrls(
      this.env.TRADINGBOT_DB,
      config.userId,
      this.env.SOLANA_RPC_URL,
    );
    const chainTimeMs = await fetchSolanaTransactionChainTimeMs(rpcUrls, swap.txid);
    const timestamp = Date.now();

    await this.env.TRADINGBOT_DB
      .prepare(
        `INSERT INTO trade_logs (
           strategy_run_id, token_id, wallet_address, action,
           requested_amount, executed_amount, executed_price, tx_signature, chain_time_ms,
           execution_trace_json, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'SUCCESS', ?11, ?11)`,
      )
      .bind(
        config.runId,
        tokenId,
        allocation.walletAddress,
        task.side.toUpperCase(),
        allocation.plannedVolumeUsd,
        executedAmount,
        executedPrice,
        swap.txid,
        chainTimeMs,
        JSON.stringify({
          runId: config.runId,
          strategyVersionId: config.versionId,
          taskId: task.id,
          side: task.side,
          accountId: allocation.accountId,
          baseAmount,
          executedVolumeUsd: swap.executedVolumeUsd,
          inputAmountAtomic: swap.inputAmountAtomic,
          outputAmountAtomic: swap.outputAmountAtomic,
        }),
        timestamp,
      )
      .run();
  }

  private async persistFailedTradeLog(
    task: StrategyEngineDurableObjectTask,
    allocation: StrategyPlannerTaskAllocation,
    error: unknown,
  ): Promise<void> {
    const config = this.persistedState.config;
    if (!config?.runId) {
      return;
    }
    const tokenId = await dbResolveTradableTokenId(
      this.env.TRADINGBOT_DB,
      config.baseTokenAddress,
    );
    if (!tokenId) {
      return;
    }
    const timestamp = Date.now();
    await this.env.TRADINGBOT_DB
      .prepare(
        `INSERT INTO trade_logs (
           strategy_run_id, token_id, wallet_address, action,
           requested_amount, execution_trace_json, status, error_message,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'FAILED', ?7, ?8, ?8)`,
      )
      .bind(
        config.runId,
        tokenId,
        allocation.walletAddress,
        task.side.toUpperCase(),
        allocation.plannedVolumeUsd,
        JSON.stringify({
          runId: config.runId,
          strategyVersionId: config.versionId,
          taskId: task.id,
          side: task.side,
          accountId: allocation.accountId,
        }),
        error instanceof Error ? error.message : String(error),
        timestamp,
      )
      .run();
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
        await dbResolveSolanaRpcUrls(
          this.env.TRADINGBOT_DB,
          config.userId,
          this.env.RPC_URL?.trim() || this.env.SOLANA_RPC_URL,
        ),
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

  private async handleTaskFailure(
    task: StrategyEngineDurableObjectTask,
    now: number,
    error: string,
    failedAccountIds: number[] = [],
  ): Promise<void> {
    const snapshot = this.persistedState.taskSnapshots.find(
      (candidate) => candidate.id === task.id,
    );
    const primaryAllocation = task.allocations?.[0];
    const accountAddress = primaryAllocation?.walletAddress ?? snapshot?.accountAddress ?? snapshot?.walletAddress ?? null;
    const accountId = primaryAllocation?.accountId ?? snapshot?.accountId ?? null;
    const attemptCount = (snapshot?.attemptCount ?? 0) + 1;
    const nextScheduledTask = this.persistedState.pendingTasks[0] ?? null;
    const transition = resolveStrategyTaskFailureTransition(
      attemptCount,
      now,
      nextScheduledTask?.scheduledAt ?? null,
    );
    const retryExcludedAccountIds = appendRetryExcludedAccountIds(
      task.metadata,
      failedAccountIds.length > 0
        ? failedAccountIds
        : [
            accountId,
            ...(task.allocations?.map((allocation) => allocation.accountId) ?? []),
          ],
    );
    if (transition.pause) {
      this.updateTaskSnapshot(task.id, {
        status: 'failed',
        attemptCount,
        nextExecutionTime: null,
        lastFailedAt: now,
        lastError: error,
        accountAddress,
        walletAddress: accountAddress,
        accountId,
      });
      this.persistedState.pausedTask = {
        ...task,
        allocations: undefined,
        metadata: {
          ...task.metadata,
          retryAttempt: attemptCount,
          retryExcludedAccountIds,
        },
      };
      this.persistedState.status = 'paused';
      await this.ctx.storage.deleteAlarm();
      await this.persistState({ scheduleAlarm: false });
      return;
    }

    const retryAt = transition.retryAt ?? now + FIRST_TASK_RETRY_DELAY_MS;
    this.enqueueTask({
      ...task,
      allocations: undefined,
      scheduledAt: retryAt,
      metadata: {
        ...task.metadata,
        retryPriority: attemptCount === 2,
        lastRetryAt: now,
        retryAttempt: attemptCount,
        retryExcludedAccountIds,
      },
    });
    this.updateTaskSnapshot(task.id, {
      status: 'failed',
      attemptCount,
      nextExecutionTime: retryAt,
      lastFailedAt: now,
      lastError: error,
      accountAddress,
      walletAddress: accountAddress,
      accountId,
    });
  }

  private async ensureBasePlanIfNeeded(startTime: number): Promise<void> {
    const config = this.persistedState.config;
    if (!config || this.persistedState.status !== 'running') {
      return;
    }
    if (config.reviewedPlan) {
      return;
    }

    const hasBaseTasks = this.persistedState.pendingTasks.some(
      (task) => task.source === 'base',
    );
    if (hasBaseTasks) {
      return;
    }
    await this.enqueuePlannedTaskSpecs(
      buildStrategyPlanTaskSpecs(
        this.buildPlannerConfig(),
        deriveRequiredNetBuyAmount(
          config.strategyDocument,
          config.targetTotalVolumeUsd,
        ),
      ),
      startTime,
      'base',
      `base-plan:${config.runId ?? config.versionId}:${this.persistedState.metrics.startTime}`,
    );
  }

  private enqueueTask(task: Omit<StrategyEngineDurableObjectTask, 'id'> & { id?: string }): void {
    const amountUsd = clampPositiveNumber(task.amountUsd, 0);
    if (amountUsd <= 0) {
      return;
    }
    const taskId = task.id ?? createTaskId();
    this.persistedState.pendingTasks.push({
      id: taskId,
      side: task.side,
      amountUsd,
      scheduledAt: Math.max(Date.now(), Math.round(task.scheduledAt)),
      source: task.source,
      allocations: task.allocations,
      metadata: task.metadata,
    });
    const primaryAllocation = task.allocations?.[0];
    const accountAddress = primaryAllocation?.walletAddress ?? null;
    const accountId = primaryAllocation?.accountId ?? null;
    const existingSnapshot = this.persistedState.taskSnapshots.find(
      (snapshot) => snapshot.id === taskId,
    );
    if (!existingSnapshot) {
      this.persistedState.taskSnapshots.push({
        id: taskId,
        side: task.side,
        amountUsd,
        scheduledAt: task.scheduledAt,
        nextExecutionTime: task.scheduledAt,
        source: task.source,
        status: 'pending',
        attemptCount: 0,
        executedVolumeUsd: 0,
        completedAt: null,
        lastFailedAt: null,
        lastError: null,
        supersededAt: null,
        planRevision:
          typeof task.metadata?.planRevision === 'number'
            ? task.metadata.planRevision
            : 0,
        triggerTxHash:
          typeof task.metadata?.txHash === 'string'
            ? task.metadata.txHash
            : null,
        accountAddress,
        walletAddress: accountAddress,
        accountId,
      });
    } else if (accountAddress && !existingSnapshot.accountAddress) {
      existingSnapshot.accountAddress = accountAddress;
      existingSnapshot.walletAddress = accountAddress;
      if (accountId != null) {
        existingSnapshot.accountId = accountId;
      }
    }
    this.persistedState.pendingTasks.sort(
      (left, right) =>
        left.scheduledAt - right.scheduledAt ||
        Number(right.metadata?.retryPriority === true) - Number(left.metadata?.retryPriority === true) ||
        left.id.localeCompare(right.id),
    );
  }

  private updateTaskSnapshot(
    taskId: string,
    update: Partial<StrategyEngineTaskSnapshot>,
  ): void {
    const snapshot = this.persistedState.taskSnapshots.find(
      (candidate) => candidate.id === taskId,
    );
    if (snapshot) {
      Object.assign(snapshot, update);
    }
  }

  private addTaskExecutedVolume(taskId: string, executedVolumeUsd: number): void {
    const snapshot = this.persistedState.taskSnapshots.find(
      (candidate) => candidate.id === taskId,
    );
    if (!snapshot) {
      return;
    }
    snapshot.executedVolumeUsd += executedVolumeUsd;
  }

  private markTaskDone(taskId: string, now: number): void {
    const snapshot = this.persistedState.taskSnapshots.find(
      (candidate) => candidate.id === taskId,
    );
    if (!snapshot) {
      return;
    }
    snapshot.status = 'done';
    snapshot.attemptCount += 1;
    snapshot.completedAt = now;
    snapshot.nextExecutionTime = null;
    snapshot.lastError = null;
  }

  private supersedePendingTaskSnapshots(triggerTxHash: string): void {
    const pendingTaskIds = new Set(this.persistedState.pendingTasks.map((task) => task.id));
    const supersededAt = Date.now();
    for (const snapshot of this.persistedState.taskSnapshots) {
      if (pendingTaskIds.has(snapshot.id)) {
        snapshot.status = 'superseded';
        snapshot.nextExecutionTime = null;
        snapshot.supersededAt = supersededAt;
        snapshot.triggerTxHash = triggerTxHash;
      }
    }
  }

  private enqueueReviewedPlan(plan: StrategyReviewedPlan, startTime: number): void {
    for (const task of plan.tasks) {
      this.enqueueTask({
        id: `base:reviewed:${task.taskId}`,
        side: task.side,
        amountUsd: task.totalVolumeUsd,
        scheduledAt: startTime + Math.max(0, task.scheduledAt - plan.generatedAt),
        source: 'base',
        allocations: task.allocations,
        metadata: {
          pulse: task.pulse,
          orderIndex: task.orderIndex,
          totalOrders: task.totalOrders,
          reviewedPlan: true,
        },
      });
    }
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

  private restoreMissingReviewedTaskSnapshots(): void {
    const state = this.persistedState;
    const plan = state.config?.reviewedPlan;
    const startTime = state.metrics.startTime;
    if (!plan || !startTime || state.status === 'idle') {
      return;
    }

    const existingIds = new Set(state.taskSnapshots.map((task) => task.id));
    const pendingById = new Map(state.pendingTasks.map((task) => [task.id, task]));
    const latestTrigger = [...state.observedOrders]
      .reverse()
      .find((order) => order.source === 'external');
    for (const task of plan.tasks) {
      const id = `base:reviewed:${task.taskId}`;
      if (existingIds.has(id)) {
        continue;
      }
      const pendingTask = pendingById.get(id);
      const scheduledAt = pendingTask?.scheduledAt ?? (
        startTime + INITIAL_EXECUTION_DELAY_MS + Math.max(0, task.scheduledAt - plan.generatedAt)
      );
      const primaryAllocation = task.allocations?.[0];
      const accountAddress = primaryAllocation?.walletAddress ?? null;
      const accountId = primaryAllocation?.accountId ?? null;
      state.taskSnapshots.push({
        id,
        side: task.side,
        amountUsd: task.totalVolumeUsd,
        scheduledAt,
        nextExecutionTime: pendingTask?.scheduledAt ?? null,
        source: 'base',
        status: pendingTask ? 'pending' : 'superseded',
        attemptCount: 0,
        executedVolumeUsd: 0,
        completedAt: null,
        lastFailedAt: null,
        lastError: null,
        supersededAt: pendingTask ? null : latestTrigger?.occurredAt ?? Date.now(),
        planRevision: 0,
        triggerTxHash: pendingTask ? null : latestTrigger?.id ?? null,
        accountAddress,
        walletAddress: accountAddress,
        accountId,
      });
      existingIds.add(id);
    }
  }

  private buildMetricsResponse() {
    this.restoreMissingReviewedTaskSnapshots();
    return {
      status: this.persistedState.status,
      runId: this.persistedState.config?.runId ?? null,
      metrics: this.persistedState.metrics,
      currentEngineState: this.persistedState.currentEngineState,
      config: this.persistedState.config,
      nextExecutionTime: this.persistedState.pendingTasks[0]?.scheduledAt ?? null,
      tasks: this.persistedState.taskSnapshots,
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