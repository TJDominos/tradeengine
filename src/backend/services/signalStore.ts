import { ApiError } from '../errors';
import {
  fetchJupiterPriceViaQuote,
  fetchJupiterTokenPrice,
} from '../jupiter';
import { summarizeStrategyRuntime } from '../strategy/runtime';
import { buildWebhookStrategyTrigger } from '../strategy/triggers';
import { nowTs, normalizeTimestampMs } from '../time';
import { dbFindTradableTokenById, dbResolveTradableTokenId } from '../tokenStore';
import {
  dbAddAuditLog,
  dbListAccounts,
  dbListManagedAccountAddresses,
  dbLoadSettings,
} from '../userStore';
import { dbRecomputeTokenHolderAggregate } from '../tokenHolders';
import type {
  Env,
  SignalCreateRequest,
  SignalRecord,
  StoredSignalTransactionDetails,
  TokenMarketSnapshot,
  TradeLogCreateRequest,
} from '../workerShared';
import { parseJsonText } from '../workerSchema';
import {
  dedupeStrings,
  extractStoredSignalContractAddresses,
  extractWebhookTransactionDetailsFromPayload,
  mergeStoredSignalTransactionDetails,
  normalizePubkey,
  parseStoredSignalTransactionDetails,
  solanaRpc,
  tryNormalizeSolanaPubkey,
  uniqueSolanaPubkeys,
} from '../workerCore';
import { SOLANA_USDC_MINT, SOLANA_WRAPPED_SOL_MINT } from '../workerShared';
import { runAndPersistStrategyEvaluation } from './strategyStore';
import { syncTokenMarketSnapshotForUser } from './tokenMarketService';

