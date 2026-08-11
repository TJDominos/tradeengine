import assert from 'node:assert/strict';

import type { ManagedAccountBalanceRecord } from '../src/backend/userStore';
import {
  buildStrategyPlanningResult,
  buildStrategyPlanTaskSpecs,
  deriveRequiredNetBuyAmount,
} from '../src/backend/strategy/planner';
import { buildStrategyPriceCurveReview } from '../src/backend/strategy/priceCurve';
import {
  allocateBoundedOrderVolume,
  calculateFeasibleTradeCounts,
  calculateRemainingPlanVolumes,
  calculateSelfCyclingTradeTotals,
} from '../src/backend/strategy/plannerMath';
import { buildStrategyDocumentFromSettings } from '../src/backend/strategy/runtime';
import { resolveBasePlannedTransactionCount } from '../src/backend/strategy/plannedTransactions';

const baseTokenAddress = 'So11111111111111111111111111111111111111112';
const quoteTokenAddress = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const totals = calculateSelfCyclingTradeTotals(150, 100, 5);
assert.deepEqual(totals, {
  buyVolumeUsd: 125,
  sellVolumeUsd: 25,
  grossVolumeUsd: 150,
  netBuyVolumeUsd: 100,
});

assert.deepEqual(
  calculateRemainingPlanVolumes(125, 25, [
    { side: 'buy', volumeUsd: 30, source: 'managed' },
    { side: 'sell', volumeUsd: 10, source: 'managed' },
    {
      side: 'sell',
      volumeUsd: 40,
      source: 'external',
      responseBuyVolumeUsd: 20,
    },
    {
      side: 'sell',
      volumeUsd: 10,
      source: 'external',
      responseBuyVolumeUsd: 5,
    },
  ]),
  {
    desiredBuyVolumeUsd: 150,
    desiredSellVolumeUsd: 25,
    executedBuyVolumeUsd: 30,
    executedSellVolumeUsd: 10,
    remainingBuyVolumeUsd: 120,
    remainingSellVolumeUsd: 15,
  },
  'event replanning should include every managed fill and every external response',
);

const feasibleCounts = calculateFeasibleTradeCounts(20, 50, 125, 25, 5, 30);
assert.ok(feasibleCounts, 'trade counts should be feasible within the configured bounds');
assert.equal(feasibleCounts.buyCount + feasibleCounts.sellCount, 20);
assert.ok(feasibleCounts.buyCount * 5 <= 125 && feasibleCounts.buyCount * 30 >= 125);
assert.ok(feasibleCounts.sellCount * 5 <= 25 && feasibleCounts.sellCount * 30 >= 25);
assert.equal(
  calculateFeasibleTradeCounts(20, 4, 125, 25, 5, 30),
  null,
  'planner should reject a total order cap below the mathematical minimum',
);

const allocationCandidates = [
  { accountId: 1, maxVolumeUsd: 10, existingPlannedVolumeUsd: 100 },
  { accountId: 2, maxVolumeUsd: 6, existingPlannedVolumeUsd: 0 },
];
const concentratedAllocation = allocateBoundedOrderVolume(10, allocationCandidates, {
  minOrderUsd: 5,
  accountCyclingEnabled: false,
  rotationOffset: 0,
  accountDispersionStrength: 0,
  random: () => 0.5,
});
assert.deepEqual(concentratedAllocation.allocations, [{ accountId: 1, volumeUsd: 10 }]);

const dispersedAllocation = allocateBoundedOrderVolume(10, allocationCandidates, {
  minOrderUsd: 5,
  accountCyclingEnabled: false,
  rotationOffset: 0,
  accountDispersionStrength: 3,
  random: () => 0.5,
});
assert.deepEqual(dispersedAllocation.allocations, [
  { accountId: 2, volumeUsd: 5 },
  { accountId: 1, volumeUsd: 5 },
]);
assert.equal(dispersedAllocation.unallocatedVolumeUsd, 0);

const tieBreakerValues = [0.9, 0.1];
const shuffledEqualAllocation = allocateBoundedOrderVolume(10, [
  { accountId: 1, maxVolumeUsd: 10, existingPlannedVolumeUsd: 0 },
  { accountId: 2, maxVolumeUsd: 10, existingPlannedVolumeUsd: 0 },
], {
  minOrderUsd: 5,
  accountCyclingEnabled: false,
  rotationOffset: 0,
  accountDispersionStrength: 1,
  random: () => tieBreakerValues.shift() ?? 0.5,
});
assert.deepEqual(
  shuffledEqualAllocation.allocations,
  [{ accountId: 2, volumeUsd: 10 }],
  'seeded tie-breaking should shuffle only equally scored accounts',
);

