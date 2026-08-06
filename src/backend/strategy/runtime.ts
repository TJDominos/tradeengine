import {
  DEFAULT_EXECUTION_CONFIG,
  DEFAULT_RISK_CONTROLS,
  DEFAULT_STRATEGY_TYPE,
  DEFAULT_TRIGGER_CONFIG,
  STRATEGY_ENGINE_VERSION,
  STRATEGY_SCHEMA_VERSION,
} from './config';
import { buildRandomizedTwapPlan, evaluateStrategy } from './engine';
import { normalizeStrategyDocument } from './migrations';
import type {
  StrategyExecutionFill,
  StrategyExecutionPlan,
  StrategyExecutionPlanningInput,
  StrategyExecutionState,
  StrategyMarketSnapshot,
  StrategyRuntimeResult,
  StrategySettingsInput,
  StrategyTriggerEvent,
  StrategyVersionDocument,
} from './types';

function clampExecutedVolume(volume: number, remainingVolume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) {
    return 0;
  }
  return Math.min(volume, remainingVolume);
}

export function createExecutionState(plan: StrategyExecutionPlan): StrategyExecutionState {
  return {
    plan,
    executedVolume: 0,
    remainingVolume: plan.totalVolume,
    completedOrderCount: 0,
    lastExecutionAt: null,
    nextExecutionTime: plan.slices[0]?.scheduledAt ?? null,
    active: plan.totalVolume > 0 && plan.slices.length > 0,
  };
}

export function applyExecutionFill(
  state: StrategyExecutionState,
  fill: StrategyExecutionFill,
): StrategyExecutionState {
  const appliedVolume = clampExecutedVolume(fill.executedVolume, state.remainingVolume);
  const executedVolume = state.executedVolume + appliedVolume;
  const remainingVolume = Math.max(0, state.plan.totalVolume - executedVolume);
  const completedOrderCount = Math.min(
    state.plan.slices.length,
    state.completedOrderCount + (appliedVolume > 0 ? 1 : 0),
  );
  const nextExecutionTime =
    completedOrderCount < state.plan.slices.length
      ? state.plan.slices[completedOrderCount]?.scheduledAt ?? null
      : null;
  return {
    ...state,
    executedVolume,
    remainingVolume,
    completedOrderCount,
    lastExecutionAt: appliedVolume > 0 ? fill.executedAt : state.lastExecutionAt,
    nextExecutionTime,
    active: remainingVolume > 0 && nextExecutionTime != null,
  };
}

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
    triggers: {
      ...DEFAULT_TRIGGER_CONFIG,
      onExternalBuy:
        settings.onExternalBuy ?? DEFAULT_TRIGGER_CONFIG.onExternalBuy,
      onExternalSell:
        settings.onExternalSell ?? DEFAULT_TRIGGER_CONFIG.onExternalSell,
      triggerThresholdUsd:
        settings.triggerThresholdUsd ?? DEFAULT_TRIGGER_CONFIG.triggerThresholdUsd,
    },
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
      timeJitterRatio:
        settings.timeJitterRatio ?? DEFAULT_EXECUTION_CONFIG.timeJitterRatio,
      volumeJitterRatio:
        settings.volumeJitterRatio ?? DEFAULT_EXECUTION_CONFIG.volumeJitterRatio,
      macroObjective:
        settings.macroObjective ?? DEFAULT_EXECUTION_CONFIG.macroObjective,
      tactics: {
        dumpRatio:
          settings.tactics?.dumpRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.dumpRatio,
        followSellRatio:
          settings.tactics?.followSellRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.followSellRatio,
        absorbRatio:
          settings.tactics?.absorbRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.absorbRatio,
      },
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
        timeJitterRatio:
          settings.timeJitterRatio ?? DEFAULT_EXECUTION_CONFIG.timeJitterRatio,
        volumeJitterRatio:
          settings.volumeJitterRatio ?? DEFAULT_EXECUTION_CONFIG.volumeJitterRatio,
        onExternalBuy:
          settings.onExternalBuy ?? DEFAULT_TRIGGER_CONFIG.onExternalBuy,
        onExternalSell:
          settings.onExternalSell ?? DEFAULT_TRIGGER_CONFIG.onExternalSell,
        triggerThresholdUsd:
          settings.triggerThresholdUsd ?? DEFAULT_TRIGGER_CONFIG.triggerThresholdUsd,
        macroObjective:
          settings.macroObjective ?? DEFAULT_EXECUTION_CONFIG.macroObjective,
        tactics: {
          dumpRatio:
            settings.tactics?.dumpRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.dumpRatio,
          followSellRatio:
            settings.tactics?.followSellRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.followSellRatio,
          absorbRatio:
            settings.tactics?.absorbRatio ?? DEFAULT_EXECUTION_CONFIG.tactics.absorbRatio,
        },
      },
    },
  });
}

export function runStrategyRuntime(input: {
  strategyDocument: StrategyVersionDocument;
  trigger: StrategyTriggerEvent;
  marketSnapshot: StrategyMarketSnapshot | null;
  evaluatedAt?: number;
  executionPlanning?: StrategyExecutionPlanningInput;
}): StrategyRuntimeResult {
  const strategy = normalizeStrategyDocument(input.strategyDocument);
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const evaluation = evaluateStrategy({
    strategy,
    trigger: input.trigger,
    marketSnapshot: input.marketSnapshot,
    evaluatedAt,
  });
  const executionPlan =
    evaluation.shouldExecute && input.executionPlanning
      ? buildRandomizedTwapPlan(strategy.execution, {
          ...input.executionPlanning,
          startTime: input.executionPlanning.startTime ?? evaluatedAt,
        })
      : null;
  const executionState = executionPlan ? createExecutionState(executionPlan) : null;

  return {
    strategy,
    evaluation,
    executionPlan,
    executionState,
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
      executionPlan,
      executionState,
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