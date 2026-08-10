import assert from 'node:assert/strict';

import type { ManagedAccountBalanceRecord } from '../src/backend/userStore';
import {
  buildStrategyPlanningResult,
  buildStrategyPlanTaskSpecs,
} from '../src/backend/strategy/planner';
import { buildStrategyDocumentFromSettings } from '../src/backend/strategy/runtime';
import { resolveBasePlannedTransactionCount } from '../src/backend/strategy/plannedTransactions';

const baseTokenAddress = 'So11111111111111111111111111111111111111112';
const quoteTokenAddress = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
assert.ok(planning.tasks.filter((task) => task.side === 'sell').length >= 14, 'at least 14 sells should unlock enough self-cycling accounts');
assert.ok(planning.tasks.reduce((sum, task) => sum + task.totalVolumeUsd, 0) >= 150, 'planned gross volume should meet the 150 USD minimum');
assert.equal(
  planning.tasks.reduce(
    (sum, task) => sum + (task.side === 'buy' ? task.totalVolumeUsd : -task.totalVolumeUsd),
    0,
  ),
  100,
  'planned net buy should equal 100 USD',
);
assert.ok(planning.tasks.every((task) => task.totalVolumeUsd >= 5 && task.totalVolumeUsd <= 30), 'every transaction should respect the 5-30 USD order bounds');

const transactionCapPlanning = buildStrategyPlanningResult({
  document,
  config: {
    ...config,
    maxOrderCount: 33,
  },
  accounts,
  taskSpecs,
  startTime: 1_000,
  baseTokenPriceUsd: 1,
  seedContext: 'planner-transaction-cap',
});
assert.equal(transactionCapPlanning.isExecutable, false, 'planner should reject a max transaction count below the computed feasible minimum');

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
assert.equal(changedPlanning.isExecutable, true, 'planner should adapt to changed balances and 10-25 USD order bounds');
assert.ok(changedPlanning.tasks.length >= 20 && changedPlanning.tasks.length <= 50, 'adapted plan should remain within its transaction range');
assert.ok(changedPlanning.tasks.every((task) => task.totalVolumeUsd >= 10 && task.totalVolumeUsd <= 25), 'adapted transactions should respect changed order bounds');

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

console.log('Strategy planner check passed. Eligibility and executable transaction count are correct.');