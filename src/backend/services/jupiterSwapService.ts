import bs58 from 'bs58';
import {
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';

import { ApiError } from '../errors';
import {
  executeJupiterSwapOrder,
  fetchJupiterSwapOrder,
  type JupiterQuoteResponse,
} from '../jupiter';
import { SOLANA_USDC_MINT, type Env } from '../workerShared';

const USDC_DECIMALS = 6;

export interface JupiterSwapExecutionResult {
  txid: string;
  executedAmountAtomic: string;
  executedAmount: number;
  executedVolumeUsd: number;
  inputMint: string;
  outputMint: string;
  inputAmountAtomic: string;
  outputAmountAtomic: string;
  slippageBps: number;
  quoteResponse: JupiterQuoteResponse;
}

export interface JupiterSwapSigner {
  publicKey: string;
  privateKey: Uint8Array | string;
}

function decodeSignerKeypair(privateKey: Uint8Array | string): Keypair {
  let decoded: Uint8Array;
  if (privateKey instanceof Uint8Array) {
    decoded = privateKey;
  } else {
    try {
      decoded = bs58.decode(privateKey.trim());
    } catch {
      throw new ApiError(500, 'Signer private key must be a valid base58 keypair');
    }
  }

  if (decoded.length === 64) {
    return Keypair.fromSecretKey(decoded);
  }
  if (decoded.length === 32) {
    return Keypair.fromSeed(decoded);
  }
  throw new ApiError(
    500,
    'Signer private key must decode to a 32-byte seed or 64-byte keypair',
  );
}

export function signVersionedTransaction(
  transaction: VersionedTransaction,
  signerInput: JupiterSwapSigner,
): VersionedTransaction {
  const signer = decodeSignerKeypair(signerInput.privateKey);
  const expectedPublicKey = signerInput.publicKey.trim();
  if (signer.publicKey.toBase58() !== expectedPublicKey) {
    throw new ApiError(
      500,
      `Signing key does not match managed wallet ${expectedPublicKey}`,
    );
  }
  transaction.sign([signer]);
  return transaction;
}

function normalizeAtomicAmount(amount: string | number | bigint): string {
  if (typeof amount === 'bigint') {
    if (amount <= 0n) {
      throw new ApiError(400, 'Swap amount must be greater than zero');
    }
    return amount.toString();
  }

  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, 'Swap amount must be greater than zero');
    }
    return Math.round(amount).toString();
  }

  const trimmed = amount.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new ApiError(400, 'Swap amount must be an integer atomic-unit string');
  }
  if (trimmed === '0') {
    throw new ApiError(400, 'Swap amount must be greater than zero');
  }
  return trimmed;
}

export async function executeSwap(
  env: Env,
  keypair: JupiterSwapSigner,
  amount: string | number | bigint,
  side: 'buy' | 'sell',
  baseToken: string,
  quoteToken: string,
): Promise<JupiterSwapExecutionResult> {
  const normalizedAmount = normalizeAtomicAmount(amount);
  const inputMint = side === 'buy' ? quoteToken : baseToken;
  const outputMint = side === 'buy' ? baseToken : quoteToken;

  const order = await fetchJupiterSwapOrder(
    inputMint,
    outputMint,
    normalizedAmount,
    keypair.publicKey,
    env.JUPITER_API_KEY,
  );
  const transaction = VersionedTransaction.deserialize(
    Uint8Array.from(atob(order.transaction!), (character) => character.charCodeAt(0)),
  );
  signVersionedTransaction(transaction, keypair);
  let signedTransaction = '';
  transaction.serialize().forEach((byte) => {
    signedTransaction += String.fromCharCode(byte);
  });
  const execution = await executeJupiterSwapOrder(
    btoa(signedTransaction),
    order.requestId,
    env.JUPITER_API_KEY,
  );

  if (inputMint !== SOLANA_USDC_MINT && outputMint !== SOLANA_USDC_MINT) {
    throw new ApiError(
      500,
      'Strategy engine swaps must route against USDC to record USD execution volume',
    );
  }

  const executedAmountAtomic = execution.totalOutputAmount;
  const executedAmount = Number(executedAmountAtomic);
  const executedVolumeUsdAtomic =
    side === 'buy' ? execution.totalInputAmount : execution.totalOutputAmount;
  const executedVolumeUsd = Number(executedVolumeUsdAtomic) / 10 ** USDC_DECIMALS;

  if (!Number.isFinite(executedAmount) || !Number.isFinite(executedVolumeUsd)) {
    throw new ApiError(502, 'Jupiter quote returned a non-finite executed amount');
  }

  return {
    txid: execution.signature,
    executedAmountAtomic,
    executedAmount,
    executedVolumeUsd,
    inputMint,
    outputMint,
    inputAmountAtomic: execution.totalInputAmount,
    outputAmountAtomic: execution.totalOutputAmount,
    slippageBps: order.slippageBps,
    quoteResponse: order,
  };
}