function applyAmmPoolDirectionCorrection(
  details: StoredSignalTransactionDetails,
  ammPoolAddress: string | null | undefined,
): StoredSignalTransactionDetails {
  const normalizedAmmPoolAddress = tryNormalizeSolanaPubkey(ammPoolAddress);
  if (!normalizedAmmPoolAddress) {
    return details;
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

const SIGNAL_SOL_PRICE_CACHE_TTL_MS = 30_000;
const SIGNAL_SOL_PRICE_FAILURE_TTL_MS = 5_000;

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

  const action: 'BUY' | 'SELL' | null =
    focusDelta && focusDelta.tracked > 0
      ? 'BUY'
      : focusDelta && focusDelta.tracked < 0
        ? 'SELL'
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
    source: 'rpc_reconcile',
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
  rows: Array<{
    id: number;
    source: string;
    event_type: string;
    wallet_address: string | null;
    tx_signature: string | null;
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
         id,
         source,
         event_type,
         wallet_address,
         tx_signature,
         details_json,
         payload,
         processed,
         error_message,
         created_at
       FROM signals
       WHERE source LIKE ?1
       ORDER BY created_at DESC, id DESC
       LIMIT 2000`,
    )
    .bind(`%:user:${userId}`)
    .all<{
      id: number;
      source: string;
      event_type: string;
      wallet_address: string | null;
      tx_signature: string | null;
      details_json: string | null;
      payload: string;
      processed: number;
      error_message: string | null;
      created_at: number;
    }>();
  const grouped = new Map<string, typeof rows.results>();
  for (const row of rows.results) {
    const createdAtMs = normalizeTimestampMs(row.created_at);
    if (startTimeMs != null && createdAtMs < startTimeMs) continue;
    if (endTimeMs != null && createdAtMs > endTimeMs) continue;
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
    details.usdcAmount != null &&
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
  for (const group of groupsToReconcile) {
    const rpcDetails = await fetchSolanaWebhookTransactionDetailsFromRpc(
      rpcUrls,
      group.txSignature!,
      contractAddress,
      group.mergedDetails,
      solPriceUsd,
    );
    const mergedDetails = mergeStoredSignalTransactionDetails(
      group.mergedDetails,
      rpcDetails,
    );
    const correctedDetails = applyAmmPoolDirectionCorrection(
      mergedDetails,
      ammPoolAddress,
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
export async function reconcileTokenTransactionsFromRpc(
  db: D1Database,
  userId: number,
  contractAddress: string,
  rpcUrls: string | string[],
  options?: {
    perAddressLimit?: number;
    additionalAddresses?: Array<string | null | undefined>;
    backfillAddresses?: Array<string | null | undefined>;
    backfillPerAddressLimit?: number;
    backfillMaxPages?: number;
    startTimeMs?: number | null;
    endTimeMs?: number | null;
  },
): Promise<{
  scannedSignatures: number;
  insertedSignals: number;
  duplicates: number;
  skippedIrrelevant: number;
}> {
  const tokenId = await dbResolveTradableTokenId(db, contractAddress);
  const trackedToken = tokenId != null ? await dbFindTradableTokenById(db, tokenId) : null;
  const ammPoolAddress = trackedToken?.ammPoolAddress ?? null;
  const perAddressLimit = options?.perAddressLimit ?? 100;
  const [managed, watched] = await Promise.all([
    dbListManagedAccountAddresses(db, userId),
    dbListAccounts(db, userId, 'watch'),
  ]);
  const candidateAddresses = dedupeStrings([
    contractAddress,
    ...(options?.additionalAddresses ?? []),
    ...managed,
    ...watched.map((account) => account.address),
  ]);
  const baseAddressSet = new Set(candidateAddresses);
  const backfillAddresses = dedupeStrings(
    (options?.backfillAddresses ?? []).filter(
      (address): address is string => typeof address === 'string',
    ),
  ).filter((address) => !baseAddressSet.has(address));
  if (candidateAddresses.length === 0 && backfillAddresses.length === 0) {
    return {
      scannedSignatures: 0,
      insertedSignals: 0,
      duplicates: 0,
      skippedIrrelevant: 0,
    };
  }

  const addressScanPlans = [
    {
      addresses: candidateAddresses,
      pageSize: perAddressLimit,
      maxPages: 10,
    },
  ];
  if (backfillAddresses.length > 0) {
    addressScanPlans.push({
      addresses: backfillAddresses,
      pageSize: options?.backfillPerAddressLimit ?? 20,
      maxPages: options?.backfillMaxPages ?? 2,
    });
  }

  const signaturePool = new Map<string, { address: string; blockTimeMs: number | null }>();
  for (const plan of addressScanPlans) {
    for (const address of plan.addresses) {
      try {
        const signatures = await fetchSolanaSignaturesForAddressInWindow(
          rpcUrls,
          address,
          {
            pageSize: plan.pageSize,
            maxPages: plan.maxPages,
            startTimeMs: options?.startTimeMs,
            endTimeMs: options?.endTimeMs,
          },
        );
        for (const entry of signatures) {
          if (!entry.signature || signaturePool.has(entry.signature)) continue;
          signaturePool.set(entry.signature, {
            address,
            blockTimeMs: signatureBlockTimeToMs(entry.blockTime),
          });
        }
      } catch (err: unknown) {
        console.warn(`Failed to fetch signatures for ${address}:`, err);
      }
    }
  }
  let insertedSignals = 0;
  let duplicates = 0;
  let skippedIrrelevant = 0;
  const solPriceUsd = signaturePool.size > 0
    ? await loadSignalSolPriceUsd()
    : null;
  for (const [txSignature, signatureMeta] of signaturePool.entries()) {
    if (
      signatureMeta.blockTimeMs != null &&
      options?.startTimeMs != null &&
      signatureMeta.blockTimeMs < options.startTimeMs
    ) {
      skippedIrrelevant += 1;
      continue;
    }
    if (
      signatureMeta.blockTimeMs != null &&
      options?.endTimeMs != null &&
      signatureMeta.blockTimeMs > options.endTimeMs
    ) {
      skippedIrrelevant += 1;
      continue;
    }
    if (await dbSignalExistsForUserTxSignature(db, userId, txSignature)) {
      duplicates += 1;
      continue;
    }
    const scannedWalletAddress = signatureMeta.address !== contractAddress
      ? signatureMeta.address
      : null;
    const rpcDetails = await fetchSolanaWebhookTransactionDetailsFromRpc(
      rpcUrls,
      txSignature,
      contractAddress,
      {
        primaryWalletAddress: scannedWalletAddress,
      },
      solPriceUsd,
    );
    const mergedDetails = applyAmmPoolDirectionCorrection(
      mergeStoredSignalTransactionDetails(
        {
          tokenContractAddress: contractAddress,
          primaryWalletAddress: scannedWalletAddress,
          source: 'rpc_reconcile',
          transactionStatus: 'PENDING',
          detailSource: 'unknown',
        },
        rpcDetails,
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
    await dbCreateSignal(db, {
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
        scannedAddress: signatureMeta.address,
        blockTimeMs: signatureMeta.blockTimeMs,
      }),
      detailsJson: JSON.stringify(mergedDetails),
    });
    await dbMarkSignalProcessed(db, source, externalId);
    insertedSignals += 1;
  }
  return {
    scannedSignatures: signaturePool.size,
    insertedSignals,
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
): Promise<Partial<StoredSignalTransactionDetails>> {
  try {
    const resolvedSolPriceUsd = solPriceUsd === undefined
      ? await loadSignalSolPriceUsd()
      : solPriceUsd;
    const transaction = await solanaRpc<{
      meta?: RpcTransactionMeta;
    }>(rpcUrls, 'getTransaction', [
      txSignature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    return buildRpcSignalDetailsFromTransactionMeta(
      transaction.meta,
      trackedContractAddress,
      payloadDetails,
      resolvedSolPriceUsd,
    );
  } catch (err: unknown) {
    console.warn(`Failed to enrich webhook transaction ${txSignature} from RPC:`, err);
    return {
      tokenContractAddress: trackedContractAddress,
      feeAmountUsd: null,
      source: 'rpc_reconcile',
      transactionStatus: 'PENDING',
      detailSource: 'unknown',
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
