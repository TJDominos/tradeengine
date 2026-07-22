import {
  STRATEGY_SNAPSHOT_MAX_AGE_MS,
  supportsTwentyFourHourAggregatesOnly,
} from './config';
import type {
  StrategyEvaluationInput,
  StrategyEvaluationMetric,
  StrategyEvaluationResult,
} from './types';

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