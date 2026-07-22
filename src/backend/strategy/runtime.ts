import {
  DEFAULT_EXECUTION_CONFIG,
  DEFAULT_RISK_CONTROLS,
  DEFAULT_STRATEGY_TYPE,
  DEFAULT_TRIGGER_CONFIG,
  STRATEGY_ENGINE_VERSION,
  STRATEGY_SCHEMA_VERSION,
} from './config';
import { evaluateStrategy } from './engine';
import { normalizeStrategyDocument } from './migrations';
import type {
  StrategyMarketSnapshot,
  StrategyRuntimeResult,
  StrategySettingsInput,
  StrategyTriggerEvent,
  StrategyVersionDocument,
} from './types';

export function buildStrategyDocumentFromSettings(
  settings: StrategySettingsInput,
  options?: {
    author?: string | null;
    changeNote?: string;
    origin?: 'settings-sync' | 'manual' | 'migration';
    executionEnabled?: boolean;
    dryRun?: boolean;
  },
): StrategyVersionDocument {
  return normalizeStrategyDocument({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    engineVersion: STRATEGY_ENGINE_VERSION,
    strategyType: DEFAULT_STRATEGY_TYPE,
    parameters: {
      contractAddress: settings.contractAddress,
      timeRangeTarget: settings.timeRangeTarget,
      maxTransactions: settings.maxTransactions,
      maxSlippageBps: Math.max(0, Math.round(settings.maxSlippage * 100)),
      notes: settings.strategyNotes,
    },
    triggers: DEFAULT_TRIGGER_CONFIG,
    targets: {
      volumeUsdMin: settings.volumeTarget,
      netBuyinUsdMin: settings.netBuyinTarget,
      volatilityPctMin: settings.volatilityTarget,
      pullbackPctMax: settings.pullbackTarget,
    },
    riskControls: {
      ...DEFAULT_RISK_CONTROLS,
      dryRun: options?.dryRun ?? DEFAULT_RISK_CONTROLS.dryRun,
    },
    execution: {
      ...DEFAULT_EXECUTION_CONFIG,
      enabled: options?.executionEnabled ?? DEFAULT_EXECUTION_CONFIG.enabled,
    },
    metadata: {
      author: options?.author ?? null,
      changeNote: options?.changeNote ?? settings.strategyNotes.trim(),
      origin: options?.origin ?? 'settings-sync',
      legacySettingsSnapshot: {
        contractAddress: settings.contractAddress,
        volatilityTarget: settings.volatilityTarget,
        pullbackTarget: settings.pullbackTarget,
        volumeTarget: settings.volumeTarget,
        netBuyinTarget: settings.netBuyinTarget,
        timeRangeTarget: settings.timeRangeTarget,
        maxTransactions: settings.maxTransactions,
        maxSlippage: settings.maxSlippage,
        strategyNotes: settings.strategyNotes,
      },
    },
  });
}

export function runStrategyRuntime(input: {
  strategyDocument: StrategyVersionDocument;
  trigger: StrategyTriggerEvent;
  marketSnapshot: StrategyMarketSnapshot | null;
  evaluatedAt?: number;
}): StrategyRuntimeResult {
  const strategy = normalizeStrategyDocument(input.strategyDocument);
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const evaluation = evaluateStrategy({
    strategy,
    trigger: input.trigger,
    marketSnapshot: input.marketSnapshot,
    evaluatedAt,
  });

  return {
    strategy,
    evaluation,
    summary: {
      strategyType: strategy.strategyType,
      schemaVersion: strategy.schemaVersion,
      engineVersion: strategy.engineVersion,
      triggerSource: input.trigger.source,
      triggerEventType: input.trigger.eventType,
      contractAddress: input.trigger.contractAddress,
      evaluatedAt,
      snapshotFetchedAt: input.marketSnapshot?.fetchedAt ?? null,
      qualified: evaluation.qualified,
      shouldExecute: evaluation.shouldExecute,
      dryRun: evaluation.dryRun,
      reasons: evaluation.reasons,
      metrics: evaluation.metrics,
    },
  };
}

export function summarizeStrategyRuntime(result: StrategyRuntimeResult): string {
  if (result.evaluation.qualified) {
    return result.evaluation.shouldExecute
      ? 'Strategy qualified and produced an executable plan.'
      : 'Strategy qualified, but execution remains disabled or dry-run only.';
  }
  return result.evaluation.reasons.length > 0
    ? `Strategy blocked: ${result.evaluation.reasons.join(' | ')}`
    : 'Strategy blocked.';
}