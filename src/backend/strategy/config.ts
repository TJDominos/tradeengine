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
  '15m',
  '30m',
  '1h',
  '4h',
  '6h',
  '12h',
  '24h',
  '3d',
  '7d',
] as const;
export const MIN_TIME_RANGE_MINUTES = 1;
export const MAX_TIME_RANGE_MINUTES = 7 * 24 * 60;
const TIME_RANGE_TARGET_PATTERN = /^(\d+(?:\.\d+)?)[\s]*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/;

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
  if (!TIME_RANGE_TARGET_PATTERN.test(value.trim().toLowerCase())) {
    return false;
  }
  const minutes = parseTimeRangeTargetToMinutes(value);
  return Number.isInteger(minutes) && minutes >= MIN_TIME_RANGE_MINUTES && minutes <= MAX_TIME_RANGE_MINUTES;
}

export function supportsTwentyFourHourAggregatesOnly(timeRangeTarget: string): boolean {
  return parseTimeRangeTargetToHours(timeRangeTarget) === 24;
}

export function parseTimeRangeTargetToMinutes(value: string): number {
  const normalizedValue = value.trim().toLowerCase();
  const match = normalizedValue.match(TIME_RANGE_TARGET_PATTERN);
  if (!match) {
    return 24 * 60;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = ['w', 'week', 'weeks'].includes(unit)
    ? 7 * 24 * 60
    : ['d', 'day', 'days'].includes(unit)
      ? 24 * 60
      : ['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)
        ? 60
        : 1;
  return Number.isFinite(amount) ? amount * multiplier : 24 * 60;
}

export function parseTimeRangeTargetToHours(value: string): number {
  return parseTimeRangeTargetToMinutes(value) / 60;
}

export function normalizeTimeRangeTarget(value: string): string {
  const minutes = parseTimeRangeTargetToMinutes(value);
  if (
    !Number.isFinite(minutes) ||
    !Number.isInteger(minutes) ||
    minutes < MIN_TIME_RANGE_MINUTES ||
    minutes > MAX_TIME_RANGE_MINUTES
  ) {
    return '1d';
  }
  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

export function parseTimeRangeTargetToDurationMs(timeRangeTarget: string): number {
  return parseTimeRangeTargetToMinutes(timeRangeTarget) * 60 * 1000;
}