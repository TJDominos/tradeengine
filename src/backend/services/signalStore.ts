import {
  fetchJupiterPriceViaQuote,
  fetchJupiterTokenPrice,
} from '../jupiter';
import { nowTs } from '../time';
import { dbFindTradableTokenById, dbResolveTradableTokenId } from '../tokenStore';
import { dbRecomputeTokenHolderAggregate } from '../tokenHolders';
import type {
  SignalCreateRequest,
  SignalRecord,
  StoredSignalTransactionDetails,
  TradeLogCreateRequest,
} from '../workerShared';
import { parseJsonText } from '../workerSchema';
import {
  extractStoredSignalContractAddresses,
  isAlchemyRpcUrl,
  mergeStoredSignalTransactionDetails,
  parseStoredSignalTransactionDetails,
  solanaRpc,
  tryNormalizeSolanaPubkey,
  uniqueSolanaPubkeys,
} from '../workerCore';
import { SOLANA_USDC_MINT, SOLANA_WRAPPED_SOL_MINT } from '../workerShared';

export function applyAmmPoolDirectionCorrection(
  details: StoredSignalTransactionDetails,
  ammPoolAddress: string | null | undefined,
  preferredPayloadLeg?: Partial<StoredSignalTransactionDetails> | null,
): StoredSignalTransactionDetails {
  const normalizedAmmPoolAddress = tryNormalizeSolanaPubkey(ammPoolAddress);
  const payloadFromWalletAddress = tryNormalizeSolanaPubkey(
    preferredPayloadLeg?.fromWalletAddress,
  );
  const payloadToWalletAddress = tryNormalizeSolanaPubkey(
    preferredPayloadLeg?.toWalletAddress,
  );
  const payloadPrimaryWalletAddress = tryNormalizeSolanaPubkey(
    preferredPayloadLeg?.primaryWalletAddress,
  );

  if (
    normalizedAmmPoolAddress &&
    payloadFromWalletAddress === normalizedAmmPoolAddress &&
    payloadToWalletAddress &&
    payloadToWalletAddress !== normalizedAmmPoolAddress
  ) {
    return {
      ...details,
      fromWalletAddress: normalizedAmmPoolAddress,
      toWalletAddress: payloadToWalletAddress,
      primaryWalletAddress: payloadToWalletAddress,
      action: 'BUY',
    };
  }

  if (
    normalizedAmmPoolAddress &&
    payloadToWalletAddress === normalizedAmmPoolAddress &&
    payloadFromWalletAddress &&
    payloadFromWalletAddress !== normalizedAmmPoolAddress
  ) {
    return {
      ...details,
      fromWalletAddress: payloadFromWalletAddress,
      toWalletAddress: normalizedAmmPoolAddress,
      primaryWalletAddress: payloadFromWalletAddress,
      action: 'SELL',
    };
  }

  if (
    payloadFromWalletAddress &&
    payloadToWalletAddress &&
    (!normalizedAmmPoolAddress ||
      (payloadFromWalletAddress !== normalizedAmmPoolAddress &&
        payloadToWalletAddress !== normalizedAmmPoolAddress))
  ) {
    return {
      ...details,
      fromWalletAddress: payloadFromWalletAddress,
      toWalletAddress: payloadToWalletAddress,
      primaryWalletAddress:
        payloadPrimaryWalletAddress ?? payloadFromWalletAddress,
      action: 'TRANSFER',
    };
  }

  if (!normalizedAmmPoolAddress) {
    return details.fromWalletAddress && details.toWalletAddress && details.action == null
      ? {
          ...details,
          primaryWalletAddress:
            details.primaryWalletAddress ?? details.fromWalletAddress,
          action: 'TRANSFER',
        }
      : details;
  }

  if (
    details.fromWalletAddress === normalizedAmmPoolAddress &&
    details.toWalletAddress &&
    details.toWalletAddress !== normalizedAmmPoolAddress
  ) {
    return {
      ...details,
      action: 'BUY',
      primaryWalletAddress: details.toWalletAddress,
    };
  }

  if (
    details.toWalletAddress === normalizedAmmPoolAddress &&
    details.fromWalletAddress &&
    details.fromWalletAddress !== normalizedAmmPoolAddress
  ) {
    return {
      ...details,
      action: 'SELL',
      primaryWalletAddress: details.fromWalletAddress,
    };
  }

  if (
    details.fromWalletAddress &&
    details.toWalletAddress &&
    details.fromWalletAddress !== normalizedAmmPoolAddress &&
    details.toWalletAddress !== normalizedAmmPoolAddress &&
    details.action == null
  ) {
    return {
      ...details,
      primaryWalletAddress:
        details.primaryWalletAddress ?? details.fromWalletAddress,
      action: 'TRANSFER',
    };
  }

  return details;
}

type RpcTokenBalanceEntry = {
  owner?: string;
  mint?: string;
  uiTokenAmount?: {
    uiAmountString?: string;
    amount?: string;
    decimals?: number;
  };
};

type RpcTransactionMeta = {
  err?: unknown;
  fee?: number;
  preTokenBalances?: RpcTokenBalanceEntry[];
  postTokenBalances?: RpcTokenBalanceEntry[];
};

type RpcWebhookTransactionDetailsResult = {
  details: Partial<StoredSignalTransactionDetails>;
  chainTimeMs: number | null;
};

type EnhancedTransactionCandidate = {
  txSignature: string;
  scannedAddress: string;
  blockTimeMs: number | null;
  transaction: HeliusEnhancedTransaction | null;
  rpcMeta?: RpcTransactionMeta | null;
};

type AlchemyTransactionsForAddressEntry = {
  signature?: string;
  blockTime?: number | null;
  err?: unknown;
  meta?: RpcTransactionMeta | null;
};

type AlchemyTransactionsForAddressResult = {
  data?: AlchemyTransactionsForAddressEntry[];
  paginationToken?: string | null;
};

type HeliusEnhancedTokenTransfer = {
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
  fromTokenAccount?: string | null;
  toTokenAccount?: string | null;
  mint?: string | null;
  tokenAmount?: number | string | null;
};

type HeliusEnhancedTransaction = {
  signature?: string;
  timestamp?: number | null;
  fee?: number | null;
  transactionError?: unknown;
  tokenTransfers?: HeliusEnhancedTokenTransfer[];
};

type PersistedWebhookTransactionLogRow = {
  id: number;
  user_id: number;
  group_key: string;
  token_id: number | null;
  token_contract_address: string;
  wallet_address: string | null;
  from_wallet_address: string | null;
  to_wallet_address: string | null;
  action: 'BUY' | 'SELL' | 'TRANSFER' | null;
  usdc_amount: number | null;
  token_amount: number | null;
  fee_amount_usd: number | null;
  source: 'webhook' | 'rpc_reconcile';
  event_type: string;
  tx_signature: string | null;
  chain_time_ms: number | null;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  error_message: string | null;
  detail_source: StoredSignalTransactionDetails['detailSource'];
  details_json: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
};

function buildWebhookTransactionLogGroupKey(
  txSignature: string | null,
  externalId: string,
  tokenContractAddress: string,
): string {
  return `${txSignature?.trim() || externalId}:${tokenContractAddress}`;
}

function parseStoredRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = parseJsonText<unknown>(value);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function buildStoredSignalTransactionDetailsFromWebhookLogRow(
  row: PersistedWebhookTransactionLogRow,
): StoredSignalTransactionDetails {
  return parseStoredSignalTransactionDetails(row.details_json) ?? {
    tokenContractAddress: row.token_contract_address,
    fromWalletAddress: row.from_wallet_address,
    toWalletAddress: row.to_wallet_address,
    primaryWalletAddress: row.wallet_address,
    action: row.action,
    usdcAmount: row.usdc_amount,
    tokenAmount: row.token_amount,
    feeAmountUsd: row.fee_amount_usd,
    source: row.source,
    transactionStatus:
      row.status === 'FAILED'
        ? 'FAILED'
        : row.status === 'CONFIRMED'
          ? 'CONFIRMED'
          : 'PENDING',
    detailSource: row.detail_source,
  };
}

function webhookActionRank(
  action: StoredSignalTransactionDetails['action'],
): number {
  return action === 'BUY' || action === 'SELL'
    ? 3
    : action === 'TRANSFER'
      ? 2
      : 1;
}

function webhookDetailSourceRank(
  detailSource: StoredSignalTransactionDetails['detailSource'],
): number {
  return detailSource === 'payload+rpc'
    ? 3
    : detailSource === 'rpc'
      ? 2
      : detailSource === 'payload'
        ? 1
        : 0;
}

function scoreStoredSignalTransactionDetails(
  details: Partial<StoredSignalTransactionDetails> | null | undefined,
): number {
  if (!details) {
    return 0;
  }
  return webhookActionRank(details.action ?? null) * 10 +
    webhookDetailSourceRank(details.detailSource ?? 'unknown');
}