function buildAccount(
  id: number,
  quoteAvailableAmount: number,
  baseTokenAmount: number,
): ManagedAccountBalanceRecord {
  const address = `account-${id}`;
  return {
    id,
    label: `Account ${id}`,
    address,
    type: 'managed',
    capabilityBaseMint: baseTokenAddress,
    capabilityQuoteMint: quoteTokenAddress,
    createdAt: 0,
    isActive: true,
    walletBalance: {
      address,
      sol: '0.1',
      usdc: String(quoteAvailableAmount),
      tokens: [],
      updatedAt: 0,
    },
    quoteAvailableAmount,
    baseTokenAmount,
    hasSolReserve: true,
    pairCompatible: true,
  };
}

const document = buildStrategyDocumentFromSettings({
  baseTokenAddress,
  quoteTokenAddress,
  minTransactions: 20,
  volatilityTarget: 0,
  pullbackTarget: 0,
  volumeTarget: 150,
  netBuyinTarget: 100,
  timeRangeTarget: '24h',
  maxTransactions: 50,
  maxSlippage: 1,
  strategyNotes: 'planner regression',
  macroObjective: 'accumulation',
});
document.parameters.minOrderUsd = 5;
document.parameters.maxOrderUsd = 30;

const config = {
  macroObjective: document.execution.macroObjective,
  baseOrderCount: resolveBasePlannedTransactionCount(document),
  maxOrderCount: document.parameters.maxTransactions,
  baseTotalVolumeUsd: 150,
  baseDurationMs: 60_000,
  minOrderUsd: document.parameters.minOrderUsd,
  maxOrderUsd: document.parameters.maxOrderUsd,
  execution: document.execution,
  baseTokenAddress,
  quoteTokenAddress,
};

const zeroNetDocument = {
  ...document,
  targets: {
    ...document.targets,
    volumeUsdMin: 100,
    netBuyinUsdMin: 0,
  },
};
const zeroNetConfig = {
  ...config,
  baseTotalVolumeUsd: 100,
};
const zeroNetBuyAmount = deriveRequiredNetBuyAmount(zeroNetDocument, 300);
assert.equal(zeroNetBuyAmount, 0, 'an explicit zero net-buy target must not use the fallback');
const zeroNetTaskSpecs = buildStrategyPlanTaskSpecs(zeroNetConfig, zeroNetBuyAmount);
assert.equal(
  zeroNetTaskSpecs.reduce(
    (sum, task) => sum + (task.side === 'buy' ? task.totalVolumeUsd : 0),
    0,
  ),
  50,
);
assert.equal(
  zeroNetTaskSpecs.reduce(
    (sum, task) => sum + (task.side === 'sell' ? task.totalVolumeUsd : 0),
    0,
  ),
  50,
);
const zeroNetPlanning = buildStrategyPlanningResult({
  document: zeroNetDocument,
  config: zeroNetConfig,
  accounts: Array.from({ length: 10 }, (_, index) => buildAccount(index + 1, 0, 5)),
  taskSpecs: zeroNetTaskSpecs,
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext: 'planner-zero-net-buy',
});
assert.equal(zeroNetPlanning.isExecutable, true);
assert.equal(
  zeroNetPlanning.tasks.reduce((sum, task) => sum + task.totalVolumeUsd, 0),
  100,
);
assert.equal(
  zeroNetPlanning.tasks.reduce(
    (sum, task) => sum + (task.side === 'buy' ? task.totalVolumeUsd : -task.totalVolumeUsd),
    0,
  ),
  0,
);

const accounts = [
  buildAccount(1, 34, 0),
  buildAccount(2, 33, 0),
  buildAccount(3, 33, 0),
  ...Array.from({ length: 29 }, (_, index) => buildAccount(index + 4, 0, 5)),
];
const taskSpecs = buildStrategyPlanTaskSpecs(config, 100);
const planning = buildStrategyPlanningResult({
  document,
  config,
  accounts,
  taskSpecs,
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext: 'planner-regression',
});

