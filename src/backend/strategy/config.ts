import type {
  StrategyExecutionConfig,
  StrategyRiskControls,
  StrategyTriggerConfig,
  StrategyType,
} from './types';

export const STRATEGY_SCHEMA_VERSION = 1;
export const STRATEGY_ENGINE_VERSION = '1.0.0';
export const PRIMARY_STRATEGY_NAME = 'Primary Strategy';
export const DEFAULT_STRATEGY_TYPE: StrategyType = 'solana-auto-trade';
export const STRATEGY_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

export const SUPPORTED_TIME_RANGE_TARGETS = [
  '1h',
  '6h',
  '12h',
  '24h',
  '3d',
  '1w',
] as const;

export const DEFAULT_TRIGGER_CONFIG: StrategyTriggerConfig = {
  sources: ['alchemy_notify', 'manual_refresh'],
  eventTypes: ['*'],
  cooldownMs: 30_000,
  idempotencyWindowMs: 300_000,
  onExternalBuy: 'watch_and_wait',
  onExternalSell: 'pause_strategy',
  triggerThresholdUsd: 0,
};

export const DEFAULT_RISK_CONTROLS: StrategyRiskControls = {
  maxPositionUsd: null,
  maxDailyLossUsd: null,
  maxConcurrentOrders: 1,
  requireCompleteMetrics: true,
};

export const DEFAULT_EXECUTION_CONFIG: StrategyExecutionConfig = {
  enabled: false,
  route: 'jupiter',
  commitment: 'confirmed',
  timeJitterRatio: 0.15,
  volumeJitterRatio: 0.15,
  macroObjective: 'accumulation',
  tactics: {
    dumpRatio: 1.2,
    followSellRatio: 0.8,
    absorbRatio: 1.0,
  },
};

export function isSupportedTimeRangeTarget(value: string): boolean {
  return (SUPPORTED_TIME_RANGE_TARGETS as readonly string[]).includes(value);
}

export function supportsTwentyFourHourAggregatesOnly(timeRangeTarget: string): boolean {
  return timeRangeTarget === '24h';
}