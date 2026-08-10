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
  requestedTaskCount: number;
  plannedTaskCount: number;
  unallocatedVolumeUsd: number;
  isExecutable: boolean;
  availableBuyAmount: number;
  eligibleBuyAccountCount: number;
  skippedForCapabilityCount: number;
  lowSolWarningCount: number;
};

export type StrategyPlannerConfig = {
  macroObjective: StrategyMacroObjective;
  baseOrderCount: number;
  maxOrderCount: number;
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

type OrderAllocationCandidate = {
  account: MutablePlannerAccount;
  maxVolumeUsd: number;
  existingPlannedVolumeUsd: number;
};

type PlannedAccountOrder = {
  account: MutablePlannerAccount;
  volumeUsd: number;
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

function splitAccountAmountIntoOrders(
  account: MutablePlannerAccount,
  amountUsd: number,
  minOrderUsd: number,
  maxOrderUsd: number,
): PlannedAccountOrder[] | null {
  const normalizedAmount = roundToSixDecimals(amountUsd);
  if (normalizedAmount + MIN_VOLUME_EPSILON < minOrderUsd) {
    return null;
  }
  const orderCount = Math.max(1, Math.ceil(normalizedAmount / maxOrderUsd));
  if (normalizedAmount + MIN_VOLUME_EPSILON < orderCount * minOrderUsd) {
    return null;
  }
  const baseAmount = normalizedAmount / orderCount;
  const orders: PlannedAccountOrder[] = [];
  let remaining = normalizedAmount;
  for (let index = 0; index < orderCount; index += 1) {
    const remainingOrders = orderCount - index;
    const volumeUsd = index === orderCount - 1
      ? remaining
      : roundToSixDecimals(remaining / remainingOrders);
    if (
      volumeUsd + MIN_VOLUME_EPSILON < minOrderUsd ||
      volumeUsd - MIN_VOLUME_EPSILON > maxOrderUsd
    ) {
      return null;
    }
    orders.push({ account, volumeUsd });
    remaining = roundToSixDecimals(remaining - volumeUsd);
  }
  return orders;
}

function allocateNetBuyOrders(
  accounts: MutablePlannerAccount[],
  targetUsd: number,
  minOrderUsd: number,
  maxOrderUsd: number,
): PlannedAccountOrder[] | null {
  let remaining = roundToSixDecimals(targetUsd);
  const allocations: PlannedAccountOrder[] = [];
  const fundedAccounts = accounts
    .filter((account) => account.pairCompatible && account.buyRemainingQuoteUsd >= minOrderUsd)
    .sort((left, right) => right.buyRemainingQuoteUsd - left.buyRemainingQuoteUsd);

  for (let index = 0; index < fundedAccounts.length && remaining > MIN_VOLUME_EPSILON; index += 1) {
    const account = fundedAccounts[index]!;
    const remainingCapacity = fundedAccounts
      .slice(index + 1)
      .reduce((sum, candidate) => sum + candidate.buyRemainingQuoteUsd, 0);
    const amountUsd = roundToSixDecimals(
      Math.min(account.buyRemainingQuoteUsd, remaining),
    );
    if (remaining - amountUsd > remainingCapacity + MIN_VOLUME_EPSILON) {
      return null;
    }
    const accountOrders = splitAccountAmountIntoOrders(
      account,
      amountUsd,
      minOrderUsd,
      maxOrderUsd,
    );
    if (!accountOrders) {
      return null;
    }
    allocations.push(...accountOrders);
    remaining = roundToSixDecimals(remaining - amountUsd);
  }

  return remaining <= MIN_VOLUME_EPSILON ? allocations : null;
}

function buildAccountAwareSelfCyclingTasks(input: {
  document: StrategyVersionDocument;
  config: StrategyPlannerConfig;
  taskSpecs: StrategyPlannerTaskSpec[];
  accounts: MutablePlannerAccount[];
  startTime: number;
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
  const netBuyAmountUsd = roundToSixDecimals(
    input.taskSpecs[1].totalVolumeUsd - input.taskSpecs[0].totalVolumeUsd,
  );
  const initiallyFundedAccounts = input.accounts.filter(
    (account) => account.pairCompatible && account.buyRemainingQuoteUsd >= minOrderUsd,
  );
  const targetBuyAccountCount = Math.max(
    initiallyFundedAccounts.length,
    input.taskSpecs[1].orderCount,
  );
  const minimumUnlockedAccountCount = Math.max(
    0,
    targetBuyAccountCount - initiallyFundedAccounts.length,
  );
  const sellerCandidates = input.accounts
    .filter(
      (account) =>
        account.pairCompatible &&
        account.sellCapacityUsd >= minOrderUsd &&
        account.buyRemainingQuoteUsd < minOrderUsd,
    )
    .sort((left, right) => right.sellCapacityUsd - left.sellCapacityUsd);

  const sellerCountCandidates = [
    ...Array.from(
      { length: Math.max(0, sellerCandidates.length - minimumUnlockedAccountCount + 1) },
      (_, index) => minimumUnlockedAccountCount + index,
    ),
  ];

  for (const sellerCount of sellerCountCandidates) {
    const sellers = sellerCandidates.slice(0, sellerCount);
    const minimumSellVolumeUsd = Math.max(
      input.taskSpecs[0].totalVolumeUsd,
      sellerCount * minOrderUsd,
    );
    const sellOrders: PlannedAccountOrder[] = [];
    let remainingSellVolumeUsd = roundToSixDecimals(minimumSellVolumeUsd);
    let validSellers = true;
    for (let index = 0; index < sellers.length; index += 1) {
      const seller = sellers[index]!;
      const remainingSellers = sellers.length - index - 1;
      const volumeUsd = roundToSixDecimals(
        Math.min(
          seller.sellCapacityUsd,
          maxOrderUsd,
          remainingSellVolumeUsd - remainingSellers * minOrderUsd,
        ),
      );
      if (volumeUsd + MIN_VOLUME_EPSILON < minOrderUsd) {
        validSellers = false;
        break;
      }
      sellOrders.push({ account: seller, volumeUsd });
      remainingSellVolumeUsd = roundToSixDecimals(remainingSellVolumeUsd - volumeUsd);
    }
    if (!validSellers || remainingSellVolumeUsd > MIN_VOLUME_EPSILON) {
      continue;
    }

    const netBuyOrders = allocateNetBuyOrders(
      initiallyFundedAccounts,
      netBuyAmountUsd,
      minOrderUsd,
      maxOrderUsd,
    );
    if (!netBuyOrders) {
      continue;
    }
    const buybackOrders = sellOrders.map((order) => ({ ...order }));
    const buyOrders = [...buybackOrders, ...netBuyOrders];
    const transactionCount = sellOrders.length + buyOrders.length;
    if (
      transactionCount < input.config.baseOrderCount ||
      transactionCount > input.config.maxOrderCount
    ) {
      continue;
    }

    const sellDurationMs = input.taskSpecs[0].durationMs;
    const buyDurationMs = input.taskSpecs[1].durationMs;
    const createTasks = (
      side: 'buy' | 'sell',
      orders: PlannedAccountOrder[],
      durationMs: number,
      scheduledOffsetMs: number,
      pulse: string | null,
    ): StrategyPlannerTask[] => orders.map((order, index) => ({
      taskId: `${pulse ?? side}-${side}-${index + 1}`,
      side,
      pulse,
      orderIndex: index + 1,
      totalOrders: orders.length,
      scheduledAt:
        input.startTime +
        scheduledOffsetMs +
        (orders.length > 1 ? Math.round((durationMs * index) / (orders.length - 1)) : 0),
      totalVolumeUsd: order.volumeUsd,
      unallocatedVolumeUsd: 0,
      allocations: [{
        accountId: order.account.accountId,
        label: order.account.label,
        walletAddress: order.account.walletAddress,
        plannedVolumeUsd: order.volumeUsd,
        quoteAvailableAmount: order.account.quoteAvailableAmount,
        baseTokenAmount: order.account.baseTokenAmount,
        solBalance: order.account.solBalance,
        accountBuyOverAllocated: false,
        accountBuyOverAllocationUsd: 0,
      }],
    }));

    for (const order of sellOrders) {
      order.account.plannedSellVolumeUsd = roundToSixDecimals(
        order.account.plannedSellVolumeUsd + order.volumeUsd,
      );
    }
    for (const order of buyOrders) {
      order.account.plannedBuyVolumeUsd = roundToSixDecimals(
        order.account.plannedBuyVolumeUsd + order.volumeUsd,
      );
    }
    for (const account of input.accounts) {
      account.buyRemainingQuoteUsd = roundToSixDecimals(
        Math.max(
          0,
          account.quoteAvailableAmount +
            account.existingPlannedSellVolumeUsd +
            account.plannedSellVolumeUsd -
            account.existingPlannedBuyVolumeUsd -
            account.plannedBuyVolumeUsd,
        ),
      );
    }

    return [
      ...createTasks(
        'sell',
        sellOrders,
        sellDurationMs,
        input.taskSpecs[0].scheduledOffsetMs,
        input.taskSpecs[0].pulse,
      ),
      ...createTasks(
        'buy',
        buyOrders,
        buyDurationMs,
        input.taskSpecs[1].scheduledOffsetMs,
        input.taskSpecs[1].pulse,
      ),
    ];
  }

  return [];
}

function rotateCandidates<T>(candidates: T[], offset: number): T[] {
  if (candidates.length <= 1) {
    return candidates;
  }
  const normalizedOffset = ((offset % candidates.length) + candidates.length) % candidates.length;
  return [
    ...candidates.slice(normalizedOffset),
    ...candidates.slice(0, normalizedOffset),
  ];
}

function allocateExecutableOrderVolume(
  targetVolumeUsd: number,
  candidates: OrderAllocationCandidate[],
  options: {
    minOrderUsd: number;
    accountCyclingEnabled: boolean;
    rotationOffset: number;
    accountDispersionStrength: number;
  },
): {
  allocations: Array<{ accountId: number; volumeUsd: number }>;
  unallocatedVolumeUsd: number;
  nextRotationOffset: number;
} {
  const normalizedTargetVolumeUsd = roundToSixDecimals(targetVolumeUsd);
  const minOrderUsd = roundToSixDecimals(Math.max(MIN_VOLUME_EPSILON, options.minOrderUsd));
  const eligibleCandidates = candidates
    .filter((candidate) => candidate.maxVolumeUsd + MIN_VOLUME_EPSILON >= minOrderUsd)
    .sort((left, right) => {
      const leftCoversTarget = left.maxVolumeUsd + MIN_VOLUME_EPSILON >= normalizedTargetVolumeUsd;
      const rightCoversTarget = right.maxVolumeUsd + MIN_VOLUME_EPSILON >= normalizedTargetVolumeUsd;
      if (leftCoversTarget !== rightCoversTarget) {
        return leftCoversTarget ? -1 : 1;
      }
      if (options.accountDispersionStrength > 0) {
        const volumeDifference = left.existingPlannedVolumeUsd - right.existingPlannedVolumeUsd;
        if (Math.abs(volumeDifference) > MIN_VOLUME_EPSILON) {
          return volumeDifference;
        }
      }
      return left.account.accountId - right.account.accountId;
    });
  const orderedCandidates = options.accountCyclingEnabled
    ? rotateCandidates(eligibleCandidates, options.rotationOffset)
    : eligibleCandidates;
  const nextRotationOffset = options.accountCyclingEnabled && eligibleCandidates.length > 0
    ? (options.rotationOffset + 1) % eligibleCandidates.length
    : 0;

  if (normalizedTargetVolumeUsd < minOrderUsd || orderedCandidates.length === 0) {
    return {
      allocations: [],
      unallocatedVolumeUsd: normalizedTargetVolumeUsd,
      nextRotationOffset,
    };
  }

  let remainingVolumeUsd = normalizedTargetVolumeUsd;
  const allocations: Array<{ accountId: number; volumeUsd: number }> = [];
  for (const candidate of orderedCandidates) {
    if (remainingVolumeUsd + MIN_VOLUME_EPSILON < minOrderUsd) {
      break;
    }
    let volumeUsd = roundToSixDecimals(
      Math.min(candidate.maxVolumeUsd, remainingVolumeUsd),
    );
    const remainingAfterAllocation = roundToSixDecimals(remainingVolumeUsd - volumeUsd);
    if (remainingAfterAllocation > 0 && remainingAfterAllocation < minOrderUsd) {
      const adjustment = minOrderUsd - remainingAfterAllocation;
      if (volumeUsd - adjustment >= minOrderUsd) {
        volumeUsd = roundToSixDecimals(volumeUsd - adjustment);
      }
    }
    if (volumeUsd + MIN_VOLUME_EPSILON < minOrderUsd) {
      continue;
    }
    allocations.push({
      accountId: candidate.account.accountId,
      volumeUsd: roundToSixDecimals(volumeUsd),
    });
    remainingVolumeUsd = roundToSixDecimals(
      Math.max(0, remainingVolumeUsd - volumeUsd),
    );
  }

  return {
    allocations,
    unallocatedVolumeUsd: remainingVolumeUsd,
    nextRotationOffset,
  };
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

function normalizePlannerTaskOrderCount(orderCount: number): number {
  return Math.max(1, Math.floor(orderCount));
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
  const plannerOrderCount = normalizePlannerTaskOrderCount(config.baseOrderCount);
  const totalVolumeUsd = positiveNumber(config.baseTotalVolumeUsd);

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
        plannerOrderCount,
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
  minOrderUsd: number,
): MutablePlannerAccount {
  const solBalance = Number.parseFloat(account.walletBalance.sol) || 0;
  const sellCapacityUsd = buildSellCapacityUsd(account, baseTokenPriceUsd);
  const existingPlannedBuyVolumeUsd = existingVolumes.buy.get(account.id) ?? 0;
  const existingPlannedSellVolumeUsd = existingVolumes.sell.get(account.id) ?? 0;
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
  });
  if (accountAwareTasks != null) {
    tasks.push(...accountAwareTasks);
    if (accountAwareTasks.length > 0) {
      requestedTaskCount = accountAwareTasks.length;
    } else {
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

      const allocationPlan = allocateExecutableOrderVolume(
        slice.targetVolume,
        eligibleAccounts.map((account) => {
          const existingPlannedVolumeUsd = spec.side === 'buy'
            ? account.existingPlannedBuyVolumeUsd + account.plannedBuyVolumeUsd
            : account.existingPlannedSellVolumeUsd + account.plannedSellVolumeUsd;
          const maxVolumeUsd = spec.side === 'buy'
            ? account.buyRemainingQuoteUsd
            : Math.max(0, account.sellCapacityUsd - existingPlannedVolumeUsd);
          return {
            account,
            maxVolumeUsd,
            existingPlannedVolumeUsd,
          };
        }),
        {
          minOrderUsd: input.config.minOrderUsd,
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
    tasks.length === requestedTaskCount &&
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