assert.equal(planning.eligibleBuyAccountCount, 3, 'only accounts able to fund a minimum buy should be eligible');
assert.equal(taskSpecs.reduce((sum, spec) => sum + spec.orderCount, 0), 20, 'task specs should preserve the requested minimum transaction count');
assert.ok(planning.tasks.length >= 20 && planning.tasks.length <= 50, 'planner should dynamically stay within the configured transaction range');
assert.equal(
  planning.isExecutable,
  true,
  `complete planner output should be executable: ${JSON.stringify({
    plannedTaskCount: planning.plannedTaskCount,
    requestedTaskCount: planning.requestedTaskCount,
    unallocatedVolumeUsd: planning.unallocatedVolumeUsd,
    incompleteTasks: planning.tasks
      .filter((task) => task.unallocatedVolumeUsd > 0)
      .map((task) => ({
        side: task.side,
        orderIndex: task.orderIndex,
        totalVolumeUsd: task.totalVolumeUsd,
        unallocatedVolumeUsd: task.unallocatedVolumeUsd,
      })),
  })}`,
);
assert.ok(planning.tasks.every((task) => task.allocations.length > 0), 'every task should have an account allocation');
assert.ok(planning.tasks.every((task) => task.allocations.length === 1), 'each planned task must map to exactly one on-chain transaction');
assert.equal(
  new Set(
    planning.tasks
      .filter((task) => task.side === 'buy')
      .flatMap((task) => task.allocations.map((allocation) => allocation.accountId))
      .filter((accountId) => accountId <= 3),
  ).size,
  3,
  'self-cycling net buys should use every funded eligible account before concentrating orders',
);
assert.ok(
  planning.tasks.filter((task) => task.side === 'sell').length >= 5,
  'sell order count should expand enough to cover per-account sell capacity',
);
const plannedQuoteBalances = new Map(accounts.map((account) => [account.id, account.quoteAvailableAmount]));
for (const task of planning.tasks) {
  const allocation = task.allocations[0]!;
  const currentBalance = plannedQuoteBalances.get(allocation.accountId) ?? 0;
  const nextBalance = currentBalance + (task.side === 'sell' ? task.totalVolumeUsd : -task.totalVolumeUsd);
  assert.ok(nextBalance >= -0.000001, 'randomized ordering must schedule every buyback after its funding sell');
  plannedQuoteBalances.set(allocation.accountId, nextBalance);
}
assert.ok(planning.tasks.reduce((sum, task) => sum + task.totalVolumeUsd, 0) >= 150, 'planned gross volume should meet the 150 USD minimum');
assert.equal(
  Number(planning.tasks.reduce(
    (sum, task) => sum + (task.side === 'buy' ? task.totalVolumeUsd : -task.totalVolumeUsd),
    0,
  ).toFixed(6)),
  100,
  'planned net buy should equal 100 USD',
);
assert.ok(planning.tasks.every((task) => task.totalVolumeUsd >= 5 && task.totalVolumeUsd <= 30), 'every transaction should respect the 5-30 USD order bounds');

const transactionCapPlanning = buildStrategyPlanningResult({
  document,
  config: {
    ...config,
    maxOrderCount: 19,
  },
  accounts,
  taskSpecs,
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext: 'planner-transaction-cap',
});
assert.equal(transactionCapPlanning.isExecutable, false, 'planner should reject a max transaction count below the configured minimum');

const changedConfig = {
  ...config,
  minOrderUsd: 10,
  maxOrderUsd: 25,
};
const changedTaskSpecs = buildStrategyPlanTaskSpecs(changedConfig, 100);
const changedPlanning = buildStrategyPlanningResult({
  document,
  config: changedConfig,
  accounts: [
    ...Array.from({ length: 5 }, (_, index) => buildAccount(index + 1, 20, 0)),
    ...Array.from({ length: 12 }, (_, index) => buildAccount(index + 6, 0, 10)),
  ],
  taskSpecs: changedTaskSpecs,
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext: 'planner-changing-conditions',
});
assert.equal(
  changedPlanning.isExecutable,
  false,
  'planner should reject 20 minimum trades when 150 USD at a 10 USD minimum permits at most 14 buy/sell trades',
);

const impossiblePlanning = buildStrategyPlanningResult({
  document,
  config: {
    ...config,
    maxOrderCount: 50,
  },
  accounts: [
    buildAccount(1, 34, 0),
    buildAccount(2, 33, 0),
    buildAccount(3, 33, 0),
  ],
  taskSpecs,
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext: 'planner-no-sellers',
});
assert.equal(impossiblePlanning.isExecutable, false, 'planner should report no solution when account capacity cannot meet the minimum transaction count');

