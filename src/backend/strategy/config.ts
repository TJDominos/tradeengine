import type {
  StrategyExecutionConfig,
  StrategyRiskControls,
  StrategyTriggerConfig,
  StrategyType,
} from './types';

export const STRATEGY_SCHEMA_VERSION = 2;
export const STRATEGY_ENGINE_VERSION = '1.0.0';
export const PRIMARY_STRATEGY_NAME = 'Primary Strategy';
export const DEFAULT_STRATEGY_TYPE: StrategyType = 'solana-auto-trade';
export const STRATEGY_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

export const SUPPORTED_TIME_RANGE_TARGETS = [
  '1h',
  '4h',
  '6h',
  '12h',
  '24h',
  '3d',
  '1w',
] as const;
export const MIN_TIME_RANGE_HOURS = 1;
export const MAX_TIME_RANGE_HOURS = 7 * 24;

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
  enabled: true,
  route: 'jupiter',
  commitment: 'confirmed',
  timeJitterRatio: 0.15,
  volumeJitterRatio: 0.15,
  accountCyclingEnabled: true,
  accountDispersionStrength: 0.5,
  minimumQuoteReserveUsd: 0,
  macroObjective: 'accumulation',
  tactics: {
    dumpRatio: 1.2,
    followSellRatio: 0.8,
    absorbRatio: 1.0,
  },
};

export function isSupportedTimeRangeTarget(value: string): boolean {
  const hours = parseTimeRangeTargetToHours(value);
  return hours >= MIN_TIME_RANGE_HOURS && hours <= MAX_TIME_RANGE_HOURS;
}

export function supportsTwentyFourHourAggregatesOnly(timeRangeTarget: string): boolean {
  return parseTimeRangeTargetToHours(timeRangeTarget) === 24;
}

export function parseTimeRangeTargetToHours(value: string): number {
  const normalizedValue = value.trim().toLowerCase();
  const match = normalizedValue.match(/^(\d+(?:\.\d+)?)(h|d|w)$/);
  if (!match) {
    return 24;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 'w' ? 7 * 24 : unit === 'd' ? 24 : 1;
  return Number.isFinite(amount) ? amount * multiplier : 24;
}

export function normalizeTimeRangeTarget(value: string): string {
  const hours = parseTimeRangeTargetToHours(value);
  if (
    !Number.isFinite(hours) ||
    hours < MIN_TIME_RANGE_HOURS ||
    hours > MAX_TIME_RANGE_HOURS
  ) {
    return '24h';
  }
  return `${hours}h`;
}

export function parseTimeRangeTargetToDurationMs(timeRangeTarget: string): number {
  return parseTimeRangeTargetToHours(timeRangeTarget) * 60 * 60 * 1000;
}