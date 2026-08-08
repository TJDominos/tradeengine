import assert from 'node:assert/strict';

import { analyzeTradeDirection } from '../src/backend/services/webhookParser.ts';

const baseTokenAddress = 'So11111111111111111111111111111111111111112';
const quoteTokenAddress = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ammPoolAddress = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const traderAddress = 'Vote111111111111111111111111111111111111111';

const config = {
  baseTokenAddress,
  ammPoolAddress,
};

const buyPayload = {
  tokenTransfers: [
    {
      mint: quoteTokenAddress,
      sender: traderAddress,
      receiver: ammPoolAddress,
    },
    {
      mint: baseTokenAddress,
      sender: ammPoolAddress,
      receiver: traderAddress,
    },
  ],
};

const sellPayload = {
  tokenTransfers: [
    {
      mint: baseTokenAddress,
      sender: traderAddress,
      receiver: ammPoolAddress,
    },
  ],
};

const unknownPayload = {
  tokenTransfers: [
    {
      mint: baseTokenAddress,
      sender: traderAddress,
      receiver: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    },
  ],
};

const missingPoolConfig = {
  baseTokenAddress,
  ammPoolAddress: '',
};

const alchemyActivityPayload = {
  event: {
    activity: [
      {
        category: 'token',
        fromAddress: ammPoolAddress,
        toAddress: traderAddress,
        rawContract: {
          address: baseTokenAddress,
        },
        tokenTransfers: [
          {
            mint: quoteTokenAddress,
            sourceOwner: traderAddress,
            destinationOwner: ammPoolAddress,
          },
          {
            mint: baseTokenAddress,
            sourceOwner: ammPoolAddress,
            destinationOwner: traderAddress,
          },
        ],
      },
    ],
  },
};

assert.equal(analyzeTradeDirection(buyPayload, config), 'BUY');
assert.equal(analyzeTradeDirection(sellPayload, config), 'SELL');
assert.equal(analyzeTradeDirection(unknownPayload, config), 'UNKNOWN');
assert.equal(analyzeTradeDirection(buyPayload, missingPoolConfig), 'UNKNOWN');
assert.equal(analyzeTradeDirection(alchemyActivityPayload, config), 'BUY');

console.log('check-webhook-parser: OK');