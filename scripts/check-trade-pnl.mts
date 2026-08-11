import assert from 'node:assert/strict';

import { calculateManagedTradeLogProfit } from '../src/backend/services/historyMetricsService';

const profit = calculateManagedTradeLogProfit([
  {
    wallet_address: 'managed-1',
    action: 'BUY',
    executed_amount: 10,
    executed_price: 2,
  },
  {
    wallet_address: 'managed-1',
    action: 'BUY',
    executed_amount: 10,
    executed_price: 4,
  },
  {
    wallet_address: 'managed-1',
    action: 'SELL',
    executed_amount: 20,
    executed_price: 5,
  },
], 4);

assert.equal(profit.realizedPnlUsdc, 8);
assert.equal(profit.unrealizedPnlUsdc, 16);
assert.equal(profit.totalPnlUsdc, 24);
assert.equal(profit.remainingTokenAmount, 16);
assert.equal(profit.successfulTradeCount, 3);

const unknownOpeningInventory = calculateManagedTradeLogProfit([
  {
    wallet_address: 'managed-2',
    action: 'SELL',
    executed_amount: 25,
    executed_price: 5,
  },
], 5);
assert.equal(
  unknownOpeningInventory.totalPnlUsdc,
  0,
  'sales without transaction-log cost basis must not be treated as pure profit',
);

console.log('Trade P/L check passed. Realized and unrealized P/L use managed transaction logs.');