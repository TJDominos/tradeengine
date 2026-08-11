import assert from 'node:assert/strict';

import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { executeSwap } from '../src/backend/services/jupiterSwapService.ts';
import type { Env } from '../src/backend/workerShared.ts';

const taker = Keypair.generate();
const sponsor = Keypair.generate();
const recipient = Keypair.generate();
const inputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const outputMint = Keypair.generate().publicKey.toBase58();
const transaction = new VersionedTransaction(
  new TransactionMessage({
    payerKey: sponsor.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: taker.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message(),
);
const unsignedTransaction = Buffer.from(transaction.serialize()).toString('base64');
const originalFetch = globalThis.fetch;
let gasless = true;
let executeCalls = 0;
let failNextDefaultOrder = true;
let orderCalls = 0;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('https://api.jup.ag/swap/v2/order?')) {
    orderCalls += 1;
    const requestUrl = new URL(url);
    assert.equal(requestUrl.searchParams.get('taker'), taker.publicKey.toBase58());
    assert.equal(requestUrl.searchParams.get('inputMint'), inputMint);
    assert.equal(requestUrl.searchParams.get('outputMint'), outputMint);
    assert.equal(requestUrl.searchParams.has('slippageBps'), false);
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'test-api-key');
    if (!requestUrl.searchParams.has('excludeRouters') && failNextDefaultOrder) {
      failNextDefaultOrder = false;
      return Response.json(
        { requestId: 'failed-quote-request', error: 'Failed to get quotes' },
        { status: 400 },
      );
    }
    if (orderCalls === 2) {
      assert.equal(
        requestUrl.searchParams.get('excludeRouters'),
        'jupiterz,dflow,okx',
        'a transient multi-router quote failure should retry through Metis',
      );
    }
    return Response.json({
      inputMint,
      inAmount: '10000000',
      outputMint,
      outAmount: '5000000',
      otherAmountThreshold: '4950000',
      swapMode: 'ExactIn',
      slippageBps: 10,
      priceImpactPct: '0',
      routePlan: [],
      transaction: unsignedTransaction,
      requestId: 'gasless-request',
      router: 'jupiterz',
      mode: 'manual',
      gasless,
      signatureFeePayer: gasless ? sponsor.publicKey.toBase58() : taker.publicKey.toBase58(),
      feeBps: 10,
      feeMint: inputMint,
    });
  }
  if (url === 'https://api.jup.ag/swap/v2/execute') {
    executeCalls += 1;
    const body = JSON.parse(String(init?.body)) as {
      signedTransaction: string;
      requestId: string;
    };
    assert.equal(body.requestId, 'gasless-request');
    const signedTransaction = VersionedTransaction.deserialize(
      Buffer.from(body.signedTransaction, 'base64'),
    );
    assert.ok(
      signedTransaction.signatures[1]?.some((byte) => byte !== 0),
      'managed taker signature should be present',
    );
    assert.ok(
      signedTransaction.signatures[0]?.every((byte) => byte === 0),
      'sponsor signature should remain available for Jupiter to add during execute',
    );
    return Response.json({
      status: 'Success',
      signature: 'mock-signature',
      code: 0,
      totalInputAmount: '10000000',
      totalOutputAmount: '5000000',
      inputAmountResult: '9990000',
      outputAmountResult: '5000000',
    });
  }
  throw new Error(`Unexpected request: ${url}`);
};

try {
  const result = await executeSwap(
    { JUPITER_API_KEY: 'test-api-key' } as Env,
    { publicKey: taker.publicKey.toBase58(), privateKey: taker.secretKey },
    '10000000',
    'buy',
    outputMint,
    inputMint,
  );
  assert.equal(result.txid, 'mock-signature');
  assert.equal(result.executedVolumeUsd, 10);
  assert.equal(orderCalls, 2);
  assert.equal(executeCalls, 1);

  gasless = false;
  await assert.rejects(
    executeSwap(
      { JUPITER_API_KEY: 'test-api-key' } as Env,
      { publicKey: taker.publicKey.toBase58(), privateKey: taker.secretKey },
      '10000000',
      'buy',
      outputMint,
      inputMint,
    ),
    /did not provide a gasless route/,
  );
  assert.equal(orderCalls, 3, 'non-gasless validation should not require a fallback retry');
  assert.equal(executeCalls, 1, 'non-gasless orders must be rejected before execute');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Jupiter gasless check passed. Managed signing uses V2 execute and non-gasless orders are rejected.');