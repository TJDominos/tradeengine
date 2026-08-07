import { ApiError } from '../errors';
import {
  fetchJupiterTokenMetadata,
  fetchJupiterTokenPrice,
} from '../jupiter';
import {
  dbGetLatestTokenMarketSnapshot,
  dbResolveTradableTokenId,
} from '../tokenStore';
import type { Env } from '../workerShared';
import { fetchSolanaMintDecimals, normalizePubkey } from '../workerCore';
import {
  buildRandomizedTwapPlan,
  type EngineState,
  type MacroObjective,
} from './engine';
import { normalizeStrategyDocument } from './migrations';
import type {
  ExecutionReport,
  StrategyExecutionConfig,
  StrategyVersionDocument,
} from './types';
import type { ExternalTradeEvent } from './triggers';
import { executeSwap } from '../services/jupiterSwapService';
import { SOLANA_USDC_MINT } from '../workerShared';
import { getActiveAccounts } from '../services/accountPoolService';
import { distributeVolumeAcrossAccounts } from '../services/tradeMath';

const STORAGE_KEY = 'strategy-engine-state';
const MAX_DEDUPED_TX_HASHES = 256;
const DEFAULT_STRATEGY_TASK_BASE_VOLUME_USD = 300;
const DEFAULT_DISTRIBUTION_CHUNK_COUNT = 3;
const DEFAULT_DISTRIBUTION_DELAY_JITTER_MS = 2_000;

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
  contractAddress: string;
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

export interface PersistedStrategyEngineState {
  config: StrategyEngineDurableObjectConfig | null;
  status: StrategyEngineDurableObjectStatus;
  metrics: StrategyEngineDurableObjectMetrics;
  currentEngineState: EngineState | null;
  pendingTasks: StrategyEngineDurableObjectTask[];
  dedupedTxHashes: string[];
  updatedAt: number;
}

function buildDurableObjectName(userId: number, contractAddress: string): string {
  return `${userId}:${contractAddress}`;
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
  contractAddress: string,
): string {
  return buildDurableObjectName(userId, contractAddress);
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
        `[StrategyEngineDO] Swap execution failed for ${nextTask.side} ${nextTask.amountUsd} on ${config.contractAddress}:`,
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
    state.status = 'running';
    state.metrics = createEmptyMetrics(startTime);
    state.currentEngineState = buildInitialStateForObjective(state.config.macroObjective);
    state.pendingTasks = [];
    state.dedupedTxHashes = [];
    this.ensureBasePlanIfNeeded(startTime);
    await this.persistState();
    await this.ctx.storage.setAlarm(startTime);
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
    const contractAddress = normalizePubkey(normalizedDocument.parameters.contractAddress);
    const nextConfig: StrategyEngineDurableObjectConfig = {
      userId: input.userId,
      versionId: input.versionId,
      contractAddress,
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
      previousConfig.contractAddress !== nextConfig.contractAddress ||
      previousConfig.macroObjective !== nextConfig.macroObjective;

    this.persistedState.config = nextConfig;
    if (configChanged && this.persistedState.status !== 'running') {
      this.persistedState.currentEngineState = buildInitialStateForObjective(nextConfig.macroObjective);
      this.persistedState.pendingTasks = [];
      this.persistedState.dedupedTxHashes = [];
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
    if (normalizedContractAddress !== config.contractAddress) {
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

    let triggered = false;
    const now = Date.now();
    if (event.type === 'whale_buy') {
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

    if (event.type === 'whale_sell' && config.macroObjective === 'accumulation') {
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

    const activeAccounts = await getActiveAccounts(this.env, config.userId);
    if (activeAccounts.length === 0) {
      throw new ApiError(
        409,
        'No active managed accounts available for strategy execution',
      );
    }

    const slices = distributeVolumeAcrossAccounts(
      task.amountUsd,
      activeAccounts.length,
    );
    let executedVolumeUsd = 0;
    let retryVolumeUsd = 0;

    for (let index = 0; index < activeAccounts.length; index += 1) {
      const account = activeAccounts[index];
      const sliceVolumeUsd = slices[index] ?? 0;
      if (!Number.isFinite(sliceVolumeUsd) || sliceVolumeUsd <= 0) {
        continue;
      }

      try {
        const swapInput = await this.resolveSwapInput(task.side, sliceVolumeUsd);
        const swap = await executeSwap(
          this.env,
          task.side,
          swapInput.amountAtomic,
          swapInput.inputMint,
          swapInput.outputMint,
          {
            slippageBps: Math.max(1, config.strategyDocument.parameters.maxSlippageBps),
            commitment: config.execution.commitment,
            signer: {
              publicKey: account.publicKey,
              privateKey: account.privateKeyBytes,
            },
          },
        );
        executedVolumeUsd += swap.executedVolumeUsd;
      } catch (error: unknown) {
        retryVolumeUsd += sliceVolumeUsd;
        console.error(
          `[StrategyEngineDO] Account ${account.publicKey} failed ${task.side} slice ${sliceVolumeUsd} on ${config.contractAddress}:`,
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
    inputMint: string;
    outputMint: string;
  }> {
    const config = this.persistedState.config;
    if (!config) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }

    if (side === 'buy') {
      return {
        amountAtomic: String(Math.max(1, Math.round(volumeUsd * 1_000_000))),
        inputMint: SOLANA_USDC_MINT,
        outputMint: config.contractAddress,
      };
    }

    const tokenRow = await this.env.TRADINGBOT_DB
      .prepare(
        'SELECT decimals FROM tradable_tokens WHERE network = ?1 AND contract_address = ?2 LIMIT 1',
      )
      .bind('solana', config.contractAddress)
      .first<{ decimals: number | null }>();

    const tokenId = await dbResolveTradableTokenId(
      this.env.TRADINGBOT_DB,
      config.contractAddress,
    );
    const marketSnapshot = tokenId
      ? await dbGetLatestTokenMarketSnapshot(this.env.TRADINGBOT_DB, tokenId)
      : null;
    const jupiterMeta = await fetchJupiterTokenMetadata(config.contractAddress);
    const tokenPriceUsd =
      marketSnapshot?.priceUsd ??
      jupiterMeta?.usdPrice ??
      (await fetchJupiterTokenPrice(config.contractAddress));
    const tokenDecimals =
      tokenRow?.decimals ??
      jupiterMeta?.decimals ??
      (await fetchSolanaMintDecimals(
        this.env.RPC_URL?.trim() || this.env.SOLANA_RPC_URL?.trim() || '',
        config.contractAddress,
      ));

    if (
      tokenPriceUsd == null ||
      !Number.isFinite(tokenPriceUsd) ||
      tokenPriceUsd <= 0
    ) {
      throw new ApiError(
        503,
        `Cannot resolve a positive USD price for ${config.contractAddress}`,
      );
    }
    if (tokenDecimals == null || !Number.isFinite(tokenDecimals) || tokenDecimals < 0) {
      throw new ApiError(
        503,
        `Cannot resolve token decimals for ${config.contractAddress}`,
      );
    }

    const tokenAmount = volumeUsd / tokenPriceUsd;
    const amountAtomic = Math.max(1, Math.round(tokenAmount * 10 ** tokenDecimals));
    return {
      amountAtomic: String(amountAtomic),
      inputMint: config.contractAddress,
      outputMint: SOLANA_USDC_MINT,
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
      contractAddress: config.contractAddress,
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
      this.persistedState = stored ?? createIdleState();
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