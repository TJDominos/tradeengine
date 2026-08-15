import assert from 'node:assert/strict';

import { buildTransactionLogs } from '../src/backend/api/stateHandler';
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
  action: 'SELL',
  requestedAmount: 6.040198,
  executedAmount: 5.961519,
  executedPrice: 0.00020463,
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

console.log('Transaction log merge check passed.');
