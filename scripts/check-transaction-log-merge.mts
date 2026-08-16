import assert from 'node:assert/strict';

import {
  buildTransactionLogs,
  resolveTransactionLogRefreshWindow,
} from '../src/backend/api/stateHandler';
import { resolveTradeLogAmounts } from '../src/backend/userStore';
import type {
  TradeLogRecord,
  WebhookTransactionLogRecord,
} from '../src/backend/workerShared';

const signature = '26Xy84ZNRDtvAqBSGzVaDeWokSZuyJDABCFz6WS9Z5EDtV27HrTZ3tCLJjBJsGSwyhKgqfxwFAiW8CH16rxPMswe';
const trade: TradeLogRecord = {
  id: 50,
  tokenId: 1,
  tokenContractAddress: 'G45pgo5kzUMPnXGqrLeDXXgxSrVx6ssXJiJTDWpHjups',
  tokenSymbol: 'TEST',
  walletAddress: '6MmkiMDaon5V9LL3FYmwBWm8hbDT4nwS2Ndq7xwRgkxi',
  fromWalletAddress: '6MmkiMDaon5V9LL3FYmwBWm8hbDT4nwS2Ndq7xwRgkxi',
  toWalletAddress: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  action: 'SELL',
  requestedAmount: 6.040198,
  executedAmount: 5.961519,
  executedPrice: 0.00020463,
  tokenAmount: 29_132.042499,
  usdcAmount: 5.961519,
  txSignature: signature,
  chainTimeMs: null,
  status: 'SUCCESS',
  errorMessage: null,
  createdAt: 1_786_776_203_383,
  updatedAt: 1_786_776_203_383,
};
const duplicateWebhook: WebhookTransactionLogRecord = {
  id: 461,
  tokenContractAddress: trade.tokenContractAddress,
  tokenSymbol: trade.tokenSymbol,
  walletAddress: trade.walletAddress,
  fromWalletAddress: trade.walletAddress,
  toWalletAddress: null,
  action: 'SELL',
  usdcAmount: trade.executedAmount,
  tokenAmount: null,
  feeAmountUsd: null,
  source: 'webhook',
  eventType: 'ADDRESS_ACTIVITY:transaction',
  txSignature: signature,
  chainTimeMs: null,
  status: 'CONFIRMED',
  errorMessage: null,
  createdAt: 1_786_776_203,
};
const olderWebhook: WebhookTransactionLogRecord = {
  ...duplicateWebhook,
  id: 460,
  txSignature: '3juKj27oq7WkCFw4FpdxsgEWmotWJszc77B4Z6XUDJW32RA7nLTX7HGJ3c1n9ydqj3qSTpA9twAm25bYwRnY8uxP',
  createdAt: 1_786_763_687,
};

const merged = buildTransactionLogs([trade], [duplicateWebhook, olderWebhook]);

assert.equal(merged.length, 2, 'Matching trade and webhook signatures must be deduplicated');
assert.equal(merged[0]?.kind, 'trade', 'Strategy trade rows must take precedence over webhook duplicates');
assert.equal(merged[0]?.txSignature, signature);
assert.equal(merged[1]?.kind, 'webhook');

const endTimeMs = 1_786_800_000_000;
assert.deepEqual(
  resolveTransactionLogRefreshWindow(1_786_794_424_732, endTimeMs),
  {
    startTimeMs: 1_786_794_419_732,
    endTimeMs,
  },
  'Refresh must continue from the latest stored transaction with a small overlap',
);
assert.deepEqual(
  resolveTransactionLogRefreshWindow(null, endTimeMs),
  {
    startTimeMs: endTimeMs - 7 * 24 * 60 * 60 * 1000,
    endTimeMs,
  },
  'Refresh must use the bounded fallback only when no transaction cursor exists',
);
assert.deepEqual(
  resolveTransactionLogRefreshWindow(endTimeMs + 60_000, endTimeMs),
  {
    startTimeMs: endTimeMs - 5_000,
    endTimeMs,
  },
  'A future cursor must not move the refresh window beyond the current time',
);

assert.deepEqual(
  resolveTradeLogAmounts({
    action: 'SELL',
    executedAmount: 4.94005,
    executedPrice: 0.00016521116635194065,
    executionTraceJson: JSON.stringify({
      baseAmount: 29_901.429238,
      executedVolumeUsd: 4.94005,
    }),
  }),
  {
    tokenAmount: 29_901.429238,
    usdcAmount: 4.94005,
  },
  'SELL rows must expose actual token quantity and actual USDC proceeds from the execution trace',
);
assert.deepEqual(
  resolveTradeLogAmounts({
    action: 'SELL',
    executedAmount: 4.948004,
    executedPrice: 0.0001654335823562602,
    executionTraceJson: JSON.stringify({
      baseAmount: 29_909.308192,
      executedVolumeUsd: 4.948004,
    }),
  }),
  {
    tokenAmount: 29_909.308192,
    usdcAmount: 4.948004,
  },
  'Each trade must preserve its own chain execution amounts',
);

console.log('Transaction log merge and refresh cursor check passed.');
