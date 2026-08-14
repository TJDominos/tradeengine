import { rngChacha20 } from '@noble/ciphers/chacha.js';

import type { ManagedAccountBalanceRecord } from '../userStore';
import { buildRandomizedTwapPlan } from './engine';
import {
  allocateBoundedOrderVolume,
  calculateFeasibleTradeCounts,
  calculateSelfCyclingTradeTotals,
} from './plannerMath';
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
  requestedTaskCount: number;
  plannedTaskCount: number;
  unallocatedVolumeUsd: number;
  isExecutable: boolean;
  availableBuyAmount: number;
  eligibleTradingAccountCount: number;
  eligibleBuyAccountCount: number;
  skippedForCapabilityCount: number;
  skippedForNoPairAssetCount: number;
  lowSolWarningCount: number;
};

export type StrategyPlannerConfig = {
  macroObjective: StrategyMacroObjective;
  baseOrderCount: number;
  maxOrderCount: number;
  baseTotalVolumeUsd: number;
  baseDurationMs: number;
  targetPullbackPct: number;
  targetVolatilityPct: number;
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

type PlannedAccountOrder = {
  account: MutablePlannerAccount;
  volumeUsd: number;
};

type SelfCyclingOrderEntry = {
  order: PlannedAccountOrder;
  side: 'buy' | 'sell';
  rank: number;
  index: number;
};

function roundToSixDecimals(value: number): number {
  return Number(value.toFixed(6));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function curveProgress(position: number, count: number, exponent: number): number {
  if (count <= 1) {
    return 0;
  }
  return clamp(position / (count - 1), 0, 1) ** exponent;
}

function positiveNumber(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function splitAccountAmountIntoOrders(
  account: MutablePlannerAccount,
  amountUsd: number,
  orderCount: number,
  minOrderUsd: number,
  maxOrderUsd: number,
  execution: StrategyExecutionConfig,
  random: () => number,
): PlannedAccountOrder[] | null {
  const normalizedAmount = roundToSixDecimals(amountUsd);
  if (
    orderCount <= 0 ||
    normalizedAmount + MIN_VOLUME_EPSILON < orderCount * minOrderUsd ||
    normalizedAmount - MIN_VOLUME_EPSILON > orderCount * maxOrderUsd
  ) {
    return null;
  }
  const plan = buildRandomizedTwapPlan(execution, {
    side: 'buy',
    totalVolume: normalizedAmount,
    orderCount,
    durationMs: 0,
    startTime: 0,
    minOrderUsd,
    maxOrderUsd,
    strictOrderCount: true,
    random,
  });
  const orders = plan.slices.map((slice) => ({
    account,
    volumeUsd: roundToSixDecimals(slice.targetVolume),
  }));
  const roundedTotal = roundToSixDecimals(
    orders.reduce((sum, order) => sum + order.volumeUsd, 0),
  );
  const roundingDifference = roundToSixDecimals(normalizedAmount - roundedTotal);
  const finalOrder = orders[orders.length - 1];
  if (finalOrder && Math.abs(roundingDifference) > MIN_VOLUME_EPSILON / 10) {
    finalOrder.volumeUsd = roundToSixDecimals(finalOrder.volumeUsd + roundingDifference);
  }
  return orders;
}

function allocateAccountOrders(
  accounts: MutablePlannerAccount[],
  targetUsd: number,
  orderCount: number,
  minOrderUsd: number,
  maxOrderUsd: number,
  execution: StrategyExecutionConfig,
  capacityUsd: (account: MutablePlannerAccount) => number,
  random: () => number,
  selectionMode: 'capacity' | 'random' = 'capacity',
): PlannedAccountOrder[] | null {
  if (targetUsd <= MIN_VOLUME_EPSILON) {
    return orderCount === 0 ? [] : null;
  }
  const maximumAccountCount = Math.min(orderCount, Math.floor(targetUsd / minOrderUsd));
  const candidates = accounts
    .map((account) => ({ account, capacity: Math.max(0, capacityUsd(account)), tie: random() }))
    .filter(({ account, capacity }) => account.pairCompatible && capacity >= minOrderUsd)
    .sort((left, right) =>
      selectionMode === 'random'
        ? left.tie - right.tie || right.capacity - left.capacity
        : right.capacity - left.capacity || left.tie - right.tie,
    );
  const selectedAccounts: Array<{ account: MutablePlannerAccount; capacity: number }> = [];
  let selectedCapacity = 0;
  for (const candidate of candidates) {
    if (selectedAccounts.length >= maximumAccountCount) {
      break;
    }
    selectedAccounts.push(candidate);
    selectedCapacity += candidate.capacity;
  }
  if (selectedCapacity + MIN_VOLUME_EPSILON < targetUsd) {
    return null;
  }

  const accountAmounts = new Map<number, number>();
  if (selectionMode === 'random') {
    let remainingRandomVolume = roundToSixDecimals(
      targetUsd - selectedAccounts.length * minOrderUsd,
    );
    if (remainingRandomVolume < -MIN_VOLUME_EPSILON) {
      return null;
    }
    for (const { account } of selectedAccounts) {
      accountAmounts.set(account.accountId, minOrderUsd);
    }

    let randomActiveAccounts = selectedAccounts
      .map((candidate) => ({
        ...candidate,
        remainingCapacity: roundToSixDecimals(candidate.capacity - minOrderUsd),
      }))
      .filter((candidate) => candidate.remainingCapacity > MIN_VOLUME_EPSILON);
    while (remainingRandomVolume > MIN_VOLUME_EPSILON && randomActiveAccounts.length > 0) {
      const weights = randomActiveAccounts.map(() => Math.max(MIN_VOLUME_EPSILON, random()));
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      let distributed = 0;
      const nextActiveAccounts: typeof randomActiveAccounts = [];
      for (let index = 0; index < randomActiveAccounts.length; index += 1) {
        const candidate = randomActiveAccounts[index]!;
        const weightedShare = remainingRandomVolume * ((weights[index] ?? 0) / totalWeight);
        const amountUsd = roundToSixDecimals(
          Math.min(candidate.remainingCapacity, weightedShare),
        );
        if (amountUsd <= MIN_VOLUME_EPSILON) {
          nextActiveAccounts.push(candidate);
          continue;
        }
        accountAmounts.set(
          candidate.account.accountId,
          roundToSixDecimals((accountAmounts.get(candidate.account.accountId) ?? 0) + amountUsd),
        );
        distributed = roundToSixDecimals(distributed + amountUsd);
        const remainingCapacity = roundToSixDecimals(candidate.remainingCapacity - amountUsd);
        if (remainingCapacity > MIN_VOLUME_EPSILON) {
          nextActiveAccounts.push({ ...candidate, remainingCapacity });
        }
      }
      if (distributed <= MIN_VOLUME_EPSILON) {
        break;
      }
      remainingRandomVolume = roundToSixDecimals(remainingRandomVolume - distributed);
      randomActiveAccounts = nextActiveAccounts;
    }
    if (remainingRandomVolume > MIN_VOLUME_EPSILON) {
      const residualTarget = selectedAccounts.find(({ account, capacity }) => {
        const amount = accountAmounts.get(account.accountId) ?? 0;
        return capacity - amount + MIN_VOLUME_EPSILON >= remainingRandomVolume;
      });
      if (!residualTarget) {
        return null;
      }
      accountAmounts.set(
        residualTarget.account.accountId,
        roundToSixDecimals((accountAmounts.get(residualTarget.account.accountId) ?? 0) + remainingRandomVolume),
      );
    }
  } else {
  let remaining = roundToSixDecimals(targetUsd);
  let activeAccounts = [...selectedAccounts];

  while (remaining > MIN_VOLUME_EPSILON && activeAccounts.length > 0) {
    const equalShare = roundToSixDecimals(remaining / activeAccounts.length);
    let distributed = 0;
    const nextActiveAccounts: typeof activeAccounts = [];
    for (const candidate of activeAccounts) {
      const alreadyAllocated = accountAmounts.get(candidate.account.accountId) ?? 0;
      const available = roundToSixDecimals(
        Math.max(0, candidate.capacity - alreadyAllocated),
      );
      const amountUsd = roundToSixDecimals(Math.min(equalShare, available));
      accountAmounts.set(
        candidate.account.accountId,
        roundToSixDecimals(alreadyAllocated + amountUsd),
      );
      distributed = roundToSixDecimals(distributed + amountUsd);
      if (available - amountUsd > MIN_VOLUME_EPSILON) {
        nextActiveAccounts.push(candidate);
      }
    }
    if (distributed <= MIN_VOLUME_EPSILON) {
      break;
    }
    remaining = roundToSixDecimals(remaining - distributed);
    activeAccounts = nextActiveAccounts;
  }

  if (remaining > MIN_VOLUME_EPSILON) {
    const residualTarget = selectedAccounts.find(({ account, capacity }) => {
      const amount = accountAmounts.get(account.accountId) ?? 0;
      return capacity - amount + MIN_VOLUME_EPSILON >= remaining;
    });
    if (!residualTarget) {
      return null;
    }
    const currentAmount = accountAmounts.get(residualTarget.account.accountId) ?? 0;
    accountAmounts.set(
      residualTarget.account.accountId,
      roundToSixDecimals(currentAmount + remaining),
    );
    remaining = 0;
  }
  }

  const allocatedAccountTotal = roundToSixDecimals(
    [...accountAmounts.values()].reduce((sum, amount) => sum + amount, 0),
  );
  const accountRoundingDifference = roundToSixDecimals(targetUsd - allocatedAccountTotal);
  if (Math.abs(accountRoundingDifference) > MIN_VOLUME_EPSILON / 10) {
    const adjustmentTarget = selectedAccounts.find(({ account, capacity }) => {
      const amount = accountAmounts.get(account.accountId) ?? 0;
      const adjustedAmount = roundToSixDecimals(amount + accountRoundingDifference);
      return adjustedAmount + MIN_VOLUME_EPSILON >= minOrderUsd && adjustedAmount <= capacity + MIN_VOLUME_EPSILON;
    });
    if (!adjustmentTarget) {
      return null;
    }
    const currentAmount = accountAmounts.get(adjustmentTarget.account.accountId) ?? 0;
    accountAmounts.set(adjustmentTarget.account.accountId,
      roundToSixDecimals(currentAmount + accountRoundingDifference));
  }

  const accountOrderCounts = new Map<number, number>();
  const accountOrderMaximums = new Map<number, number>();
  let allocatedOrderCount = 0;
  for (const { account } of selectedAccounts) {
    const amountUsd = accountAmounts.get(account.accountId) ?? 0;
    const minimumCount = Math.max(1, Math.ceil((amountUsd - MIN_VOLUME_EPSILON) / maxOrderUsd));
    const maximumCount = Math.floor((amountUsd + MIN_VOLUME_EPSILON) / minOrderUsd);
    accountOrderCounts.set(account.accountId, minimumCount);
    accountOrderMaximums.set(account.accountId, maximumCount);
    allocatedOrderCount += minimumCount;
  }
  if (allocatedOrderCount > orderCount) {
    return null;
  }
  while (allocatedOrderCount < orderCount) {
    const expandable = selectedAccounts
      .map(({ account }) => {
        const count = accountOrderCounts.get(account.accountId) ?? 0;
        const maximum = accountOrderMaximums.get(account.accountId) ?? 0;
        return {
          account,
          count,
          maximum,
          averageAfterSplit: (accountAmounts.get(account.accountId) ?? 0) / (count + 1),
          tie: random(),
        };
      })
      .filter(({ count, maximum }) => count < maximum)
      .sort((left, right) => right.averageAfterSplit - left.averageAfterSplit || left.tie - right.tie);
    const selected = expandable[0];
    if (!selected) {
      return null;
    }
    accountOrderCounts.set(selected.account.accountId, selected.count + 1);
    allocatedOrderCount += 1;
  }

  const allocations: PlannedAccountOrder[] = [];
  for (const { account } of selectedAccounts) {
    const amountUsd = accountAmounts.get(account.accountId) ?? 0;
    const accountOrders = splitAccountAmountIntoOrders(
      account,
      amountUsd,
      accountOrderCounts.get(account.accountId) ?? 0,
      minOrderUsd,
      maxOrderUsd,
      execution,
      random,
    );
    if (!accountOrders) {
      return null;
    }
    allocations.push(...accountOrders);
  }

  return allocations;
}

function buildTaskAllocation(order: PlannedAccountOrder): StrategyPlannerTaskAllocation {
  return {
    accountId: order.account.accountId,
    label: order.account.label,
    walletAddress: order.account.walletAddress,
    plannedVolumeUsd: order.volumeUsd,
    quoteAvailableAmount: order.account.quoteAvailableAmount,
    baseTokenAmount: order.account.baseTokenAmount,
    solBalance: order.account.solBalance,
    accountBuyOverAllocated: false,
    accountBuyOverAllocationUsd: 0,
  };
}

function buildShakeoutCurveManagedTasks(input: {
  config: StrategyPlannerConfig;
  taskSpecs: StrategyPlannerTaskSpec[];
  accounts: MutablePlannerAccount[];
  startTime: number;
  seedBase: string;
}): StrategyPlannerTask[] {
  const sellSpec = input.taskSpecs[0];
  const buySpec = input.taskSpecs[1];
  if (!sellSpec || !buySpec) {
    return [];
  }

  const minOrderUsd = input.config.minOrderUsd;
  const maxOrderUsd = input.config.maxOrderUsd;
  const sellerCandidates = input.accounts
    .filter(
      (account) =>
        account.pairCompatible &&
        account.sellCapacityUsd >= minOrderUsd,
    )
    .sort((left, right) => right.sellCapacityUsd - left.sellCapacityUsd);
  const minimumSellOrderCount = Math.max(
    sellSpec.orderCount,
    Math.ceil((sellSpec.totalVolumeUsd - MIN_VOLUME_EPSILON) / maxOrderUsd),
  );
  const maximumSellOrderCount = Math.floor(
    (sellSpec.totalVolumeUsd + MIN_VOLUME_EPSILON) / minOrderUsd,
  );
  const minimumBuyOrderCount = Math.max(
    buySpec.orderCount,
    Math.ceil((buySpec.totalVolumeUsd - MIN_VOLUME_EPSILON) / maxOrderUsd),
  );
  const maximumBuyOrderCount = Math.floor(
    (buySpec.totalVolumeUsd + MIN_VOLUME_EPSILON) / minOrderUsd,
  );

  let sellOrders: PlannedAccountOrder[] | null = null;
  let buyOrders: PlannedAccountOrder[] | null = null;
  for (
    let candidateTotal = input.config.baseOrderCount;
    candidateTotal <= input.config.maxOrderCount;
    candidateTotal += 1
  ) {
    const candidateMaximumSellCount = Math.min(
      maximumSellOrderCount,
      candidateTotal - minimumBuyOrderCount,
    );
    for (
      let candidateSellCount = minimumSellOrderCount;
      candidateSellCount <= candidateMaximumSellCount;
      candidateSellCount += 1
    ) {
      const candidateBuyCount = candidateTotal - candidateSellCount;
      if (
        candidateBuyCount < minimumBuyOrderCount ||
        candidateBuyCount > maximumBuyOrderCount
      ) {
        continue;
      }

      const candidateSellOrders = allocateAccountOrders(
        sellerCandidates,
        sellSpec.totalVolumeUsd,
        candidateSellCount,
        minOrderUsd,
        maxOrderUsd,
        input.config.execution,
        (account) => account.sellCapacityUsd,
        createDeterministicRandom(
          `${input.seedBase}:shakeout:sell-amounts:${candidateSellCount}`,
        ),
        'random',
      );
      if (!candidateSellOrders) {
        continue;
      }

      const soldByAccountId = new Map<number, number>();
      for (const order of candidateSellOrders) {
        soldByAccountId.set(
          order.account.accountId,
          roundToSixDecimals((soldByAccountId.get(order.account.accountId) ?? 0) + order.volumeUsd),
        );
      }
      const initiallyFundedBuyCandidates = input.accounts.filter((account) =>
        account.pairCompatible && account.buyRemainingQuoteUsd >= minOrderUsd,
      );
      const initialBuyCapacityUsd = initiallyFundedBuyCandidates.reduce(
        (sum, account) => sum + account.buyRemainingQuoteUsd,
        0,
      );
      const buyCandidates = initialBuyCapacityUsd + MIN_VOLUME_EPSILON >= buySpec.totalVolumeUsd
        ? initiallyFundedBuyCandidates
        : input.accounts.filter((account) =>
            account.pairCompatible &&
            account.buyRemainingQuoteUsd + (soldByAccountId.get(account.accountId) ?? 0) >= minOrderUsd,
          );
      const candidateBuyOrders = allocateAccountOrders(
        buyCandidates,
        buySpec.totalVolumeUsd,
        candidateBuyCount,
        minOrderUsd,
        maxOrderUsd,
        input.config.execution,
        (account) => account.buyRemainingQuoteUsd + (soldByAccountId.get(account.accountId) ?? 0),
        createDeterministicRandom(
          `${input.seedBase}:shakeout:buy-amounts:${candidateBuyCount}`,
        ),
        'random',
      );
      if (candidateBuyOrders) {
        sellOrders = candidateSellOrders;
        buyOrders = candidateBuyOrders;
        break;
      }
    }
    if (sellOrders && buyOrders) {
      break;
    }
  }
  if (!sellOrders || !buyOrders) {
    return [];
  }

  const sequenceRandom = createDeterministicRandom(`${input.seedBase}:shakeout:sequence`);
  const rankedOrders: SelfCyclingOrderEntry[] = [
    ...sellOrders
      .map((order, index) => ({
        order,
        side: 'sell' as const,
        rank: sequenceRandom(),
        index,
      }))
      .sort((left, right) => right.order.volumeUsd - left.order.volumeUsd || left.rank - right.rank || left.index - right.index),
    ...buyOrders
      .map((order, index) => ({
        order,
        side: 'buy' as const,
        rank: sequenceRandom(),
        index: sellOrders.length + index,
      }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index),
  ];
  const sellCount = sellOrders.length;
  const buyCount = buyOrders.length;
  const dumpRatio = positiveNumber(input.config.execution.tactics.dumpRatio);
  const pullbackRatio = clamp(positiveNumber(input.config.targetPullbackPct) / 100, 0, 0.3);
  const volatilityRatio = clamp(positiveNumber(input.config.targetVolatilityPct) / 100, 0, 0.3);
  const curveAggression = clamp(dumpRatio / 4 + pullbackRatio * 2 + volatilityRatio, 0, 1);
  const sellWindowRatio = clamp(0.42 - curveAggression * 0.2, 0.18, 0.4);
  const recoveryGapRatio = clamp(0.12 + pullbackRatio * 0.7, 0.1, 0.28);
  const buyStartRatio = clamp(sellWindowRatio + recoveryGapRatio, 0.36, 0.7);
  const sellCurveExponent = 1.25 + curveAggression * 1.35;
  const buyCurveExponent = 0.95 - curveAggression * 0.35;
  const tasks = rankedOrders.map((entry, index) => {
    const spec = entry.side === 'buy' ? buySpec : sellSpec;
    const stageIndex = entry.side === 'sell' ? index : index - sellCount;
    const stageProgress = entry.side === 'sell'
      ? curveProgress(stageIndex, sellCount, sellCurveExponent)
      : curveProgress(stageIndex, buyCount, buyCurveExponent);
    const scheduledAtRatio = entry.side === 'sell'
      ? sellWindowRatio * stageProgress
      : buyStartRatio + (1 - buyStartRatio) * stageProgress;
    return {
      taskId: `${spec.pulse ?? entry.side}-${entry.side}-${index + 1}`,
      side: entry.side,
      pulse: spec.pulse,
      orderIndex: index + 1,
      totalOrders: rankedOrders.length,
      scheduledAt: Math.round(
        input.startTime + input.config.baseDurationMs * scheduledAtRatio,
      ),
      totalVolumeUsd: entry.order.volumeUsd,
      unallocatedVolumeUsd: 0,
      allocations: [buildTaskAllocation(entry.order)],
    } satisfies StrategyPlannerTask;
  });

  for (const order of sellOrders) {
    reservePlannedAllocation(order.account, 'sell', order.volumeUsd);
  }
  for (const order of buyOrders) {
    reservePlannedAllocation(order.account, 'buy', order.volumeUsd);
  }
  return tasks;
}

function buildAccountAwareSelfCyclingTasks(input: {
  document: StrategyVersionDocument;
  config: StrategyPlannerConfig;
  taskSpecs: StrategyPlannerTaskSpec[];
  accounts: MutablePlannerAccount[];
  startTime: number;
  seedBase: string;
}): StrategyPlannerTask[] | null {
  if (
    input.config.macroObjective === 'distribution' ||
    input.taskSpecs.length !== 2 ||
    input.taskSpecs[0]?.side !== 'sell' ||
    input.taskSpecs[1]?.side !== 'buy'
  ) {
    return null;
  }

  const minOrderUsd = input.config.minOrderUsd;
  const maxOrderUsd = input.config.maxOrderUsd;
  if (input.config.macroObjective === 'shakeout') {
    return buildShakeoutCurveManagedTasks(input);
  }
  const sellerCandidates = input.accounts
    .filter(
      (account) =>
        account.pairCompatible &&
        account.sellCapacityUsd >= minOrderUsd,
    )
    .sort((left, right) => right.sellCapacityUsd - left.sellCapacityUsd);
  const maximumSellOrderCount = Math.floor(
    (input.taskSpecs[0].totalVolumeUsd + MIN_VOLUME_EPSILON) / minOrderUsd,
  );
  const maximumBuyOrderCount = Math.floor(
    (input.taskSpecs[1].totalVolumeUsd + MIN_VOLUME_EPSILON) / minOrderUsd,
  );
  let sellOrders: PlannedAccountOrder[] | null = null;
  let buyOrders: PlannedAccountOrder[] | null = null;
  const countRandom = createDeterministicRandom(`${input.seedBase}:self-cycling:trade-count`);
  const candidateTotals = Array.from(
    { length: Math.max(0, input.config.maxOrderCount - input.config.baseOrderCount + 1) },
    (_, index) => input.config.baseOrderCount + index,
  );
  for (let index = candidateTotals.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(countRandom() * (index + 1));
    [candidateTotals[index], candidateTotals[swapIndex]] = [candidateTotals[swapIndex]!, candidateTotals[index]!];
  }
  for (const candidateTotal of candidateTotals) {
    if (sellOrders) {
      break;
    }
    for (
      let candidateSellCount = Math.min(
        maximumSellOrderCount, candidateTotal - input.taskSpecs[1].orderCount,
      );
      candidateSellCount >= input.taskSpecs[0].orderCount;
      candidateSellCount -= 1
    ) {
      const candidateBuyCount = candidateTotal - candidateSellCount;
      if (
        candidateBuyCount < input.taskSpecs[1].orderCount ||
        candidateBuyCount > maximumBuyOrderCount
      ) {
        continue;
      }
      const candidateSellOrders = allocateAccountOrders(
        sellerCandidates,
        input.taskSpecs[0].totalVolumeUsd,
        candidateSellCount,
        minOrderUsd,
        maxOrderUsd,
        input.config.execution,
        (account) => account.sellCapacityUsd,
        createDeterministicRandom(
          `${input.seedBase}:self-cycling:sell-amounts:${candidateSellCount}`,
        ),
        'random',
      );
      if (!candidateSellOrders) {
        continue;
      }
      const soldByAccountId = new Map<number, number>();
      for (const order of candidateSellOrders) {
        soldByAccountId.set(
          order.account.accountId,
          roundToSixDecimals((soldByAccountId.get(order.account.accountId) ?? 0) + order.volumeUsd),
        );
      }
      const buyCandidates = input.accounts.filter((account) =>
        account.pairCompatible &&
        account.buyRemainingQuoteUsd + (soldByAccountId.get(account.accountId) ?? 0) >= minOrderUsd,
      );
      const candidateBuyOrders = allocateAccountOrders(
        buyCandidates,
        input.taskSpecs[1].totalVolumeUsd,
        candidateBuyCount,
        minOrderUsd,
        maxOrderUsd,
        input.config.execution,
        (account) => account.buyRemainingQuoteUsd + (soldByAccountId.get(account.accountId) ?? 0),
        createDeterministicRandom(
          `${input.seedBase}:self-cycling:buy-amounts:${candidateBuyCount}`,
        ),
        'random',
      );
      if (candidateBuyOrders) {
        sellOrders = candidateSellOrders;
        buyOrders = candidateBuyOrders;
        break;
      }
    }
  }
  if (!sellOrders || !buyOrders) {
    return [];
  }
  const sequenceRandom = createDeterministicRandom(`${input.seedBase}:self-cycling:sequence`);
  const remainingOrders: SelfCyclingOrderEntry[] = [
    ...buyOrders.map((order, index) => ({
      order,
      side: 'buy' as const,
      rank: sequenceRandom(),
      index,
    })),
    ...sellOrders.map((order, index) => ({
      order,
      side: 'sell' as const,
      rank: sequenceRandom(),
      index: buyOrders.length + index,
    })),
  ];
  const availableQuoteByAccountId = new Map(
    input.accounts.map((account) => [account.accountId, account.buyRemainingQuoteUsd]),
  );
  const rankedOrders: SelfCyclingOrderEntry[] = [];
  while (remainingOrders.length > 0) {
    let executableOrders = remainingOrders
      .filter((entry) =>
        entry.side === 'sell' ||
        (availableQuoteByAccountId.get(entry.order.account.accountId) ?? 0) +
          MIN_VOLUME_EPSILON >= entry.order.volumeUsd,
      )
      .sort((left, right) => left.rank - right.rank || left.index - right.index);
    const previousSide = rankedOrders[rankedOrders.length - 1]?.side;
    const hasSameSideStreak = previousSide != null &&
      rankedOrders[rankedOrders.length - 2]?.side === previousSide;
    if (hasSameSideStreak) {
      const oppositeSideOrders = executableOrders.filter(
        (entry) => entry.side !== previousSide,
      );
      if (oppositeSideOrders.length > 0) {
        executableOrders = oppositeSideOrders;
      }
    }
    const selected = executableOrders[0];
    if (!selected) {
      return [];
    }
    remainingOrders.splice(remainingOrders.indexOf(selected), 1);
    rankedOrders.push(selected);
    const currentQuote = availableQuoteByAccountId.get(selected.order.account.accountId) ?? 0;
    availableQuoteByAccountId.set(
      selected.order.account.accountId,
      currentQuote + (selected.side === 'sell' ? selected.order.volumeUsd : -selected.order.volumeUsd),
    );
  }
  const totalDurationMs = Math.max(
    input.taskSpecs[0].scheduledOffsetMs + input.taskSpecs[0].durationMs,
    input.taskSpecs[1].scheduledOffsetMs + input.taskSpecs[1].durationMs,
  );
  const schedulePlan = buildRandomizedTwapPlan(input.config.execution, {
    side: 'buy',
    totalVolume: rankedOrders.length,
    orderCount: rankedOrders.length,
    durationMs: totalDurationMs,
    startTime: input.startTime,
    minOrderUsd: 1,
    maxOrderUsd: 1,
    strictOrderCount: true,
    random: createDeterministicRandom(`${input.seedBase}:self-cycling:schedule`),
  });
  const tasks = rankedOrders.map((entry, index) => {
    const spec = entry.side === 'buy' ? input.taskSpecs[1] : input.taskSpecs[0];
    return {
      taskId: `${spec.pulse ?? entry.side}-${entry.side}-${index + 1}`,
      side: entry.side,
      pulse: spec.pulse,
      orderIndex: index + 1,
      totalOrders: rankedOrders.length,
      scheduledAt: schedulePlan.slices[index]?.scheduledAt ?? input.startTime,
      totalVolumeUsd: entry.order.volumeUsd,
      unallocatedVolumeUsd: 0,
      allocations: [{
        accountId: entry.order.account.accountId,
        label: entry.order.account.label,
        walletAddress: entry.order.account.walletAddress,
        plannedVolumeUsd: entry.order.volumeUsd,
        quoteAvailableAmount: entry.order.account.quoteAvailableAmount,
        baseTokenAmount: entry.order.account.baseTokenAmount,
        solBalance: entry.order.account.solBalance,
        accountBuyOverAllocated: false,
        accountBuyOverAllocationUsd: 0,
      }],
    } satisfies StrategyPlannerTask;
  });

  for (const order of sellOrders) {
    reservePlannedAllocation(order.account, 'sell', order.volumeUsd);
  }
  for (const order of buyOrders) {
    reservePlannedAllocation(order.account, 'buy', order.volumeUsd);
  }
  return tasks;
}

export function createDeterministicRandom(seedText: string): () => number {
  const generator = rngChacha20(new TextEncoder().encode(seedText));
  return () => {
    const bytes = generator.randomBytes(4);
    const value = (
      bytes[0]! |
      (bytes[1]! << 8) |
      (bytes[2]! << 16) |
      (bytes[3]! << 24)
    ) >>> 0;
    return value / 4294967296;
  };
}

export function deriveRequiredNetBuyAmount(
  document: StrategyVersionDocument,
  fallback = 0,
): number {
  if (
    Number.isFinite(document.targets.netBuyinUsdMin) &&
    document.targets.netBuyinUsdMin >= 0
  ) {
    return document.targets.netBuyinUsdMin;
  }
  return positiveNumber(fallback);
}

function normalizePlannerTaskOrderCount(orderCount: number): number {
  return Math.max(1, Math.floor(orderCount));
}

function resolveMinimumSelfCyclingSellVolume(
  config: StrategyPlannerConfig,
): number {
  const baseVolumeUsd = positiveNumber(config.baseTotalVolumeUsd);
  const pullbackIntensity = clamp(positiveNumber(config.targetPullbackPct) / 100, 0, 0.3);
  const volatilityIntensity = clamp(positiveNumber(config.targetVolatilityPct) / 100, 0, 0.3);
  const tacticRatio = config.macroObjective === 'shakeout'
    ? Math.min(
        0.6,
        Math.max(
          0.1,
          config.execution.tactics.dumpRatio * 0.12 + pullbackIntensity + volatilityIntensity * 0.5,
        ),
      )
    : Math.min(0.25, Math.max(0.05, config.execution.tactics.absorbRatio * 0.1));
  return roundToSixDecimals(Math.max(
    config.minOrderUsd,
    baseVolumeUsd * tacticRatio,
  ));
}

export function buildStrategyPlanTaskSpecs(
  config: StrategyPlannerConfig,
  requiredNetBuyAmount: number,
): StrategyPlannerTaskSpec[] {
  const plannerOrderCount = normalizePlannerTaskOrderCount(config.baseOrderCount);
  const totalVolumeUsd = positiveNumber(config.baseTotalVolumeUsd);
  const staggeredPulseOffsetMs = Math.min(750, config.baseDurationMs);

  switch (config.macroObjective) {
    case 'distribution': {
      const { buyCount, sellCount } = splitBasePlannedTransactionCount(
        config.macroObjective,
        plannerOrderCount,
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
          durationMs: Math.max(0, config.baseDurationMs - staggeredPulseOffsetMs),
          scheduledOffsetMs: staggeredPulseOffsetMs,
        },
      ];
    }
    case 'accumulation':
    case 'shakeout': {
      const { buyVolumeUsd, sellVolumeUsd } = calculateSelfCyclingTradeTotals(
        totalVolumeUsd,
        positiveNumber(requiredNetBuyAmount),
        resolveMinimumSelfCyclingSellVolume(config),
      );
      const feasibleCounts = calculateFeasibleTradeCounts(
        plannerOrderCount,
        config.maxOrderCount,
        buyVolumeUsd,
        sellVolumeUsd,
        config.minOrderUsd,
        config.maxOrderUsd,
      );
      const fallbackSellCount = Math.max(1, Math.round(
        plannerOrderCount * sellVolumeUsd / Math.max(MIN_VOLUME_EPSILON, totalVolumeUsd),
      ));
      const sellCount = feasibleCounts?.sellCount ?? Math.min(
        plannerOrderCount - 1,
        fallbackSellCount,
      );
      const buyCount = feasibleCounts?.buyCount ?? plannerOrderCount - sellCount;

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
          durationMs: config.baseDurationMs,
          scheduledOffsetMs: 0,
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
  minOrderUsd: number,
): MutablePlannerAccount {
  const solBalance = Number.parseFloat(account.walletBalance.sol) || 0;
  const storedSellCapacityUsd = buildSellCapacityUsd(account, baseTokenPriceUsd);
  const existingPlannedBuyVolumeUsd = existingVolumes.buy.get(account.id) ?? 0;
  const existingPlannedSellVolumeUsd = existingVolumes.sell.get(account.id) ?? 0;
  const sellCapacityUsd = Math.max(
    0,
    storedSellCapacityUsd + existingPlannedBuyVolumeUsd - existingPlannedSellVolumeUsd,
  );
  const buyRemainingQuoteUsd = Math.max(
    0,
    account.quoteAvailableAmount - existingPlannedBuyVolumeUsd + existingPlannedSellVolumeUsd,
  );
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
    buyRemainingQuoteUsd,
    isBuyOverAllocated: false,
    pairCompatible: account.pairCompatible,
    eligibleForBuy: account.pairCompatible && buyRemainingQuoteUsd >= minOrderUsd,
    eligibleForSell: account.pairCompatible && sellCapacityUsd >= minOrderUsd,
    existingPlannedBuyVolumeUsd,
    existingPlannedSellVolumeUsd,
    sellCapacityUsd,
  };
}

function reservePlannedAllocation(
  account: MutablePlannerAccount,
  side: 'buy' | 'sell',
  volumeUsd: number,
): void {
  if (side === 'buy') {
    account.plannedBuyVolumeUsd = roundToSixDecimals(
      account.plannedBuyVolumeUsd + volumeUsd,
    );
    account.buyRemainingQuoteUsd = roundToSixDecimals(
      Math.max(0, account.buyRemainingQuoteUsd - volumeUsd),
    );
    return;
  }
  account.plannedSellVolumeUsd = roundToSixDecimals(
    account.plannedSellVolumeUsd + volumeUsd,
  );
  account.buyRemainingQuoteUsd = roundToSixDecimals(
    account.buyRemainingQuoteUsd + volumeUsd,
  );
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
  const eligibleAssetAccounts = input.accounts.filter(
    (account) =>
      account.pairCompatible &&
      (account.quoteAvailableAmount > MIN_VOLUME_EPSILON ||
        account.baseTokenAmount > MIN_VOLUME_EPSILON),
  );
  const accountSummaries = new Map<number, MutablePlannerAccount>(
    eligibleAssetAccounts.map((account) => [
      account.id,
      toMutablePlannerAccount(
        account,
        input.baseTokenPriceUsd,
        input.existingPlannedVolumes ?? createEmptyPlanningVolumeMaps(),
        input.config.minOrderUsd,
      ),
    ]),
  );

  const tasks: StrategyPlannerTask[] = [];
  let requestedTaskCount = input.taskSpecs.reduce(
    (sum, spec) => sum + Math.max(0, Math.floor(spec.orderCount)),
    0,
  );
  let unallocatedVolumeUsd = 0;
  const accountAwareTasks = buildAccountAwareSelfCyclingTasks({
    document: input.document,
    config: input.config,
    taskSpecs: input.taskSpecs,
    accounts: [...accountSummaries.values()],
    startTime: input.startTime,
    seedBase,
  });
  if (accountAwareTasks != null) {
    tasks.push(...accountAwareTasks);
    if (accountAwareTasks.length === 0) {
      unallocatedVolumeUsd = roundToSixDecimals(
        input.taskSpecs.reduce((sum, spec) => sum + spec.totalVolumeUsd, 0),
      );
    }
  } else {
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
      strictOrderCount: true,
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

      const random = createDeterministicRandom(
        `${seedBase}:allocation:${specIndex}:${spec.side}:${spec.pulse ?? 'base'}:${slice.orderIndex}`,
      );

      const allocationPlan = allocateBoundedOrderVolume(
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
            existingPlannedVolumeUsd,
          };
        }),
        {
          minOrderUsd: input.config.minOrderUsd,
          accountCyclingEnabled: input.document.execution.accountCyclingEnabled,
          rotationOffset: rotationOffsets[spec.side],
          accountDispersionStrength: input.document.execution.accountDispersionStrength,
          random,
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
          reservePlannedAllocation(account, spec.side, plannedVolumeUsd);
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

      const allocatedVolumeUsd = roundToSixDecimals(
        allocations.reduce((sum, allocation) => sum + allocation.plannedVolumeUsd, 0),
      );
      unallocatedVolumeUsd = roundToSixDecimals(
        unallocatedVolumeUsd + allocationPlan.unallocatedVolumeUsd,
      );
      if (allocatedVolumeUsd <= MIN_VOLUME_EPSILON) {
        continue;
      }

      tasks.push({
        taskId: `${spec.pulse ?? spec.side}-${specIndex + 1}-${slice.orderIndex}`,
        side: spec.side,
        pulse: spec.pulse,
        orderIndex: slice.orderIndex,
        totalOrders: plan.orderCount,
        scheduledAt: slice.scheduledAt + spec.scheduledOffsetMs,
        totalVolumeUsd: allocatedVolumeUsd,
        unallocatedVolumeUsd: roundToSixDecimals(allocationPlan.unallocatedVolumeUsd),
        allocations,
      });
    }
    });
  }

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

  const executableAccountList = accountList.filter(
    (account) =>
      account.plannedBuyVolumeUsd > MIN_VOLUME_EPSILON ||
      account.plannedSellVolumeUsd > MIN_VOLUME_EPSILON,
  );
  const eligibleBuyAccounts = accountList.filter((account) => account.eligibleForBuy);
  const isExecutable =
    tasks.length >= requestedTaskCount &&
    tasks.length <= input.config.maxOrderCount &&
    unallocatedVolumeUsd <= MIN_VOLUME_EPSILON;
  return {
    accounts: executableAccountList,
    tasks: tasks.sort((left, right) =>
      left.scheduledAt - right.scheduledAt || left.taskId.localeCompare(right.taskId),
    ),
    requestedTaskCount,
    plannedTaskCount: tasks.length,
    unallocatedVolumeUsd,
    isExecutable,
    availableBuyAmount: roundToSixDecimals(
      eligibleBuyAccounts.reduce((sum, account) => sum + account.quoteAvailableAmount, 0),
    ),
    eligibleTradingAccountCount: eligibleAssetAccounts.length,
    eligibleBuyAccountCount: eligibleBuyAccounts.length,
    skippedForCapabilityCount: input.accounts.filter((account) => !account.pairCompatible).length,
    skippedForNoPairAssetCount: input.accounts.filter(
      (account) =>
        account.pairCompatible &&
        account.quoteAvailableAmount <= MIN_VOLUME_EPSILON &&
        account.baseTokenAmount <= MIN_VOLUME_EPSILON,
    ).length,
    lowSolWarningCount: accountList.filter(
      (account) =>
        account.pairCompatible &&
        (account.quoteAvailableAmount > 0 || account.baseTokenAmount > 0) &&
        account.solBalance < 0.01,
    ).length,
  };
}