const accumulation25Document = buildStrategyDocumentFromSettings({
  baseTokenAddress,
  quoteTokenAddress,
  minTransactions: 25,
  volatilityTarget: 0,
  pullbackTarget: 0,
  volumeTarget: 180,
  netBuyinTarget: 100,
  timeRangeTarget: '24h',
  maxTransactions: 50,
  maxSlippage: 1,
  strategyNotes: 'reported 25-trade accumulation regression',
  macroObjective: 'accumulation',
});
accumulation25Document.parameters.minOrderUsd = 5;
accumulation25Document.parameters.maxOrderUsd = 30;
const accumulation25Config = {
  ...config,
  baseOrderCount: resolveBasePlannedTransactionCount(accumulation25Document),
  baseTotalVolumeUsd: 180,
  minOrderUsd: 5,
  maxOrderUsd: 30,
  execution: accumulation25Document.execution,
};
const accumulation25Specs = buildStrategyPlanTaskSpecs(accumulation25Config, 100);
const accumulation25Accounts = [
  buildAccount(1, 34, 0),
  buildAccount(2, 33, 0),
  buildAccount(3, 33, 0),
  ...Array.from({ length: 12 }, (_, index) => buildAccount(index + 4, 0, 10)),
  buildAccount(100, 0, 0),
];
const buildAccumulation25Plan = (seedContext: string) => buildStrategyPlanningResult({
  document: accumulation25Document,
  config: accumulation25Config,
  accounts: accumulation25Accounts,
  taskSpecs: accumulation25Specs,
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext,
});
const accumulation25Plan = buildAccumulation25Plan('accumulation-25-a');
assert.equal(
  accumulation25Plan.isExecutable,
  true,
  JSON.stringify({
    requestedTaskCount: accumulation25Plan.requestedTaskCount,
    plannedTaskCount: accumulation25Plan.plannedTaskCount,
    unallocatedVolumeUsd: accumulation25Plan.unallocatedVolumeUsd,
    taskVolumes: accumulation25Plan.tasks.map((task) => [task.side, task.totalVolumeUsd]),
  }),
);
assert.ok(accumulation25Plan.tasks.length >= 25, 'feasible accumulation plan must honor minTransactions=25');
assert.ok(
  accumulation25Plan.tasks.every((task) =>
    task.allocations.every((allocation) => allocation.accountId !== 100),
  ),
  'an account holding neither asset in the configured pair must never receive a task',
);
assert.equal(
  accumulation25Plan.skippedForNoPairAssetCount,
  1,
  'planner review should report asset-empty accounts separately',
);
assert.equal(
  Number(accumulation25Plan.tasks.reduce((sum, task) => sum + task.totalVolumeUsd, 0).toFixed(6)),
  180,
  'accumulation plan must preserve target gross volume',
);
assert.equal(
  Number(accumulation25Plan.tasks.reduce(
    (sum, task) => sum + (task.side === 'buy' ? task.totalVolumeUsd : -task.totalVolumeUsd),
    0,
  ).toFixed(6)),
  100,
  'accumulation plan must preserve net buy-in',
);
const repeatedAccumulation25Plan = buildAccumulation25Plan('accumulation-25-a');
assert.deepEqual(
  repeatedAccumulation25Plan.tasks.map((task) => [task.side, task.totalVolumeUsd, task.scheduledAt]),
  accumulation25Plan.tasks.map((task) => [task.side, task.totalVolumeUsd, task.scheduledAt]),
  'the same planning seed must reproduce amounts, sides, and timing',
);
const alternateAccumulation25Plan = buildAccumulation25Plan('accumulation-25-b');
assert.notDeepEqual(
  alternateAccumulation25Plan.tasks.map((task) => [task.side, task.totalVolumeUsd, task.scheduledAt]),
  accumulation25Plan.tasks.map((task) => [task.side, task.totalVolumeUsd, task.scheduledAt]),
  'different planning seeds should vary amounts and timing',
);
assert.ok(
  Array.from({ length: 32 }, (_, index) =>
    buildAccumulation25Plan(`accumulation-funded-first-${index}`),
  ).some((candidate) => candidate.tasks[0]?.side === 'buy'),
  'an initially funded account must be able to buy before any sell',
);
const priceCurveReview = buildStrategyPriceCurveReview({
  tasks: accumulation25Plan.tasks,
  targetVolatilityPct: 10,
  priceUsd: 2,
  liquidityUsd: 10_000,
});
assert.equal(priceCurveReview.available, true);
assert.equal(priceCurveReview.targetVolatilityPct, 10);
assert.ok((priceCurveReview.projectedVolatilityPct ?? 0) > 0);
assert.equal(
  accumulation25Plan.isExecutable,
  true,
  'optional volatility review must not block an otherwise executable plan',
);

