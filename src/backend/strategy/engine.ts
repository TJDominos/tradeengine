import {
  BaseTradingStrategy,
  type StrategyLifecycleState,
  type TradingStrategyContext,
} from './algorithms/baseStrategy';
import { AccumulationStrategy } from './algorithms/accumulation';
import { DistributionStrategy } from './algorithms/distribution';
import { ShakeoutStrategy } from './algorithms/shakeout';
import {
  STRATEGY_SNAPSHOT_MAX_AGE_MS,
  DEFAULT_EXECUTION_CONFIG,
  supportsTwentyFourHourAggregatesOnly,
} from './config';
import {
  StrategyTaskQueue,
  type StrategyQueuedTask,
  type StrategyTaskInput,
} from './taskQueue';
import type { StrategyTaskExecutionContext } from '../workerCore';
import type {
  StrategyAllocatedAccount,
  StrategyExecutionAccountAllocationInput,
  StrategyExecutionConfig,
  StrategyExecutionTactics,
  StrategyExecutionPlan,
  StrategyExecutionPlanningInput,
  StrategyExecutionPlanSlice,
  StrategyEvaluationInput,
  StrategyEvaluationMetric,
  StrategyEvaluationResult,
  StrategyMacroObjective,
} from './types';

const MIN_PLAN_WEIGHT = 0.000001;

export type MacroObjective = StrategyMacroObjective;

export type EngineState = StrategyLifecycleState;

export interface StrategyConfig {
  macroObjective: MacroObjective;
  contractAddress: string;
  tactics: Partial<StrategyExecutionTactics>;
  baseOrderCount?: number;
  baseTotalVolumeUsd?: number;
  baseDurationMs?: number;
  distributionChunkCount?: number;
  distributionChunkDelayJitterMs?: number;
  execution?: Partial<
    Pick<
      StrategyExecutionConfig,
      'enabled' | 'route' | 'commitment' | 'timeJitterRatio' | 'volumeJitterRatio'
    >
  >;
  taskHandler?: (task: StrategyQueuedTask) => Promise<void>;
  dispatchContext?: StrategyTaskExecutionContext;
  allocateAccount?: (
    input: StrategyExecutionAccountAllocationInput,
  ) => Promise<StrategyAllocatedAccount | null>;
  onTaskError?: (task: StrategyQueuedTask, error: unknown) => void | Promise<void>;
  now?: () => number;
  random?: () => number;
}

