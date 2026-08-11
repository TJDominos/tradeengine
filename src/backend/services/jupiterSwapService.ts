import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  VersionedTransaction,
  type Commitment,
} from '@solana/web3.js';

import { ApiError } from '../errors';
import {
  buildJupiterSwapTransactionWithTrace,
  fetchJupiterSwapQuote,
  type JupiterQuoteResponse,
} from '../jupiter';
import { SOLANA_USDC_MINT, type Env } from '../workerShared';

const DEFAULT_JUPITER_SLIPPAGE_BPS = 10;
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

function resolveRpcUrls(env: Env, configuredRpcUrls?: string[]): string[] {
  const rpcUrls = [
    ...(configuredRpcUrls ?? []),
    env.RPC_URL?.trim() ?? '',
    env.SOLANA_RPC_URL?.trim() ?? '',
  ].filter((rpcUrl, index, values) => rpcUrl && values.indexOf(rpcUrl) === index);
  if (rpcUrls.length === 0) {
    throw new ApiError(
      500,
      'An active Solana RPC endpoint must be configured for Jupiter swap execution',
    );
  }
  return rpcUrls;
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
  options?: {
    slippageBps?: number;
    commitment?: Commitment;
    rpcUrls?: string[];
  },
): Promise<JupiterSwapExecutionResult> {
  const rpcUrls = resolveRpcUrls(env, options?.rpcUrls);
  const commitment = options?.commitment ?? 'confirmed';
  const slippageBps = Math.max(1, Math.round(options?.slippageBps ?? DEFAULT_JUPITER_SLIPPAGE_BPS));
  const normalizedAmount = normalizeAtomicAmount(amount);
  const inputMint = side === 'buy' ? quoteToken : baseToken;
  const outputMint = side === 'buy' ? baseToken : quoteToken;

  const quoteResponse = await fetchJupiterSwapQuote(
    inputMint,
    outputMint,
    normalizedAmount,
    slippageBps,
  );

  const swapBuild = await buildJupiterSwapTransactionWithTrace(
    quoteResponse,
    keypair.publicKey,
  );
  const transaction = VersionedTransaction.deserialize(
    swapBuild.swapTransactionBytes,
  );
  signVersionedTransaction(transaction, keypair);

  let txid = '';
  let confirmed = false;
  let lastRpcError: unknown = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const connection = new Connection(rpcUrl, commitment);
      txid = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: commitment,
      });
      const confirmation = await connection.confirmTransaction(txid, commitment);
      if (confirmation.value.err) {
        throw new ApiError(
          502,
          `Solana transaction ${txid} failed: ${JSON.stringify(confirmation.value.err)}`,
        );
      }
      confirmed = true;
      break;
    } catch (error: unknown) {
      lastRpcError = error;
    }
  }
  if (!confirmed) {
    throw lastRpcError instanceof Error
      ? lastRpcError
      : new ApiError(502, 'All configured Solana RPC endpoints failed');
  }

  if (inputMint !== SOLANA_USDC_MINT && outputMint !== SOLANA_USDC_MINT) {
    throw new ApiError(
      500,
      'Strategy engine swaps must route against USDC to record USD execution volume',
    );
  }

  const executedAmountAtomic = quoteResponse.outAmount;
  const executedAmount = Number(executedAmountAtomic);
  const executedVolumeUsdAtomic =
    side === 'buy' ? quoteResponse.inAmount : quoteResponse.outAmount;
  const executedVolumeUsd = Number(executedVolumeUsdAtomic) / 10 ** USDC_DECIMALS;

  if (!Number.isFinite(executedAmount) || !Number.isFinite(executedVolumeUsd)) {
    throw new ApiError(502, 'Jupiter quote returned a non-finite executed amount');
  }

  return {
    txid,
    executedAmountAtomic,
    executedAmount,
    executedVolumeUsd,
    inputMint,
    outputMint,
    inputAmountAtomic: quoteResponse.inAmount,
    outputAmountAtomic: quoteResponse.outAmount,
    slippageBps,
    quoteResponse,
  };
}