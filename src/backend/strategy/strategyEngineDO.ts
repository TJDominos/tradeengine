import { ApiError } from '../errors';
import type { Env } from '../workerShared';
import { executeTradeTask, normalizePubkey } from '../workerCore';
import {
  buildRandomizedTwapPlan,
  type EngineState,
  type MacroObjective,
} from './engine';
import { DEFAULT_EXECUTION_CONFIG } from './config';
import { normalizeStrategyDocument } from './migrations';
import {
  TriggerHandler,
  type ExternalTradeEvent,
  type StrategyEventRouterTarget,
} from './triggers';
import type {
  StrategyExecutionConfig,
  StrategyExecutionTaskPayload,
  StrategyVersionDocument,
} from './types';
import type { StrategyQueuedTask } from './taskQueue';

const STORAGE_KEY = 'strategy-engine-state';
const MAX_DEDUPED_TX_HASHES = 256;
const DEFAULT_STRATEGY_TASK_BASE_VOLUME_USD = 300;

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
  userId: number;
  versionId: number;
  contractAddress: string;
  macroObjective: MacroObjective;
  currentState: EngineState;
  triggerThresholdUsd: number;
  execution: StrategyExecutionConfig;
  dryRun: boolean;
  paused: boolean;
  queue: StrategyQueuedTask[];
  dedupedTxHashes: string[];
  baseOrderCount: number;
  baseTotalVolumeUsd: number;
  baseDurationMs: number;
  distributionChunkCount: number;
  distributionChunkDelayJitterMs: number;
  updatedAt: number;
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