function mergeNormalizedWebhookTransactionDetails(
  existingDetails: StoredSignalTransactionDetails | null,
  nextDetails: StoredSignalTransactionDetails,
): StoredSignalTransactionDetails {
  if (!existingDetails) {
    return nextDetails;
  }

  const useNextAsPrimary =
    scoreStoredSignalTransactionDetails(nextDetails) >=
    scoreStoredSignalTransactionDetails(existingDetails);
  const primaryDetails = useNextAsPrimary ? nextDetails : existingDetails;
  const secondaryDetails = useNextAsPrimary ? existingDetails : nextDetails;
  const mergedDetails = mergeStoredSignalTransactionDetails(
    primaryDetails,
    secondaryDetails,
  );

  if (primaryDetails.fromWalletAddress) {
    mergedDetails.fromWalletAddress = primaryDetails.fromWalletAddress;
  }
  if (primaryDetails.toWalletAddress) {
    mergedDetails.toWalletAddress = primaryDetails.toWalletAddress;
  }
  if (primaryDetails.primaryWalletAddress) {
    mergedDetails.primaryWalletAddress = primaryDetails.primaryWalletAddress;
  }
  if (primaryDetails.action) {
    mergedDetails.action = primaryDetails.action;
  }

  return mergedDetails;
}

function deriveWebhookTransactionLogStatus(input: {
  details: StoredSignalTransactionDetails;
  processed: boolean;
  errorMessage: string | null;
}): 'PENDING' | 'CONFIRMED' | 'FAILED' {
  if (input.errorMessage || input.details.transactionStatus === 'FAILED') {
    return 'FAILED';
  }
  if (!input.processed || input.details.transactionStatus === 'PENDING') {
    return 'PENDING';
  }
  return 'CONFIRMED';
}

export async function dbUpsertWebhookTransactionLog(
  db: D1Database,
  input: {
    userId: number;
    tokenId: number | null;
    tokenContractAddress: string;
    source: 'webhook' | 'rpc_reconcile';
    eventType: string;
    txSignature: string | null;
    chainTimeMs?: number | null;
    externalId: string;
    walletAddress: string | null;
    details: StoredSignalTransactionDetails;
    processed: boolean;
    errorMessage: string | null;
    createdAt: number;
    updatedAt?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const groupKey = buildWebhookTransactionLogGroupKey(
    input.txSignature,
    input.externalId,
    input.tokenContractAddress,
  );
  const existing = await db
    .prepare(
      `SELECT
         id,
         user_id,
         group_key,
         token_id,
         token_contract_address,
         wallet_address,
         from_wallet_address,
         to_wallet_address,
         action,
         usdc_amount,
         token_amount,
         fee_amount_usd,
         source,
         event_type,
         tx_signature,
         chain_time_ms,
         status,
         error_message,
         detail_source,
         details_json,
         metadata_json,
         created_at,
         updated_at
       FROM webhook_transaction_logs
       WHERE user_id = ?1 AND group_key = ?2
       LIMIT 1`,
    )
    .bind(input.userId, groupKey)
    .first<PersistedWebhookTransactionLogRow>();

  const existingDetails = existing
    ? buildStoredSignalTransactionDetailsFromWebhookLogRow(existing)
    : null;
  const mergedDetails = mergeNormalizedWebhookTransactionDetails(
    existingDetails,
    input.details,
  );
  const mergedMetadata = {
    ...parseStoredRecord(existing?.metadata_json),
    ...(input.metadata ?? {}),
    lastExternalId: input.externalId,
    lastSource: input.source,
    lastEventType: input.eventType,
  };
  const createdAt = existing?.created_at ?? input.createdAt;
  const chainTimeMs = input.chainTimeMs ?? existing?.chain_time_ms ?? null;
  const updatedAt = input.updatedAt ?? nowTs();
  const walletAddress =
    input.walletAddress ??
    mergedDetails.primaryWalletAddress ??
    existing?.wallet_address ??
    null;
  const status = deriveWebhookTransactionLogStatus({
    details: mergedDetails,
    processed: input.processed,
    errorMessage: input.errorMessage,
  });

  await db
    .prepare(
      `INSERT INTO webhook_transaction_logs (
         user_id,
         group_key,
         token_id,
         token_contract_address,
         wallet_address,
         from_wallet_address,
         to_wallet_address,
         action,
         usdc_amount,
         token_amount,
         fee_amount_usd,
         source,
         event_type,
         tx_signature,
         chain_time_ms,
         status,
         error_message,
         detail_source,
         details_json,
         metadata_json,
         created_at,
         updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
       ON CONFLICT(user_id, group_key)
       DO UPDATE SET
         token_id = excluded.token_id,
         token_contract_address = excluded.token_contract_address,
         wallet_address = excluded.wallet_address,
         from_wallet_address = excluded.from_wallet_address,
         to_wallet_address = excluded.to_wallet_address,
         action = excluded.action,
         usdc_amount = excluded.usdc_amount,
         token_amount = excluded.token_amount,
         fee_amount_usd = excluded.fee_amount_usd,
         source = excluded.source,
         tx_signature = excluded.tx_signature,
         chain_time_ms = excluded.chain_time_ms,
         status = excluded.status,
         error_message = excluded.error_message,
         detail_source = excluded.detail_source,
         details_json = excluded.details_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.userId,
      groupKey,
      input.tokenId ?? existing?.token_id ?? null,
      input.tokenContractAddress,
      walletAddress,
      mergedDetails.fromWalletAddress,
      mergedDetails.toWalletAddress,
      mergedDetails.action,
      mergedDetails.usdcAmount,
      mergedDetails.tokenAmount,
      mergedDetails.feeAmountUsd,
      mergedDetails.source,
      existing?.event_type ?? input.eventType,
      input.txSignature,
      chainTimeMs,
      status,
      status === 'FAILED' ? input.errorMessage : null,
      mergedDetails.detailSource,
      JSON.stringify(mergedDetails),
      JSON.stringify(mergedMetadata),
      createdAt,
      updatedAt,
    )
    .run();
}

const SIGNAL_SOL_PRICE_CACHE_TTL_MS = 30_000;
const SIGNAL_SOL_PRICE_FAILURE_TTL_MS = 5_000;
const TRADE_LOG_CHAIN_TIME_BACKFILL_LIMIT = 50;
const TRADE_LOG_CHAIN_TIME_BACKFILL_CONCURRENCY = 5;

let cachedSignalSolPriceUsd: {
  expiresAt: number;
  value: number | null;
} | null = null;
let pendingSignalSolPriceUsd: Promise<number | null> | null = null;

async function loadSignalSolPriceUsd(): Promise<number | null> {
  const now = Date.now();
  if (cachedSignalSolPriceUsd && cachedSignalSolPriceUsd.expiresAt > now) {
    return cachedSignalSolPriceUsd.value;
  }

  if (pendingSignalSolPriceUsd) {
    return pendingSignalSolPriceUsd;
  }

  pendingSignalSolPriceUsd = (async () => {
    const value =
      (await fetchJupiterTokenPrice(SOLANA_WRAPPED_SOL_MINT))
      ?? (await fetchJupiterPriceViaQuote(SOLANA_WRAPPED_SOL_MINT, 9));
    cachedSignalSolPriceUsd = {
      value,
      expiresAt: Date.now() + (value != null
        ? SIGNAL_SOL_PRICE_CACHE_TTL_MS
        : SIGNAL_SOL_PRICE_FAILURE_TTL_MS),
    };
    return value;
  })();

  try {
    return await pendingSignalSolPriceUsd;
  } finally {
    pendingSignalSolPriceUsd = null;
  }
}

function readRpcUiTokenAmount(balance: RpcTokenBalanceEntry): number | null {
  if (balance.uiTokenAmount?.uiAmountString != null) {
    const parsed = Number.parseFloat(balance.uiTokenAmount.uiAmountString);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (
    typeof balance.uiTokenAmount?.amount === 'string' &&
    typeof balance.uiTokenAmount?.decimals === 'number'
  ) {
    const parsed = Number.parseFloat(balance.uiTokenAmount.amount) / 10 ** balance.uiTokenAmount.decimals;
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveEnrichedSignalSource(
  payloadDetails: Partial<StoredSignalTransactionDetails>,
): 'webhook' | 'rpc_reconcile' {
  return payloadDetails.source === 'rpc_reconcile' ? 'rpc_reconcile' : 'webhook';
}

function readHeliusTokenTransferAmount(transfer: HeliusEnhancedTokenTransfer): number | null {
  const amount = typeof transfer.tokenAmount === 'number'
    ? transfer.tokenAmount
    : typeof transfer.tokenAmount === 'string'
      ? Number.parseFloat(transfer.tokenAmount)
      : null;
  return amount != null && Number.isFinite(amount) ? amount : null;
}

function extractHeliusApiKeyFromRpcUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.toLowerCase().includes('helius')) {
      return null;
    }
    const apiKey = parsed.searchParams.get('api-key')?.trim();
    return apiKey || null;
  } catch {
    return null;
  }
}

function resolveAlchemyRpcUrl(rpcUrls: string | string[]): string | null {
  return (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls])
    .map((rpcUrl) => rpcUrl.trim())
    .find((rpcUrl) => rpcUrl && isAlchemyRpcUrl(rpcUrl)) ?? null;
}

function rpcMetaContainsTrackedToken(
  meta: RpcTransactionMeta | null | undefined,
  trackedContractAddress: string,
): boolean {
  return [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])].some(
    (balance) => tryNormalizeSolanaPubkey(balance.mint) === trackedContractAddress,
  );
}

async function fetchAlchemyTransactionsForAddressInWindow(
  rpcUrls: string | string[],
  address: string,
  trackedContractAddress: string,
  options?: {
    pageSize?: number;
    maxPages?: number;
    startTimeMs?: number | null;
    endTimeMs?: number | null;
  },
): Promise<EnhancedTransactionCandidate[] | null> {
  const endpoint = resolveAlchemyRpcUrl(rpcUrls);
  if (!endpoint) {
    return null;
  }

  const pageSize = Math.min(Math.max(options?.pageSize ?? 100, 1), 100);
  const maxPages = options?.maxPages ?? 10;
  const startTimeSec = options?.startTimeMs != null ? Math.floor(options.startTimeMs / 1000) : null;
  const endTimeSec = options?.endTimeMs != null ? Math.ceil(options.endTimeMs / 1000) : null;
  const results: EnhancedTransactionCandidate[] = [];
  let paginationToken: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const filters: Record<string, unknown> = {
      status: 'succeeded',
      tokenAccounts: 'balanceChanged',
    };
    if (startTimeSec != null || endTimeSec != null) {
      filters.blockTime = {
        ...(startTimeSec != null ? { gte: startTimeSec } : {}),
        ...(endTimeSec != null ? { lte: endTimeSec } : {}),
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransactionsForAddress',
        params: [
          address,
          {
            transactionDetails: 'full',
            sortOrder: 'desc',
            limit: pageSize,
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            ...(paginationToken ? { paginationToken } : {}),
            filters,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Alchemy getTransactionsForAddress request failed: ${response.status}`);
    }

    const payload = await response.json<{
      result?: AlchemyTransactionsForAddressResult;
      error?: { message?: string };
    }>();
    if (payload.error) {
      throw new Error(payload.error.message ?? 'Alchemy getTransactionsForAddress returned an error');
    }
    const batch = payload.result?.data ?? [];
    for (const transaction of batch) {
      if (!transaction.signature || !rpcMetaContainsTrackedToken(transaction.meta, trackedContractAddress)) {
        continue;
      }
      const blockTimeMs = signatureBlockTimeToMs(transaction.blockTime);
      if (options?.startTimeMs != null && blockTimeMs != null && blockTimeMs < options.startTimeMs) {
        continue;
      }
      if (options?.endTimeMs != null && blockTimeMs != null && blockTimeMs > options.endTimeMs) {
        continue;
      }
      results.push({
        txSignature: transaction.signature,
        scannedAddress: address,
        blockTimeMs,
        transaction: null,
        rpcMeta: transaction.meta ?? {
          err: transaction.err,
        },
      });
    }

    paginationToken = payload.result?.paginationToken ?? null;
    if (!paginationToken || batch.length === 0) {
      break;
    }
  }

  return results;
}

