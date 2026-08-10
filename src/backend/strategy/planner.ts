import { allocateVolumeAcrossAccountCaps } from '../services/tradeMath';
import type { ManagedAccountBalanceRecord } from '../userStore';
import { buildRandomizedTwapPlan } from './engine';
import { splitBasePlannedTransactionCount } from './plannedTransactions';
import type {
  StrategyExecutionConfig,
  StrategyMacroObjective,
  StrategyVersionDocument,
} from './types';

const MIN_VOLUME_EPSILON = 0.000001;

export type StrategyPlannerTaskSpec = {
  side: 'buy' | 'sell';
  pulse: string | null;
  totalVolumeUsd: number;
  orderCount: number;
  durationMs: number;
  scheduledOffsetMs: number;
};

export type StrategyPlannerTaskAllocation = {
  accountId: number;
  label: string;
  walletAddress: string;
  plannedVolumeUsd: number;
  quoteAvailableAmount: number;
  baseTokenAmount: number;
  solBalance: number;
  accountBuyOverAllocated: boolean;
  accountBuyOverAllocationUsd: number;
};

export type StrategyPlannerTask = {
  taskId: string;
  side: 'buy' | 'sell';
  pulse: string | null;
  orderIndex: number;
  totalOrders: number;
  scheduledAt: number;
  totalVolumeUsd: number;
  unallocatedVolumeUsd: number;
  allocations: StrategyPlannerTaskAllocation[];
};

export type StrategyPlannerAccount = {
  accountId: number;
  label: string;
  walletAddress: string;
  quoteAvailableAmount: number;
  baseTokenAmount: number;
  solBalance: number;
  plannedBuyVolumeUsd: number;
  plannedSellVolumeUsd: number;
  buyOverAllocationUsd: number;
  buyRemainingQuoteUsd: number;
  isBuyOverAllocated: boolean;
  pairCompatible: boolean;
  eligibleForBuy: boolean;
  eligibleForSell: boolean;
};

export type StrategyPlannerResult = {
  accounts: StrategyPlannerAccount[];
  tasks: StrategyPlannerTask[];
  availableBuyAmount: number;
  eligibleBuyAccountCount: number;
  skippedForCapabilityCount: number;
  lowSolWarningCount: number;
};

export type StrategyPlannerConfig = {
  macroObjective: StrategyMacroObjective;
  baseOrderCount: number;
  baseTotalVolumeUsd: number;
  baseDurationMs: number;
  minOrderUsd: number;
  maxOrderUsd: number;
  execution: StrategyExecutionConfig;
  baseTokenAddress: string;
  quoteTokenAddress: string;
};

type PlanningVolumeMaps = {
  buy: Map<number, number>;
  sell: Map<number, number>;
};

type MutablePlannerAccount = StrategyPlannerAccount & {
  existingPlannedBuyVolumeUsd: number;
  existingPlannedSellVolumeUsd: number;
  sellCapacityUsd: number;
};

function roundToSixDecimals(value: number): number {
  return Number(value.toFixed(6));
}

