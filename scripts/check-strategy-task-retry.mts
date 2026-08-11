import assert from 'node:assert/strict';

import { resolveStrategyTaskFailureTransition } from '../src/backend/strategy/strategyEngineDO.ts';

const now = 1_000_000;
const nextTaskScheduledAt = now + 120_000;

assert.deepEqual(
  resolveStrategyTaskFailureTransition(1, now, nextTaskScheduledAt),
  { pause: false, retryAt: now + 30_000 },
  'the first failure should retry after 30 seconds',
);

assert.deepEqual(
  resolveStrategyTaskFailureTransition(2, now, nextTaskScheduledAt),
  { pause: false, retryAt: nextTaskScheduledAt },
  'the second failure should retry at the next planned task slot',
);

assert.deepEqual(
  resolveStrategyTaskFailureTransition(2, now, now - 5_000),
  { pause: false, retryAt: now - 5_000 },
  'an overdue next slot should preserve its time so the failed task sorts first',
);

assert.deepEqual(
  resolveStrategyTaskFailureTransition(3, now, nextTaskScheduledAt),
  { pause: true, retryAt: null },
  'the third failure should pause the queue',
);

console.log('Strategy task retry check passed. Failure transitions match the 30s, next-slot, then pause policy.');