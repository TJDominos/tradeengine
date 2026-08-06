import type { StrategyTaskQueue } from '../taskQueue';
import type {
  StrategyExecutionPlan,
  StrategyExecutionTactics,
  StrategyMacroObjective,
} from '../types';

export type StrategyLifecycleState =
  | 'BUILDING_TREND'
  | 'DUMPING'
  | 'WAITING_FOR_LOSS_CUT'
  | 'DISTRIBUTING'
  | 'ACCUMULATING';

export interface TradingStrategyPulseInput {
  side: 'buy' | 'sell';
  totalVolumeUsd: number;
  orderCount: number;
  durationMs: number;
  enqueue: 'normal' | 'preemptive';
  metadata?: Record<string, unknown>;
  scheduledOffsetMs?: number;
}

export interface TradingStrategyImmediateTaskInput {
  action: 'BUY' | 'SELL';
  amountUsd: number;
  delayMs?: number;
  metadata?: Record<string, unknown>;
}

export interface TradingStrategyContext {
  readonly macroObjective: StrategyMacroObjective;
  readonly contractAddress: string;
  readonly tactics: StrategyExecutionTactics;
  readonly queue: StrategyTaskQueue;
  readonly now: () => number;
  readonly random: () => number;
  getState(): StrategyLifecycleState;
  setState(state: StrategyLifecycleState): void;
  hasNormalWorkQueued(): boolean;
  pauseQueue(): void;
  resumeQueue(): void;
  getBaseTotalVolumeUsd(): number;
  getBaseOrderCount(): number;
  getBaseDurationMs(): number;
  getDistributionChunkCount(): number;
  getDistributionChunkDelayJitterMs(): number;
  enqueuePulsePlan(
    input: TradingStrategyPulseInput,
  ): Promise<StrategyExecutionPlan | null>;
  enqueueSinglePreemptiveTask(
    input: TradingStrategyImmediateTaskInput,
  ): Promise<void>;
}

export abstract class BaseTradingStrategy {
  protected constructor(protected readonly context: TradingStrategyContext) {}

  public abstract readonly macroObjective: StrategyMacroObjective;

  public abstract onInit(): Promise<void> | void;

  public abstract onExternalWhaleBuy(amountUsd: number): Promise<void> | void;

  public abstract onExternalWhaleSell(amountUsd: number): Promise<void> | void;

  public abstract onLossCut(amountUsd: number): Promise<void> | void;
}