function resolveHeliusEnhancedTransactionsUrl(rpcUrls: string | string[]): string | null {
  const apiKey = (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls])
    .map((rpcUrl) => extractHeliusApiKeyFromRpcUrl(rpcUrl))
    .find((value): value is string => !!value);
  return apiKey
    ? `https://api.helius.xyz/v0/transactions/?api-key=${encodeURIComponent(apiKey)}`
    : null;
}

function resolveHeliusEnhancedAddressTransactionsUrl(
  rpcUrls: string | string[],
  address: string,
): string | null {
  const apiKey = (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls])
    .map((rpcUrl) => extractHeliusApiKeyFromRpcUrl(rpcUrl))
    .find((value): value is string => !!value);
  return apiKey
    ? `https://api.helius.xyz/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(apiKey)}`
    : null;
}

function heliusTransactionContainsTrackedToken(
  transaction: HeliusEnhancedTransaction,
  trackedContractAddress: string,
): boolean {
  return (transaction.tokenTransfers ?? []).some(
    (transfer) => tryNormalizeSolanaPubkey(transfer.mint) === trackedContractAddress,
  );
}

async function fetchHeliusEnhancedTransactionsForAddressInWindow(
  rpcUrls: string | string[],
  address: string,
  trackedContractAddress: string,
  options?: {
    pageSize?: number;
    maxPages?: number;
    startTimeMs?: number | null;
    endTimeMs?: number | null;
  },
): Promise<EnhancedTransactionCandidate[] | null> {
  const endpoint = resolveHeliusEnhancedAddressTransactionsUrl(rpcUrls, address);
  if (!endpoint) {
    return null;
  }

  const pageSize = Math.min(Math.max(options?.pageSize ?? 100, 1), 100);
  const maxPages = options?.maxPages ?? 10;
  const startTimeSec = options?.startTimeMs != null ? Math.floor(options.startTimeMs / 1000) : null;
  const endTimeSec = options?.endTimeMs != null ? Math.ceil(options.endTimeMs / 1000) : null;
  const results: EnhancedTransactionCandidate[] = [];
  let beforeSignature: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('commitment', 'confirmed');
    url.searchParams.set('token-accounts', 'balanceChanged');
    url.searchParams.set('sort-order', 'desc');
    if (beforeSignature) {
      url.searchParams.set('before-signature', beforeSignature);
    }
    if (startTimeSec != null) {
      url.searchParams.set('gte-time', String(startTimeSec));
    }
    if (endTimeSec != null) {
      url.searchParams.set('lte-time', String(endTimeSec));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Helius enhanced address transaction request failed: ${response.status}`);
    }
    const batch = await response.json<unknown>();
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    for (const item of batch) {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const transaction = item as HeliusEnhancedTransaction;
      if (!transaction.signature || !heliusTransactionContainsTrackedToken(transaction, trackedContractAddress)) {
        continue;
      }
      const blockTimeMs = signatureBlockTimeToMs(transaction.timestamp);
      if (options?.startTimeMs != null && blockTimeMs != null && blockTimeMs < options.startTimeMs) {
        continue;
      }
      if (options?.endTimeMs != null && blockTimeMs != null && blockTimeMs > options.endTimeMs) {
        continue;
      }
      results.push({
        txSignature: transaction.signature,
        scannedAddress: address,
        blockTimeMs,
        transaction,
      });
    }

    const lastTransaction = batch[batch.length - 1] as HeliusEnhancedTransaction | undefined;
    beforeSignature = typeof lastTransaction?.signature === 'string'
      ? lastTransaction.signature
      : null;
    if (!beforeSignature) {
      break;
    }
  }

  return results;
}

async function fetchHeliusEnhancedTransaction(
  rpcUrls: string | string[],
  txSignature: string,
): Promise<HeliusEnhancedTransaction | null> {
  const endpoint = resolveHeliusEnhancedTransactionsUrl(rpcUrls);
  if (!endpoint) {
    return null;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: [txSignature] }),
  });
  if (!response.ok) {
    throw new Error(`Helius enhanced transaction request failed: ${response.status}`);
  }

  const result = await response.json<unknown>();
  if (!Array.isArray(result)) {
    return null;
  }
  const transaction = result.find((item): item is HeliusEnhancedTransaction => {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      return false;
    }
    const candidate = item as HeliusEnhancedTransaction;
    return !candidate.signature || candidate.signature === txSignature;
  });
  return transaction ?? null;
}

function buildHeliusSignalDetailsFromEnhancedTransaction(
  transaction: HeliusEnhancedTransaction,
  trackedContractAddress: string,
  payloadDetails: Partial<StoredSignalTransactionDetails>,
  solPriceUsd: number | null,
): Partial<StoredSignalTransactionDetails> {
  const deltaByOwner = new Map<string, { tracked: number; usdc: number }>();
  for (const transfer of transaction.tokenTransfers ?? []) {
    const mint = tryNormalizeSolanaPubkey(transfer.mint);
    const amount = readHeliusTokenTransferAmount(transfer);
    if (!mint || amount == null || amount <= 0) {
      continue;
    }

    const fromOwner = tryNormalizeSolanaPubkey(transfer.fromUserAccount) ??
      tryNormalizeSolanaPubkey(transfer.fromTokenAccount);
    const toOwner = tryNormalizeSolanaPubkey(transfer.toUserAccount) ??
      tryNormalizeSolanaPubkey(transfer.toTokenAccount);
    const trackedDelta = mint === trackedContractAddress ? amount : 0;
    const usdcDelta = mint === SOLANA_USDC_MINT ? amount : 0;
    if (trackedDelta === 0 && usdcDelta === 0) {
      continue;
    }
    if (fromOwner) {
      const current = deltaByOwner.get(fromOwner) ?? { tracked: 0, usdc: 0 };
      current.tracked -= trackedDelta;
      current.usdc -= usdcDelta;
      deltaByOwner.set(fromOwner, current);
    }
    if (toOwner) {
      const current = deltaByOwner.get(toOwner) ?? { tracked: 0, usdc: 0 };
      current.tracked += trackedDelta;
      current.usdc += usdcDelta;
      deltaByOwner.set(toOwner, current);
    }
  }

  const payloadPrimaryWalletAddress = tryNormalizeSolanaPubkey(payloadDetails.primaryWalletAddress);
  const payloadFromWalletAddress = tryNormalizeSolanaPubkey(payloadDetails.fromWalletAddress);
  const payloadToWalletAddress = tryNormalizeSolanaPubkey(payloadDetails.toWalletAddress);
  const traderCandidates = uniqueSolanaPubkeys([
    payloadPrimaryWalletAddress,
    payloadToWalletAddress,
    payloadFromWalletAddress,
  ]);
  let focusWallet: string | null = null;
  let focusDelta: { tracked: number; usdc: number } | null = null;
  for (const wallet of traderCandidates) {
    const delta = deltaByOwner.get(wallet);
    if (delta && delta.tracked !== 0) {
      focusWallet = wallet;
      focusDelta = delta;
      break;
    }
  }
  if (!focusWallet) {
    const swapParties = [...deltaByOwner.entries()].filter(
      ([, delta]) =>
        delta.tracked !== 0 &&
        ((delta.tracked > 0 && delta.usdc < 0) ||
          (delta.tracked < 0 && delta.usdc > 0)),
    );
    if (swapParties.length === 1) {
      focusWallet = swapParties[0][0];
      focusDelta = swapParties[0][1];
    }
  }

  const trackedPositiveEntries = [...deltaByOwner.entries()].filter(([, delta]) => delta.tracked > 0);
  const trackedNegativeEntries = [...deltaByOwner.entries()].filter(([, delta]) => delta.tracked < 0);
  const inferredFromWalletAddress = trackedNegativeEntries[0]?.[0] ?? null;
  const inferredToWalletAddress = trackedPositiveEntries[0]?.[0] ?? null;
  const inferredTrackedTransferAmount = focusDelta && focusDelta.tracked !== 0
    ? Math.abs(focusDelta.tracked)
    : trackedPositiveEntries.length === 1 && trackedNegativeEntries.length === 1
      ? Math.max(
          Math.abs(trackedPositiveEntries[0][1].tracked),
          Math.abs(trackedNegativeEntries[0][1].tracked),
        )
      : null;
  const action: 'BUY' | 'SELL' | 'TRANSFER' | null = focusDelta && focusDelta.tracked > 0
    ? 'BUY'
    : focusDelta && focusDelta.tracked < 0
      ? 'SELL'
      : inferredTrackedTransferAmount != null && inferredFromWalletAddress && inferredToWalletAddress
        ? 'TRANSFER'
        : null;

  return {
    tokenContractAddress: trackedContractAddress,
    fromWalletAddress:
      (action === 'SELL' ? focusWallet : null) ?? inferredFromWalletAddress ?? payloadFromWalletAddress ?? null,
    toWalletAddress:
      (action === 'BUY' ? focusWallet : null) ?? inferredToWalletAddress ?? payloadToWalletAddress ?? null,
    primaryWalletAddress:
      focusWallet ?? payloadPrimaryWalletAddress ?? inferredFromWalletAddress ?? inferredToWalletAddress ?? null,
    action,
    usdcAmount: focusDelta && focusDelta.usdc !== 0 ? Math.abs(focusDelta.usdc) : null,
    tokenAmount: inferredTrackedTransferAmount,
    source: resolveEnrichedSignalSource(payloadDetails),
    transactionStatus: transaction.transactionError ? 'FAILED' : 'CONFIRMED',
    detailSource: 'rpc',
    feeAmountUsd:
      typeof transaction.fee === 'number' && solPriceUsd != null
        ? (transaction.fee / 1_000_000_000) * solPriceUsd
        : null,
  };
}

export function buildRpcSignalDetailsFromTransactionMeta(
  meta: RpcTransactionMeta | null | undefined,
  trackedContractAddress: string,
  payloadDetails: Partial<StoredSignalTransactionDetails>,
  solPriceUsd: number | null,
): Partial<StoredSignalTransactionDetails> {
  const deltaByOwner = new Map<string, { tracked: number; usdc: number }>();
  const applyTokenBalances = (
    balances: RpcTokenBalanceEntry[] | undefined,
    sign: -1 | 1,
  ) => {
    for (const balance of balances ?? []) {
      const owner = tryNormalizeSolanaPubkey(balance.owner);
      const mint = tryNormalizeSolanaPubkey(balance.mint);
      if (!owner || !mint) {
        continue;
      }
      const uiAmount = readRpcUiTokenAmount(balance);
      if (uiAmount == null || !Number.isFinite(uiAmount)) {
        continue;
      }
      const current = deltaByOwner.get(owner) ?? { tracked: 0, usdc: 0 };
      if (mint === trackedContractAddress) {
        current.tracked += sign * uiAmount;
      }
      if (mint === SOLANA_USDC_MINT) {
        current.usdc += sign * uiAmount;
      }
      deltaByOwner.set(owner, current);
    }
  };

  applyTokenBalances(meta?.preTokenBalances, -1);
  applyTokenBalances(meta?.postTokenBalances, 1);

  const payloadPrimaryWalletAddress = tryNormalizeSolanaPubkey(payloadDetails.primaryWalletAddress);
  const payloadFromWalletAddress = tryNormalizeSolanaPubkey(payloadDetails.fromWalletAddress);
  const payloadToWalletAddress = tryNormalizeSolanaPubkey(payloadDetails.toWalletAddress);

  const traderCandidates = uniqueSolanaPubkeys([
    payloadPrimaryWalletAddress,
    payloadToWalletAddress,
    payloadFromWalletAddress,
  ]);
  let focusWallet: string | null = null;
  let focusDelta: { tracked: number; usdc: number } | null = null;
  for (const wallet of traderCandidates) {
    const delta = deltaByOwner.get(wallet);
    if (delta && delta.tracked !== 0) {
      focusWallet = wallet;
      focusDelta = delta;
      break;
    }
  }

  if (!focusWallet) {
    const swapParties = [...deltaByOwner.entries()].filter(
      ([, delta]) =>
        delta.tracked !== 0 &&
        ((delta.tracked > 0 && delta.usdc < 0) ||
          (delta.tracked < 0 && delta.usdc > 0)),
    );
    if (swapParties.length === 1) {
      focusWallet = swapParties[0][0];
      focusDelta = swapParties[0][1];
    }
  }

  const trackedPositiveEntries = [...deltaByOwner.entries()].filter(
    ([, delta]) => delta.tracked > 0,
  );
  const trackedNegativeEntries = [...deltaByOwner.entries()].filter(
    ([, delta]) => delta.tracked < 0,
  );
  const inferredFromWalletAddress = trackedNegativeEntries[0]?.[0] ?? null;
  const inferredToWalletAddress = trackedPositiveEntries[0]?.[0] ?? null;
  const inferredTrackedTransferAmount =
    focusDelta && focusDelta.tracked !== 0
      ? Math.abs(focusDelta.tracked)
      : trackedPositiveEntries.length === 1 && trackedNegativeEntries.length === 1
        ? Math.max(
            Math.abs(trackedPositiveEntries[0][1].tracked),
            Math.abs(trackedNegativeEntries[0][1].tracked),
          )
        : null;

  const action: 'BUY' | 'SELL' | 'TRANSFER' | null =
    focusDelta && focusDelta.tracked > 0
      ? 'BUY'
      : focusDelta && focusDelta.tracked < 0
        ? 'SELL'
        : inferredTrackedTransferAmount != null && inferredFromWalletAddress && inferredToWalletAddress
          ? 'TRANSFER'
          : null;
  const fromWalletAddress =
    (action === 'SELL' ? focusWallet : null) ??
    inferredFromWalletAddress ??
    payloadFromWalletAddress ??
    null;
  const toWalletAddress =
    (action === 'BUY' ? focusWallet : null) ??
    inferredToWalletAddress ??
    payloadToWalletAddress ??
    null;
  const primaryWalletAddress =
    focusWallet ??
    (payloadPrimaryWalletAddress && deltaByOwner.has(payloadPrimaryWalletAddress)
      ? payloadPrimaryWalletAddress
      : null) ??
    (payloadFromWalletAddress && deltaByOwner.has(payloadFromWalletAddress)
      ? payloadFromWalletAddress
      : null) ??
    (payloadToWalletAddress && deltaByOwner.has(payloadToWalletAddress)
      ? payloadToWalletAddress
      : null) ??
    fromWalletAddress ??
    toWalletAddress ??
    payloadPrimaryWalletAddress ??
    null;

  return {
    tokenContractAddress: trackedContractAddress,
    fromWalletAddress,
    toWalletAddress,
    primaryWalletAddress,
    action,
    usdcAmount: focusDelta && focusDelta.usdc !== 0 ? Math.abs(focusDelta.usdc) : null,
    tokenAmount: inferredTrackedTransferAmount,
    source: resolveEnrichedSignalSource(payloadDetails),
    transactionStatus: meta?.err ? 'FAILED' : 'CONFIRMED',
    detailSource: 'rpc',
    feeAmountUsd:
      typeof meta?.fee === 'number' && solPriceUsd != null
        ? (meta.fee / 1_000_000_000) * solPriceUsd
        : null,
  };
}

export async function dbApplyTokenHolderTransactionDelta(
  db: D1Database,
  userId: number,
  tokenId: number,
  txSignature: string,
  details: StoredSignalTransactionDetails,
): Promise<boolean> {
  if (!details.fromWalletAddress || !details.toWalletAddress || details.tokenAmount == null || details.tokenAmount <= 0) {
    return false;
  }
  const existingDelta = await db
    .prepare(
      'SELECT id FROM token_holder_transaction_deltas WHERE token_id = ?1 AND tx_signature = ?2 LIMIT 1',
    )
    .bind(tokenId, txSignature)
    .first<{ id: number }>();
  if (existingDelta) {
    return false;
  }
  const timestamp = nowTs();
  await db.batch([
    db
      .prepare(
        `INSERT INTO token_holder_addresses (
           token_id,
           wallet_address,
           amount_holding,
           source,
           first_seen_at,
           last_seen_at
         ) VALUES (?1, ?2, 0, 'tx_delta', ?3, ?3)
         ON CONFLICT(token_id, wallet_address)
         DO UPDATE SET
           amount_holding = CASE
             WHEN token_holder_addresses.amount_holding - ?4 < 0 THEN 0
             ELSE token_holder_addresses.amount_holding - ?4
           END,
           source = 'tx_delta',
           last_seen_at = ?3`,
      )
      .bind(tokenId, details.fromWalletAddress, timestamp, details.tokenAmount),
    db
      .prepare(
        `INSERT INTO token_holder_addresses (
           token_id,
           wallet_address,
           amount_holding,
           source,
           first_seen_at,
           last_seen_at
         ) VALUES (?1, ?2, ?3, 'tx_delta', ?4, ?4)
         ON CONFLICT(token_id, wallet_address)
         DO UPDATE SET
           amount_holding = token_holder_addresses.amount_holding + excluded.amount_holding,
           source = 'tx_delta',
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(tokenId, details.toWalletAddress, details.tokenAmount, timestamp),
    db
      .prepare(
        `INSERT INTO token_holder_transaction_deltas (
           token_id,
           tx_signature,
           wallet_from,
           wallet_to,
           token_amount,
           source,
           applied_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'tx_delta', ?6)`,
      )
      .bind(
        tokenId,
        txSignature,
        details.fromWalletAddress,
        details.toWalletAddress,
        details.tokenAmount,
        timestamp,
      ),
  ]);
  await dbRecomputeTokenHolderAggregate(db, userId, tokenId, {
    source: 'tx_delta',
    deltaSyncAt: timestamp,
  });
  return true;
}
async function dbUpdateSignalsByTxSignatureForUser(
  db: D1Database,
  userId: number,
  txSignature: string,
  walletAddress: string | null,
  details: StoredSignalTransactionDetails,
): Promise<void> {
  await db
    .prepare(
      `UPDATE signals
       SET wallet_address = COALESCE(?3, wallet_address),
           details_json = ?4
       WHERE source LIKE ?1 AND tx_signature = ?2`,
    )
    .bind(`%:user:${userId}`, txSignature, walletAddress, JSON.stringify(details))
    .run();
}
async function dbListSignalGroupsForTokenWindow(
  db: D1Database,
  userId: number,
  contractAddress: string,
  startTimeMs: number | null,
  endTimeMs: number | null,
): Promise<Array<{
  groupKey: string;
  txSignature: string | null;
  chainTimeMs: number | null;
  rows: Array<{
    id: number;
    source: string;
    event_type: string;
    wallet_address: string | null;
    tx_signature: string | null;
    chain_time_ms: number | null;
    details_json: string | null;
    payload: string;
    processed: number;
    error_message: string | null;
    created_at: number;
  }>;
  mergedDetails: StoredSignalTransactionDetails;
}>> {
  const rows = await db
    .prepare(
      `SELECT
         s.id,
         s.source,
         s.event_type,
         s.wallet_address,
         s.tx_signature,
         wtl.chain_time_ms,
         s.details_json,
         s.payload,
         s.processed,
         s.error_message,
         s.created_at
       FROM signals s
       LEFT JOIN webhook_transaction_logs wtl
         ON wtl.user_id = ?2
        AND wtl.tx_signature = s.tx_signature
        AND wtl.token_contract_address = ?3
       WHERE s.source LIKE ?1
       ORDER BY COALESCE(wtl.chain_time_ms, s.created_at) DESC, s.id DESC
       LIMIT 2000`,
    )
    .bind(`%:user:${userId}`, userId, contractAddress)
    .all<{
      id: number;
      source: string;
      event_type: string;
      wallet_address: string | null;
      tx_signature: string | null;
      chain_time_ms: number | null;
      details_json: string | null;
      payload: string;
      processed: number;
      error_message: string | null;
      created_at: number;
    }>();
  const grouped = new Map<string, typeof rows.results>();
  for (const row of rows.results) {
    const chainTimeMs = row.chain_time_ms;
    if (startTimeMs != null && chainTimeMs != null && chainTimeMs < startTimeMs) continue;
    if (endTimeMs != null && chainTimeMs != null && chainTimeMs > endTimeMs) continue;
    const contractAddresses = extractStoredSignalContractAddresses(row.payload);
    if (!contractAddresses.includes(contractAddress)) {
      continue;
    }
    const key = row.tx_signature?.trim() || `signal:${row.id}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }
  return [...grouped.entries()].map(([groupKey, groupRows]) => ({
    groupKey,
    txSignature: groupRows[0]?.tx_signature ?? null,
    chainTimeMs: groupRows[0]?.chain_time_ms ?? null,
    rows: groupRows,
    mergedDetails: mergeStoredSignalTransactionDetails(
      ...groupRows.map((row) => parseStoredSignalTransactionDetails(row.details_json)),
      {
        tokenContractAddress: contractAddress,
        source: groupRows[0]?.source.includes('rpc_reconcile') ? 'rpc_reconcile' : 'webhook',
      },
    ),
  }));
}
function isWebhookTransactionDetailsComplete(
  details: StoredSignalTransactionDetails,
): boolean {
  return !!(
    details.fromWalletAddress &&
    details.toWalletAddress &&
    details.action &&
    details.tokenAmount != null
  );
}
export async function reconcileWebhookTransactionDetailsInWindow(
  db: D1Database,
  userId: number,
  contractAddress: string,
  rpcUrls: string | string[],
  startTimeMs: number | null,
  endTimeMs: number | null,
): Promise<{
  expectedTransactions: number;
  completeTransactionsBefore: number;
  enrichedTransactions: number;
  holderDeltasApplied: number;
  completeTransactionsAfter: number;
}> {
  const tokenId = await dbResolveTradableTokenId(db, contractAddress);
  const trackedToken = tokenId != null ? await dbFindTradableTokenById(db, tokenId) : null;
  const ammPoolAddress = trackedToken?.ammPoolAddress ?? null;
  const groups = await dbListSignalGroupsForTokenWindow(
    db,
    userId,
    contractAddress,
    startTimeMs,
    endTimeMs,
  );
  const groupsToReconcile = groups.filter((group) => group.txSignature);
  const solPriceUsd = groupsToReconcile.length > 0
    ? await loadSignalSolPriceUsd()
    : null;
  let enrichedTransactions = 0;
  let holderDeltasApplied = 0;
  for (const group of groupsToReconcile) {
    const needsProviderEnrichment = !isWebhookTransactionDetailsComplete(group.mergedDetails);
    const rpcResult = needsProviderEnrichment
      ? await fetchSolanaWebhookTransactionDetailsFromRpc(
          rpcUrls,
          group.txSignature!,
          contractAddress,
          group.mergedDetails,
          solPriceUsd,
        )
      : null;
    const chainTimeMs = rpcResult.chainTimeMs ?? group.chainTimeMs ?? null;
    const mergedDetails = mergeStoredSignalTransactionDetails(
      group.mergedDetails,
      rpcResult.details,
    );
    const correctedDetails = applyAmmPoolDirectionCorrection(
      mergedDetails,
      ammPoolAddress,
      group.rows
        .map((row) => parseStoredSignalTransactionDetails(row.details_json))
        .find((details) => details?.fromWalletAddress && details?.toWalletAddress) ?? null,
    );
    const preferredWalletAddress = await dbResolvePreferredSignalWalletAddress(
      db,
      userId,
      [
        correctedDetails.primaryWalletAddress,
        correctedDetails.fromWalletAddress,
        correctedDetails.toWalletAddress,
      ],
      null,
    );
    correctedDetails.primaryWalletAddress = preferredWalletAddress;
    await dbUpdateSignalsByTxSignatureForUser(
      db,
      userId,
      group.txSignature!,
      preferredWalletAddress,
      correctedDetails,
    );
    await dbUpsertWebhookTransactionLog(db, {
      userId,
      tokenId,
      tokenContractAddress: contractAddress,
      source: correctedDetails.source,
      eventType: group.rows[0]?.event_type ?? 'webhook:transaction',
      txSignature: group.txSignature,
      externalId: group.groupKey,
      walletAddress: preferredWalletAddress,
      details: correctedDetails,
      processed: group.rows.every((row) => row.processed === 1),
      errorMessage: group.rows.find((row) => row.error_message)?.error_message ?? null,
      chainTimeMs,
      createdAt: group.rows[0]?.created_at ?? nowTs(),
      metadata: {
        updateReason: 'signal_detail_reconcile',
        chainTimeMs,
      },
    });
    if (tokenId) {
      const deltaApplied = await dbApplyTokenHolderTransactionDelta(
        db,
        userId,
        tokenId,
        group.txSignature!,
        correctedDetails,
      ).catch((err) => {
        console.warn(`Failed to apply token holder delta for reconciled transaction ${group.txSignature}:`, err);
        return false;
      });
      if (deltaApplied) {
        holderDeltasApplied += 1;
      }
    }
    const detailsChanged =
      JSON.stringify(group.mergedDetails) !== JSON.stringify(correctedDetails) ||
      preferredWalletAddress !== (group.rows[0]?.wallet_address ?? null);
    if (detailsChanged) {
      enrichedTransactions += 1;
    }
  }
  const finalGroups = await dbListSignalGroupsForTokenWindow(
    db,
    userId,
    contractAddress,
    startTimeMs,
    endTimeMs,
  );
  return {
    expectedTransactions: groups.length,
    completeTransactionsBefore: groups.filter((group) => isWebhookTransactionDetailsComplete(group.mergedDetails)).length,
    enrichedTransactions,
    holderDeltasApplied,
    completeTransactionsAfter: finalGroups.filter((group) => isWebhookTransactionDetailsComplete(group.mergedDetails)).length,
  };
}
async function dbSignalExistsForUserTxSignature(
  db: D1Database,
  userId: number,
  txSignature: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id
       FROM signals
       WHERE source LIKE ?1 AND tx_signature = ?2
       LIMIT 1`,
    )
    .bind(`%:user:${userId}`, txSignature)
    .first<{ id: number }>();
  return !!row;
}
async function fetchSolanaSignaturesForAddressInWindow(
  rpcUrls: string | string[],
  address: string,
  options?: {
    pageSize?: number;
    maxPages?: number;
    startTimeMs?: number | null;
    endTimeMs?: number | null;
  },
): Promise<Array<{ signature: string; blockTime?: number | null; err?: unknown }>> {
  const pageSize = options?.pageSize ?? 100;
  const maxPages = options?.maxPages ?? 10;
  const results: Array<{ signature: string; blockTime?: number | null; err?: unknown }> = [];
  let beforeSignature: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await solanaRpc<Array<{ signature: string; blockTime?: number | null; err?: unknown }>>(
      rpcUrls,
      'getSignaturesForAddress',
      [address, { limit: pageSize, ...(beforeSignature ? { before: beforeSignature } : {}) }],
    );
    if (batch.length === 0) {
      break;
    }
    let shouldStop = false;
    for (const entry of batch) {
      const blockTimeMs = signatureBlockTimeToMs(entry.blockTime);
      if (options?.endTimeMs != null && blockTimeMs != null && blockTimeMs > options.endTimeMs) {
        continue;
      }
      if (options?.startTimeMs != null && blockTimeMs != null && blockTimeMs < options.startTimeMs) {
        shouldStop = true;
        break;
      }
      results.push(entry);
    }
    if (shouldStop) {
      break;
    }
    beforeSignature = batch[batch.length - 1]?.signature;
    if (!beforeSignature) {
      break;
    }
  }
  return results;
}