const wltUsdcAccounts = [
  ...Array.from({ length: 3 }, (_, index) => buildAccount(index + 1, 100 / 3, 0)),
  ...Array.from({ length: 31 }, (_, index) => buildAccount(index + 4, 0, 10)),
  ...Array.from({ length: 62 }, (_, index) => buildAccount(index + 35, 0, 0)),
];
const wltUsdcPlanning = buildStrategyPlanningResult({
  document: accumulation25Document,
  config: accumulation25Config,
  accounts: wltUsdcAccounts,
  taskSpecs: accumulation25Specs,
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext: 'wlt-usdc-34-tradable-accounts',
});
assert.equal(wltUsdcPlanning.isExecutable, true);
assert.equal(wltUsdcPlanning.eligibleTradingAccountCount, 34);
assert.equal(wltUsdcPlanning.eligibleBuyAccountCount, 3);
assert.equal(wltUsdcPlanning.skippedForNoPairAssetCount, 62);
assert.ok(
  new Set(wltUsdcPlanning.tasks.flatMap((task) =>
    task.allocations.map((allocation) => allocation.accountId),
  )).size > 3,
  'feasible tasks must be dispersed beyond a single account',
);
assert.ok(
  new Set(wltUsdcPlanning.tasks
    .filter((task) => task.side === 'sell')
    .flatMap((task) => task.allocations.map((allocation) => allocation.accountId)),
  ).size > 1,
  'sell orders must use multiple funded base-asset accounts when order count permits',
);
assert.ok(
  wltUsdcPlanning.tasks.every((task, index, tasks) =>
    index < 2 ||
    task.side !== tasks[index - 1]?.side ||
    task.side !== tasks[index - 2]?.side ||
    !tasks.slice(index + 1).some((laterTask) => laterTask.side !== task.side),
  ),
  'seeded scheduling should avoid three same-side orders while the opposite side remains',
);

const accumulation20Document = {
  ...accumulation25Document,
  parameters: {
    ...accumulation25Document.parameters,
    minTransactions: 20,
  },
};
const accumulation20Config = {
  ...accumulation25Config,
  baseOrderCount: resolveBasePlannedTransactionCount(accumulation20Document),
};
const accumulation20Planning = buildStrategyPlanningResult({
  document: accumulation20Document,
  config: accumulation20Config,
  accounts: wltUsdcAccounts,
  taskSpecs: buildStrategyPlanTaskSpecs(accumulation20Config, 100),
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext: 'wlt-usdc-minimum-20-trades',
});
assert.equal(
  accumulation20Planning.isExecutable,
  true,
  JSON.stringify({
    specs: buildStrategyPlanTaskSpecs(accumulation20Config, 100),
    requestedTaskCount: accumulation20Planning.requestedTaskCount,
    plannedTaskCount: accumulation20Planning.plannedTaskCount,
    unallocatedVolumeUsd: accumulation20Planning.unallocatedVolumeUsd,
  }),
);
assert.equal(accumulation20Planning.requestedTaskCount, 20);
assert.ok(
  accumulation20Planning.plannedTaskCount >= 20 && accumulation20Planning.plannedTaskCount <= 36,
  'trade count must stay between the configured minimum and the volume/min-order ceiling',
);
assert.ok(
  new Set(accumulation20Planning.tasks.flatMap((task) =>
    task.allocations.map((allocation) => allocation.accountId),
  )).size >= 10,
  '20 trades should use at least 10 eligible accounts when pair balances permit',
);
const diverseAccumulation20Counts = new Set(
  Array.from({ length: 32 }, (_, index) => buildStrategyPlanningResult({
    document: accumulation20Document,
    config: accumulation20Config,
    accounts: wltUsdcAccounts,
    taskSpecs: buildStrategyPlanTaskSpecs(accumulation20Config, 100),
    startTime: 1_000,
    baseTokenPriceUsd: 1,
    seedContext: `wlt-usdc-diverse-count-${index}`,
  }).plannedTaskCount),
);
assert.ok(diverseAccumulation20Counts.size > 1, 'different seeds should produce diverse feasible trade counts');
assert.ok(
  [...diverseAccumulation20Counts].every((count) => count >= 20 && count <= 36),
  'all randomized counts must stay within configured and mathematical bounds',
);

const impossibleMinimumCounts = calculateFeasibleTradeCounts(20, 50, 80, 5, 5, 30);
assert.equal(
  impossibleMinimumCounts,
  null,
  'a mathematically impossible minimum must be rejected instead of silently reduced to 17',
);

console.log('Strategy planner check passed. Eligibility and executable transaction count are correct.');