function positiveNumber(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

export function createDeterministicRandom(seedText: string): () => number {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6D2B79F5;
    let next = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveRequiredNetBuyAmount(
  document: StrategyVersionDocument,
  fallback = 0,
): number {
  if (
    Number.isFinite(document.targets.netBuyinUsdMin) &&
    document.targets.netBuyinUsdMin > 0
  ) {
    return document.targets.netBuyinUsdMin;
  }
  if (
    document.riskControls.maxPositionUsd != null &&
    Number.isFinite(document.riskControls.maxPositionUsd) &&
    document.riskControls.maxPositionUsd > 0
  ) {
    return document.riskControls.maxPositionUsd;
  }
  if (
    Number.isFinite(document.targets.volumeUsdMin) &&
    document.targets.volumeUsdMin > 0
  ) {
    return document.targets.volumeUsdMin;
  }
  return positiveNumber(fallback);
}

function normalizePlannerTaskOrderCeiling(minTransactions: number): number {
  return Math.max(100, minTransactions);
}

function resolveSelfCyclingOrderSplit(
  totalOrders: number,
  buyVolumeUsd: number,
  sellVolumeUsd: number,
): { buyCount: number; sellCount: number } {
  const normalizedTotalOrders = Math.max(
    sellVolumeUsd > MIN_VOLUME_EPSILON ? 2 : 1,
    Math.floor(totalOrders),
  );
  if (sellVolumeUsd <= MIN_VOLUME_EPSILON) {
    return {
      buyCount: normalizedTotalOrders,
      sellCount: 0,
    };
  }

  const totalVolumeUsd = buyVolumeUsd + sellVolumeUsd;
  const sellRatio = totalVolumeUsd > 0 ? sellVolumeUsd / totalVolumeUsd : 0;
  const sellCount = Math.min(
    normalizedTotalOrders - 1,
    Math.max(1, Math.round(normalizedTotalOrders * sellRatio)),
  );
  return {
    buyCount: Math.max(1, normalizedTotalOrders - sellCount),
    sellCount,
  };
}

function resolveSelfCyclingSellVolume(
  config: StrategyPlannerConfig,
  netBuyAmountUsd: number,
): number {
  const baseVolumeUsd = positiveNumber(config.baseTotalVolumeUsd);
  const existingSellVolumeUsd = Math.max(0, (baseVolumeUsd - netBuyAmountUsd) / 2);
  const tacticRatio = config.macroObjective === 'shakeout'
    ? Math.min(0.45, Math.max(0.1, config.execution.tactics.dumpRatio * 0.15))
    : Math.min(0.25, Math.max(0.05, config.execution.tactics.absorbRatio * 0.1));
  const requiredSelfCyclingSellUsd = Math.max(
    config.minOrderUsd,
    baseVolumeUsd * tacticRatio,
  );
  return roundToSixDecimals(Math.max(existingSellVolumeUsd, requiredSelfCyclingSellUsd));
}

export function buildStrategyPlanTaskSpecs(
  config: StrategyPlannerConfig,
  requiredNetBuyAmount: number,
): StrategyPlannerTaskSpec[] {
  const plannerOrderCeiling = normalizePlannerTaskOrderCeiling(config.baseOrderCount);
  const totalVolumeUsd = positiveNumber(config.baseTotalVolumeUsd);

  switch (config.macroObjective) {
    case 'distribution': {
      const { buyCount, sellCount } = splitBasePlannedTransactionCount(
        config.macroObjective,
        plannerOrderCeiling,
      );
      return [
        {
          side: 'buy',
          pulse: 'wash_buy',
          totalVolumeUsd: totalVolumeUsd / 2,
          orderCount: buyCount,
          durationMs: config.baseDurationMs,
          scheduledOffsetMs: 0,
        },
        {
          side: 'sell',
          pulse: 'wash_sell',
          totalVolumeUsd: totalVolumeUsd / 2,
          orderCount: sellCount,
          durationMs: config.baseDurationMs,
          scheduledOffsetMs: 750,
        },
      ];
    }
    case 'accumulation':
    case 'shakeout': {
      const netBuyAmountUsd = Math.min(
        totalVolumeUsd,
        positiveNumber(requiredNetBuyAmount),
      );
      const sellVolumeUsd = resolveSelfCyclingSellVolume(config, netBuyAmountUsd);
      const buyVolumeUsd = roundToSixDecimals(netBuyAmountUsd + sellVolumeUsd);
      const { buyCount, sellCount } = resolveSelfCyclingOrderSplit(
        plannerOrderCeiling,
        buyVolumeUsd,
        sellVolumeUsd,
      );

      return [
        {
          side: 'sell',
          pulse: config.macroObjective === 'accumulation' ? 'self_sell' : 'shakeout_sell',
          totalVolumeUsd: sellVolumeUsd,
          orderCount: sellCount,
          durationMs: config.baseDurationMs,
          scheduledOffsetMs: 0,
        },
        {
          side: 'buy',
          pulse: config.macroObjective === 'accumulation' ? 'buyback' : 'shakeout_buyback',
          totalVolumeUsd: buyVolumeUsd,
          orderCount: buyCount,
          durationMs:
            config.macroObjective === 'accumulation'
              ? Math.round(config.baseDurationMs * 1.5)
              : config.baseDurationMs,
          scheduledOffsetMs: config.baseDurationMs + 750,
        },
      ];
    }
  }
}

function buildPlanningSeedBase(
  document: StrategyVersionDocument,
  config: StrategyPlannerConfig,
  seedContext: string,
): string {
  return JSON.stringify({
    strategyType: document.strategyType,
    parameters: document.parameters,
    execution: document.execution,
    targets: document.targets,
    riskControls: document.riskControls,
    macroObjective: config.macroObjective,
    baseOrderCount: config.baseOrderCount,
    baseTotalVolumeUsd: config.baseTotalVolumeUsd,
    baseDurationMs: config.baseDurationMs,
    minOrderUsd: config.minOrderUsd,
    maxOrderUsd: config.maxOrderUsd,
    seedContext,
  });
}

function buildSellCapacityUsd(
  account: ManagedAccountBalanceRecord,
  baseTokenPriceUsd: number | null,
): number {
  if (baseTokenPriceUsd == null || !Number.isFinite(baseTokenPriceUsd) || baseTokenPriceUsd <= 0) {
    return 0;
  }
  return roundToSixDecimals(
    Math.max(0, account.baseTokenAmount * baseTokenPriceUsd),
  );
}

function toMutablePlannerAccount(
  account: ManagedAccountBalanceRecord,
  baseTokenPriceUsd: number | null,
  existingVolumes: PlanningVolumeMaps,
): MutablePlannerAccount {
  const solBalance = Number.parseFloat(account.walletBalance.sol) || 0;
  const sellCapacityUsd = buildSellCapacityUsd(account, baseTokenPriceUsd);
  return {
    accountId: account.id,
    label: account.label,
    walletAddress: account.address,
    quoteAvailableAmount: account.quoteAvailableAmount,
    baseTokenAmount: account.baseTokenAmount,
    solBalance,
    plannedBuyVolumeUsd: 0,
    plannedSellVolumeUsd: 0,
    buyOverAllocationUsd: 0,
    buyRemainingQuoteUsd: Math.max(
      0,
      account.quoteAvailableAmount - (existingVolumes.buy.get(account.id) ?? 0),
    ),
    isBuyOverAllocated: false,
    pairCompatible: account.pairCompatible,
    eligibleForBuy: account.pairCompatible && account.quoteAvailableAmount > 0,
    eligibleForSell: account.pairCompatible && sellCapacityUsd > 0,
    existingPlannedBuyVolumeUsd: existingVolumes.buy.get(account.id) ?? 0,
    existingPlannedSellVolumeUsd: existingVolumes.sell.get(account.id) ?? 0,
    sellCapacityUsd,
  };
}

export function createEmptyPlanningVolumeMaps(): PlanningVolumeMaps {
  return {
    buy: new Map<number, number>(),
    sell: new Map<number, number>(),
  };
}

export function buildPlanningVolumeMapsFromTasks(
  tasks: Array<{ side: 'buy' | 'sell'; allocations?: Array<{ accountId: number; plannedVolumeUsd: number }> }>,
): PlanningVolumeMaps {
  const volumes = createEmptyPlanningVolumeMaps();
  for (const task of tasks) {
    for (const allocation of task.allocations ?? []) {
      const target = task.side === 'buy' ? volumes.buy : volumes.sell;
      target.set(
        allocation.accountId,
        roundToSixDecimals(
          (target.get(allocation.accountId) ?? 0) + positiveNumber(allocation.plannedVolumeUsd),
        ),
      );
    }
  }
  return volumes;
}

export function buildStrategyPlanningResult(input: {
  document: StrategyVersionDocument;
  config: StrategyPlannerConfig;
  accounts: ManagedAccountBalanceRecord[];
  taskSpecs: StrategyPlannerTaskSpec[];
  startTime: number;
  baseTokenPriceUsd: number | null;
  existingPlannedVolumes?: PlanningVolumeMaps;
  seedContext?: string;
}): StrategyPlannerResult {
  const seedBase = buildPlanningSeedBase(
    input.document,
    input.config,
    input.seedContext ?? 'base-plan',
  );
  const rotationOffsets: Record<'buy' | 'sell', number> = {
    buy: 0,
    sell: 0,
  };
  const accountSummaries = new Map<number, MutablePlannerAccount>(
    input.accounts.map((account) => [
      account.id,
      toMutablePlannerAccount(
        account,
        input.baseTokenPriceUsd,
        input.existingPlannedVolumes ?? createEmptyPlanningVolumeMaps(),
      ),
    ]),
  );

  const tasks: StrategyPlannerTask[] = [];
  input.taskSpecs.forEach((spec, specIndex) => {
    if (spec.totalVolumeUsd <= MIN_VOLUME_EPSILON || spec.orderCount <= 0) {
      return;
    }
    const plan = buildRandomizedTwapPlan(input.config.execution, {
      side: spec.side,
      totalVolume: spec.totalVolumeUsd,
      orderCount: spec.orderCount,
      durationMs: spec.durationMs,
      startTime: input.startTime,
      minOrderUsd: input.config.minOrderUsd,
      maxOrderUsd: input.config.maxOrderUsd,
      baseTokenAddress: input.config.baseTokenAddress,
      random: createDeterministicRandom(
        `${seedBase}:plan:${specIndex}:${spec.side}:${spec.pulse ?? 'base'}`,
      ),
    });

    for (const slice of plan.slices) {
      const eligibleAccounts = [...accountSummaries.values()].filter((account) =>
        spec.side === 'buy'
          ? account.pairCompatible && account.buyRemainingQuoteUsd > MIN_VOLUME_EPSILON
          : account.eligibleForSell,
      );
      const eligibleAccountsById = new Map(
        eligibleAccounts.map((account) => [account.accountId, account]),
      );

      const allocationPlan = allocateVolumeAcrossAccountCaps(
        slice.targetVolume,
        eligibleAccounts.map((account) => {
          const existingPlannedVolumeUsd = spec.side === 'buy'
            ? account.existingPlannedBuyVolumeUsd + account.plannedBuyVolumeUsd
            : account.existingPlannedSellVolumeUsd + account.plannedSellVolumeUsd;
          const maxVolumeUsd = spec.side === 'buy'
            ? account.buyRemainingQuoteUsd
            : Math.max(0, account.sellCapacityUsd - existingPlannedVolumeUsd);
          return {
            accountId: account.accountId,
            maxVolumeUsd,
            existingVolumeUsd: existingPlannedVolumeUsd,
          };
        }),
        {
          random: createDeterministicRandom(
            `${seedBase}:allocation:${specIndex}:${spec.side}:${spec.pulse ?? 'base'}:${slice.orderIndex}`,
          ),
          accountCyclingEnabled: input.document.execution.accountCyclingEnabled,
          rotationOffset: rotationOffsets[spec.side],
          accountDispersionStrength: input.document.execution.accountDispersionStrength,
        },
      );
      rotationOffsets[spec.side] = allocationPlan.nextRotationOffset;

      const allocations = allocationPlan.allocations
        .map((allocationEntry) => {
          const account = eligibleAccountsById.get(allocationEntry.accountId);
          if (!account) {
            return null;
          }
          const plannedVolumeUsd = roundToSixDecimals(allocationEntry.volumeUsd);
          if (spec.side === 'buy') {
            account.plannedBuyVolumeUsd = roundToSixDecimals(
              account.plannedBuyVolumeUsd + plannedVolumeUsd,
            );
            account.buyRemainingQuoteUsd = roundToSixDecimals(
              Math.max(0, account.buyRemainingQuoteUsd - plannedVolumeUsd),
            );
          } else {
            account.plannedSellVolumeUsd = roundToSixDecimals(
              account.plannedSellVolumeUsd + plannedVolumeUsd,
            );
            account.buyRemainingQuoteUsd = roundToSixDecimals(
              account.buyRemainingQuoteUsd + plannedVolumeUsd,
            );
          }
          return {
            accountId: account.accountId,
            label: account.label,
            walletAddress: account.walletAddress,
            plannedVolumeUsd,
            quoteAvailableAmount: account.quoteAvailableAmount,
            baseTokenAmount: account.baseTokenAmount,
            solBalance: account.solBalance,
            accountBuyOverAllocated: false,
            accountBuyOverAllocationUsd: 0,
          };
        })
        .filter((allocation): allocation is StrategyPlannerTaskAllocation => allocation != null);

      tasks.push({
        taskId: `${spec.pulse ?? spec.side}-${specIndex + 1}-${slice.orderIndex}`,
        side: spec.side,
        pulse: spec.pulse,
        orderIndex: slice.orderIndex,
        totalOrders: plan.orderCount,
        scheduledAt: slice.scheduledAt + spec.scheduledOffsetMs,
        totalVolumeUsd: roundToSixDecimals(slice.targetVolume),
        unallocatedVolumeUsd: roundToSixDecimals(allocationPlan.unallocatedVolumeUsd),
        allocations,
      });
    }
  });

  const accountList = [...accountSummaries.values()].sort((left, right) => {
    const leftTotal = left.plannedBuyVolumeUsd + left.plannedSellVolumeUsd;
    const rightTotal = right.plannedBuyVolumeUsd + right.plannedSellVolumeUsd;
    if (rightTotal !== leftTotal) {
      return rightTotal - leftTotal;
    }
    return left.label.localeCompare(right.label) || left.walletAddress.localeCompare(right.walletAddress);
  });

  for (const account of accountList) {
    account.buyOverAllocationUsd = roundToSixDecimals(
      Math.max(
        0,
        account.plannedBuyVolumeUsd + account.existingPlannedBuyVolumeUsd -
          account.quoteAvailableAmount - account.plannedSellVolumeUsd -
          account.existingPlannedSellVolumeUsd,
      ),
    );
    account.buyRemainingQuoteUsd = roundToSixDecimals(account.buyRemainingQuoteUsd);
    account.isBuyOverAllocated = account.buyOverAllocationUsd > 0;
  }

  const overAllocatedByAccountId = new Map(
    accountList.map((account) => [
      account.accountId,
      {
        isBuyOverAllocated: account.isBuyOverAllocated,
        buyOverAllocationUsd: account.buyOverAllocationUsd,
      },
    ]),
  );
  for (const task of tasks) {
    for (const allocation of task.allocations) {
      const status = overAllocatedByAccountId.get(allocation.accountId);
      allocation.accountBuyOverAllocated = status?.isBuyOverAllocated ?? false;
      allocation.accountBuyOverAllocationUsd = status?.buyOverAllocationUsd ?? 0;
    }
  }

  const eligibleBuyAccounts = accountList.filter((account) => account.eligibleForBuy);
  return {
    accounts: accountList,
    tasks: tasks.sort((left, right) =>
      left.scheduledAt - right.scheduledAt || left.taskId.localeCompare(right.taskId),
    ),
    availableBuyAmount: roundToSixDecimals(
      eligibleBuyAccounts.reduce((sum, account) => sum + account.quoteAvailableAmount, 0),
    ),
    eligibleBuyAccountCount: eligibleBuyAccounts.length,
    skippedForCapabilityCount: accountList.filter((account) => !account.pairCompatible).length,
    lowSolWarningCount: accountList.filter(
      (account) =>
        account.pairCompatible &&
        (account.quoteAvailableAmount > 0 || account.baseTokenAmount > 0) &&
        account.solBalance < 0.01,
    ).length,
  };
}