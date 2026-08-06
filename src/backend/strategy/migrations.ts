import {
  DEFAULT_EXECUTION_CONFIG,
  DEFAULT_RISK_CONTROLS,
  DEFAULT_STRATEGY_TYPE,
  DEFAULT_TRIGGER_CONFIG,
  STRATEGY_ENGINE_VERSION,
  STRATEGY_SCHEMA_VERSION,
} from './config';
import type {
  StrategyExecutionConfig,
  StrategyExecutionTactics,
  StrategyMetadata,
  StrategyParameters,
  StrategyRiskControls,
  StrategyTargets,
  StrategyTriggerConfig,
  StrategyVersionDocument,
} from './types';

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeJitterRatio(value: unknown, fallback: number): number {
  const parsed = readNumber(value, fallback);
  return clampNumber(parsed, 0, 0.5);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeParameters(value: unknown): StrategyParameters {
  const raw = readRecord(value);
  return {
    contractAddress: readString(raw.contractAddress),
    timeRangeTarget: readString(raw.timeRangeTarget, '24h'),
    maxTransactions: readNumber(raw.maxTransactions, 100),
    maxSlippageBps: readNumber(raw.maxSlippageBps, 100),
    notes: readString(raw.notes),
  };
}

function normalizeTriggers(value: unknown): StrategyTriggerConfig {
  const raw = readRecord(value);
  return {
    sources: Array.isArray(raw.sources)
      ? raw.sources.filter((entry): entry is StrategyTriggerConfig['sources'][number] => typeof entry === 'string')
      : DEFAULT_TRIGGER_CONFIG.sources,
    eventTypes: Array.isArray(raw.eventTypes)
      ? raw.eventTypes.filter((entry): entry is string => typeof entry === 'string')
      : DEFAULT_TRIGGER_CONFIG.eventTypes,
    cooldownMs: readNumber(raw.cooldownMs, DEFAULT_TRIGGER_CONFIG.cooldownMs),
    idempotencyWindowMs: readNumber(
      raw.idempotencyWindowMs,
      DEFAULT_TRIGGER_CONFIG.idempotencyWindowMs,
    ),
    onExternalBuy:
      raw.onExternalBuy === 'reduce_target' ||
      raw.onExternalBuy === 'counter_trade' ||
      raw.onExternalBuy === 'watch_and_wait'
        ? raw.onExternalBuy
        : DEFAULT_TRIGGER_CONFIG.onExternalBuy,
    onExternalSell:
      raw.onExternalSell === 'buy_the_dip' || raw.onExternalSell === 'pause_strategy'
        ? raw.onExternalSell
        : DEFAULT_TRIGGER_CONFIG.onExternalSell,
    triggerThresholdUsd: Math.max(
      0,
      readNumber(raw.triggerThresholdUsd, DEFAULT_TRIGGER_CONFIG.triggerThresholdUsd),
    ),
  };
}

function normalizeTargets(value: unknown): StrategyTargets {
  const raw = readRecord(value);
  return {
    volumeUsdMin: readNumber(raw.volumeUsdMin, 0),
    netBuyinUsdMin: readNumber(raw.netBuyinUsdMin, 0),
    volatilityPctMin: readNumber(raw.volatilityPctMin, 0),
    pullbackPctMax: readNumber(raw.pullbackPctMax, 0),
  };
}

function normalizeRiskControls(value: unknown): StrategyRiskControls {
  const raw = readRecord(value);
  return {
    maxPositionUsd:
      typeof raw.maxPositionUsd === 'number' && Number.isFinite(raw.maxPositionUsd)
        ? raw.maxPositionUsd
        : DEFAULT_RISK_CONTROLS.maxPositionUsd,
    maxDailyLossUsd:
      typeof raw.maxDailyLossUsd === 'number' && Number.isFinite(raw.maxDailyLossUsd)
        ? raw.maxDailyLossUsd
        : DEFAULT_RISK_CONTROLS.maxDailyLossUsd,
    maxConcurrentOrders: readNumber(
      raw.maxConcurrentOrders,
      DEFAULT_RISK_CONTROLS.maxConcurrentOrders,
    ),
    dryRun: readBoolean(raw.dryRun, DEFAULT_RISK_CONTROLS.dryRun),
    requireCompleteMetrics: readBoolean(
      raw.requireCompleteMetrics,
      DEFAULT_RISK_CONTROLS.requireCompleteMetrics,
    ),
  };
}

function normalizeExecution(value: unknown): StrategyExecutionConfig {
  const raw = readRecord(value);
  const rawTactics = readRecord(raw.tactics);
  const tactics: StrategyExecutionTactics = {
    dumpRatio: Math.max(
      0,
      readNumber(rawTactics.dumpRatio, DEFAULT_EXECUTION_CONFIG.tactics.dumpRatio),
    ),
    followSellRatio: Math.max(
      0,
      readNumber(
        rawTactics.followSellRatio,
        DEFAULT_EXECUTION_CONFIG.tactics.followSellRatio,
      ),
    ),
    absorbRatio: Math.max(
      0,
      readNumber(rawTactics.absorbRatio, DEFAULT_EXECUTION_CONFIG.tactics.absorbRatio),
    ),
  };
  return {
    enabled: readBoolean(raw.enabled, DEFAULT_EXECUTION_CONFIG.enabled),
    route: raw.route === 'jupiter' ? raw.route : DEFAULT_EXECUTION_CONFIG.route,
    commitment:
      raw.commitment === 'confirmed'
        ? raw.commitment
        : DEFAULT_EXECUTION_CONFIG.commitment,
    timeJitterRatio: normalizeJitterRatio(
      raw.timeJitterRatio,
      DEFAULT_EXECUTION_CONFIG.timeJitterRatio,
    ),
    volumeJitterRatio: normalizeJitterRatio(
      raw.volumeJitterRatio,
      DEFAULT_EXECUTION_CONFIG.volumeJitterRatio,
    ),
    macroObjective:
      raw.macroObjective === 'shakeout' ||
      raw.macroObjective === 'distribution' ||
      raw.macroObjective === 'accumulation'
        ? raw.macroObjective
        : DEFAULT_EXECUTION_CONFIG.macroObjective,
    tactics,
  };
}

function normalizeMetadata(value: unknown): StrategyMetadata {
  const raw = readRecord(value);
  return {
    author: typeof raw.author === 'string' ? raw.author : null,
    changeNote: readString(raw.changeNote),
    origin:
      raw.origin === 'manual' || raw.origin === 'migration' || raw.origin === 'settings-sync'
        ? raw.origin
        : 'settings-sync',
    legacySettingsSnapshot: readRecord(raw.legacySettingsSnapshot),
  };
}

export function normalizeStrategyDocument(value: unknown): StrategyVersionDocument {
  const raw = readRecord(value);
  return {
    schemaVersion: readNumber(raw.schemaVersion, STRATEGY_SCHEMA_VERSION),
    engineVersion: readString(raw.engineVersion, STRATEGY_ENGINE_VERSION),
    strategyType:
      raw.strategyType === DEFAULT_STRATEGY_TYPE
        ? raw.strategyType
        : DEFAULT_STRATEGY_TYPE,
    parameters: normalizeParameters(raw.parameters),
    triggers: normalizeTriggers(raw.triggers),
    targets: normalizeTargets(raw.targets),
    riskControls: normalizeRiskControls(raw.riskControls),
    execution: normalizeExecution(raw.execution),
    metadata: normalizeMetadata(raw.metadata),
  };
}