function signatureBlockTimeToMs(blockTime: number | null | undefined): number | null {
  if (typeof blockTime !== 'number' || !Number.isFinite(blockTime) || blockTime <= 0) {
    return null;
  }
  return blockTime * 1000;
}

export async function fetchSolanaTransactionChainTimeMs(
  rpcUrls: string | string[],
  txSignature: string,
): Promise<number | null> {
  try {
    const transaction = await solanaRpc<{
      blockTime?: number | null;
    } | null>(rpcUrls, 'getTransaction', [
      txSignature,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    return signatureBlockTimeToMs(transaction?.blockTime);
  } catch (err: unknown) {
    console.warn(`Failed to load chain time for trade transaction ${txSignature}:`, err);
    return null;
  }
}

export async function backfillTradeLogChainTimes(
  db: D1Database,
  rpcUrls: string | string[],
  options?: {
    limit?: number;
  },
): Promise<{
  candidateLogs: number;
  updatedLogs: number;
  unresolvedLogs: number;
}> {
  const limit = Math.min(
    Math.max(options?.limit ?? TRADE_LOG_CHAIN_TIME_BACKFILL_LIMIT, 1),
    TRADE_LOG_CHAIN_TIME_BACKFILL_LIMIT,
  );
  const rows = await db
    .prepare(
      `SELECT id, tx_signature
       FROM trade_logs
       WHERE tx_signature IS NOT NULL
         AND TRIM(tx_signature) <> ''
         AND chain_time_ms IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{
      id: number;
      tx_signature: string;
    }>();

  let updatedLogs = 0;
  let unresolvedLogs = 0;
  for (let index = 0; index < rows.results.length; index += TRADE_LOG_CHAIN_TIME_BACKFILL_CONCURRENCY) {
    const chunk = rows.results.slice(
      index,
      index + TRADE_LOG_CHAIN_TIME_BACKFILL_CONCURRENCY,
    );
    const chainTimes = await Promise.allSettled(
      chunk.map(async (row) => ({
        id: row.id,
        chainTimeMs: await fetchSolanaTransactionChainTimeMs(rpcUrls, row.tx_signature),
      })),
    );

    const updateStatements: D1PreparedStatement[] = [];
    const timestamp = nowTs();
    for (const result of chainTimes) {
      if (result.status !== 'fulfilled' || result.value.chainTimeMs == null) {
        unresolvedLogs += 1;
        continue;
      }
      updateStatements.push(
        db
          .prepare(
            `UPDATE trade_logs
             SET chain_time_ms = ?2,
                 updated_at = ?3
             WHERE id = ?1`,
          )
          .bind(result.value.id, result.value.chainTimeMs, timestamp),
      );
    }

    if (updateStatements.length > 0) {
      await db.batch(updateStatements);
      updatedLogs += updateStatements.length;
    }
  }

  return {
    candidateLogs: rows.results.length,
    updatedLogs,
    unresolvedLogs,
  };
}

export async function dbGetLatestBaseTokenTransactionTimeMs(
  db: D1Database,
  userId: number,
  contractAddress: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MAX(timestamp_ms) AS latest_transaction_time_ms
       FROM (
         SELECT CASE
                  WHEN chain_time_ms IS NOT NULL THEN chain_time_ms
                  WHEN created_at >= 1000000000000 THEN created_at
                  ELSE created_at * 1000
                END AS timestamp_ms
         FROM webhook_transaction_logs
         WHERE user_id = ?1
           AND token_contract_address = ?2
           AND tx_signature IS NOT NULL
           AND TRIM(tx_signature) <> ''
           AND status = 'CONFIRMED'
         UNION ALL
         SELECT CASE
                  WHEN tl.chain_time_ms IS NOT NULL THEN tl.chain_time_ms
                  WHEN tl.created_at >= 1000000000000 THEN tl.created_at
                  ELSE tl.created_at * 1000
                END AS timestamp_ms
         FROM trade_logs tl
         INNER JOIN tradable_tokens tt ON tt.id = tl.token_id
         INNER JOIN accounts a
           ON a.user_id = ?1
          AND a.wallet_address = tl.wallet_address
         WHERE tt.base_token_address = ?2
           AND tl.tx_signature IS NOT NULL
           AND TRIM(tl.tx_signature) <> ''
           AND tl.status = 'SUCCESS'
       )`,
    )
    .bind(userId, contractAddress)
    .first<{ latest_transaction_time_ms: number | null }>();
  const timestamp = row?.latest_transaction_time_ms;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
    ? timestamp
    : null;
}

export async function reconcileTokenTransactionsFromRpc(
  db: D1Database,
  userId: number,
  contractAddress: string,
  rpcUrls: string | string[],
  options?: {
    perAddressLimit?: number;
    perAddressMaxPages?: number;
    startTimeMs?: number | null;
    endTimeMs?: number | null;
  },
): Promise<{
  scannedSignatures: number;
  insertedSignals: number;
  holderDeltasApplied: number;
  duplicates: number;
  skippedIrrelevant: number;
}> {
  const tokenId = await dbResolveTradableTokenId(db, contractAddress);
  const trackedToken = tokenId != null ? await dbFindTradableTokenById(db, tokenId) : null;
  const ammPoolAddress = trackedToken?.ammPoolAddress ?? null;
  const perAddressLimit = options?.perAddressLimit ?? 100;
  const perAddressMaxPages = options?.perAddressMaxPages ?? 10;
  if (!contractAddress.trim()) {
    return {
      scannedSignatures: 0,
      insertedSignals: 0,
      holderDeltasApplied: 0,
      duplicates: 0,
      skippedIrrelevant: 0,
    };
  }

  const transactionPool = new Map<string, EnhancedTransactionCandidate>();
  let usedProviderDiscovery = false;
  try {
    const alchemyTransactions = await fetchAlchemyTransactionsForAddressInWindow(
      rpcUrls,
      contractAddress,
      contractAddress,
      {
        pageSize: perAddressLimit,
        maxPages: perAddressMaxPages,
        startTimeMs: options?.startTimeMs,
        endTimeMs: options?.endTimeMs,
      },
    );
    if (alchemyTransactions) {
      usedProviderDiscovery = true;
      for (const transaction of alchemyTransactions) {
        if (!transactionPool.has(transaction.txSignature)) {
          transactionPool.set(transaction.txSignature, transaction);
        }
      }
    }
  } catch (err: unknown) {
    console.warn(`Failed to fetch Alchemy transactions for mint ${contractAddress}:`, err);
  }

  try {
    if (!usedProviderDiscovery) {
      const enhancedTransactions = await fetchHeliusEnhancedTransactionsForAddressInWindow(
        rpcUrls,
        contractAddress,
        contractAddress,
        {
          pageSize: perAddressLimit,
          maxPages: perAddressMaxPages,
          startTimeMs: options?.startTimeMs,
          endTimeMs: options?.endTimeMs,
        },
      );
      if (enhancedTransactions) {
        usedProviderDiscovery = true;
        for (const transaction of enhancedTransactions) {
          if (!transactionPool.has(transaction.txSignature)) {
            transactionPool.set(transaction.txSignature, transaction);
          }
        }
      }
    }
  } catch (err: unknown) {
    console.warn(`Failed to fetch Helius enhanced transactions for mint ${contractAddress}:`, err);
  }

  if (!usedProviderDiscovery) {
    try {
      const signatures = await fetchSolanaSignaturesForAddressInWindow(
        rpcUrls,
        contractAddress,
        {
          pageSize: perAddressLimit,
          maxPages: perAddressMaxPages,
          startTimeMs: options?.startTimeMs,
          endTimeMs: options?.endTimeMs,
        },
      );
      for (const entry of signatures) {
        if (!entry.signature || transactionPool.has(entry.signature)) continue;
        transactionPool.set(entry.signature, {
          txSignature: entry.signature,
          scannedAddress: contractAddress,
          blockTimeMs: signatureBlockTimeToMs(entry.blockTime),
          transaction: null,
        });
      }
    } catch (err: unknown) {
      console.warn(`Failed to fetch signatures for mint ${contractAddress}:`, err);
    }
  }
  let insertedSignals = 0;
  let holderDeltasApplied = 0;
  let duplicates = 0;
  let skippedIrrelevant = 0;
  const solPriceUsd = transactionPool.size > 0
    ? await loadSignalSolPriceUsd()
    : null;
  for (const [txSignature, transactionCandidate] of transactionPool.entries()) {
    if (
      transactionCandidate.blockTimeMs != null &&
      options?.startTimeMs != null &&
      transactionCandidate.blockTimeMs < options.startTimeMs
    ) {
      skippedIrrelevant += 1;
      continue;
    }
    if (
      transactionCandidate.blockTimeMs != null &&
      options?.endTimeMs != null &&
      transactionCandidate.blockTimeMs > options.endTimeMs
    ) {
      skippedIrrelevant += 1;
      continue;
    }
    if (await dbSignalExistsForUserTxSignature(db, userId, txSignature)) {
      duplicates += 1;
      continue;
    }
    const scannedWalletAddress = transactionCandidate.scannedAddress !== contractAddress
      ? transactionCandidate.scannedAddress
      : null;
    const rpcResult = transactionCandidate.transaction
      ? {
          chainTimeMs: transactionCandidate.blockTimeMs,
          details: buildHeliusSignalDetailsFromEnhancedTransaction(
            transactionCandidate.transaction,
            contractAddress,
            {
              primaryWalletAddress: scannedWalletAddress,
              source: 'rpc_reconcile',
            },
            solPriceUsd,
          ),
        }
      : transactionCandidate.rpcMeta
        ? {
            chainTimeMs: transactionCandidate.blockTimeMs,
            details: buildRpcSignalDetailsFromTransactionMeta(
              transactionCandidate.rpcMeta,
              contractAddress,
              {
                primaryWalletAddress: scannedWalletAddress,
                source: 'rpc_reconcile',
              },
              solPriceUsd,
            ),
          }
      : await fetchSolanaWebhookTransactionDetailsFromRpc(
          rpcUrls,
          txSignature,
          contractAddress,
          {
            primaryWalletAddress: scannedWalletAddress,
            source: 'rpc_reconcile',
          },
          solPriceUsd,
        );
    const chainTimeMs = rpcResult.chainTimeMs ?? transactionCandidate.blockTimeMs ?? null;
    const mergedDetails = applyAmmPoolDirectionCorrection(
      mergeStoredSignalTransactionDetails(
        {
          tokenContractAddress: contractAddress,
          primaryWalletAddress: scannedWalletAddress,
          source: 'rpc_reconcile',
          transactionStatus: 'PENDING',
          detailSource: 'unknown',
        },
        rpcResult.details,
      ),
      ammPoolAddress,
    );
    const isRelevant =
      mergedDetails.action != null ||
      mergedDetails.tokenAmount != null ||
      mergedDetails.usdcAmount != null;
    if (!isRelevant) {
      skippedIrrelevant += 1;
      continue;
    }
    const preferredWalletAddress = await dbResolvePreferredSignalWalletAddress(
      db,
      userId,
      [
        mergedDetails.primaryWalletAddress,
        mergedDetails.fromWalletAddress,
        mergedDetails.toWalletAddress,
      ],
      null,
    );
    mergedDetails.primaryWalletAddress = preferredWalletAddress;
    const source = `rpc_reconcile:refresh:user:${userId}`;
    const externalId = `${txSignature}:${contractAddress}`;
    const createdSignal = await dbCreateSignal(db, {
      source,
      externalId,
      eventType: 'rpc_reconcile:transaction',
      walletAddress: preferredWalletAddress,
      txSignature,
      payload: JSON.stringify({
        type: 'rpc_reconcile',
        txSignature,
        contractAddress,
        walletAddress: scannedWalletAddress,
        scannedAddress: transactionCandidate.scannedAddress,
        blockTimeMs: transactionCandidate.blockTimeMs,
        discoverySource: transactionCandidate.rpcMeta
          ? 'alchemy_get_transactions_for_address'
          : transactionCandidate.transaction
            ? 'helius_enhanced'
            : 'solana_rpc',
      }),
      detailsJson: JSON.stringify(mergedDetails),
    });
    await dbMarkSignalProcessed(db, source, externalId);
    await dbUpsertWebhookTransactionLog(db, {
      userId,
      tokenId,
      tokenContractAddress: contractAddress,
      source: mergedDetails.source,
      eventType: 'rpc_reconcile:transaction',
      txSignature,
      externalId,
      walletAddress: preferredWalletAddress,
      details: mergedDetails,
      processed: true,
      errorMessage: null,
      chainTimeMs,
      createdAt: createdSignal.signal.createdAt,
      metadata: {
        updateReason: 'rpc_reconcile_insert',
        scannedAddress: transactionCandidate.scannedAddress,
        discoverySource: transactionCandidate.rpcMeta
          ? 'alchemy_get_transactions_for_address'
          : transactionCandidate.transaction
            ? 'helius_enhanced'
            : 'solana_rpc',
        blockTimeMs: chainTimeMs,
      },
    });
    if (tokenId) {
      const deltaApplied = await dbApplyTokenHolderTransactionDelta(
        db,
        userId,
        tokenId,
        txSignature,
        mergedDetails,
      ).catch((err) => {
        console.warn(`Failed to apply token holder delta for RPC transaction ${txSignature}:`, err);
        return false;
      });
      if (deltaApplied) {
        holderDeltasApplied += 1;
      }
    }
    insertedSignals += 1;
  }
  return {
    scannedSignatures: transactionPool.size,
    insertedSignals,
    holderDeltasApplied,
    duplicates,
    skippedIrrelevant,
  };
}
export async function dbCreateTradeLog(
  db: D1Database,
  input: TradeLogCreateRequest,
): Promise<void> {
  const timestamp = nowTs();
  await db
    .prepare(
      `INSERT INTO trade_logs (
        token_id,
        signal_id,
        setup_id,
        wallet_address,
        action,
        requested_amount,
        executed_amount,
        executed_price,
        tx_signature,
        status,
        error_message,
        created_at,
        updated_at
      ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      input.tokenId,
      input.setupId,
      input.walletAddress,
      input.action,
      input.requestedAmount,
      input.executedAmount ?? null,
      input.executedPrice ?? null,
      input.txSignature ?? null,
      input.status,
      input.errorMessage ?? null,
      timestamp,
      timestamp,
    )
    .run();
}
export async function dbCreateSignal(
  db: D1Database,
  input: SignalCreateRequest,
): Promise<{ signal: SignalRecord; inserted: boolean }> {
  const existing = await db
    .prepare(
      `SELECT
         id,
         source,
         external_id,
         event_type,
         wallet_address,
         tx_signature,
         payload,
        details_json,
         processed,
         processed_at,
         error_message,
         retry_count,
         created_at
       FROM signals
       WHERE source = ?1 AND external_id = ?2
       LIMIT 1`,
    )
    .bind(input.source, input.externalId)
    .first<{
      id: number;
      source: string;
      external_id: string;
      event_type: string;
      wallet_address: string | null;
      tx_signature: string | null;
      payload: string;
      details_json: string | null;
      processed: number;
      processed_at: number | null;
      error_message: string | null;
      retry_count: number;
      created_at: number;
    }>();
  if (existing) {
    return {
      inserted: false,
      signal: {
        id: existing.id,
        source: existing.source,
        externalId: existing.external_id,
        eventType: existing.event_type,
        walletAddress: existing.wallet_address,
        txSignature: existing.tx_signature,
        payload: existing.payload,
        detailsJson: existing.details_json,
        processed: existing.processed === 1,
        processedState: existing.processed,
        processedAt: existing.processed_at,
        errorMessage: existing.error_message,
        retryCount: existing.retry_count,
        createdAt: existing.created_at,
      },
    };
  }
  const createdAt = nowTs();
  await db
    .prepare(
      `INSERT INTO signals (
        source,
        external_id,
        event_type,
        wallet_address,
        tx_signature,
        payload,
        details_json,
        processed,
        processed_at,
        error_message,
        retry_count,
        created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 2, NULL, NULL, 0, ?8)`,
    )
    .bind(
      input.source,
      input.externalId,
      input.eventType,
      input.walletAddress,
      input.txSignature,
      input.payload,
      input.detailsJson ?? null,
      createdAt,
    )
    .run();
  return {
    inserted: true,
    signal: {
      id: 0,
      source: input.source,
      externalId: input.externalId,
      eventType: input.eventType,
      walletAddress: input.walletAddress,
      txSignature: input.txSignature,
      payload: input.payload,
      detailsJson: input.detailsJson ?? null,
      processed: false,
      processedState: 2,
      processedAt: null,
      errorMessage: null,
      retryCount: 0,
      createdAt,
    },
  };
}

export async function dbFindSignalByUserTxSignature(
  db: D1Database,
  userId: number,
  txSignature: string,
): Promise<SignalRecord | null> {
  const row = await db
    .prepare(
      `SELECT
         id,
         source,
         external_id,
         event_type,
         wallet_address,
         tx_signature,
         payload,
         details_json,
         processed,
         processed_at,
         error_message,
         retry_count,
         created_at
       FROM signals
       WHERE source LIKE ?1 AND tx_signature = ?2
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .bind(`%:user:${userId}`, txSignature)
    .first<{
      id: number;
      source: string;
      external_id: string;
      event_type: string;
      wallet_address: string | null;
      tx_signature: string | null;
      payload: string;
      details_json: string | null;
      processed: number;
      processed_at: number | null;
      error_message: string | null;
      retry_count: number;
      created_at: number;
    }>();

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    eventType: row.event_type,
    walletAddress: row.wallet_address,
    txSignature: row.tx_signature,
    payload: row.payload,
    detailsJson: row.details_json,
    processed: row.processed === 1,
    processedState: row.processed,
    processedAt: row.processed_at,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    createdAt: row.created_at,
  };
}
export async function dbClaimSignalProcessing(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE signals
       SET processed = 2,
           processed_at = NULL,
           error_message = NULL
       WHERE source = ?1 AND external_id = ?2 AND processed = 0`,
    )
    .bind(source, externalId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
export async function dbResolvePreferredSignalWalletAddress(
  db: D1Database,
  userId: number,
  candidates: Array<string | null | undefined>,
  fallbackWalletAddress: string | null,
): Promise<string | null> {
  const normalizedCandidates = uniqueSolanaPubkeys(candidates);
  if (normalizedCandidates.length === 0) {
    return fallbackWalletAddress;
  }
  const normalizedFallbackWalletAddress = tryNormalizeSolanaPubkey(
    fallbackWalletAddress,
  );
  const rows = await db
    .prepare(
      `SELECT wallet_address, type
       FROM accounts
       WHERE user_id = ?1 AND wallet_address IN (?2, ?3, ?4, ?5, ?6)
       ORDER BY CASE type WHEN 'managed' THEN 0 ELSE 1 END, id ASC`,
    )
    .bind(
      userId,
      normalizedCandidates[0] ?? '',
      normalizedCandidates[1] ?? '',
      normalizedCandidates[2] ?? '',
      normalizedCandidates[3] ?? '',
      normalizedCandidates[4] ?? '',
    )
    .all<{
      wallet_address: string;
      type: string;
    }>();
  if (rows.results.length > 0) {
    return rows.results[0].wallet_address;
  }
  return normalizedCandidates.find(
    (candidate) => candidate !== normalizedFallbackWalletAddress,
  ) ?? normalizedFallbackWalletAddress ?? normalizedCandidates[0] ?? null;
}
export async function dbUpdateSignalTransactionDetails(
  db: D1Database,
  source: string,
  externalId: string,
  walletAddress: string | null,
  details: StoredSignalTransactionDetails,
): Promise<void> {
  await db
    .prepare(
      `UPDATE signals
       SET wallet_address = ?3,
           details_json = ?4
       WHERE source = ?1 AND external_id = ?2`,
    )
    .bind(source, externalId, walletAddress, JSON.stringify(details))
    .run();
}
export async function fetchSolanaWebhookTransactionDetailsFromRpc(
  rpcUrls: string | string[],
  txSignature: string,
  trackedContractAddress: string,
  payloadDetails: Partial<StoredSignalTransactionDetails>,
  solPriceUsd?: number | null,
): Promise<RpcWebhookTransactionDetailsResult> {
  try {
    const resolvedSolPriceUsd = solPriceUsd === undefined
      ? await loadSignalSolPriceUsd()
      : solPriceUsd;
    const heliusTransaction = await fetchHeliusEnhancedTransaction(
      rpcUrls,
      txSignature,
    ).catch((err: unknown) => {
      console.warn(`Failed to enrich webhook transaction ${txSignature} from Helius enhanced API:`, err);
      return null;
    });
    if (heliusTransaction) {
      const heliusDetails = buildHeliusSignalDetailsFromEnhancedTransaction(
        heliusTransaction,
        trackedContractAddress,
        payloadDetails,
        resolvedSolPriceUsd,
      );
      const hasTrackedTokenDetails =
        heliusDetails.action != null ||
        heliusDetails.tokenAmount != null ||
        heliusDetails.usdcAmount != null;
      if (!hasTrackedTokenDetails) {
        console.warn(`Helius enhanced transaction ${txSignature} did not include tracked token details; falling back to Solana RPC.`);
      } else {
        return {
          chainTimeMs: signatureBlockTimeToMs(heliusTransaction.timestamp),
          details: heliusDetails,
        };
      }
    }

    const transaction = await solanaRpc<{
      meta?: RpcTransactionMeta;
      blockTime?: number | null;
    }>(rpcUrls, 'getTransaction', [
      txSignature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    return {
      chainTimeMs: signatureBlockTimeToMs(transaction.blockTime),
      details: buildRpcSignalDetailsFromTransactionMeta(
        transaction.meta,
        trackedContractAddress,
        payloadDetails,
        resolvedSolPriceUsd,
      ),
    };
  } catch (err: unknown) {
    console.warn(`Failed to enrich webhook transaction ${txSignature} from RPC:`, err);
    return {
      chainTimeMs: null,
      details: {
        tokenContractAddress: trackedContractAddress,
        feeAmountUsd: null,
        source: resolveEnrichedSignalSource(payloadDetails),
        transactionStatus: 'PENDING',
        detailSource: 'unknown',
      },
    };
  }
}
export async function dbMarkSignalProcessed(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE signals
       SET processed = 1,
           processed_at = ?3,
           error_message = NULL
       WHERE source = ?1 AND external_id = ?2`,
    )
    .bind(source, externalId, nowTs())
    .run();
}
export async function dbMarkSignalFailed(
  db: D1Database,
  source: string,
  externalId: string,
  errorMessage: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE signals
       SET processed = 0,
           processed_at = NULL,
           error_message = ?3,
           retry_count = retry_count + 1
       WHERE source = ?1 AND external_id = ?2`,
    )
    .bind(source, externalId, errorMessage)
    .run();
}
