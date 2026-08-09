import assert from 'node:assert/strict';

import { analyzeTradeDirection } from '../src/backend/services/webhookParser.ts';
import {
  extractStoredSignalContractAddresses,
  extractWebhookTransactionDetailsFromPayload,
} from '../src/backend/workerCore.ts';

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

const sellPayloadWithTokenAccounts = {
  tokenTransfers: [
    {
      mint: baseTokenAddress,
      sender: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      receiver: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      sourceOwner: traderAddress,
      destinationOwner: ammPoolAddress,
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

const alchemyActivityPayloadWithAtaAddresses = JSON.stringify({
  activity: {
    fromAddress: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    toAddress: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    rawContract: {
      address: baseTokenAddress,
    },
    tokenTransfers: [
      {
        mint: baseTokenAddress,
        sender: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        receiver: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        sourceOwner: traderAddress,
        destinationOwner: ammPoolAddress,
        tokenAmount: 7.25,
      },
    ],
  },
});

assert.equal(analyzeTradeDirection(buyPayload, config), 'BUY');
assert.equal(analyzeTradeDirection(sellPayload, config), 'SELL');
assert.equal(analyzeTradeDirection(sellPayloadWithTokenAccounts, config), 'SELL');
assert.equal(analyzeTradeDirection(unknownPayload, config), 'UNKNOWN');
assert.equal(analyzeTradeDirection(buyPayload, missingPoolConfig), 'UNKNOWN');
assert.equal(analyzeTradeDirection(alchemyActivityPayload, config), 'BUY');

const transferOnlySignalPayload = JSON.stringify({
  activity: {
    tokenTransfers: [
      {
        mint: baseTokenAddress,
        sourceOwner: traderAddress,
        destinationOwner: ammPoolAddress,
        tokenAmount: 12.5,
      },
    ],
  },
});

assert.deepEqual(extractStoredSignalContractAddresses(transferOnlySignalPayload), [baseTokenAddress]);

const transferOnlyDetails = extractWebhookTransactionDetailsFromPayload(
  transferOnlySignalPayload,
  baseTokenAddress,
);

assert.equal(transferOnlyDetails.tokenContractAddress, baseTokenAddress);
assert.equal(transferOnlyDetails.fromWalletAddress, traderAddress);
assert.equal(transferOnlyDetails.toWalletAddress, ammPoolAddress);
assert.equal(transferOnlyDetails.primaryWalletAddress, traderAddress);
assert.equal(transferOnlyDetails.tokenAmount, 12.5);
assert.equal(transferOnlyDetails.source, 'webhook');
assert.equal(transferOnlyDetails.detailSource, 'payload');

const ataOwnerDetails = extractWebhookTransactionDetailsFromPayload(
  alchemyActivityPayloadWithAtaAddresses,
  baseTokenAddress,
);

assert.equal(ataOwnerDetails.fromWalletAddress, traderAddress);
assert.equal(ataOwnerDetails.toWalletAddress, ammPoolAddress);
assert.equal(ataOwnerDetails.primaryWalletAddress, traderAddress);
assert.equal(ataOwnerDetails.tokenAmount, 7.25);

console.log('check-webhook-parser: OK');