function buildDurableObjectName(userId: number, contractAddress: string): string {
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

function createTaskId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `strategy-task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sortQueuedTasks(tasks: StrategyQueuedTask[]): void {
  tasks.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority === 'preemptive' ? -1 : 1;
    }
    if (left.scheduledAt !== right.scheduledAt) {
      return left.scheduledAt - right.scheduledAt;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.id.localeCompare(right.id);
  });
}

export function strategyEngineDurableObjectNameFor(
  userId: number,
  contractAddress: string,
): string {
  return buildDurableObjectName(userId, contractAddress);
}

export class StrategyEngineDurableObject implements StrategyEventRouterTarget {
  private persistedState: PersistedStrategyEngineState | null = null;

  private hydrated = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  public get macroObjective(): MacroObjective {
    return this.requireState().macroObjective;
  }

  public get contractAddress(): string {
    return this.requireState().contractAddress;
  }

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/state') {
      await this.ensureHydrated();
      return Response.json(this.persistedState);
    }

    if (request.method === 'POST' && url.pathname === '/configure') {
      const body = await request.json<StrategyEngineDurableObjectConfigureRequest>();
      await this.applyConfiguration(body);
      return Response.json({ ok: true, configured: true });
    }

    if (request.method === 'POST' && url.pathname === '/event') {
      const body = await request.json<StrategyEngineDurableObjectEventRequest>();
      await this.applyConfiguration(body);
      const duplicate = await this.handleExternalTradeEvent(body.event);
      return Response.json({ ok: true, accepted: !duplicate, duplicate });
    }

    if (request.method === 'POST' && url.pathname === '/clear') {
      await this.ensureHydrated();
      if (this.persistedState) {
        this.persistedState.queue = [];
        this.persistedState.paused = false;
        await this.persistState();
      }
      return Response.json({ ok: true, cleared: true });
    }

    return new Response('Not found', { status: 404 });
  }

  public async alarm(): Promise<void> {
    await this.ensureHydrated();
    const currentState = this.requireState();
    const now = Date.now();

    while (true) {
      const nextTask = this.popNextReadyTask(now, currentState);
      if (!nextTask) {
        break;
      }
      try {
        await executeTradeTask(nextTask, {
          env: this.env,
          userId: currentState.userId,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[StrategyEngineDO] Failed to execute task ${nextTask.id} for ${currentState.contractAddress}: ${message}`,
          error,
        );
      }
    }

    await this.ensureBasePulseIfNeeded();
    await this.persistState();
  }

  public async executeDump(externalBuyAmount: number): Promise<void> {
    const currentState = this.requireState();
    if (
      currentState.currentState === 'DUMPING' ||
      currentState.currentState === 'WAITING_FOR_LOSS_CUT'
    ) {
      return;
    }

    const dumpAmountUsd = Math.max(
      0,
      externalBuyAmount * currentState.execution.tactics.dumpRatio,
    );
    if (dumpAmountUsd <= 0) {
      return;
    }

    currentState.currentState = 'DUMPING';
    currentState.paused = true;
    this.enqueueTask({
      action: 'SELL',
      accountId: null,
      walletAddress: null,
      contractAddress: currentState.contractAddress,
      requestedAmount: dumpAmountUsd,
      scheduledAt: Date.now(),
      metadata: {
        tacticalAction: 'dump',
      },
    }, 'preemptive');
    currentState.currentState = 'WAITING_FOR_LOSS_CUT';
    await this.persistState();
  }

  public async onExternalWhaleBuy(amountUsd: number): Promise<void> {
    switch (this.macroObjective) {
      case 'shakeout':
        await this.executeDump(amountUsd);
        break;
      case 'distribution':
        await this.executeFollowSell(amountUsd);
        break;
      default:
        break;
    }
  }

  public async onExternalWhaleSell(amountUsd: number): Promise<void> {
    if (this.macroObjective === 'accumulation') {
      await this.executeAbsorb(amountUsd);
    }
  }

  public async onLossCut(amountUsd: number): Promise<void> {
    if (this.macroObjective === 'shakeout') {
      await this.executeScoop(amountUsd);
    }
  }

  public async executeScoop(lossCutAmount: number): Promise<void> {
    const currentState = this.requireState();
    if (currentState.currentState !== 'WAITING_FOR_LOSS_CUT') {
      return;
    }

    if (!Number.isFinite(lossCutAmount) || lossCutAmount <= 0) {
      return;
    }

    this.enqueueTask({
      action: 'BUY',
      accountId: null,
      walletAddress: null,
      contractAddress: currentState.contractAddress,
      requestedAmount: lossCutAmount,
      scheduledAt: Date.now(),
      metadata: {
        tacticalAction: 'scoop',
      },
    }, 'preemptive');
    currentState.currentState = 'BUILDING_TREND';
    currentState.paused = false;
    await this.ensureBasePulseIfNeeded();
    await this.persistState();
  }

  public async executeFollowSell(externalBuyAmount: number): Promise<void> {
    const currentState = this.requireState();
    const totalSellUsd = Math.max(
      0,
      externalBuyAmount * currentState.execution.tactics.followSellRatio,
    );
    if (totalSellUsd <= 0) {
      return;
    }

    currentState.currentState = 'DISTRIBUTING';
    for (let index = 0; index < currentState.distributionChunkCount; index += 1) {
      this.enqueueTask({
        action: 'SELL',
        accountId: null,
        walletAddress: null,
        contractAddress: currentState.contractAddress,
        requestedAmount: totalSellUsd / currentState.distributionChunkCount,
        scheduledAt:
          Date.now() +
          Math.round(Math.random() * currentState.distributionChunkDelayJitterMs),
        metadata: {
          tacticalAction: 'follow_sell',
          chunkIndex: index + 1,
          chunkCount: currentState.distributionChunkCount,
        },
      }, 'preemptive');
    }
    await this.persistState();
  }

  public async executeAbsorb(externalSellAmount: number): Promise<void> {
    const currentState = this.requireState();
    const absorbAmountUsd = Math.max(
      0,
      externalSellAmount * currentState.execution.tactics.absorbRatio,
    );
    if (absorbAmountUsd <= 0) {
      return;
    }

    currentState.currentState = 'ACCUMULATING';
    this.enqueueTask({
      action: 'BUY',
      accountId: null,
      walletAddress: null,
      contractAddress: currentState.contractAddress,
      requestedAmount: absorbAmountUsd,
      scheduledAt: Date.now(),
      metadata: {
        tacticalAction: 'absorb',
      },
    }, 'preemptive');
    await this.ensureBasePulseIfNeeded();
    await this.persistState();
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) {
      return;
    }

    await this.state.blockConcurrencyWhile(async () => {
      if (this.hydrated) {
        return;
      }
      const stored = await this.state.storage.get<PersistedStrategyEngineState>(STORAGE_KEY);
      this.persistedState = stored ?? null;
      this.hydrated = true;
    });
  }

  private requireState(): PersistedStrategyEngineState {
    if (!this.persistedState) {
      throw new ApiError(409, 'Strategy engine durable object is not configured');
    }
    return this.persistedState;
  }

  private async applyConfiguration(
    input: StrategyEngineDurableObjectConfigureRequest,
  ): Promise<void> {
    await this.ensureHydrated();
    const normalizedDocument = normalizeStrategyDocument(input.strategyDocument);
    const contractAddress = normalizePubkey(normalizedDocument.parameters.contractAddress);
    const versionChanged =
      !this.persistedState ||
      this.persistedState.versionId !== input.versionId ||
      this.persistedState.contractAddress !== contractAddress ||
      this.persistedState.macroObjective !== normalizedDocument.execution.macroObjective;

    const nextState: PersistedStrategyEngineState = {
      userId: input.userId,
      versionId: input.versionId,
      contractAddress,
      macroObjective: normalizedDocument.execution.macroObjective,
      currentState: versionChanged
        ? buildInitialStateForObjective(normalizedDocument.execution.macroObjective)
        : this.persistedState?.currentState ??
          buildInitialStateForObjective(normalizedDocument.execution.macroObjective),
      triggerThresholdUsd: normalizedDocument.triggers.triggerThresholdUsd,
      execution: normalizedDocument.execution,
      dryRun: normalizedDocument.riskControls.dryRun,
      paused: versionChanged ? false : this.persistedState?.paused ?? false,
      queue: versionChanged ? [] : this.persistedState?.queue ?? [],
      dedupedTxHashes: this.persistedState?.dedupedTxHashes ?? [],
      baseOrderCount: Math.max(
        1,
        Math.min(12, Math.max(3, normalizedDocument.riskControls.maxConcurrentOrders * 3)),
      ),
      baseTotalVolumeUsd:
        normalizedDocument.riskControls.maxPositionUsd ??
        (normalizedDocument.targets.volumeUsdMin > 0
          ? normalizedDocument.targets.volumeUsdMin
          : DEFAULT_STRATEGY_TASK_BASE_VOLUME_USD),
      baseDurationMs: parseTimeRangeTargetToDurationMs(
        normalizedDocument.parameters.timeRangeTarget,
      ),
      distributionChunkCount: 3,
      distributionChunkDelayJitterMs: 2_000,
      updatedAt: Date.now(),
    };

    this.persistedState = nextState;
    if (!normalizedDocument.execution.enabled || normalizedDocument.riskControls.dryRun) {
      nextState.queue = [];
      nextState.paused = false;
    } else {
      await this.ensureBasePulseIfNeeded();
    }
    await this.persistState();
  }

  private async handleExternalTradeEvent(event: ExternalTradeEvent): Promise<boolean> {
    const currentState = this.requireState();
    const normalizedContractAddress = normalizePubkey(event.contractAddress);
    if (normalizedContractAddress !== currentState.contractAddress) {
      return false;
    }

    if (currentState.dedupedTxHashes.includes(event.txHash)) {
      return true;
    }
    currentState.dedupedTxHashes = [
      ...currentState.dedupedTxHashes,
      event.txHash,
    ].slice(-MAX_DEDUPED_TX_HASHES);

    const triggerHandler = new TriggerHandler(this, currentState.triggerThresholdUsd);
    await triggerHandler.handleWebhookEvent({
      ...event,
      contractAddress: normalizedContractAddress,
    });
    await this.persistState();
    return false;
  }

  private enqueueTask(
    task: StrategyExecutionTaskPayload & {
      metadata?: Record<string, unknown>;
      delayMs?: number;
    },
    priority: StrategyQueuedTask['priority'],
  ): void {
    const currentState = this.requireState();
    currentState.queue.push({
      id: createTaskId(),
      priority,
      createdAt: Date.now(),
      delayMs: Math.max(0, Math.round(task.delayMs ?? 0)),
      action: task.action,
      accountId: task.accountId,
      walletAddress: task.walletAddress,
      contractAddress: task.contractAddress,
      requestedAmount: task.requestedAmount,
      scheduledAt: task.scheduledAt,
      metadata: task.metadata,
    });
    sortQueuedTasks(currentState.queue);
  }

  private async ensureBasePulseIfNeeded(): Promise<void> {
    const currentState = this.requireState();
    if (!currentState.execution.enabled || currentState.dryRun) {
      return;
    }

    const hasNormalTasks = currentState.queue.some((task) => task.priority === 'normal');
    if (hasNormalTasks) {
      return;
    }

    switch (currentState.currentState) {
      case 'BUILDING_TREND':
        this.enqueuePlan(
          'buy',
          currentState.baseTotalVolumeUsd,
          currentState.baseOrderCount,
          currentState.baseDurationMs,
          'normal',
          { basePulse: 'trend' },
        );
        break;
      case 'DISTRIBUTING':
        this.enqueuePlan(
          'buy',
          currentState.baseTotalVolumeUsd / 2,
          Math.max(1, Math.floor(currentState.baseOrderCount / 2)),
          currentState.baseDurationMs,
          'normal',
          { basePulse: 'wash_buy' },
        );
        this.enqueuePlan(
          'sell',
          currentState.baseTotalVolumeUsd / 2,
          Math.max(1, Math.floor(currentState.baseOrderCount / 2)),
          currentState.baseDurationMs,
          'normal',
          { basePulse: 'wash_sell' },
          750,
        );
        break;
      case 'ACCUMULATING':
        this.enqueuePlan(
          'buy',
          currentState.baseTotalVolumeUsd,
          Math.max(1, Math.ceil(currentState.baseOrderCount / 2)),
          Math.round(currentState.baseDurationMs * 1.5),
          'normal',
          { basePulse: 'slow_buy' },
        );
        break;
      default:
        break;
    }
  }

  private enqueuePlan(
    side: 'buy' | 'sell',
    totalVolumeUsd: number,
    orderCount: number,
    durationMs: number,
    priority: StrategyQueuedTask['priority'],
    metadata?: Record<string, unknown>,
    scheduledOffsetMs = 0,
  ): void {
    const currentState = this.requireState();
    const plan = buildRandomizedTwapPlan(currentState.execution, {
      side,
      totalVolume: totalVolumeUsd,
      orderCount,
      durationMs,
      startTime: Date.now(),
      contractAddress: currentState.contractAddress,
    });

    for (const slice of plan.slices) {
      this.enqueueTask({
        ...slice.taskPayload,
        accountId: null,
        walletAddress: null,
        scheduledAt: slice.scheduledAt + scheduledOffsetMs,
        metadata: {
          macroObjective: currentState.macroObjective,
          engineState: currentState.currentState,
          orderIndex: slice.orderIndex,
          totalOrders: plan.orderCount,
          ...metadata,
        },
      }, priority);
    }
  }

  private popNextReadyTask(
    now: number,
    currentState: PersistedStrategyEngineState,
  ): StrategyQueuedTask | null {
    const preemptiveIndex = currentState.queue.findIndex(
      (task) => task.priority === 'preemptive' && task.scheduledAt <= now,
    );
    if (preemptiveIndex >= 0) {
      return currentState.queue.splice(preemptiveIndex, 1)[0] ?? null;
    }
    if (currentState.paused) {
      return null;
    }
    const normalIndex = currentState.queue.findIndex(
      (task) => task.priority === 'normal' && task.scheduledAt <= now,
    );
    if (normalIndex >= 0) {
      return currentState.queue.splice(normalIndex, 1)[0] ?? null;
    }
    return null;
  }

  private async persistState(): Promise<void> {
    const currentState = this.requireState();
    currentState.updatedAt = Date.now();
    await this.state.storage.put(STORAGE_KEY, currentState);
    await this.scheduleNextAlarm(currentState);
  }

  private async scheduleNextAlarm(
    currentState: PersistedStrategyEngineState,
  ): Promise<void> {
    const nextTask = currentState.queue
      .filter((task) => !currentState.paused || task.priority === 'preemptive')
      .sort((left, right) => left.scheduledAt - right.scheduledAt)[0];

    const currentAlarm = await this.state.storage.getAlarm();
    if (!nextTask) {
      if (currentAlarm != null) {
        await this.state.storage.deleteAlarm();
      }
      return;
    }

    if (currentAlarm == null || currentAlarm !== nextTask.scheduledAt) {
      await this.state.storage.setAlarm(nextTask.scheduledAt);
    }
  }
}