function withDefaultTactics(
  tactics: Partial<StrategyExecutionTactics> | undefined,
): StrategyExecutionTactics {
  return {
    dumpRatio: tactics?.dumpRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.dumpRatio,
    followSellRatio:
      tactics?.followSellRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.followSellRatio,
    absorbRatio: tactics?.absorbRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.absorbRatio,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sanitizePositiveNumber(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function randomInRange(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

function buildNormalizedWeights(
  count: number,
  jitterRatio: number,
  random: () => number,
): number[] {
  if (count <= 0) {
    return [];
  }
  const boundedJitterRatio = clampNumber(jitterRatio, 0, 0.5);
  const rawWeights = Array.from({ length: count }, () => {
    const weight =
      1 + randomInRange(random, -boundedJitterRatio, boundedJitterRatio);
    return Math.max(MIN_PLAN_WEIGHT, weight);
  });
  const totalWeight = rawWeights.reduce((sum, weight) => sum + weight, 0);
  return rawWeights.map((weight) => weight / totalWeight);
}

function buildSchedule(
  startTime: number,
  durationMs: number,
  orderCount: number,
  jitterRatio: number,
  random: () => number,
): number[] {
  if (orderCount <= 0) {
    return [];
  }
  if (orderCount === 1 || durationMs <= 0) {
    return [Math.round(startTime)];
  }
  const intervalWeights = buildNormalizedWeights(orderCount - 1, jitterRatio, random);
  const schedule = [Math.round(startTime)];
  let cursor = startTime;
  for (const weight of intervalWeights) {
    cursor += durationMs * weight;
    schedule.push(Math.round(cursor));
  }
  schedule[schedule.length - 1] = Math.round(startTime + durationMs);
  return schedule;
}

export async function assignAccountsToExecutionPlan(
  plan: StrategyExecutionPlan,
  input: {
    contractAddress?: string;
    allocateAccount: (
      input: StrategyExecutionAccountAllocationInput,
    ) => Promise<StrategyAllocatedAccount | null>;
  },
): Promise<StrategyExecutionPlan> {
  const slices: StrategyExecutionPlanSlice[] = [];
  for (const slice of plan.slices) {
    const allocatedAccount = await input.allocateAccount({
      action: plan.side,
      estimatedAmount: slice.targetVolume,
      scheduledAt: slice.scheduledAt,
      orderIndex: slice.orderIndex,
    });
    slices.push({
      ...slice,
      accountId: allocatedAccount?.accountId ?? null,
      walletAddress: allocatedAccount?.walletAddress ?? null,
      taskPayload: {
        action: plan.side === 'buy' ? 'BUY' : 'SELL',
        accountId: allocatedAccount?.accountId ?? null,
        walletAddress: allocatedAccount?.walletAddress ?? null,
        contractAddress: input.contractAddress ?? null,
        requestedAmount: slice.targetVolume,
        scheduledAt: slice.scheduledAt,
      },
    });
  }

  return {
    ...plan,
    slices,
  };
}

export function buildRandomizedTwapPlan(
  execution: StrategyExecutionConfig,
  input: StrategyExecutionPlanningInput,
): StrategyExecutionPlan {
  const totalVolume = sanitizePositiveNumber(input.totalVolume);
  const orderCount = Math.max(1, Math.floor(input.orderCount));
  const durationMs = Math.max(0, Math.round(input.durationMs));
  const random = input.random ?? Math.random;
  const startTime = Math.round(input.startTime);
  const baseVolume = orderCount > 0 ? totalVolume / orderCount : 0;
  const baseIntervalMs = orderCount > 1 ? durationMs / (orderCount - 1) : durationMs;
  const volumeWeights = buildNormalizedWeights(
    orderCount,
    execution.volumeJitterRatio,
    random,
  );
  const schedule = buildSchedule(
    startTime,
    durationMs,
    orderCount,
    execution.timeJitterRatio,
    random,
  );

  let cumulativeTargetVolume = 0;
  const slices: StrategyExecutionPlanSlice[] = volumeWeights.map((weight, index) => {
    const remainingVolume = Math.max(0, totalVolume - cumulativeTargetVolume);
    const targetVolume =
      index === orderCount - 1
        ? remainingVolume
        : Math.min(remainingVolume, totalVolume * weight);
    cumulativeTargetVolume += targetVolume;
    const previousTime = index === 0 ? startTime : schedule[index - 1] ?? startTime;
    const scheduledAt = schedule[index] ?? Math.round(startTime + durationMs);
    return {
      orderIndex: index + 1,
      scheduledAt,
      intervalMsFromPrevious: Math.max(0, scheduledAt - previousTime),
      targetVolume,
      cumulativeTargetVolume,
      accountId: null,
      walletAddress: null,
      taskPayload: {
        action: input.side === 'buy' ? 'BUY' : 'SELL',
        accountId: null,
        walletAddress: null,
        contractAddress: input.contractAddress ?? null,
        requestedAmount: targetVolume,
        scheduledAt,
      },
    };
  });

  return {
    side: input.side,
    totalVolume,
    orderCount,
    durationMs,
    startTime,
    generatedAt: Date.now(),
    baseVolume,
    baseIntervalMs,
    timeJitterRatio: clampNumber(execution.timeJitterRatio, 0, 0.5),
    volumeJitterRatio: clampNumber(execution.volumeJitterRatio, 0, 0.5),
    slices,
  };
}

function buildExecutionConfig(config: StrategyConfig): StrategyExecutionConfig {
  return {
    ...DEFAULT_EXECUTION_CONFIG,
    ...config.execution,
    macroObjective: config.macroObjective,
    tactics: withDefaultTactics(config.tactics),
  };
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

function createActiveStrategy(
  macroObjective: MacroObjective,
  context: TradingStrategyContext,
): BaseTradingStrategy {
  switch (macroObjective) {
    case 'shakeout':
      return new ShakeoutStrategy(context);
    case 'distribution':
      return new DistributionStrategy(context);
    case 'accumulation':
    default:
      return new AccumulationStrategy(context);
  }
}

export class StrategyEngine {
  public readonly macroObjective: MacroObjective;

  public currentState: EngineState;

  public readonly queue: StrategyTaskQueue;

  public readonly config: StrategyConfig;

  private readonly executionConfig: StrategyExecutionConfig;

  private readonly now: () => number;

  private readonly random: () => number;

  private readonly strategyContext: TradingStrategyContext;

  private readonly activeStrategy: BaseTradingStrategy;

  constructor(config: StrategyConfig) {
    this.config = {
      ...config,
      tactics: withDefaultTactics(config.tactics),
    };
    this.macroObjective = this.config.macroObjective;
    this.executionConfig = buildExecutionConfig(this.config);
    this.now = this.config.now ?? (() => Date.now());
    this.random = this.config.random ?? Math.random;
    this.queue = new StrategyTaskQueue(this.config.taskHandler, {
      onTaskError: this.config.onTaskError,
      now: this.now,
      dispatchContext: this.config.dispatchContext,
    });
    this.currentState = buildInitialStateForObjective(this.macroObjective);
    this.strategyContext = {
      macroObjective: this.macroObjective,
      contractAddress: this.config.contractAddress,
      tactics: this.executionConfig.tactics,
      queue: this.queue,
      now: this.now,
      random: this.random,
      getState: () => this.currentState,
      setState: (state) => {
        this.currentState = state;
      },
      hasNormalWorkQueued: () => this.hasNormalWorkQueued(),
      pauseQueue: () => {
        this.queue.pause();
      },
      resumeQueue: () => {
        this.queue.resume();
      },
      getBaseTotalVolumeUsd: () => this.getBaseTotalVolumeUsd(),
      getBaseOrderCount: () => this.getBaseOrderCount(),
      getBaseDurationMs: () => this.getBaseDurationMs(),
      getDistributionChunkCount: () =>
        Math.max(1, Math.floor(this.config.distributionChunkCount ?? 3)),
      getDistributionChunkDelayJitterMs: () =>
        Math.max(0, Math.round(this.config.distributionChunkDelayJitterMs ?? 2_000)),
      enqueuePulsePlan: (input) => this.enqueuePulsePlan(input),
      enqueueSinglePreemptiveTask: (input) => this.enqueueSinglePreemptiveTask(input),
    };
    this.activeStrategy = createActiveStrategy(this.macroObjective, this.strategyContext);
    void this.activeStrategy.onInit();
  }

  public get contractAddress(): string {
    return this.config.contractAddress;
  }

  public getExecutionConfig(): StrategyExecutionConfig {
    return this.executionConfig;
  }

  private getBaseTotalVolumeUsd(): number {
    return sanitizePositiveNumber(this.config.baseTotalVolumeUsd ?? 300);
  }

  private getBaseOrderCount(): number {
    return Math.max(1, Math.floor(this.config.baseOrderCount ?? 6));
  }

  private getBaseDurationMs(): number {
    return Math.max(1_000, Math.round(this.config.baseDurationMs ?? 30 * 60 * 1000));
  }

  private async allocateTaskInput(
    action: 'BUY' | 'SELL',
    requestedAmount: number,
    scheduledAt: number,
    orderIndex = 0,
  ): Promise<Pick<StrategyTaskInput, 'accountId' | 'walletAddress'>> {
    if (!this.config.allocateAccount) {
      return {
        accountId: null,
        walletAddress: null,
      };
    }

    const allocation = await this.config.allocateAccount({
      action: action === 'BUY' ? 'buy' : 'sell',
      estimatedAmount: requestedAmount,
      scheduledAt,
      orderIndex,
    });
    return {
      accountId: allocation?.accountId ?? null,
      walletAddress: allocation?.walletAddress ?? null,
    };
  }

  private async enqueuePulsePlan(input: {
    side: 'buy' | 'sell';
    totalVolumeUsd: number;
    orderCount: number;
    durationMs: number;
    enqueue: 'normal' | 'preemptive';
    metadata?: Record<string, unknown>;
    scheduledOffsetMs?: number;
  }): Promise<StrategyExecutionPlan | null> {
    const totalVolumeUsd = sanitizePositiveNumber(input.totalVolumeUsd);
    if (totalVolumeUsd <= 0) {
      return null;
    }

    const plan = buildRandomizedTwapPlan(this.executionConfig, {
      side: input.side,
      totalVolume: totalVolumeUsd,
      orderCount: Math.max(1, Math.floor(input.orderCount)),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      startTime: this.now(),
      random: this.random,
      contractAddress: this.config.contractAddress,
    });
    const allocatedPlan = this.config.allocateAccount
      ? await assignAccountsToExecutionPlan(plan, {
          contractAddress: this.config.contractAddress,
          allocateAccount: this.config.allocateAccount,
        })
      : plan;

    for (const slice of allocatedPlan.slices) {
      const queueInput: StrategyTaskInput = {
        ...slice.taskPayload,
        scheduledAt: slice.scheduledAt + (input.scheduledOffsetMs ?? 0),
        metadata: {
          macroObjective: this.macroObjective,
          engineState: this.currentState,
          orderIndex: slice.orderIndex,
          totalOrders: allocatedPlan.orderCount,
          ...input.metadata,
        },
      };
      if (input.enqueue === 'preemptive') {
        this.queue.enqueuePreemptive(queueInput);
      } else {
        this.queue.enqueueNormal(queueInput);
      }
    }

    return allocatedPlan;
  }

  private hasNormalWorkQueued(): boolean {
    return this.queue.snapshot().normalQueueSize > 0;
  }

  private async enqueueSinglePreemptiveTask(input: {
    action: 'BUY' | 'SELL';
    amountUsd: number;
    delayMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const requestedAmount = sanitizePositiveNumber(input.amountUsd);
    if (requestedAmount <= 0) {
      return;
    }
    const scheduledAt = this.now() + Math.max(0, Math.round(input.delayMs ?? 0));
    const account = await this.allocateTaskInput(
      input.action,
      requestedAmount,
      scheduledAt,
      0,
    );
    this.queue.enqueuePreemptive({
      action: input.action,
      accountId: account.accountId,
      walletAddress: account.walletAddress,
      contractAddress: this.config.contractAddress,
      requestedAmount,
      scheduledAt,
      delayMs: input.delayMs,
      metadata: {
        macroObjective: this.macroObjective,
        engineState: this.currentState,
        ...input.metadata,
      },
    });
  }

  public async onExternalWhaleBuy(amountUsd: number): Promise<void> {
    await this.activeStrategy.onExternalWhaleBuy(amountUsd);
  }

  public async onExternalWhaleSell(amountUsd: number): Promise<void> {
    await this.activeStrategy.onExternalWhaleSell(amountUsd);
  }

  public async onLossCut(amountUsd: number): Promise<void> {
    await this.activeStrategy.onLossCut(amountUsd);
  }

  public async executeDump(externalBuyAmount: number): Promise<void> {
    await this.onExternalWhaleBuy(externalBuyAmount);
  }

  public async executeScoop(lossCutAmount: number): Promise<void> {
    await this.onLossCut(lossCutAmount);
  }

  public async executeFollowSell(externalBuyAmount: number): Promise<void> {
    await this.onExternalWhaleBuy(externalBuyAmount);
  }

  public async executeAbsorb(externalSellAmount: number): Promise<void> {
    await this.onExternalWhaleSell(externalSellAmount);
  }
}

function matchesConfiguredEvent(eventType: string, configuredEventTypes: string[]): boolean {
  if (configuredEventTypes.length === 0) {
    return true;
  }
  if (configuredEventTypes.includes('*')) {
    return true;
  }
  return configuredEventTypes.some(
    (configured) => configured === eventType || eventType.startsWith(`${configured}:`),
  );
}

function pushMetric(metrics: StrategyEvaluationMetric[], metric: StrategyEvaluationMetric): void {
  metrics.push(metric);
}

export function evaluateStrategy(
  input: StrategyEvaluationInput,
): StrategyEvaluationResult {
  const { strategy, trigger, marketSnapshot, evaluatedAt } = input;
  const reasons: string[] = [];
  const metrics: StrategyEvaluationMetric[] = [];

  const triggerAccepted =
    strategy.triggers.sources.includes(trigger.source) &&
    matchesConfiguredEvent(trigger.eventType, strategy.triggers.eventTypes);
  if (!triggerAccepted) {
    reasons.push(
      `Trigger ${trigger.source}/${trigger.eventType} is not enabled for this strategy version`,
    );
  }

  const contractMatched =
    !strategy.parameters.contractAddress ||
    strategy.parameters.contractAddress === trigger.contractAddress;
  if (!contractMatched) {
    reasons.push(
      `Trigger contract ${trigger.contractAddress} does not match active strategy contract ${strategy.parameters.contractAddress}`,
    );
  }

  const snapshotPresent = marketSnapshot != null;
  const snapshotFresh =
    snapshotPresent &&
    evaluatedAt - marketSnapshot.fetchedAt <= STRATEGY_SNAPSHOT_MAX_AGE_MS;
  if (!snapshotPresent) {
    reasons.push('No market snapshot is available for strategy evaluation');
  } else if (!snapshotFresh) {
    reasons.push('Market snapshot is stale and cannot drive automated execution');
  }

  const aggregatesSupported = supportsTwentyFourHourAggregatesOnly(
    strategy.parameters.timeRangeTarget,
  );

  const volumeThreshold = strategy.targets.volumeUsdMin;
  if (volumeThreshold > 0) {
    const available = snapshotPresent && aggregatesSupported && marketSnapshot.volume24h != null;
    const satisfied = available ? (marketSnapshot.volume24h ?? 0) >= volumeThreshold : null;
    pushMetric(metrics, {
      name: 'volume24h',
      required: true,
      available,
      value: available ? marketSnapshot?.volume24h ?? null : null,
      threshold: volumeThreshold,
      comparator: 'gte',
      satisfied,
      note: aggregatesSupported
        ? undefined
        : `Current engine only supports 24h aggregate volume, not ${strategy.parameters.timeRangeTarget}`,
    });
    if (!available && strategy.riskControls.requireCompleteMetrics) {
      reasons.push(
        aggregatesSupported
          ? '24h volume is unavailable for the current market snapshot'
          : `24h volume cannot satisfy requested time range ${strategy.parameters.timeRangeTarget}`,
      );
    } else if (satisfied === false) {
      reasons.push(`24h volume ${marketSnapshot?.volume24h ?? 0} is below target ${volumeThreshold}`);
    }
  }

  const maxTransactions = strategy.parameters.maxTransactions;
  if (maxTransactions > 0) {
    const available =
      snapshotPresent && aggregatesSupported && marketSnapshot.totalTransactions24h != null;
    const satisfied =
      available ? (marketSnapshot.totalTransactions24h ?? 0) <= maxTransactions : null;
    pushMetric(metrics, {
      name: 'transactions24h',
      required: true,
      available,
      value: available ? marketSnapshot?.totalTransactions24h ?? null : null,
      threshold: maxTransactions,
      comparator: 'lte',
      satisfied,
      note: aggregatesSupported
        ? undefined
        : `Current engine only supports 24h aggregate transaction counts, not ${strategy.parameters.timeRangeTarget}`,
    });
    if (!available && strategy.riskControls.requireCompleteMetrics) {
      reasons.push(
        aggregatesSupported
          ? '24h transaction count is unavailable for the current market snapshot'
          : `24h transaction count cannot satisfy requested time range ${strategy.parameters.timeRangeTarget}`,
      );
    } else if (satisfied === false) {
      reasons.push(
        `24h transaction count ${marketSnapshot?.totalTransactions24h ?? 0} exceeds max ${maxTransactions}`,
      );
    }
  }

  const unsupportedTargets = [
    {
      name: 'netBuyinUsd',
      threshold: strategy.targets.netBuyinUsdMin,
      description: 'Net buyin is not yet derived from the current market snapshot pipeline',
    },
    {
      name: 'volatilityPct',
      threshold: strategy.targets.volatilityPctMin,
      description: 'Volatility is not yet derived from the current market snapshot pipeline',
    },
    {
      name: 'pullbackPct',
      threshold: strategy.targets.pullbackPctMax,
      description: 'Pullback is not yet derived from the current market snapshot pipeline',
    },
  ];

  for (const target of unsupportedTargets) {
    if (target.threshold <= 0) {
      continue;
    }
    pushMetric(metrics, {
      name: target.name,
      required: true,
      available: false,
      value: null,
      threshold: target.threshold,
      comparator: 'gte',
      satisfied: null,
      note: target.description,
    });
    if (strategy.riskControls.requireCompleteMetrics) {
      reasons.push(target.description);
    }
  }

  const qualified = reasons.length === 0;
  const dryRun = strategy.riskControls.dryRun || !strategy.execution.enabled;
  const shouldExecute = qualified && strategy.execution.enabled && !strategy.riskControls.dryRun;

  return {
    status: qualified ? 'accepted' : 'blocked',
    qualified,
    shouldExecute,
    dryRun,
    reasons,
    metrics,
    triggerAccepted,
    contractMatched,
    snapshotPresent,
    snapshotFresh,
  };
}