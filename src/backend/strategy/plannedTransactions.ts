import type { StrategyMacroObjective, StrategyVersionDocument } from './types';

const DEFAULT_MIN_PLANNED_TRANSACTIONS = 1;
const DEFAULT_MAX_PLANNED_TRANSACTIONS = 100;
const LEGACY_BASE_ORDER_COUNT_MIN = 3;
const LEGACY_BASE_ORDER_COUNT_MAX = 12;

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeMinimumTransactionCountForObjective(
  macroObjective: StrategyMacroObjective,
  value: unknown,
  fallback: number,
): number {
  const normalized = normalizePositiveInteger(value, fallback);
  return macroObjective === 'distribution' ? Math.max(2, normalized) : normalized;
}

export function normalizeMinimumPlannedTransactions(
  macroObjective: StrategyMacroObjective,
  value: unknown,
  fallback = DEFAULT_MIN_PLANNED_TRANSACTIONS,
): number {
  return normalizeMinimumTransactionCountForObjective(
    macroObjective,
    value,
    fallback,
  );
}

function normalizePlannerTransactionCeiling(minTransactions: number): number {
  return Math.max(DEFAULT_MAX_PLANNED_TRANSACTIONS, minTransactions);
}

function deriveLegacyPlannedTransactionCount(
  macroObjective: StrategyMacroObjective,
  maxConcurrentOrders: number,
): number {
  const legacyBaseOrderCount = Math.min(
    LEGACY_BASE_ORDER_COUNT_MAX,
    Math.max(
      LEGACY_BASE_ORDER_COUNT_MIN,
      normalizePositiveInteger(maxConcurrentOrders, 1) * 3,
    ),
  );

  switch (macroObjective) {
    case 'distribution':
      return Math.max(1, Math.floor(legacyBaseOrderCount / 2)) * 2;
    case 'accumulation':
      return Math.max(1, Math.ceil(legacyBaseOrderCount / 2));
    case 'shakeout':
    default:
      return legacyBaseOrderCount;
  }
}

export function resolveBasePlannedTransactionCount(
  document: StrategyVersionDocument,
): number {
  const minTransactions = normalizeMinimumPlannedTransactions(
    document.execution.macroObjective,
    document.parameters.minTransactions,
  );
  const plannerTransactionCeiling = normalizePlannerTransactionCeiling(
    minTransactions,
  );
  const legacyTransactionCount = deriveLegacyPlannedTransactionCount(
    document.execution.macroObjective,
    document.riskControls.maxConcurrentOrders,
  );

  return Math.min(
    plannerTransactionCeiling,
    Math.max(minTransactions, legacyTransactionCount),
  );
}

export function splitBasePlannedTransactionCount(
  macroObjective: StrategyMacroObjective,
  totalTransactions: number,
): { buyCount: number; sellCount: number } {
  const normalizedTotalTransactions = normalizeMinimumTransactionCountForObjective(
    macroObjective,
    totalTransactions,
    1,
  );

  switch (macroObjective) {
    case 'distribution': {
      const buyCount = Math.floor(normalizedTotalTransactions / 3);
      return {
        buyCount,
        sellCount: Math.max(1, normalizedTotalTransactions - buyCount),
      };
    }
    case 'accumulation':
    case 'shakeout':
    default:
      return {
        buyCount: normalizedTotalTransactions,
        sellCount: 0,
      };
  }
}