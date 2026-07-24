/// <reference types="@cloudflare/workers-types" />

import nacl from 'tweetnacl';

import { ApiError } from './backend/errors';
import {
  buildJupiterSwapTransaction,
  fetchJupiterPriceViaQuote,
  fetchJupiterSwapQuote,
  fetchJupiterTokenMetadata,
  fetchJupiterTokenPrice,
  type JupiterQuoteResponse,
  type JupiterTokenMetadata,
} from './backend/jupiter';
import {
  DEFAULT_STRATEGY_TYPE,
  PRIMARY_STRATEGY_NAME,
} from './backend/strategy/config';
import { normalizeStrategyDocument } from './backend/strategy/migrations';
import {
  buildStrategyDocumentFromSettings,
  runStrategyRuntime,
  summarizeStrategyRuntime,
} from './backend/strategy/runtime';
import {
  buildManualRefreshStrategyTrigger,
  buildWebhookStrategyTrigger,
} from './backend/strategy/triggers';
import {
  dbAddRpcEndpoint,
  dbCreateTradableToken,
  dbDeleteRpcEndpoint,
  dbGetLatestTokenMarketSnapshot,
  dbGetTokenMarketSnapshotsByTimeRange,
  dbInsertTokenMarketSnapshot,
  dbListRpcEndpoints,
  dbListTradableTokens,
  dbResolveSolanaRpcUrls,
  dbResolveTradableTokenId,
  dbUpdateTradableTokenMetadata,
} from './backend/tokenStore';
import {
  dbAddAuditLog,
  dbAuthenticateUser,
  dbCreateSession,
  dbCreateUser,
  dbDeleteOtherSessions,
  dbDeleteSession,
  dbGetUserBySessionToken,
  dbImportManagedKey,
  dbImportManagedKeyBytes,
  dbImportWatchAccount,
  dbListAccounts,
  dbListAuditLogs,
  dbListManagedAccountAddresses,
  dbListRecentSignalsForDebug,
  dbListTradeLogs,
  dbListWebhookTransactionLogs,
  dbLoadManagedKeypairBytes,
  dbLoadSettings,
  dbSaveActiveContractAddress,
  dbSaveSettings,
  dbSetupRequired,
  dbVerifyUserPassword,
} from './backend/userStore';
import {
  dbComputeTokenHolderAggregateFromStage,
  dbCountTokenHolderSyncStageHolders,
  dbFinalizePagedTokenHolderSync,
  dbGetTokenHolderAggregate,
  dbGetTokenHolderSyncState,
  dbHasTokenHolderRows,
  dbListOutsideTokenHolders,
  dbPutTokenHolderSyncState,
  dbRecomputeTokenHolderAggregate,
  dbStageTokenHolderBalanceShard,
  dbStartOrResumeTokenHolderSync,
  dbSyncTokenHolderBalances,
  dbUpsertTokenHolderAddresses,
} from './backend/tokenHolders';
import type {
  StrategyDefinitionRecord,
  StrategyMarketSnapshot,
  StrategyRuntimeResult,
  StrategySettingsInput,
  StrategyTriggerEvent,
  StrategyVersionDocument,
  StrategyVersionRecord,
} from './backend/strategy/types';
import { nowMs, nowTs, normalizeTimestampMs } from './backend/time';
import type {
  AccountRecord,
  ActiveTokenUpdateRequest,
  AlchemyWebhookPayload,
  AuditLog,
  DerivedChainSignal,
  Env,
  HistoricalSetupRecord,
  ManagedWalletImportRequest,
  OutsideTokenHolderRecord,
  RpcEndpoint,
  RpcEndpointCreateRequest,
  SessionUser,
  SettingsState,
  SettingsUpdateRequest,
  SignalCreateRequest,
  SignalRecord,
  StoredSignalTransactionDetails,
  TokenHolderAggregateRecord,
  TokenHolderSyncStateRecord,
  TokenHolderSyncStatus,
  TokenHolderSyncSummary,
  TokenMarketSnapshot,
  TradableToken,
  TradableTokenCreateRequest,
  TrackedTokenDescriptor,
  TradeLogCreateRequest,
  TradeLogRecord,
  WalletBalanceResponse,
  WalletBalanceToken,
  WebhookTransactionLogRecord,
} from './backend/workerShared';
import {
  base58Encode,
  buildSessionCookie,
  buildTokenHolderSyncSummary,
  clearSessionCookie,
  decodeBase64Bytes,
  dedupeStrings,
  decryptPrivateKey,
  deriveSolanaKeypairFromRecoveryPhrase,
  encryptPrivateKey,
  errorResponse,
  extractStoredSignalContractAddresses,
  extractWebhookTransactionDetailsFromPayload,
  formatTokenAmount,
  generateToken,
  getTokenHolderSyncShardCursor,
  hashPassword,
  isRecord,
  isSecure,
  isSolanaRpcRateLimitError,
  jsonResponse,
  mergeStoredSignalTransactionDetails,
  normalizePrivateKey,
  normalizePubkey,
  normalizeRpcUrl,
  parseStoredSignalTransactionDetails,
  readNonEmptyString,
  readTokenMarketCache,
  readUint64LittleEndian,
  readWalletBalanceCache,
  sessionTokenFromCookie,
  sha256Hex,
  solanaPubkeyFromKeypairBytes,
  tokenMarketCacheKey,
  tryNormalizeSolanaPubkey,
  uniqueSolanaPubkeys,
  validateContractAddress,
  validateLabel,
  validatePassword,
  validateUsername,
  verifyPassword,
  walletBalanceCacheKey,
  writeTokenMarketCache,
  writeWalletBalanceCache,
} from './backend/workerCore';
import {
  dbEnsureSchema,
  dbEnsureTradeDomainSchema,
  parseActiveTokenUpdateRequest,
  parseCredentialsBody,
  parseJsonBody,
  parseJsonText,
  parseManagedWalletImportRequest,
  parseRpcEndpointCreateRequest,
  parseTradableTokenCreateRequest,
} from './backend/workerSchema';
import {
  DEFAULT_SOLANA_DERIVATION_PATH,
  SOLANA_SPL_TOKEN_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  SOLANA_USDC_MINT,
  SOLANA_WRAPPED_SOL_MINT,
  TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT,
  TOKEN_HOLDER_SYNC_PROGRAM_IDS,
  TOKEN_HOLDER_SYNC_SHARDS_PER_REFRESH,
  TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
  TOKEN_MARKET_CACHE_TTL_MS,
  SESSION_TTL_HOURS,
} from './backend/workerShared';

// ─── D1 database operations ───────────────────────────────────────────────────

const HOLDER_SYNC_PROGRAM_ACCOUNTS_PRIMARY_RPC_URL =
  'https://api.mainnet-beta.solana.com';
const HOLDER_SYNC_ACCOUNT_DETAILS_PRIMARY_RPC_URL =
  'https://mainnet.helius-rpc.com/fda76be1-7d09-4880-80db-837831934193';
const HOLDER_SYNC_PROGRAM_ACCOUNTS_INTERVAL_MS = 10_000;
const HOLDER_SYNC_ACCOUNT_DETAILS_REQUESTS_PER_SECOND = 4;
const HOLDER_SYNC_ACCOUNT_DETAILS_INTERVAL_MS = Math.ceil(
  1000 / HOLDER_SYNC_ACCOUNT_DETAILS_REQUESTS_PER_SECOND,
);

function buildHolderProgramAccountsRpcUrls(
  _rpcUrls: string | string[],
): string[] {
  return [HOLDER_SYNC_PROGRAM_ACCOUNTS_PRIMARY_RPC_URL];
}

function buildHolderAccountDetailsRpcUrls(
  _rpcUrls: string | string[],
): string[] {
  return [HOLDER_SYNC_ACCOUNT_DETAILS_PRIMARY_RPC_URL];
}

async function fetchSolanaTokenHolderAddresses(
  rpcUrls: string | string[],
  mint: string,
): Promise<string[]> {
  const filters = [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }];
  const programResults = await Promise.allSettled(
    [SOLANA_SPL_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID].map((programId) =>
      solanaRpc<
        Array<{
          account: {
            data: {
              parsed?: {
                info?: {
                  owner?: string;
                };
              };
            };
          };
        }>
      >(rpcUrls, 'getProgramAccounts', [
        programId,
        { filters, encoding: 'jsonParsed' },
      ]),
    ),
  );

  const owners = new Set<string>();
  for (const result of programResults) {
    if (result.status !== 'fulfilled') {
      continue;
    }
    for (const account of result.value) {
      const owner = tryNormalizeSolanaPubkey(
        account.account.data.parsed?.info?.owner,
      );
      if (owner) {
        owners.add(owner);
      }
    }
  }
  return [...owners];
}

async function fetchSolanaTokenHolderBalances(
  rpcUrls: string | string[],
  mint: string,
  decimals: number,
): Promise<Map<string, number>> {
  // Phase 1: get token-account pubkeys only (minimal response payload).
  const filters = [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }];
  const tokenAccountPubkeys = new Set<string>();
  let successfulProgramCalls = 0;
  let lastListError: unknown = null;
  const programIds = [SOLANA_SPL_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID];
  const holderProgramAccountsRpcUrls = buildHolderProgramAccountsRpcUrls(rpcUrls);
  const holderAccountDetailsRpcUrls = buildHolderAccountDetailsRpcUrls(rpcUrls);
  for (let index = 0; index < programIds.length; index += 1) {
    const programId = programIds[index];
    try {
      const rows = await solanaRpc<Array<{ pubkey: string }>>(
        holderProgramAccountsRpcUrls,
        'getProgramAccounts',
        [
          programId,
          {
            filters,
            dataSlice: { offset: 0, length: 0 },
          },
        ],
      );
      successfulProgramCalls += 1;
      for (const row of rows) {
        const pubkey = tryNormalizeSolanaPubkey(row.pubkey);
        if (pubkey) {
          tokenAccountPubkeys.add(pubkey);
        }
      }
    } catch (err: unknown) {
      lastListError = err;
      console.warn(
        `Holder pubkey listing failed for program ${programId}:`,
        err,
      );
    }

    if (index < programIds.length - 1) {
      await waitMs(HOLDER_SYNC_PROGRAM_ACCOUNTS_INTERVAL_MS);
    }
  }

  if (successfulProgramCalls === 0) {
    throw lastListError instanceof Error
      ? lastListError
      : new ApiError(502, 'Failed to list token holder accounts from Solana RPC');
  }

  // Phase 2: batch-fetch account details and parse owner (32 bytes) + amount (8 bytes).
  const balances = new Map<string, number>();
  const allPubkeys = [...tokenAccountPubkeys];
  const chunkSize = 100;
  for (let index = 0; index < allPubkeys.length; index += chunkSize) {
    const chunk = allPubkeys.slice(index, index + chunkSize);
    const accountInfos = await solanaRpc<{
      value: Array<
        | {
            data: [string, string] | string;
          }
        | null
      >;
    }>(holderAccountDetailsRpcUrls, 'getMultipleAccounts', [
      chunk,
      {
        encoding: 'base64',
        dataSlice: { offset: 32, length: 40 },
      },
    ]);

    for (const accountInfo of accountInfos.value ?? []) {
      if (!accountInfo) {
        continue;
      }
      const data = Array.isArray(accountInfo.data)
        ? accountInfo.data[0]
        : accountInfo.data;
      if (typeof data !== 'string' || data.length === 0) {
        continue;
      }
      const bytes = decodeBase64Bytes(data);
      if (bytes.length < 40) {
        continue;
      }
      const owner = base58Encode(bytes.slice(0, 32));
      const rawAmount = readUint64LittleEndian(bytes, 32);
      if (rawAmount <= 0n) {
        continue;
      }
      const amountHolding = Number(rawAmount) / 10 ** decimals;
      if (!Number.isFinite(amountHolding) || amountHolding <= 0) {
        continue;
      }
      balances.set(owner, (balances.get(owner) ?? 0) + amountHolding);
    }

    if (index + chunkSize < allPubkeys.length) {
      await waitMs(HOLDER_SYNC_ACCOUNT_DETAILS_INTERVAL_MS);
    }
  }

  return balances;
}

async function fetchSolanaTokenHolderBalanceShard(
  rpcUrls: string | string[],
  mint: string,
  programId: (typeof TOKEN_HOLDER_SYNC_PROGRAM_IDS)[number],
  ownerPrefix: number,
  decimals: number,
): Promise<Map<string, number>> {
  const ownerPrefixFilter = base58Encode(Uint8Array.of(ownerPrefix));
  const filters = [
    { dataSize: 165 },
    { memcmp: { offset: 0, bytes: mint } },
    { memcmp: { offset: 32, bytes: ownerPrefixFilter } },
  ];

  const rows = await solanaRpc<
    Array<{
      account: {
        data: [string, string] | string;
      };
    }>
  >(rpcUrls, 'getProgramAccounts', [
    programId,
    {
      filters,
      encoding: 'base64',
      dataSlice: { offset: 32, length: 40 },
    },
  ]);

  const balances = new Map<string, number>();
  for (const row of rows) {
    const data = Array.isArray(row.account.data)
      ? row.account.data[0]
      : row.account.data;
    if (typeof data !== 'string' || data.length === 0) {
      continue;
    }
    const bytes = decodeBase64Bytes(data);
    if (bytes.length < 40) {
      continue;
    }
    const owner = base58Encode(bytes.slice(0, 32));
    const rawAmount = readUint64LittleEndian(bytes, 32);
    if (rawAmount <= 0n) {
      continue;
    }
    const amountHolding = Number(rawAmount) / 10 ** decimals;
    if (!Number.isFinite(amountHolding) || amountHolding <= 0) {
      continue;
    }
    balances.set(owner, (balances.get(owner) ?? 0) + amountHolding);
  }

  return balances;
}

async function syncSolanaTokenHolderBalancesPaged(
  db: D1Database,
  userId: number,
  tokenId: number,
  mint: string,
  rpcUrls: string | string[],
  options?: {
    maxShards?: number;
    continueUntilFirstStage?: boolean;
    timeBudgetMs?: number;
  },
): Promise<TokenHolderSyncSummary> {
  const maxShards = options?.maxShards ?? TOKEN_HOLDER_SYNC_SHARDS_PER_REFRESH;
  const state = await dbStartOrResumeTokenHolderSync(db, tokenId);
  const decimals = await fetchSolanaMintDecimals(rpcUrls, mint);
  if (decimals == null) {
    const failedState = await dbPutTokenHolderSyncState(db, {
      ...state,
      status: 'failed',
      errorMessage: 'Failed to resolve token mint decimals for holder sync',
      updatedAt: nowTs(),
    });
    return buildTokenHolderSyncSummary(failedState);
  }

  let currentState = state;
  let shardsProcessedThisRun = 0;
  let stagedHolderCount = currentState.stagedHolderCount;
  const startedAtMs = Date.now();
  try {
    while (
      currentState.nextShardIndex < currentState.totalShardCount &&
      (
        shardsProcessedThisRun < maxShards ||
        (!!options?.continueUntilFirstStage && stagedHolderCount === 0)
      ) &&
      currentState.nextShardIndex < currentState.totalShardCount
    ) {
      if (
        options?.timeBudgetMs != null &&
        shardsProcessedThisRun > 0 &&
        Date.now() - startedAtMs >= options.timeBudgetMs
      ) {
        break;
      }

      const shardIndex = currentState.nextShardIndex;
      const cursor = getTokenHolderSyncShardCursor(shardIndex);
      let balances: Map<string, number> | null = null;
      let lastShardError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          balances = await fetchSolanaTokenHolderBalanceShard(
            rpcUrls,
            mint,
            cursor.programId,
            cursor.ownerPrefix,
            decimals,
          );
          break;
        } catch (err: unknown) {
          lastShardError = err;
          if (attempt === 0) {
            continue;
          }
        }
      }
      if (!balances) {
        throw lastShardError ?? new Error('Failed to fetch token holder shard');
      }
      if (currentState.runId) {
        await dbStageTokenHolderBalanceShard(
          db,
          tokenId,
          currentState.runId,
          shardIndex,
          balances,
        );
        if (balances.size > 0) {
          stagedHolderCount = await dbCountTokenHolderSyncStageHolders(
            db,
            tokenId,
            currentState.runId,
          );
        }
      }
      shardsProcessedThisRun += 1;
      currentState = await dbPutTokenHolderSyncState(db, {
        ...currentState,
        status: 'running',
        source: 'rpc_owner_prefix_shards',
        nextShardIndex: shardIndex + 1,
        processedShardCount: Math.min(
          currentState.totalShardCount,
          shardIndex + 1,
        ),
        stagedHolderCount,
        lastProgramId: cursor.programId,
        lastOwnerPrefix: cursor.ownerPrefix,
        errorMessage: null,
        updatedAt: nowTs(),
      });
    }
  } catch (err: unknown) {
    const stagedHolderCount = currentState.runId
      ? await dbCountTokenHolderSyncStageHolders(
          db,
          tokenId,
          currentState.runId,
        )
      : 0;
    const isRateLimited = isSolanaRpcRateLimitError(err);
    const failedState = await dbPutTokenHolderSyncState(db, {
      ...currentState,
      status: isRateLimited ? 'running' : 'failed',
      stagedHolderCount,
      errorMessage: isRateLimited
        ? 'Holder sync rate limited by the current Solana RPC endpoint. Retry after the endpoint cooldown or add a higher-capacity RPC.'
        : err instanceof Error
          ? err.message
          : String(err),
      updatedAt: nowTs(),
    });
    return buildTokenHolderSyncSummary(failedState, {
      shardsProcessedThisRun,
      stagedHolderCount,
      activeHolderCount: stagedHolderCount,
    });
  }

  stagedHolderCount = currentState.runId
    ? await dbCountTokenHolderSyncStageHolders(
        db,
        tokenId,
        currentState.runId,
      )
    : 0;
  currentState = await dbPutTokenHolderSyncState(db, {
    ...currentState,
    stagedHolderCount,
    updatedAt: nowTs(),
  });

  if (currentState.nextShardIndex >= currentState.totalShardCount) {
    const completedSummary = await dbFinalizePagedTokenHolderSync(
      db,
      userId,
      currentState,
    );
    return buildTokenHolderSyncSummary(null, {
      ...completedSummary,
      shardsProcessedThisRun,
    });
  }

  return buildTokenHolderSyncSummary(currentState, {
    shardsProcessedThisRun,
    stagedHolderCount,
    activeHolderCount: stagedHolderCount,
  });
}

async function syncSolanaTokenHolderBalancesFull(
  db: D1Database,
  userId: number,
  tokenId: number,
  mint: string,
  rpcUrls: string | string[],
): Promise<TokenHolderSyncSummary> {
  const timestamp = nowTs();
  const existingState = await dbGetTokenHolderSyncState(db, tokenId);
  const holderAccountDetailsRpcUrls = buildHolderAccountDetailsRpcUrls(rpcUrls);

  try {
    const decimals = await fetchSolanaMintDecimals(holderAccountDetailsRpcUrls, mint);
    if (decimals == null) {
      const failedState = await dbPutTokenHolderSyncState(db, {
        tokenId,
        runId: existingState?.runId ?? crypto.randomUUID(),
        status: 'failed',
        source: 'rpc_full_sync',
        nextShardIndex: existingState?.nextShardIndex ?? 0,
        processedShardCount: existingState?.processedShardCount ?? 0,
        totalShardCount:
          existingState?.totalShardCount ?? TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
        stagedHolderCount: existingState?.stagedHolderCount ?? 0,
        lastProgramId: existingState?.lastProgramId ?? null,
        lastOwnerPrefix: existingState?.lastOwnerPrefix ?? null,
        errorMessage: 'Failed to resolve token mint decimals for holder sync',
        startedAt: existingState?.startedAt ?? timestamp,
        updatedAt: timestamp,
        lastCompletedAt: existingState?.lastCompletedAt ?? null,
      });
      return buildTokenHolderSyncSummary(failedState);
    }
    const balances = await fetchSolanaTokenHolderBalances(
      holderAccountDetailsRpcUrls,
      mint,
      decimals,
    );
    const { activeHolderCount, upsertedCount, zeroedCount } =
      await dbSyncTokenHolderBalances(db, tokenId, balances, 'rpc_full_sync');

    await dbRecomputeTokenHolderAggregate(db, userId, tokenId, {
      source: 'rpc_full_sync',
      fullSyncAt: timestamp,
    });

    await db
      .prepare('DELETE FROM token_holder_sync_stage WHERE token_id = ?1')
      .bind(tokenId)
      .run();

    const completedState = await dbPutTokenHolderSyncState(db, {
      tokenId,
      runId: existingState?.runId ?? crypto.randomUUID(),
      status: 'completed',
      source: 'rpc_full_sync',
      nextShardIndex: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
      processedShardCount: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
      totalShardCount: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
      stagedHolderCount: activeHolderCount,
      lastProgramId:
        TOKEN_HOLDER_SYNC_PROGRAM_IDS[TOKEN_HOLDER_SYNC_PROGRAM_IDS.length - 1],
      lastOwnerPrefix: TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT - 1,
      errorMessage: null,
      startedAt: existingState?.startedAt ?? timestamp,
      updatedAt: timestamp,
      lastCompletedAt: timestamp,
    });

    return buildTokenHolderSyncSummary(completedState, {
      activeHolderCount,
      stagedHolderCount: activeHolderCount,
      upsertedCount,
      zeroedCount,
      shardsProcessedThisRun: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
    });
  } catch (err: unknown) {
    if (isSolanaRpcRateLimitError(err)) {
      const rateLimitedState = await dbPutTokenHolderSyncState(db, {
        tokenId,
        runId: existingState?.runId ?? crypto.randomUUID(),
        status: 'failed',
        source: 'rpc_full_sync',
        nextShardIndex: existingState?.nextShardIndex ?? 0,
        processedShardCount: existingState?.processedShardCount ?? 0,
        totalShardCount:
          existingState?.totalShardCount ?? TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
        stagedHolderCount: existingState?.stagedHolderCount ?? 0,
        lastProgramId: existingState?.lastProgramId ?? null,
        lastOwnerPrefix: existingState?.lastOwnerPrefix ?? null,
        errorMessage:
          'Holder sync is rate-limited (HTTP 429) on all configured Solana RPC endpoints. Add a higher-capacity RPC endpoint and retry refresh.',
        startedAt: existingState?.startedAt ?? timestamp,
        updatedAt: timestamp,
        lastCompletedAt: existingState?.lastCompletedAt ?? null,
      });
      return buildTokenHolderSyncSummary(rateLimitedState);
    }

    const failedState = await dbPutTokenHolderSyncState(db, {
      tokenId,
      runId: existingState?.runId ?? crypto.randomUUID(),
      status: 'failed',
      source: 'rpc_full_sync',
      nextShardIndex: existingState?.nextShardIndex ?? 0,
      processedShardCount: existingState?.processedShardCount ?? 0,
      totalShardCount: existingState?.totalShardCount ?? TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
      stagedHolderCount: existingState?.stagedHolderCount ?? 0,
      lastProgramId: existingState?.lastProgramId ?? null,
      lastOwnerPrefix: existingState?.lastOwnerPrefix ?? null,
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt: existingState?.startedAt ?? timestamp,
      updatedAt: timestamp,
      lastCompletedAt: existingState?.lastCompletedAt ?? null,
    });

    return buildTokenHolderSyncSummary(failedState);
  }
}

function serializeStrategyVersionContent(
  document: StrategyVersionDocument,
): string {
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    engineVersion: document.engineVersion,
    strategyType: document.strategyType,
    parameters: document.parameters,
    triggers: document.triggers,
    targets: document.targets,
    riskControls: document.riskControls,
    execution: document.execution,
  });
}

function dedupeStrategyVersionsForDisplay(
  versions: StrategyVersionRecord[],
  activeVersion: StrategyVersionRecord | null,
): {
  versions: StrategyVersionRecord[];
  activeVersion: StrategyVersionRecord | null;
} {
  const uniqueByContent = new Map<string, StrategyVersionRecord>();
  for (const version of [...versions].reverse()) {
    const signature = serializeStrategyVersionContent(version.document);
    if (!uniqueByContent.has(signature)) {
      uniqueByContent.set(signature, version);
    }
  }

  const dedupedVersions = [...uniqueByContent.values()].sort(
    (left, right) => right.versionNo - left.versionNo || right.id - left.id,
  );

  if (!activeVersion) {
    return { versions: dedupedVersions, activeVersion: null };
  }

  const activeSignature = serializeStrategyVersionContent(activeVersion.document);
  return {
    versions: dedupedVersions,
    activeVersion:
      dedupedVersions.find(
        (version) =>
          serializeStrategyVersionContent(version.document) === activeSignature,
      ) ?? activeVersion,
  };
}

function isManualStrategyVersionDocument(
  document: StrategyVersionDocument,
): boolean {
  return document.metadata.origin === 'manual';
}

async function dbApplyTokenHolderTransactionDelta(
  db: D1Database,
  userId: number,
  tokenId: number,
  txSignature: string,
  details: StoredSignalTransactionDetails,
): Promise<boolean> {
  await dbEnsureTradeDomainSchema(db);
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
  await dbEnsureTradeDomainSchema(db);
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
  await dbEnsureTradeDomainSchema(db);
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

async function reconcileWebhookTransactionDetailsInWindow(
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
  const groups = await dbListSignalGroupsForTokenWindow(
    db,
    userId,
    contractAddress,
    startTimeMs,
    endTimeMs,
  );

  const groupsToReconcile = groups.filter((group) => group.txSignature);
  let enrichedTransactions = 0;

  for (const group of groupsToReconcile) {
    const rpcDetails = await fetchSolanaWebhookTransactionDetailsFromRpc(
      rpcUrls,
      group.txSignature!,
      contractAddress,
      group.mergedDetails,
    );
    const mergedDetails = mergeStoredSignalTransactionDetails(
      group.mergedDetails,
      rpcDetails,
    );
    const preferredWalletAddress = await dbResolvePreferredSignalWalletAddress(
      db,
      userId,
      [
        mergedDetails.primaryWalletAddress,
        mergedDetails.fromWalletAddress,
        mergedDetails.toWalletAddress,
      ],
      group.rows[0]?.wallet_address ?? null,
    );
    mergedDetails.primaryWalletAddress = preferredWalletAddress;
    await dbUpdateSignalsByTxSignatureForUser(
      db,
      userId,
      group.txSignature!,
      preferredWalletAddress,
      mergedDetails,
    );
    const detailsChanged =
      JSON.stringify(group.mergedDetails) !== JSON.stringify(mergedDetails) ||
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
  await dbEnsureTradeDomainSchema(db);
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

async function reconcileTokenTransactionsFromRpc(
  db: D1Database,
  userId: number,
  contractAddress: string,
  rpcUrls: string | string[],
  options?: {
    perAddressLimit?: number;
    additionalAddresses?: Array<string | null | undefined>;
    startTimeMs?: number | null;
    endTimeMs?: number | null;
  },
): Promise<{
  scannedSignatures: number;
  insertedSignals: number;
  duplicates: number;
  skippedIrrelevant: number;
}> {
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

  if (candidateAddresses.length === 0) {
    return {
      scannedSignatures: 0,
      insertedSignals: 0,
      duplicates: 0,
      skippedIrrelevant: 0,
    };
  }

  const signaturePool = new Map<string, { address: string; blockTimeMs: number | null }>();
  for (const address of candidateAddresses) {
    try {
      const signatures = await fetchSolanaSignaturesForAddressInWindow(
        rpcUrls,
        address,
        {
          pageSize: perAddressLimit,
          maxPages: 10,
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

  let insertedSignals = 0;
  let duplicates = 0;
  let skippedIrrelevant = 0;

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

    const rpcDetails = await fetchSolanaWebhookTransactionDetailsFromRpc(
      rpcUrls,
      txSignature,
      contractAddress,
      {
        primaryWalletAddress: signatureMeta.address,
      },
    );

    const mergedDetails = mergeStoredSignalTransactionDetails(
      {
        tokenContractAddress: contractAddress,
        primaryWalletAddress: signatureMeta.address,
        source: 'rpc_reconcile',
        transactionStatus: 'PENDING',
        detailSource: 'unknown',
      },
      rpcDetails,
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
      signatureMeta.address,
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
        walletAddress: signatureMeta.address,
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

async function dbCreateTradeLog(
  db: D1Database,
  input: TradeLogCreateRequest,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
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

async function dbCreateSignal(
  db: D1Database,
  input: SignalCreateRequest,
): Promise<{ signal: SignalRecord; inserted: boolean }> {
  await dbEnsureTradeDomainSchema(db);
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

async function dbClaimSignalProcessing(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<boolean> {
  await dbEnsureTradeDomainSchema(db);
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

async function dbResolvePreferredSignalWalletAddress(
  db: D1Database,
  userId: number,
  candidates: Array<string | null | undefined>,
  fallbackWalletAddress: string | null,
): Promise<string | null> {
  const normalizedCandidates = uniqueSolanaPubkeys(candidates);
  if (normalizedCandidates.length === 0) {
    return fallbackWalletAddress;
  }

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
  return fallbackWalletAddress ?? normalizedCandidates[0] ?? null;
}

async function dbUpdateSignalTransactionDetails(
  db: D1Database,
  source: string,
  externalId: string,
  walletAddress: string | null,
  details: StoredSignalTransactionDetails,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
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

async function fetchSolanaWebhookTransactionDetailsFromRpc(
  rpcUrls: string | string[],
  txSignature: string,
  trackedContractAddress: string,
  payloadDetails: Partial<StoredSignalTransactionDetails>,
): Promise<Partial<StoredSignalTransactionDetails>> {
  try {
    const solPriceUsd =
      (await fetchJupiterTokenPrice(SOLANA_WRAPPED_SOL_MINT)) ??
      (await fetchJupiterPriceViaQuote(SOLANA_WRAPPED_SOL_MINT, 9));
    const transaction = await solanaRpc<{
      meta?: {
        err?: unknown;
        fee?: number;
        preTokenBalances?: Array<{
          owner?: string;
          mint?: string;
          uiTokenAmount?: {
            uiAmountString?: string;
            amount?: string;
            decimals?: number;
          };
        }>;
        postTokenBalances?: Array<{
          owner?: string;
          mint?: string;
          uiTokenAmount?: {
            uiAmountString?: string;
            amount?: string;
            decimals?: number;
          };
        }>;
      };
    }>(rpcUrls, 'getTransaction', [
      txSignature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);

    const deltaByOwner = new Map<string, { tracked: number; usdc: number }>();
    const applyTokenBalances = (
      balances:
        | Array<{
            owner?: string;
            mint?: string;
            uiTokenAmount?: {
              uiAmountString?: string;
              amount?: string;
              decimals?: number;
            };
          }>
        | undefined,
      sign: -1 | 1,
    ) => {
      for (const balance of balances ?? []) {
        const owner = tryNormalizeSolanaPubkey(balance.owner);
        const mint = tryNormalizeSolanaPubkey(balance.mint);
        if (!owner || !mint) {
          continue;
        }
        const uiAmount =
          balance.uiTokenAmount?.uiAmountString != null
            ? Number.parseFloat(balance.uiTokenAmount.uiAmountString)
            : typeof balance.uiTokenAmount?.amount === 'string' && typeof balance.uiTokenAmount?.decimals === 'number'
              ? Number.parseFloat(balance.uiTokenAmount.amount) / 10 ** balance.uiTokenAmount.decimals
              : null;
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

    applyTokenBalances(transaction.meta?.preTokenBalances, -1);
    applyTokenBalances(transaction.meta?.postTokenBalances, 1);

    // For a WLT/USDC pair the trade direction is unambiguous from the monitored
    // wallet's tracked-token balance change: received tracked token => BUY, sent
    // tracked token => SELL. We deliberately do NOT require a matching USDC delta
    // on the same owner, because routers/aggregators can settle the USDC leg
    // through a different account, which previously left action = null and let an
    // incorrect webhook payload label (e.g. SELL) stick.
    const traderCandidates = uniqueSolanaPubkeys([
      payloadDetails.primaryWalletAddress,
      payloadDetails.toWalletAddress,
      payloadDetails.fromWalletAddress,
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

    // Fallback: if no monitored wallet moved the tracked token, use the single
    // wallet whose tracked and USDC balances moved in opposite directions (a
    // genuine swap counterparty). Left null when ambiguous so we never overwrite
    // an already-correct record with a guess.
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

    const action: 'BUY' | 'SELL' | null =
      focusDelta && focusDelta.tracked > 0
        ? 'BUY'
        : focusDelta && focusDelta.tracked < 0
          ? 'SELL'
          : null;

    const trackedPositiveWallets = [...deltaByOwner.entries()]
      .filter(([, delta]) => delta.tracked > 0)
      .map(([wallet]) => wallet);
    const trackedNegativeWallets = [...deltaByOwner.entries()]
      .filter(([, delta]) => delta.tracked < 0)
      .map(([wallet]) => wallet);

    const fromWalletAddress =
      (action === 'SELL' ? focusWallet : null) ??
      payloadDetails.fromWalletAddress ??
      trackedNegativeWallets[0] ??
      null;
    const toWalletAddress =
      (action === 'BUY' ? focusWallet : null) ??
      payloadDetails.toWalletAddress ??
      trackedPositiveWallets[0] ??
      null;

    return {
      tokenContractAddress: trackedContractAddress,
      fromWalletAddress,
      toWalletAddress,
      primaryWalletAddress:
        focusWallet ??
        payloadDetails.primaryWalletAddress ??
        toWalletAddress ??
        fromWalletAddress ??
        null,
      action,
      usdcAmount: focusDelta && focusDelta.usdc !== 0 ? Math.abs(focusDelta.usdc) : null,
      tokenAmount: focusDelta && focusDelta.tracked !== 0 ? Math.abs(focusDelta.tracked) : null,
      source: 'rpc_reconcile',
      transactionStatus: transaction.meta?.err ? 'FAILED' : 'CONFIRMED',
      detailSource: 'rpc',
      feeAmountUsd:
        typeof transaction.meta?.fee === 'number' && solPriceUsd != null
          ? (transaction.meta.fee / 1_000_000_000) * solPriceUsd
          : null,
    };
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

async function dbMarkSignalProcessed(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
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

async function dbMarkSignalFailed(
  db: D1Database,
  source: string,
  externalId: string,
  errorMessage: string,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
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

async function dbCreateHistoricalSetupSnapshot(
  db: D1Database,
  userId: number,
  settings: SettingsState,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  const tokenId = settings.contractAddress.trim()
    ? await dbResolveTradableTokenId(db, settings.contractAddress)
    : null;
  await db
    .prepare(
      `INSERT INTO historic_setups (
        user_id,
        token_id,
        time_range_target,
        max_transactions,
        max_slippage,
        volume_target,
        net_buyin_target,
        volatility_target,
        pullback_target,
        contract_address,
        metadata,
        created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      userId,
      tokenId,
      settings.timeRangeTarget,
      settings.maxTransactions,
      settings.maxSlippage,
      settings.volumeTarget,
      settings.netBuyinTarget,
      settings.volatilityTarget,
      settings.pullbackTarget,
      settings.contractAddress.trim() || null,
      JSON.stringify({ managedKeyCount: settings.managedKeyCount }),
      nowTs(),
    )
    .run();
}

async function dbGetLatestHistoricalSetupId(
  db: D1Database,
  userId: number,
): Promise<number | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      'SELECT id FROM historic_setups WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .bind(userId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function dbComputeManagedProfitUsdc(
  db: D1Database,
  userId: number,
  contractAddress: string,
  currentPriceUsd: number | null,
): Promise<number> {
  await dbEnsureTradeDomainSchema(db);
  const tokenId = await dbResolveTradableTokenId(db, contractAddress);
  if (!tokenId) {
    return 0;
  }

  const rows = await db
    .prepare(
      `SELECT p.quantity, p.avg_cost, p.realized_pnl
       FROM positions p
       INNER JOIN accounts a ON a.wallet_address = p.wallet_address
       WHERE a.user_id = ?1 AND a.type = 'managed' AND p.token_id = ?2`,
    )
    .bind(userId, tokenId)
    .all<{
      quantity: number;
      avg_cost: number;
      realized_pnl: number;
    }>();

  let profitUsdc = 0;
  for (const row of rows.results) {
    profitUsdc += row.realized_pnl ?? 0;
    if (currentPriceUsd != null) {
      profitUsdc += (currentPriceUsd - (row.avg_cost ?? 0)) * (row.quantity ?? 0);
    }
  }
  return profitUsdc;
}

async function dbListHistoricalSetups(
  db: D1Database,
  userId: number,
): Promise<HistoricalSetupRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `SELECT
         hs.id,
         hs.contract_address,
         hs.time_range_target,
         hs.max_transactions,
         hs.max_slippage,
         hs.volume_target,
         hs.net_buyin_target,
         hs.volatility_target,
         hs.pullback_target,
         hs.created_at,
         tt.symbol AS token_symbol
       FROM historic_setups hs
       LEFT JOIN tradable_tokens tt ON tt.id = hs.token_id
       WHERE hs.user_id = ?1
       ORDER BY hs.created_at DESC, hs.id DESC
       LIMIT 20`,
    )
    .bind(userId)
    .all<{
      id: number;
      contract_address: string | null;
      time_range_target: string;
      max_transactions: number;
      max_slippage: number;
      volume_target: number;
      net_buyin_target: number;
      volatility_target: number;
      pullback_target: number;
      created_at: number;
      token_symbol: string | null;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    tokenSymbol: row.token_symbol,
    contractAddress: row.contract_address,
    timeRangeTarget: row.time_range_target,
    maxTransactions: row.max_transactions,
    maxSlippage: row.max_slippage,
    volumeTarget: row.volume_target,
    netBuyinTarget: row.net_buyin_target,
    volatilityTarget: row.volatility_target,
    pullbackTarget: row.pullback_target,
    createdAt: row.created_at,
  }));
}

function mapTokenMarketSnapshotToStrategySnapshot(
  snapshot: TokenMarketSnapshot | null,
): StrategyMarketSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return {
    contractAddress: snapshot.contractAddress,
    priceUsd: snapshot.priceUsd,
    liquidityUsd: snapshot.liquidityUsd,
    fdv: snapshot.fdv,
    volume24h: snapshot.volume24h,
    totalTransactions24h: snapshot.totalTransactions24h,
    outsidersOverOneUsd: snapshot.outsidersOverOneUsd,
    fetchedAt: snapshot.fetchedAt,
  };
}

function mapStrategyDefinitionRow(row: {
  id: number;
  user_id: number;
  name: string;
  strategy_type: string;
  current_version_id: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}): StrategyDefinitionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    strategyType: row.strategy_type as StrategyDefinitionRecord['strategyType'],
    currentVersionId: row.current_version_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStrategyVersionRow(row: {
  id: number;
  strategy_id: number;
  version_no: number;
  schema_version: number;
  engine_version: string;
  strategy_type: string;
  status: string;
  params_json: string;
  triggers_json: string;
  targets_json: string;
  risk_json: string;
  execution_json: string;
  metadata_json: string;
  checksum: string;
  change_note: string | null;
  created_at: number;
  activated_at: number | null;
}): StrategyVersionRecord {
  const document: StrategyVersionDocument = normalizeStrategyDocument({
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    strategyType: row.strategy_type,
    parameters: parseJsonText(row.params_json),
    triggers: parseJsonText(row.triggers_json),
    targets: parseJsonText(row.targets_json),
    riskControls: parseJsonText(row.risk_json),
    execution: parseJsonText(row.execution_json),
    metadata: parseJsonText(row.metadata_json),
  });

  return {
    id: row.id,
    strategyId: row.strategy_id,
    versionNo: row.version_no,
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    strategyType: row.strategy_type as StrategyVersionRecord['strategyType'],
    status: row.status as StrategyVersionRecord['status'],
    checksum: row.checksum,
    changeNote: row.change_note,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    document,
  };
}

function mapStrategyEvaluationRow(row: {
  id: number;
  user_id: number;
  strategy_version_id: number;
  version_no: number;
  source: string;
  event_type: string;
  external_id: string | null;
  contract_address: string;
  wallet_address: string | null;
  tx_signature: string | null;
  status: string;
  should_execute: number;
  dry_run: number;
  summary_json: string;
  created_at: number;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    strategyVersionId: row.strategy_version_id,
    strategyVersionNo: row.version_no,
    source: row.source,
    eventType: row.event_type,
    externalId: row.external_id,
    contractAddress: row.contract_address,
    walletAddress: row.wallet_address,
    txSignature: row.tx_signature,
    status: row.status,
    shouldExecute: row.should_execute === 1,
    dryRun: row.dry_run === 1,
    summary: parseJsonText<Record<string, unknown>>(row.summary_json),
    createdAt: row.created_at,
  };
}

async function dbGetOrCreatePrimaryStrategyDefinition(
  db: D1Database,
  userId: number,
): Promise<StrategyDefinitionRecord> {
  await dbEnsureTradeDomainSchema(db);
  const existing = await db
    .prepare(
      `SELECT
         id,
         user_id,
         name,
         strategy_type,
         current_version_id,
         status,
         created_at,
         updated_at
       FROM strategy_definitions
       WHERE user_id = ?1 AND strategy_type = ?2
       LIMIT 1`,
    )
    .bind(userId, DEFAULT_STRATEGY_TYPE)
    .first<{
      id: number;
      user_id: number;
      name: string;
      strategy_type: string;
      current_version_id: number | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>();
  if (existing) {
    return mapStrategyDefinitionRow(existing);
  }

  const createdAt = nowTs();
  await db
    .prepare(
      `INSERT INTO strategy_definitions (
         user_id,
         name,
         strategy_type,
         current_version_id,
         status,
         created_at,
         updated_at
       ) VALUES (?1, ?2, ?3, NULL, 'active', ?4, ?4)`,
    )
    .bind(userId, PRIMARY_STRATEGY_NAME, DEFAULT_STRATEGY_TYPE, createdAt)
    .run();

  const created = await db
    .prepare(
      `SELECT
         id,
         user_id,
         name,
         strategy_type,
         current_version_id,
         status,
         created_at,
         updated_at
       FROM strategy_definitions
       WHERE user_id = ?1 AND strategy_type = ?2
       LIMIT 1`,
    )
    .bind(userId, DEFAULT_STRATEGY_TYPE)
    .first<{
      id: number;
      user_id: number;
      name: string;
      strategy_type: string;
      current_version_id: number | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>();
  if (!created) {
    throw new ApiError(500, 'Failed to create primary strategy definition');
  }
  return mapStrategyDefinitionRow(created);
}

async function dbGetStrategyVersionById(
  db: D1Database,
  versionId: number,
): Promise<StrategyVersionRecord | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `SELECT
         id,
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       FROM strategy_versions
       WHERE id = ?1
       LIMIT 1`,
    )
    .bind(versionId)
    .first<{
      id: number;
      strategy_id: number;
      version_no: number;
      schema_version: number;
      engine_version: string;
      strategy_type: string;
      status: string;
      params_json: string;
      triggers_json: string;
      targets_json: string;
      risk_json: string;
      execution_json: string;
      metadata_json: string;
      checksum: string;
      change_note: string | null;
      created_at: number;
      activated_at: number | null;
    }>();
  return row ? mapStrategyVersionRow(row) : null;
}

async function dbGetActiveStrategyVersion(
  db: D1Database,
  userId: number,
): Promise<StrategyVersionRecord | null> {
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  if (definition.currentVersionId == null) {
    return null;
  }
  return dbGetStrategyVersionById(db, definition.currentVersionId);
}

function mapStrategyDocumentToSettingsUpdate(
  document: StrategyVersionDocument,
): SettingsUpdateRequest {
  return {
    contractAddress: document.parameters.contractAddress,
    volatilityTarget: document.targets.volatilityPctMin,
    pullbackTarget: document.targets.pullbackPctMax,
    volumeTarget: document.targets.volumeUsdMin,
    netBuyinTarget: document.targets.netBuyinUsdMin,
    timeRangeTarget: document.parameters.timeRangeTarget,
    maxTransactions: document.parameters.maxTransactions,
    maxSlippage: document.parameters.maxSlippageBps / 100,
    strategyNotes: document.parameters.notes,
  };
}

async function dbSaveActiveStrategyVersionDocument(
  db: D1Database,
  userId: number,
  documentInput: StrategyVersionDocument,
  options?: {
    changeNote?: string;
  },
): Promise<{ version: StrategyVersionRecord; created: boolean }> {
  await dbEnsureTradeDomainSchema(db);
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  const document = normalizeStrategyDocument(documentInput);
  const checksum = await sha256Hex(serializeStrategyVersionContent(document));
  const currentVersion = definition.currentVersionId
    ? await dbGetStrategyVersionById(db, definition.currentVersionId)
    : null;
  const currentVersionChecksum = currentVersion
    ? await sha256Hex(serializeStrategyVersionContent(currentVersion.document))
    : null;

  if (currentVersion && currentVersionChecksum === checksum) {
    return { version: currentVersion, created: false };
  }

  const nextVersionNo =
    ((await db
      .prepare(
        'SELECT MAX(version_no) AS max_version_no FROM strategy_versions WHERE strategy_id = ?1',
      )
      .bind(definition.id)
      .first<{ max_version_no: number | null }>())?.max_version_no ?? 0) + 1;
  const createdAt = nowTs();

  await db
    .prepare(
      `INSERT INTO strategy_versions (
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
    )
    .bind(
      definition.id,
      nextVersionNo,
      document.schemaVersion,
      document.engineVersion,
      document.strategyType,
      JSON.stringify(document.parameters),
      JSON.stringify(document.triggers),
      JSON.stringify(document.targets),
      JSON.stringify(document.riskControls),
      JSON.stringify(document.execution),
      JSON.stringify(document.metadata),
      checksum,
      options?.changeNote ?? document.metadata.changeNote,
      createdAt,
    )
    .run();

  const inserted = await db
    .prepare(
      `SELECT
         id,
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       FROM strategy_versions
       WHERE strategy_id = ?1 AND version_no = ?2
       LIMIT 1`,
    )
    .bind(definition.id, nextVersionNo)
    .first<{
      id: number;
      strategy_id: number;
      version_no: number;
      schema_version: number;
      engine_version: string;
      strategy_type: string;
      status: string;
      params_json: string;
      triggers_json: string;
      targets_json: string;
      risk_json: string;
      execution_json: string;
      metadata_json: string;
      checksum: string;
      change_note: string | null;
      created_at: number;
      activated_at: number | null;
    }>();
  if (!inserted) {
    throw new ApiError(500, 'Failed to load inserted strategy version');
  }

  if (currentVersion) {
    await db
      .prepare("UPDATE strategy_versions SET status = 'published' WHERE id = ?1")
      .bind(currentVersion.id)
      .run();
  }

  await db
    .prepare(
      'UPDATE strategy_definitions SET current_version_id = ?2, updated_at = ?3 WHERE id = ?1',
    )
    .bind(definition.id, inserted.id, createdAt)
    .run();

  return {
    version: mapStrategyVersionRow(inserted),
    created: true,
  };
}

async function dbListStrategyVersions(
  db: D1Database,
  userId: number,
  limit = 25,
): Promise<StrategyVersionRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  const fetchLimit = Math.max(limit * 10, 250);
  const rows = await db
    .prepare(
      `SELECT
         id,
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       FROM strategy_versions
       WHERE strategy_id = ?1
       ORDER BY version_no DESC, id DESC
       LIMIT ?2`,
    )
     .bind(definition.id, fetchLimit)
    .all<{
      id: number;
      strategy_id: number;
      version_no: number;
      schema_version: number;
      engine_version: string;
      strategy_type: string;
      status: string;
      params_json: string;
      triggers_json: string;
      targets_json: string;
      risk_json: string;
      execution_json: string;
      metadata_json: string;
      checksum: string;
      change_note: string | null;
      created_at: number;
      activated_at: number | null;
    }>();
  return rows.results.map(mapStrategyVersionRow).slice(0, fetchLimit);
}

async function dbDeletePreviousStrategyVersions(
  db: D1Database,
  userId: number,
): Promise<{
  deletedVersions: number;
  deletedEvaluations: number;
  keptVersion: StrategyVersionRecord | null;
}> {
  await dbEnsureTradeDomainSchema(db);
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  const rows = await db
    .prepare(
      `SELECT
         id,
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       FROM strategy_versions
       WHERE strategy_id = ?1
       ORDER BY version_no DESC, id DESC`,
    )
    .bind(definition.id)
    .all<{
      id: number;
      strategy_id: number;
      version_no: number;
      schema_version: number;
      engine_version: string;
      strategy_type: string;
      status: string;
      params_json: string;
      triggers_json: string;
      targets_json: string;
      risk_json: string;
      execution_json: string;
      metadata_json: string;
      checksum: string;
      change_note: string | null;
      created_at: number;
      activated_at: number | null;
    }>();

  const versions = rows.results.map(mapStrategyVersionRow);
  const manualVersions = versions.filter((version) =>
    isManualStrategyVersionDocument(version.document),
  );
  const deletedVersionsList = versions.filter(
    (version) => !isManualStrategyVersionDocument(version.document),
  );

  if (versions.length === 0) {
    return {
      deletedVersions: 0,
      deletedEvaluations: 0,
      keptVersion: null,
    };
  }

  const keepVersion = manualVersions.find(
    (version) => version.id === definition.currentVersionId,
  ) ?? manualVersions[0] ?? null;

  if (deletedVersionsList.length === 0) {
    const updatedAt = nowTs();
    if (keepVersion) {
      await db.batch(
        manualVersions.map((version) =>
          db
            .prepare(
              `UPDATE strategy_versions
               SET status = ?2,
                   activated_at = CASE
                     WHEN id = ?1 THEN COALESCE(activated_at, ?3)
                     ELSE activated_at
                   END
               WHERE id = ?1`,
            )
            .bind(
              version.id,
              version.id === keepVersion.id ? 'active' : 'published',
              updatedAt,
            ),
        ),
      );
      await db
        .prepare(
          'UPDATE strategy_definitions SET current_version_id = ?2, updated_at = ?3 WHERE id = ?1',
        )
        .bind(definition.id, keepVersion.id, updatedAt)
        .run();
    } else {
      await db
        .prepare(
          'UPDATE strategy_definitions SET current_version_id = NULL, updated_at = ?2 WHERE id = ?1',
        )
        .bind(definition.id, updatedAt)
        .run();
    }
    return {
      deletedVersions: 0,
      deletedEvaluations: 0,
      keptVersion: keepVersion,
    };
  }

  let deletedEvaluations = 0;
  for (const version of deletedVersionsList) {
    deletedEvaluations +=
      (
        await db
          .prepare(
            'SELECT COUNT(*) AS count FROM strategy_evaluations WHERE strategy_version_id = ?1',
          )
          .bind(version.id)
          .first<{ count: number }>()
      )?.count ?? 0;
  }

  if (deletedVersionsList.length > 0) {
    await db.batch(
      deletedVersionsList.map((version) =>
        db
          .prepare('DELETE FROM strategy_versions WHERE id = ?1')
          .bind(version.id),
      ),
    );
  }

  const updatedAt = nowTs();
  if (manualVersions.length > 0 && keepVersion) {
    await db.batch(
      manualVersions.map((version) =>
        db
          .prepare(
            `UPDATE strategy_versions
             SET status = ?2,
                 activated_at = CASE
                   WHEN id = ?1 THEN COALESCE(activated_at, ?3)
                   ELSE activated_at
                 END
             WHERE id = ?1`,
          )
          .bind(
            version.id,
            version.id === keepVersion.id ? 'active' : 'published',
            updatedAt,
          ),
      ),
    );
    await db
      .prepare(
        'UPDATE strategy_definitions SET current_version_id = ?2, updated_at = ?3 WHERE id = ?1',
      )
      .bind(definition.id, keepVersion.id, updatedAt)
      .run();
  } else {
    await db
      .prepare(
        'UPDATE strategy_definitions SET current_version_id = NULL, updated_at = ?2 WHERE id = ?1',
      )
      .bind(definition.id, updatedAt)
      .run();
  }

  return {
    deletedVersions: deletedVersionsList.length,
    deletedEvaluations,
    keptVersion: keepVersion,
  };
}

async function dbListStrategyEvaluations(
  db: D1Database,
  userId: number,
  limit = 50,
): Promise<Array<{
  id: number;
  userId: number;
  strategyVersionId: number;
  strategyVersionNo: number;
  source: string;
  eventType: string;
  externalId: string | null;
  contractAddress: string;
  walletAddress: string | null;
  txSignature: string | null;
  status: string;
  shouldExecute: boolean;
  dryRun: boolean;
  summary: Record<string, unknown>;
  createdAt: number;
}>> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `SELECT
         se.id,
         se.user_id,
         se.strategy_version_id,
         sv.version_no,
         se.source,
         se.event_type,
         se.external_id,
         se.contract_address,
         se.wallet_address,
         se.tx_signature,
         se.status,
         se.should_execute,
         se.dry_run,
         se.summary_json,
         se.created_at
       FROM strategy_evaluations se
       INNER JOIN strategy_versions sv ON sv.id = se.strategy_version_id
       WHERE se.user_id = ?1
       ORDER BY se.created_at DESC, se.id DESC
       LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<{
      id: number;
      user_id: number;
      strategy_version_id: number;
      version_no: number;
      source: string;
      event_type: string;
      external_id: string | null;
      contract_address: string;
      wallet_address: string | null;
      tx_signature: string | null;
      status: string;
      should_execute: number;
      dry_run: number;
      summary_json: string;
      created_at: number;
    }>();
  return rows.results.map(mapStrategyEvaluationRow);
}

async function dbSyncActiveStrategyVersionFromSettings(
  db: D1Database,
  userId: number,
  settings: StrategySettingsInput,
  options?: {
    author?: string | null;
    changeNote?: string;
    origin?: 'settings-sync' | 'manual' | 'migration';
  },
): Promise<{ version: StrategyVersionRecord; created: boolean }> {
  const document = buildStrategyDocumentFromSettings(settings, {
    author: options?.author ?? null,
    changeNote: options?.changeNote,
    origin: options?.origin,
  });
  return dbSaveActiveStrategyVersionDocument(db, userId, document, {
    changeNote: options?.changeNote,
  });
}

async function dbCreateStrategyEvaluation(
  db: D1Database,
  userId: number,
  strategyVersionId: number,
  trigger: StrategyTriggerEvent,
  runtime: StrategyRuntimeResult,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  const createdAt = nowTs();
  await db
    .prepare(
      `INSERT INTO strategy_evaluations (
         user_id,
         strategy_version_id,
         source,
         event_type,
         external_id,
         contract_address,
         wallet_address,
         tx_signature,
         status,
         should_execute,
         dry_run,
         summary_json,
         created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      userId,
      strategyVersionId,
      trigger.source,
      trigger.eventType,
      trigger.externalId,
      trigger.contractAddress,
      trigger.walletAddress,
      trigger.txSignature,
      runtime.evaluation.status,
      runtime.evaluation.shouldExecute ? 1 : 0,
      runtime.evaluation.dryRun ? 1 : 0,
      JSON.stringify(runtime.summary),
      createdAt,
    )
    .run();
}

async function runAndPersistStrategyEvaluation(
  db: D1Database,
  userId: number,
  settings: StrategySettingsInput,
  trigger: StrategyTriggerEvent,
  marketSnapshot: TokenMarketSnapshot | null,
  options?: {
    author?: string | null;
    changeNote?: string;
    origin?: 'settings-sync' | 'manual' | 'migration';
  },
): Promise<{ version: StrategyVersionRecord; runtime: StrategyRuntimeResult } | null> {
  void settings;
  void options;
  const version = await dbGetActiveStrategyVersion(db, userId);
  if (!version) {
    return null;
  }
  const runtime = runStrategyRuntime({
    strategyDocument: version.document,
    trigger,
    marketSnapshot: mapTokenMarketSnapshotToStrategySnapshot(marketSnapshot),
  });
  await dbCreateStrategyEvaluation(db, userId, version.id, trigger, runtime);
  return { version, runtime };
}

async function dbUserOwnsAccount(
  db: D1Database,
  userId: number,
  address: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT id FROM accounts WHERE user_id = ?1 AND wallet_address = ?2 LIMIT 1',
    )
    .bind(userId, address)
    .first<{ id: number }>();
  return !!row;
}

// ─── Jupiter token API ────────────────────────────────────────────────────────

// ─── Solana transaction signing ───────────────────────────────────────────────

/**
 * Parse a compact-u16 integer from a byte array at a given offset.
 * Returns [value, number of bytes consumed].
 */
function readCompactU16(bytes: Uint8Array, offset: number): [number, number] {
  let val = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < bytes.length) {
    const byte = bytes[offset + bytesRead];
    bytesRead += 1;
    val |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [val, bytesRead];
}

/**
 * Sign a Solana (legacy or v0) serialized transaction with the given 64-byte
 * Solana keypair. The first signature slot is replaced with the real signature.
 * The keypair must be the primary signer (index 0).
 */
function signSolanaTransaction(txBytes: Uint8Array, signerKeypair: Uint8Array): Uint8Array {
  const [sigCount, sigCountLen] = readCompactU16(txBytes, 0);
  if (sigCount === 0) throw new Error('Transaction has no signature slots');
  const messageOffset = sigCountLen + sigCount * 64;
  const messageBytes = txBytes.slice(messageOffset);
  // nacl.sign.detached takes the 64-byte secretKey
  const signature = nacl.sign.detached(messageBytes, signerKeypair);
  const signed = new Uint8Array(txBytes);
  // Replace the first 64-byte signature slot
  signed.set(signature, sigCountLen);
  return signed;
}

async function sendSolanaTransaction(
  rpcUrls: string | string[],
  signedTxBytes: Uint8Array,
): Promise<string> {
  let binary = '';
  signedTxBytes.forEach((b) => (binary += String.fromCharCode(b)));
  const base64Tx = btoa(binary);
  const signature = await solanaRpc<string>(rpcUrls, 'sendTransaction', [
    base64Tx,
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  return signature;
}


async function fetchSolanaOutsiderHolderCountOverOneUsd(
  rpcUrls: string | string[],
  mint: string,
  managedAccountAddresses: string[],
  priceUsd: number | null,
): Promise<number | null> {
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return null;
  }

  const filters = [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }];
  const managedSet = new Set(
    managedAccountAddresses.map((address) => normalizePubkey(address)),
  );
  const programResults = await Promise.allSettled(
    [SOLANA_SPL_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID].map((programId) =>
      solanaRpc<
        Array<{
          account: {
            data: {
              parsed?: {
                info?: {
                  owner?: string;
                  tokenAmount?: {
                    amount?: string;
                    decimals?: number;
                  };
                };
              };
            };
          };
        }>
      >(rpcUrls, 'getProgramAccounts', [
        programId,
        { filters, encoding: 'jsonParsed' },
      ]),
    ),
  );

  let decimals: number | null = null;
  let successfulQueryCount = 0;
  const holderBalances = new Map<string, bigint>();

  for (const programResult of programResults) {
    if (programResult.status !== 'fulfilled') {
      continue;
    }
    successfulQueryCount += 1;
    for (const account of programResult.value) {
      const owner = account.account.data.parsed?.info?.owner;
      const tokenAmount = account.account.data.parsed?.info?.tokenAmount;
      if (!owner || !tokenAmount?.amount) {
        continue;
      }

      const normalizedOwner = normalizePubkey(owner);
      if (managedSet.has(normalizedOwner)) {
        continue;
      }

      holderBalances.set(
        normalizedOwner,
        (holderBalances.get(normalizedOwner) ?? 0n) + BigInt(tokenAmount.amount),
      );
      if (typeof tokenAmount.decimals === 'number') {
        decimals = tokenAmount.decimals;
      }
    }
  }

  if (successfulQueryCount === 0) {
    const rejectedResult = programResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    throw rejectedResult?.reason instanceof Error
      ? rejectedResult.reason
      : new ApiError(502, 'Failed to load token holder accounts from Solana RPC');
  }

  if (decimals == null) {
    decimals = await fetchSolanaMintDecimals(rpcUrls, mint);
  }
  if (decimals == null) {
    return null;
  }

  let outsiderCount = 0;
  for (const rawAmount of holderBalances.values()) {
    const tokenAmount = Number.parseFloat(formatTokenAmount(rawAmount, decimals));
    if (Number.isFinite(tokenAmount) && tokenAmount * priceUsd > 1) {
      outsiderCount += 1;
    }
  }

  return outsiderCount;
}

async function syncTokenMarketSnapshotForUser(
  db: D1Database,
  userId: number,
  network: string,
  contractAddress: string,
  rpcUrls: string | string[],
  options?: {
    force?: boolean;
    managedAccountAddresses?: string[];
    fallbackToStoredOnError?: boolean;
  },
): Promise<TokenMarketSnapshot | null> {
  const normalizedNetwork = network.trim().toLowerCase();
  if (normalizedNetwork !== 'solana') {
    return null;
  }

  const normalizedAddress = normalizePubkey(contractAddress);
  const cacheKey = tokenMarketCacheKey(normalizedNetwork, normalizedAddress);
  const tokenId = await dbResolveTradableTokenId(db, normalizedAddress);
  const latestStoredSnapshot = tokenId
    ? await dbGetLatestTokenMarketSnapshot(db, tokenId)
    : null;

  if (!options?.force) {
    const cachedSnapshot = readTokenMarketCache(cacheKey);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    const latestSnapshotAgeMs = latestStoredSnapshot
      ? nowMs() - latestStoredSnapshot.fetchedAt
      : null;
    if (
      latestStoredSnapshot &&
      latestSnapshotAgeMs != null &&
      latestSnapshotAgeMs <= TOKEN_MARKET_CACHE_TTL_MS
    ) {
      writeTokenMarketCache(cacheKey, latestStoredSnapshot);
      return latestStoredSnapshot;
    }
  }

  // Look up stored decimals for the quote-based price fallback
  const storedDecimals: number | null = tokenId
    ? ((await db
        .prepare('SELECT decimals FROM tradable_tokens WHERE id = ?1')
        .bind(tokenId)
        .first<{ decimals: number | null }>())?.decimals ?? null)
    : null;

  // Fetch metadata from Jupiter lite API (includes price, FDV, liquidity, holders)
  let liveSnapshot: TokenMarketSnapshot | null = null;
  let jupiterMeta: JupiterTokenMetadata | null = null;
  try {
    jupiterMeta = await fetchJupiterTokenMetadata(normalizedAddress);

    // Resolve decimals: DB → Jupiter metadata → Solana RPC (fallback)
    let resolvedDecimals = storedDecimals ?? jupiterMeta?.decimals ?? null;
    if (resolvedDecimals == null) {
      try {
        resolvedDecimals = await fetchSolanaMintDecimals(rpcUrls, normalizedAddress);
      } catch {
        // Non-fatal — quote-based price will be skipped
      }
    }

    // Use price from lite-api metadata, fall back to quote-derived price
    let jupiterPrice = jupiterMeta?.usdPrice ?? null;
    if (jupiterPrice == null && resolvedDecimals != null) {
      jupiterPrice = await fetchJupiterPriceViaQuote(normalizedAddress, resolvedDecimals);
    }

    // Build a snapshot from any available data — even if price is null
    if (jupiterPrice != null || jupiterMeta != null) {
      liveSnapshot = {
        network: normalizedNetwork,
        contractAddress: normalizedAddress,
        tokenName: jupiterMeta?.name ?? latestStoredSnapshot?.tokenName ?? null,
        tokenSymbol: jupiterMeta?.symbol ?? latestStoredSnapshot?.tokenSymbol ?? null,
        priceUsd: jupiterPrice,
        liquidityUsd: jupiterMeta?.liquidityUsd ?? null,
        fdv: jupiterMeta?.fdv ?? null,
        volume24h: jupiterMeta?.volume24h ?? null,
        totalTransactions24h: jupiterMeta?.totalTransactions24h ?? null,
        outsidersOverOneUsd: null,
        dexId: jupiterMeta?.dexId ?? null,
        pairAddress: jupiterMeta?.pairAddress ?? null,
        fetchedAt: nowMs(),
      };
    }
  } catch (err: unknown) {
    console.warn(`Jupiter market fetch failed for ${normalizedAddress}:`, err);
  }

  if (!liveSnapshot) {
    if ((options?.fallbackToStoredOnError ?? true) && latestStoredSnapshot) {
      writeTokenMarketCache(cacheKey, latestStoredSnapshot);
      return latestStoredSnapshot;
    }
    return null;
  }

  let outsidersOverOneUsd: number | null = null;
  try {
    const managedAccountAddresses =
      options?.managedAccountAddresses ??
      (await dbListManagedAccountAddresses(db, userId));

    // If Jupiter provides total holders count, calculate outsiders = total - internal
    if (jupiterMeta?.totalHolders != null && jupiterMeta.totalHolders > 0) {
      outsidersOverOneUsd = Math.max(
        0,
        jupiterMeta.totalHolders - managedAccountAddresses.length,
      );
      console.log(`[syncTokenMarketSnapshotForUser] Outsiders from Jupiter: ${jupiterMeta.totalHolders} total - ${managedAccountAddresses.length} managed = ${outsidersOverOneUsd}`);
    } else if (liveSnapshot?.priceUsd != null) {
      // Fallback: use RPC to scan for outsiders with balance > $1 USD
      outsidersOverOneUsd = await fetchSolanaOutsiderHolderCountOverOneUsd(
        rpcUrls,
        normalizedAddress,
        managedAccountAddresses,
        liveSnapshot.priceUsd,
      );
    } else {
      console.log(`[syncTokenMarketSnapshotForUser] Cannot calculate outsiders: no holders count from Jupiter and no price for RPC filtering`);
    }
  } catch (err: unknown) {
    console.warn(
      `Failed to compute outsider holder count for ${normalizedAddress}:`,
      err,
    );
  }

  const snapshot: TokenMarketSnapshot = {
    ...liveSnapshot,
    outsidersOverOneUsd,
  };

  if (tokenId) {
    await Promise.all([
      dbUpdateTradableTokenMetadata(db, tokenId, snapshot),
      dbInsertTokenMarketSnapshot(db, tokenId, snapshot),
    ]);
  }

  writeTokenMarketCache(cacheKey, snapshot);
  return snapshot;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function solanaRpc<T>(
  rpcUrls: string | string[],
  method: string,
  params: unknown[],
): Promise<T> {
  const pool = dedupeStrings(
    (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls]).map((url) => url.trim()),
  );
  const maxAttemptsPerEndpoint = 3;
  let lastErrorMessage = 'Unknown Solana RPC failure';

  for (const rpcUrl of pool) {
    for (let attempt = 0; attempt < maxAttemptsPerEndpoint; attempt += 1) {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
        });
        if (!response.ok) {
          throw new ApiError(502, `Solana RPC request failed with ${response.status}`);
        }
        const body = await response.json<{
          result?: T;
          error?: { code?: number; message?: string };
        }>();
        if (body.error) {
          throw new ApiError(
            502,
            `Solana RPC error: ${body.error.message ?? 'unknown error'}`,
          );
        }
        if (body.result == null) {
          throw new ApiError(502, 'Solana RPC returned an empty result');
        }
        return body.result;
      } catch (err: unknown) {
        lastErrorMessage = err instanceof Error ? err.message : String(err);
        console.warn(
          `Solana RPC attempt ${attempt + 1}/${maxAttemptsPerEndpoint} failed for ${rpcUrl}: ${lastErrorMessage}`,
        );

        const isLastAttempt = attempt + 1 >= maxAttemptsPerEndpoint;
        if (!isLastAttempt && isSolanaRpcRateLimitError(err)) {
          // Backoff when providers return 429 so we do not instantly re-hit the limit.
          await waitMs(250 * (attempt + 1));
          continue;
        }
        break;
      }
    }
  }

  throw new ApiError(
    502,
    `All configured Solana RPC endpoints failed for ${method}. Last error: ${lastErrorMessage}`,
  );
}

async function fetchSolanaMintDecimals(
  rpcUrls: string | string[],
  mint: string,
): Promise<number | null> {
  const result = await solanaRpc<{ value: { decimals: number } }>(
    rpcUrls,
    'getTokenSupply',
    [mint],
  );
  return result.value?.decimals ?? null;
}

async function fetchSolanaTokenBalance(
  rpcUrls: string | string[],
  owner: string,
  token: TrackedTokenDescriptor,
): Promise<WalletBalanceToken> {
  const result = await solanaRpc<{
    value: Array<{
      account: {
        data: {
          parsed?: {
            info?: {
              tokenAmount?: {
                amount?: string;
                decimals?: number;
              };
            };
          };
        };
      };
    }>;
  }>(rpcUrls, 'getTokenAccountsByOwner', [owner, { mint: token.mint }, { encoding: 'jsonParsed' }]);

  let total = 0n;
  let decimals = token.decimals;
  for (const account of result.value) {
    const tokenAmount =
      account.account.data.parsed?.info?.tokenAmount;
    if (!tokenAmount?.amount) continue;
    total += BigInt(tokenAmount.amount);
    if (typeof tokenAmount.decimals === 'number') {
      decimals = tokenAmount.decimals;
    }
  }

  return {
    mint: token.mint,
    symbol: token.symbol,
    network: token.network,
    amount: formatTokenAmount(total, decimals ?? 0),
    decimals,
  };
}

function buildTrackedTokens(
  settings: SettingsState,
  tradableTokens: TradableToken[],
): TrackedTokenDescriptor[] {
  const tracked = new Map<string, TrackedTokenDescriptor>();

  for (const token of tradableTokens) {
    if (!token.isActive || token.network !== 'solana') continue;
    if (token.contractAddress === SOLANA_USDC_MINT) continue;
    tracked.set(token.contractAddress, {
      mint: token.contractAddress,
      symbol: token.symbol ?? `${token.contractAddress.slice(0, 4)}…${token.contractAddress.slice(-4)}`,
      network: token.network,
      decimals: token.decimals,
    });
  }

  if (
    settings.contractAddress.trim() &&
    settings.contractAddress !== SOLANA_USDC_MINT
  ) {
    const mint = normalizePubkey(settings.contractAddress);
    if (!tracked.has(mint)) {
      tracked.set(mint, {
        mint,
        symbol: 'Configured Token',
        network: 'solana',
        decimals: null,
      });
    }
  }

  return [...tracked.values()];
}

async function loadWalletBalance(
  address: string,
  settings: SettingsState,
  tradableTokens: TradableToken[],
  rpcUrls: string | string[],
): Promise<WalletBalanceResponse> {
  const trackedTokens = buildTrackedTokens(settings, tradableTokens);
  const cacheKey = walletBalanceCacheKey(address, trackedTokens);
  const cached = readWalletBalanceCache(cacheKey);
  if (cached) return cached;

  const lamportsResult = await solanaRpc<{ value: number }>(
    rpcUrls,
    'getBalance',
    [address],
  );
  const sol = formatTokenAmount(BigInt(lamportsResult.value), 9);
  const usdc = await fetchSolanaTokenBalance(rpcUrls, address, {
    mint: SOLANA_USDC_MINT,
    symbol: 'USDC',
    network: 'solana',
    decimals: 6,
  });

  const tokenResults = await Promise.allSettled(
    trackedTokens.map(async (token) => {
      const decimals =
        token.decimals ?? (await fetchSolanaMintDecimals(rpcUrls, token.mint));
      return fetchSolanaTokenBalance(rpcUrls, address, {
        ...token,
        decimals,
      });
    }),
  );

  const tokens = tokenResults
    .filter(
      (result): result is PromiseFulfilledResult<WalletBalanceToken> =>
        result.status === 'fulfilled',
    )
    .map((result) => result.value);

  const response: WalletBalanceResponse = {
    address,
    sol,
    usdc: usdc.amount,
    tokens,
    updatedAt: nowTs(),
  };

  writeWalletBalanceCache(cacheKey, response);
  return response;
}

// ─── auth middleware helpers ──────────────────────────────────────────────────

async function requireUser(request: Request, env: Env): Promise<SessionUser> {
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (!token) throw new ApiError(401, 'Login required');
  const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
  if (!user) throw new ApiError(401, 'Login required');
  return user;
}

async function requireAdmin(request: Request, env: Env): Promise<SessionUser> {
  const user = await requireUser(request, env);
  if (user.role !== 'admin') {
    throw new ApiError(403, 'Admin permissions are required for this action');
  }
  return user;
}

async function dbListUserIdsByActiveContractAddress(
  db: D1Database,
  contractAddress: string,
): Promise<number[]> {
  await dbEnsureSchema(db);
  const rows = await db
    .prepare(
      `SELECT DISTINCT user_id
       FROM settings
       WHERE key = ?1 AND value = ?2
       ORDER BY user_id ASC`,
    )
    .bind('contractAddress', normalizePubkey(contractAddress))
    .all<{ user_id: number }>();
  return rows.results.map((row) => row.user_id);
}

function resolveAlchemyWebhookSigningKey(env: Env): string {
  const signingKey =
    env.ALCHEMY_WEBHOOK_SIGNING_KEY?.trim() ||
    env.ALCHEMY_WEBHOOK_SECRET?.trim();
  if (!signingKey) {
    throw new ApiError(
      503,
      'ALCHEMY_WEBHOOK_SIGNING_KEY is not configured',
    );
  }
  return signingKey;
}

function parseHexString(value: string): Uint8Array {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) {
    throw new ApiError(400, 'X-Alchemy-Signature must be a valid hex string');
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

async function assertAlchemyWebhookSignature(
  request: Request,
  env: Env,
  rawBody: string,
): Promise<void> {
  const signature = request.headers.get('X-Alchemy-Signature')?.trim();
  if (!signature) {
    throw new ApiError(401, 'Missing X-Alchemy-Signature header');
  }

  const signingKey = resolveAlchemyWebhookSigningKey(env);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    parseHexString(signature),
    new TextEncoder().encode(rawBody),
  );
  if (!isValid) {
    throw new ApiError(401, 'Alchemy webhook signature is invalid');
  }
}

function compactDefinedRecord(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value == null) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    if (isRecord(value) && Object.keys(value).length === 0) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function compactAddressParticipant(value: unknown): Record<string, unknown> | null {
  const record = isRecord(value) ? value : null;
  const address = readNonEmptyString(record?.address);
  return address ? { address } : null;
}

function buildCompactAlchemyLogPayload(
  logValue: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!logValue) {
    return null;
  }
  const transaction = isRecord(logValue.transaction) ? logValue.transaction : null;
  return compactDefinedRecord([
    ['address', readNonEmptyString(logValue.address)],
    ['contractAddress', readNonEmptyString(logValue.contractAddress)],
    ['tokenAddress', readNonEmptyString(logValue.tokenAddress)],
    ['mint', readNonEmptyString(logValue.mint)],
    ['transactionHash', readNonEmptyString(logValue.transactionHash)],
    ['type', readNonEmptyString(logValue.type)],
    ['category', readNonEmptyString(logValue.category)],
    ['walletAddress', readNonEmptyString(logValue.walletAddress)],
    ['amount', logValue.amount],
    ['value', logValue.value],
    ['tokenAmount', logValue.tokenAmount],
    ['fee', logValue.fee],
    ['feeUsd', logValue.feeUsd],
    ['feeUSD', logValue.feeUSD],
    [
      'transaction',
      compactDefinedRecord([
        ['from', compactAddressParticipant(transaction?.from)],
        ['to', compactAddressParticipant(transaction?.to)],
      ]),
    ],
  ]);
}

function buildCompactAlchemyActivityPayload(
  activityValue: Record<string, unknown>,
): Record<string, unknown> {
  const rawContract = isRecord(activityValue.rawContract) ? activityValue.rawContract : null;
  const log = isRecord(activityValue.log) ? activityValue.log : null;
  return compactDefinedRecord([
    ['hash', readNonEmptyString(activityValue.hash)],
    ['type', readNonEmptyString(activityValue.type)],
    ['side', readNonEmptyString(activityValue.side)],
    ['category', readNonEmptyString(activityValue.category)],
    ['asset', readNonEmptyString(activityValue.asset)],
    ['fromAddress', readNonEmptyString(activityValue.fromAddress)],
    ['toAddress', readNonEmptyString(activityValue.toAddress)],
    ['walletAddress', readNonEmptyString(activityValue.walletAddress)],
    ['contractAddress', readNonEmptyString(activityValue.contractAddress)],
    ['tokenAddress', readNonEmptyString(activityValue.tokenAddress)],
    ['mint', readNonEmptyString(activityValue.mint)],
    ['amount', activityValue.amount],
    ['value', activityValue.value],
    ['tokenAmount', activityValue.tokenAmount],
    ['fee', activityValue.fee],
    ['feeUsd', activityValue.feeUsd],
    ['feeUSD', activityValue.feeUSD],
    [
      'rawContract',
      compactDefinedRecord([
        ['address', readNonEmptyString(rawContract?.address)],
      ]),
    ],
    ['log', buildCompactAlchemyLogPayload(log)],
  ]);
}

function buildCompactAlchemySignalPayload(input: {
  webhookId: string | null;
  eventId: string;
  type: string;
  txSignature: string | null;
  contractAddresses: string[];
  activity?: Record<string, unknown> | null;
  log?: Record<string, unknown> | null;
}): string {
  return JSON.stringify(
    compactDefinedRecord([
      ['webhookId', input.webhookId],
      ['eventId', input.eventId],
      ['type', input.type],
      ['txSignature', input.txSignature],
      ['contractAddresses', input.contractAddresses],
      ['activity', input.activity ? buildCompactAlchemyActivityPayload(input.activity) : null],
      ['log', buildCompactAlchemyLogPayload(input.log ?? null)],
    ]),
  );
}

async function loadStoredMarketSnapshotByContractAddress(
  db: D1Database,
  contractAddress: string,
): Promise<TokenMarketSnapshot | null> {
  const tokenId = await dbResolveTradableTokenId(db, contractAddress);
  if (!tokenId) {
    return null;
  }
  return dbGetLatestTokenMarketSnapshot(db, tokenId);
}

function deriveAlchemySignalsFromPayload(
  payload: AlchemyWebhookPayload,
  defaultContractAddress: string | null,
): DerivedChainSignal[] {
  const webhookId = readNonEmptyString(payload.webhookId);
  const eventId = readNonEmptyString(payload.id) ?? `alchemy-${nowTs()}`;
  const payloadType = readNonEmptyString(payload.type) ?? 'ALCHEMY_NOTIFY';
  const event = isRecord(payload.event) ? payload.event : null;
  const fallbackContracts = defaultContractAddress ? [defaultContractAddress] : [];

  if (event && Array.isArray(event.activity)) {
    const activitySignals = event.activity.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const rawContract = isRecord(item.rawContract) ? item.rawContract : null;
      const log = isRecord(item.log) ? item.log : null;
      const txSignature =
        readNonEmptyString(item.hash) ??
        readNonEmptyString(log?.transactionHash) ??
        null;
      const contractAddresses = uniqueSolanaPubkeys([
        ...fallbackContracts,
        rawContract?.address,
        item.contractAddress,
        item.tokenAddress,
        item.mint,
        log?.address,
      ]);
      return [
        {
          externalId: `${eventId}:${txSignature ?? index}:${index}`,
          eventType: `${payloadType}:${readNonEmptyString(item.category) ?? 'activity'}`,
          walletAddress:
            tryNormalizeSolanaPubkey(item.fromAddress) ??
            tryNormalizeSolanaPubkey(item.toAddress),
          txSignature,
          contractAddresses,
          payload: buildCompactAlchemySignalPayload({
            webhookId,
            eventId,
            type: payloadType,
            txSignature,
            contractAddresses,
            activity: item,
          }),
        } satisfies DerivedChainSignal,
      ];
    });
    if (activitySignals.length > 0) {
      return activitySignals;
    }
  }

  const data = event && isRecord(event.data) ? event.data : null;
  const block = data && isRecord(data.block) ? data.block : null;
  if (block && Array.isArray(block.logs)) {
    const logSignals = block.logs.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const transaction = isRecord(item.transaction) ? item.transaction : null;
      const from = transaction && isRecord(transaction.from) ? transaction.from : null;
      const to = transaction && isRecord(transaction.to) ? transaction.to : null;
      const account = isRecord(item.account) ? item.account : null;
      const txSignature =
        readNonEmptyString(transaction?.hash) ??
        readNonEmptyString(item.transactionHash) ??
        null;
      const contractAddresses = uniqueSolanaPubkeys([
        ...fallbackContracts,
        account?.address,
        item.address,
        item.contractAddress,
        item.tokenAddress,
        item.mint,
      ]);
      return [
        {
          externalId: `${eventId}:${txSignature ?? index}:${index}`,
          eventType: `${payloadType}:log`,
          walletAddress:
            tryNormalizeSolanaPubkey(from?.address) ??
            tryNormalizeSolanaPubkey(to?.address),
          txSignature,
          contractAddresses,
          payload: buildCompactAlchemySignalPayload({
            webhookId,
            eventId,
            type: payloadType,
            txSignature,
            contractAddresses,
            log: item,
          }),
        } satisfies DerivedChainSignal,
      ];
    });
    if (logSignals.length > 0) {
      return logSignals;
    }
  }

  return [
    {
      externalId: eventId,
      eventType: payloadType,
      walletAddress: null,
      txSignature: null,
      contractAddresses: uniqueSolanaPubkeys([
        ...fallbackContracts,
        event?.contractAddress,
        event?.address,
        event?.tokenAddress,
        event?.mint,
      ]),
      payload: JSON.stringify(
        compactDefinedRecord([
          ['webhookId', webhookId],
          ['eventId', eventId],
          ['type', payloadType],
          [
            'contractAddresses',
            uniqueSolanaPubkeys([
              ...fallbackContracts,
              event?.contractAddress,
              event?.address,
              event?.tokenAddress,
              event?.mint,
            ]),
          ],
        ]),
      ),
    },
  ];
}

async function processTokenActivitySignal(
  env: Env,
  input: {
    userId: number;
    contractAddress: string;
    source: string;
    externalId: string;
    eventType: string;
    walletAddress: string | null;
    txSignature: string | null;
    payload: string;
    providerLabel: string;
  },
): Promise<boolean> {
  const normalizedContractAddress = normalizePubkey(input.contractAddress);
  const { inserted, signal } = await dbCreateSignal(env.TRADINGBOT_DB, {
    source: input.source,
    externalId: input.externalId,
    eventType: input.eventType,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature,
    payload: input.payload,
    detailsJson: null,
  });

  if (!inserted) {
    if (signal.processed) {
      return false;
    }
    const claimed = await dbClaimSignalProcessing(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
    );
    if (!claimed) {
      return false;
    }
  }

  try {
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      input.userId,
      env.SOLANA_RPC_URL,
    );
    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    const payloadDetails = extractWebhookTransactionDetailsFromPayload(
      input.payload,
      normalizedContractAddress,
    );
    const rpcDetails = input.txSignature
      ? await fetchSolanaWebhookTransactionDetailsFromRpc(
          rpcUrls,
          input.txSignature,
          normalizedContractAddress,
          payloadDetails,
        )
      : null;
    const mergedDetails = mergeStoredSignalTransactionDetails(
      {
        tokenContractAddress: normalizedContractAddress,
        primaryWalletAddress: input.walletAddress,
        transactionStatus: 'PENDING',
        detailSource: 'unknown',
      },
      payloadDetails,
      rpcDetails,
    );
    const preferredWalletAddress = await dbResolvePreferredSignalWalletAddress(
      env.TRADINGBOT_DB,
      input.userId,
      [
        mergedDetails.primaryWalletAddress,
        mergedDetails.fromWalletAddress,
        mergedDetails.toWalletAddress,
      ],
      input.walletAddress,
    );
    mergedDetails.primaryWalletAddress = preferredWalletAddress;
    await dbUpdateSignalTransactionDetails(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
      preferredWalletAddress,
      mergedDetails,
    );
    if (tokenId && input.txSignature) {
      await dbApplyTokenHolderTransactionDelta(
        env.TRADINGBOT_DB,
        input.userId,
        tokenId,
        input.txSignature,
        mergedDetails,
      ).catch((err) => {
        console.warn(`Failed to apply token holder delta for ${input.txSignature}:`, err);
      });
    }

    let marketSnapshot: TokenMarketSnapshot | null = null;
    try {
      marketSnapshot = await syncTokenMarketSnapshotForUser(
        env.TRADINGBOT_DB,
        input.userId,
        'solana',
        normalizedContractAddress,
        rpcUrls,
        {
          force: true,
        },
      );
    } catch (err: unknown) {
      console.warn(
        `Failed to refresh market snapshot from ${input.providerLabel} event for ${normalizedContractAddress}:`,
        err,
      );
    }

    let strategySummary: string | null = null;
    try {
      const settings = await dbLoadSettings(env.TRADINGBOT_DB, input.userId);
      const strategyResult = await runAndPersistStrategyEvaluation(
        env.TRADINGBOT_DB,
        input.userId,
        settings,
        buildWebhookStrategyTrigger({
          eventType: input.eventType,
          externalId: input.externalId,
          contractAddress: normalizedContractAddress,
          walletAddress: input.walletAddress,
          txSignature: input.txSignature,
          payloadJson: null,
        }),
        marketSnapshot,
        {
          changeNote: `Webhook trigger ${input.eventType}`,
          origin: 'settings-sync',
        },
      );
      strategySummary = strategyResult
        ? `Strategy v${strategyResult.version.versionNo}: ${summarizeStrategyRuntime(strategyResult.runtime)}`
        : 'No manual strategy version is active, so the webhook did not create an evaluation.';
    } catch (err: unknown) {
      console.warn(
        `Strategy evaluation failed for webhook ${input.eventType} on ${normalizedContractAddress}:`,
        err,
      );
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      input.userId,
      'strategy.triggered',
      input.txSignature ?? input.externalId,
      marketSnapshot
        ? `Received an ${input.providerLabel} ${input.eventType} event for ${normalizedContractAddress}. Recorded a fresh market snapshot and triggered strategy evaluation. ${strategySummary ?? 'Strategy runtime is not yet actionable for automated execution.'}`
        : `Received an ${input.providerLabel} ${input.eventType} event for ${normalizedContractAddress}. Triggered strategy evaluation. ${strategySummary ?? 'Strategy runtime is not yet actionable for automated execution.'}`,
    );
    await dbMarkSignalProcessed(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
    );
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await dbMarkSignalFailed(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
      errorMessage,
    );
    throw err;
  }
}

async function processAlchemyNotifyWebhookPayload(
  env: Env,
  payload: AlchemyWebhookPayload,
  contractFromQuery: string | null,
  derivedSignals: DerivedChainSignal[],
): Promise<{
  received: number;
  routedTargets: number;
  processed: number;
  duplicates: number;
  ignored: number;
}> {
  const webhookId = readNonEmptyString(payload.webhookId) ?? 'shared';
  const targetCache = new Map<string, number[]>();

  let processed = 0;
  let duplicates = 0;
  let ignored = 0;
  let routedTargets = 0;

  for (const signal of derivedSignals) {
    const contractAddresses = signal.contractAddresses.length > 0
      ? signal.contractAddresses
      : contractFromQuery
        ? [contractFromQuery]
        : [];
    if (contractAddresses.length === 0) {
      ignored += 1;
      continue;
    }

    const handledTargets = new Set<string>();
    for (const contractAddress of contractAddresses) {
      let userIds = targetCache.get(contractAddress);
      if (!userIds) {
        userIds = await dbListUserIdsByActiveContractAddress(
          env.TRADINGBOT_DB,
          contractAddress,
        );
        targetCache.set(contractAddress, userIds);
      }

      for (const userId of userIds) {
        const targetKey = `${userId}:${contractAddress}`;
        if (handledTargets.has(targetKey)) {
          continue;
        }
        handledTargets.add(targetKey);
        routedTargets += 1;
        const inserted = await processTokenActivitySignal(env, {
          userId,
          contractAddress,
          source: `alchemy_notify:${webhookId}:user:${userId}`,
          externalId: `${signal.externalId}:${contractAddress}`,
          eventType: signal.eventType,
          walletAddress: signal.walletAddress,
          txSignature: signal.txSignature,
          payload: signal.payload,
          providerLabel: 'Alchemy Notify',
        });
        if (inserted) {
          processed += 1;
        } else {
          duplicates += 1;
        }
      }
    }

    if (handledTargets.size === 0) {
      ignored += 1;
    }
  }

  return {
    received: derivedSignals.length,
    routedTargets,
    processed,
    duplicates,
    ignored,
  };
}

async function handleAlchemyNotifyWebhook(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  await assertAlchemyWebhookSignature(request, env, rawBody);
  const payload = parseJsonText<AlchemyWebhookPayload>(rawBody);
  const contractFromQuery = tryNormalizeSolanaPubkey(
    url.searchParams.get('contractAddress'),
  );
  const derivedSignals = deriveAlchemySignalsFromPayload(
    payload,
    contractFromQuery,
  );

  // Background processing: handle webhook and update market snapshots
  ctx.waitUntil(
    (async () => {
      try {
        const result = await processAlchemyNotifyWebhookPayload(
          env,
          payload,
          contractFromQuery,
          derivedSignals,
        );
        console.log(
          `[webhook] Routed ${result.routedTargets} targets, processed ${result.processed} signal(s), duplicates ${result.duplicates}, ignored ${result.ignored}`,
        );
      } catch (err) {
        console.error('Alchemy webhook background processing failed:', err);
      }
    })(),
  );

  return jsonResponse({ ok: true, accepted: true }, 200);
}

// ─── route handlers ───────────────────────────────────────────────────────────

// GET /api/health
async function handleHealth(_req: Request, env: Env): Promise<Response> {
  // Verify DB connectivity with a lightweight query
  await env.TRADINGBOT_DB.prepare('SELECT 1').first();
  return jsonResponse({
    ok: true,
    backend: 'cloudflare-worker',
    databaseConnected: true,
    databasePath: 'D1:tradingbot',
  });
}

// GET /api/debug/webhook-transactions
async function handleDebugWebhookTransactions(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const limitText = url.searchParams.get('limit');
  const limit = Number.isInteger(Number.parseInt(limitText ?? '', 10))
    ? Math.min(Math.max(Number.parseInt(limitText ?? '', 10), 1), 50)
    : 10;

  const [signalCountRow, recentSignals, groupedWebhookTransactions, tradeLogCountRow] =
    await Promise.all([
      env.TRADINGBOT_DB
        .prepare('SELECT COUNT(*) AS cnt FROM signals WHERE source LIKE ?1')
        .bind(`%:user:${user.id}`)
        .first<{ cnt: number }>(),
      dbListRecentSignalsForDebug(env.TRADINGBOT_DB, user.id, limit),
      dbListWebhookTransactionLogs(env.TRADINGBOT_DB, user.id),
      env.TRADINGBOT_DB
        .prepare('SELECT COUNT(*) AS cnt FROM trade_logs')
        .first<{ cnt: number }>(),
    ]);

  return jsonResponse({
    user: { id: user.id, username: user.username },
    signalCount: signalCountRow?.cnt ?? 0,
    tradeLogCount: tradeLogCountRow?.cnt ?? 0,
    groupedWebhookTransactionCount: groupedWebhookTransactions.length,
    groupedWebhookTransactions: groupedWebhookTransactions.slice(0, limit),
    recentSignals,
  });
}

// GET /api/auth/status
async function handleAuthStatus(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (setupRequired) {
    return jsonResponse({ setupRequired: true, authenticated: false, user: null });
  }
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (!token) {
    return jsonResponse({ setupRequired: false, authenticated: false, user: null });
  }
  const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
  return jsonResponse({
    setupRequired: false,
    authenticated: !!user,
    user: user ? { username: user.username, role: user.role } : null,
  });
}

// POST /api/auth/bootstrap
async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (!setupRequired) {
    throw new ApiError(
      403,
      'Bootstrap is disabled because an admin user already exists',
    );
  }
  const body = parseCredentialsBody(await parseJsonBody<unknown>(request));
  const user = await dbCreateUser(
    env.TRADINGBOT_DB,
    body.username,
    body.password,
  );
  const token = await dbCreateSession(
    env.TRADINGBOT_DB,
    user.id,
    SESSION_TTL_HOURS,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'auth.bootstrap',
    user.username,
    'Created initial admin account',
  );
  return jsonResponse(
    { authenticated: true, user: { username: user.username, role: user.role } },
    201,
    { 'Set-Cookie': buildSessionCookie(token, SESSION_TTL_HOURS, isSecure(request)) },
  );
}

// POST /api/auth/login
async function handleLogin(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (setupRequired) {
    throw new ApiError(
      403,
      'Initial admin setup is required before login. Create an admin account first.',
    );
  }
  const body = parseCredentialsBody(await parseJsonBody<unknown>(request));
  const user = await dbAuthenticateUser(
    env.TRADINGBOT_DB,
    body.username,
    body.password,
  );
  const token = await dbCreateSession(
    env.TRADINGBOT_DB,
    user.id,
    SESSION_TTL_HOURS,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'auth.login',
    user.username,
    'Authenticated admin session',
  );
  return jsonResponse(
    { authenticated: true, user: { username: user.username, role: user.role } },
    200,
    { 'Set-Cookie': buildSessionCookie(token, SESSION_TTL_HOURS, isSecure(request)) },
  );
}

// POST /api/auth/logout
async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (token) {
    const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
    await dbDeleteSession(env.TRADINGBOT_DB, token);
    if (user) {
      await dbAddAuditLog(
        env.TRADINGBOT_DB,
        user.id,
        'auth.logout',
        user.username,
        'Ended admin session',
      );
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
  });
}

// GET /api/state
async function handleGetState(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  let activeStrategyVersion = await dbGetActiveStrategyVersion(
    env.TRADINGBOT_DB,
    user.id,
  ).catch(() => null);
  let [
    internalAccs,
    outsiderAccs,
    activityLogs,
    tradeLogs,
    webhookTransactionLogs,
    tradableTokens,
    historicalSetups,
    strategyVersions,
    strategyEvaluations,
    rpcEndpoints,
  ] =
    await Promise.all([
      dbListAccounts(env.TRADINGBOT_DB, user.id, 'managed'),
      dbListAccounts(env.TRADINGBOT_DB, user.id, 'watch'),
      dbListAuditLogs(env.TRADINGBOT_DB, user.id, user.username),
      dbListTradeLogs(env.TRADINGBOT_DB),
      dbListWebhookTransactionLogs(env.TRADINGBOT_DB, user.id),
      dbListTradableTokens(env.TRADINGBOT_DB),
      dbListHistoricalSetups(env.TRADINGBOT_DB, user.id),
      dbListStrategyVersions(env.TRADINGBOT_DB, user.id),
      dbListStrategyEvaluations(env.TRADINGBOT_DB, user.id),
      dbListRpcEndpoints(env.TRADINGBOT_DB, user.id),
    ]);

  let marketSnapshot: TokenMarketSnapshot | null = null;
  let tokenHolderAggregate: TokenHolderAggregateRecord | null = null;
  let outsideTokenHolders: OutsideTokenHolderRecord[] = [];
  let tokenId: number | null = null;
  if (settings.contractAddress.trim()) {
    try {
      tokenId = await dbResolveTradableTokenId(
        env.TRADINGBOT_DB,
        settings.contractAddress,
      );
      if (tokenId) {
        marketSnapshot = await dbGetLatestTokenMarketSnapshot(
          env.TRADINGBOT_DB,
          tokenId,
        );
      }
    } catch (err: unknown) {
      console.warn(
        `Failed to load token market snapshot for ${settings.contractAddress}:`,
        err,
      );
    }

    try {
      if (tokenId) {
        const holderSyncState = await dbGetTokenHolderSyncState(
          env.TRADINGBOT_DB,
          tokenId,
        );
        tokenHolderAggregate = await dbGetTokenHolderAggregate(
          env.TRADINGBOT_DB,
          tokenId,
        );
        if (
          holderSyncState?.runId &&
          holderSyncState.stagedHolderCount > 0 &&
          (holderSyncState.status === 'running' || holderSyncState.status === 'failed')
        ) {
          tokenHolderAggregate =
            (await dbComputeTokenHolderAggregateFromStage(
              env.TRADINGBOT_DB,
              user.id,
              tokenId,
              holderSyncState.runId,
              holderSyncState.updatedAt,
            )) ?? tokenHolderAggregate;
        }
        if (
          !tokenHolderAggregate &&
          (await dbHasTokenHolderRows(env.TRADINGBOT_DB, tokenId))
        ) {
          tokenHolderAggregate = await dbRecomputeTokenHolderAggregate(
            env.TRADINGBOT_DB,
            user.id,
            tokenId,
            {
              source: 'state_recompute',
            },
          );
        }
        outsideTokenHolders = await dbListOutsideTokenHolders(
          env.TRADINGBOT_DB,
          user.id,
          tokenId,
        );
      }
    } catch (err: unknown) {
      console.warn(
        `Failed to load token holder aggregate for ${settings.contractAddress}:`,
        err,
      );
    }
  }

  const dedupedStrategyDisplay = dedupeStrategyVersionsForDisplay(
    strategyVersions,
    activeStrategyVersion,
  );
  strategyVersions = dedupedStrategyDisplay.versions;
  activeStrategyVersion = dedupedStrategyDisplay.activeVersion;

  const profitUsdc = settings.contractAddress.trim()
    ? await dbComputeManagedProfitUsdc(
        env.TRADINGBOT_DB,
        user.id,
        settings.contractAddress,
        marketSnapshot?.priceUsd ?? null,
      )
    : 0;

  return jsonResponse({
    auth: { username: user.username, role: user.role },
    settings,
    internalAccs,
    outsiderAccs,
    logs: activityLogs,
    activityLogs,
    tradeLogs,
    webhookTransactionLogs,
    tradableTokens,
    historicalSetups,
    activeStrategyVersion,
    strategyVersions,
    strategyEvaluations,
    tokenHolderAggregate,
    outsideTokenHolders,
    rpcEndpoints,
    marketSnapshot,
    marketSnapshotHistory: [],
    profitUsdc,
    stats: {
      managedAccounts: internalAccs.length,
      watchedAccounts: outsiderAccs.length,
      tradeExecutionEnabled: false,
    },
    system: {
      backend: 'cloudflare-worker',
      databasePath: 'D1:tradingbot',
      databaseConnected: true,
    },
  });
}

// POST /api/settings
async function handleSaveSettings(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = await parseJsonBody<SettingsUpdateRequest>(request);
  const normalizedContractAddress = body.contractAddress.trim()
    ? normalizePubkey(body.contractAddress)
    : '';
  let rpcUrls: string[] | null = null;
  if (normalizedContractAddress) {
    rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );
    const decimals = await fetchSolanaMintDecimals(
      rpcUrls,
      normalizedContractAddress,
    ).catch(() => null);
    await dbCreateTradableToken(
      env.TRADINGBOT_DB,
      { network: 'solana', contractAddress: normalizedContractAddress },
      decimals,
    );
  }
  await dbSaveSettings(env.TRADINGBOT_DB, user.id, {
    ...body,
    contractAddress: normalizedContractAddress,
  });
  const updated = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  await dbCreateHistoricalSetupSnapshot(
    env.TRADINGBOT_DB,
    user.id,
    updated,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'settings.updated',
    'settings',
    'Trading settings were updated. No strategy version was created automatically.',
  );

  return jsonResponse(updated);
}

// POST /api/settings/active-token
async function handleSaveActiveToken(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = parseActiveTokenUpdateRequest(
    await parseJsonBody<unknown>(request),
  );
  const normalizedContractAddress = await dbSaveActiveContractAddress(
    env.TRADINGBOT_DB,
    user.id,
    body.contractAddress,
  );

  let marketSnapshot: TokenMarketSnapshot | null = null;
  if (normalizedContractAddress) {
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );

    const existingTokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    if (!existingTokenId) {
      try {
        const decimals = await fetchSolanaMintDecimals(
          rpcUrls,
          normalizedContractAddress,
        ).catch(() => null);
        await dbCreateTradableToken(
          env.TRADINGBOT_DB,
          {
            network: 'solana',
            contractAddress: normalizedContractAddress,
          },
          decimals,
        );
      } catch (err: unknown) {
        console.warn(
          `Failed to ensure tracked token metadata for ${normalizedContractAddress}:`,
          err,
        );
      }
    }
    marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
  }

  const updatedSettings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  void updatedSettings;

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    normalizedContractAddress ? 'token.activated' : 'token.cleared',
    normalizedContractAddress || 'none',
    normalizedContractAddress
      ? marketSnapshot
        ? 'Activated the tracked token and reused the latest stored market data. No strategy version was created automatically.'
        : 'Activated the tracked token. Market data will refresh only on manual refresh or webhook events. No strategy version was created automatically.'
      : 'Cleared the active tracked token. No strategy version was created automatically.',
  );

  return jsonResponse({
    contractAddress: normalizedContractAddress,
    marketSnapshot,
  });
}

// POST /api/strategy/active
async function handleSaveActiveStrategy(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const document = normalizeStrategyDocument(
    await parseJsonBody<unknown>(request),
  );

  const normalizedContractAddress = document.parameters.contractAddress.trim()
    ? normalizePubkey(document.parameters.contractAddress)
    : '';
  const normalizedDocument = normalizeStrategyDocument({
    ...document,
    parameters: {
      ...document.parameters,
      contractAddress: normalizedContractAddress,
    },
    metadata: {
      ...document.metadata,
      author: user.username,
      changeNote:
        document.metadata.changeNote ||
        document.parameters.notes ||
        'Strategy document updated',
      origin: 'manual',
    },
  });

  const strategySave = await dbSaveActiveStrategyVersionDocument(
    env.TRADINGBOT_DB,
    user.id,
    normalizedDocument,
    {
      changeNote:
        normalizedDocument.metadata.changeNote ||
        normalizedDocument.parameters.notes ||
        'Strategy document updated',
    },
  );

  const settingsUpdate = mapStrategyDocumentToSettingsUpdate(normalizedDocument);
  await dbSaveSettings(env.TRADINGBOT_DB, user.id, settingsUpdate);
  const updatedSettings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  await dbCreateHistoricalSetupSnapshot(
    env.TRADINGBOT_DB,
    user.id,
    updatedSettings,
  );

  let marketSnapshot: TokenMarketSnapshot | null = null;
  if (normalizedContractAddress) {
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );

    const existingTokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    if (!existingTokenId) {
      try {
        const decimals = await fetchSolanaMintDecimals(
          rpcUrls,
          normalizedContractAddress,
        ).catch(() => null);
        await dbCreateTradableToken(
          env.TRADINGBOT_DB,
          {
            network: 'solana',
            contractAddress: normalizedContractAddress,
          },
          decimals,
        );
      } catch (err: unknown) {
        console.warn(
          `Failed to ensure tracked token metadata for strategy contract ${normalizedContractAddress}:`,
          err,
        );
      }
    }
    marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
  }

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'strategy.version_activated',
    normalizedContractAddress || 'none',
    strategySave.created
      ? `Activated strategy version v${strategySave.version.versionNo}.`
      : `Strategy version v${strategySave.version.versionNo} remains active.`,
  );

  return jsonResponse({
    activeStrategyVersion: strategySave.version,
    settings: updatedSettings,
    marketSnapshot,
  });
}

// POST /api/strategy/versions/cleanup
async function handleCleanupStrategyVersions(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const cleanup = await dbDeletePreviousStrategyVersions(
    env.TRADINGBOT_DB,
    user.id,
  );

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'strategy.versions_cleaned',
    cleanup.keptVersion?.document.parameters.contractAddress || 'strategy',
    cleanup.keptVersion
      ? `Deleted ${cleanup.deletedVersions} automatic strategy version(s) and ${cleanup.deletedEvaluations} related evaluation(s). Kept manual v${cleanup.keptVersion.versionNo} active.`
      : `Deleted ${cleanup.deletedVersions} automatic strategy version(s) and ${cleanup.deletedEvaluations} related evaluation(s). No manual strategy version remains active.`,
  );

  return jsonResponse({
    deletedVersions: cleanup.deletedVersions,
    deletedEvaluations: cleanup.deletedEvaluations,
    activeStrategyVersion: cleanup.keptVersion,
  });
}

// POST /api/private-keys/import and POST /api/admin/private-keys
async function handleImportManagedWallet(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.PRIVATE_KEY_ENCRYPTION_KEY) {
    throw new ApiError(
      503,
      'PRIVATE_KEY_ENCRYPTION_KEY is not configured on the server',
    );
  }
  const user = await requireAdmin(request, env);
  const body = parseManagedWalletImportRequest(
    await parseJsonBody<unknown>(request),
  );
  if (body.adminPassword) {
    const passwordValid = await dbVerifyUserPassword(
      env.TRADINGBOT_DB,
      user.id,
      body.adminPassword,
    );
    if (!passwordValid) {
      throw new ApiError(401, 'Admin password is incorrect');
    }
  }
  const account = body.privateKey
    ? await dbImportManagedKey(
        env.TRADINGBOT_DB,
        user.id,
        body.label,
        body.privateKey,
        env.PRIVATE_KEY_ENCRYPTION_KEY,
      )
    : await dbImportManagedKeyBytes(
        env.TRADINGBOT_DB,
        user.id,
        body.label,
        deriveSolanaKeypairFromRecoveryPhrase(
          body.recoveryPhrase ?? '',
          body.derivationPath,
        ),
        env.PRIVATE_KEY_ENCRYPTION_KEY,
      );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'private_key.imported',
    account.address,
    body.privateKey
      ? `Imported managed key '${account.label}' from a private key. Private key material was encrypted at rest and is never returned by the API.`
      : `Imported managed key '${account.label}' from a recovery phrase using ${body.derivationPath ?? DEFAULT_SOLANA_DERIVATION_PATH}. Derived key material was encrypted at rest and is never returned by the API.`,
  );
  return jsonResponse({ account }, 201);
}

// POST /api/tradable-tokens
async function handleAddTradableToken(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = parseTradableTokenCreateRequest(
    await parseJsonBody<unknown>(request),
  );
  const normalizedAddress = normalizePubkey(body.contractAddress);
  const rpcUrls = await dbResolveSolanaRpcUrls(
    env.TRADINGBOT_DB,
    user.id,
    env.SOLANA_RPC_URL,
  );
  const decimals = await fetchSolanaMintDecimals(
    rpcUrls,
    normalizedAddress,
  ).catch(() => null);
  const token = await dbCreateTradableToken(
    env.TRADINGBOT_DB,
    { network: body.network, contractAddress: normalizedAddress },
    decimals,
  );
  const marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
    env.TRADINGBOT_DB,
    normalizedAddress,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'token.added',
    token.contractAddress,
    marketSnapshot
      ? `Added tradable token on ${token.network} and reused the latest stored market snapshot.`
      : `Added tradable token on ${token.network}. Market data will refresh only on manual refresh or webhook events.`,
  );
  return jsonResponse({ token, marketSnapshot }, 201);
}

// GET /api/market-snapshots?startTime=xxx&endTime=xxx
async function handleGetMarketSnapshotsByTimeRange(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  const contractAddress = settings.contractAddress.trim();

  if (!contractAddress) {
    throw new ApiError(
      400,
      'Set an active trading token before querying market snapshots',
    );
  }

  const startTimeParam = url.searchParams.get('startTime');
  const endTimeParam = url.searchParams.get('endTime');
  const limitParam = url.searchParams.get('limit');

  const now = nowMs();
  let startTime = now - 7 * 24 * 60 * 60 * 1000;
  let endTime = now;
  let limit = 100;

  if (startTimeParam) {
    const parsed = Number.parseInt(startTimeParam, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      startTime = normalizeTimestampMs(parsed);
    }
  }

  if (endTimeParam) {
    const parsed = Number.parseInt(endTimeParam, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      endTime = normalizeTimestampMs(parsed);
    }
  }

  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 500) {
      limit = parsed;
    }
  }

  // Find token by contract address
  const tokenId = await dbResolveTradableTokenId(
    env.TRADINGBOT_DB,
    contractAddress,
  );

  if (!tokenId) {
    throw new ApiError(404, 'Token not found');
  }

  const snapshots = await dbGetTokenMarketSnapshotsByTimeRange(
    env.TRADINGBOT_DB,
    tokenId,
    startTime,
    endTime,
    limit,
  );

  return jsonResponse({ snapshots });
}

// POST /api/market-snapshot/refresh
async function handleForceRefreshMarketSnapshot(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const url = new URL(request.url);
  const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  const contractAddress = settings.contractAddress.trim();
  if (!contractAddress) {
    throw new ApiError(
      400,
      'Set an active trading token before forcing a live market refresh',
    );
  }

  const rpcUrls = await dbResolveSolanaRpcUrls(
    env.TRADINGBOT_DB,
    user.id,
    env.SOLANA_RPC_URL,
  );
  const marketSnapshot = await syncTokenMarketSnapshotForUser(
    env.TRADINGBOT_DB,
    user.id,
    'solana',
    contractAddress,
    rpcUrls,
    {
      force: true,
      fallbackToStoredOnError: false,
    },
  );

  const startTimeMs = (() => {
    const raw = url.searchParams.get('startTime');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? normalizeTimestampMs(parsed) : null;
  })();
  const endTimeMs = (() => {
    const raw = url.searchParams.get('endTime');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? normalizeTimestampMs(parsed) : null;
  })();

  const tokenId = await dbResolveTradableTokenId(
    env.TRADINGBOT_DB,
    contractAddress,
  );
  let holderSyncSummary = buildTokenHolderSyncSummary(null);
  if (tokenId) {
    holderSyncSummary = await syncSolanaTokenHolderBalancesFull(
      env.TRADINGBOT_DB,
      user.id,
      tokenId,
      contractAddress,
      rpcUrls,
    ).catch((err) => {
      console.warn(
        `Failed to page holder balances for ${contractAddress}:`,
        err,
      );
      return buildTokenHolderSyncSummary(
        {
          tokenId,
          runId: null,
          status: 'failed',
          source: 'rpc_owner_prefix_shards',
          nextShardIndex: 0,
          processedShardCount: 0,
          totalShardCount: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
          stagedHolderCount: 0,
          lastProgramId: null,
          lastOwnerPrefix: null,
          errorMessage: err instanceof Error ? err.message : String(err),
          startedAt: null,
          updatedAt: nowTs(),
          lastCompletedAt: null,
        },
      );
    });
  }

  const holderSyncAuditDetails =
    holderSyncSummary.status === 'completed'
      ? `Holder sync completed with ${holderSyncSummary.activeHolderCount} active holders, upserted ${holderSyncSummary.upsertedCount}, zeroed ${holderSyncSummary.zeroedCount}.`
      : holderSyncSummary.status === 'failed'
        ? `Holder sync failed after ${holderSyncSummary.processedShardCount}/${holderSyncSummary.totalShardCount} shards. ${holderSyncSummary.errorMessage ?? 'Unknown error'}.`
        : `Holder sync is running ${holderSyncSummary.processedShardCount}/${holderSyncSummary.totalShardCount} shards, processed ${holderSyncSummary.shardsProcessedThisRun} shard(s) this refresh, staged ${holderSyncSummary.stagedHolderCount} holders so far.`;

  const windowCompleteness = await reconcileWebhookTransactionDetailsInWindow(
    env.TRADINGBOT_DB,
    user.id,
    contractAddress,
    rpcUrls,
    startTimeMs,
    endTimeMs,
  ).catch((err) => {
    console.warn(`Window detail reconciliation failed for ${contractAddress}:`, err);
    return {
      expectedTransactions: 0,
      completeTransactionsBefore: 0,
      enrichedTransactions: 0,
      completeTransactionsAfter: 0,
    };
  });

  const rpcReconciliation = await reconcileTokenTransactionsFromRpc(
    env.TRADINGBOT_DB,
    user.id,
    contractAddress,
    rpcUrls,
    {
      additionalAddresses: [marketSnapshot?.pairAddress ?? null],
      startTimeMs,
      endTimeMs,
    },
  ).catch((err) => {
    console.warn(`RPC reconciliation failed for ${contractAddress}:`, err);
    return {
      scannedSignatures: 0,
      insertedSignals: 0,
      duplicates: 0,
      skippedIrrelevant: 0,
    };
  });

  let strategyEvaluationSummary: string | null = null;
  let strategyEvaluationPayload: Record<string, unknown> | null = null;
  try {
    const strategyResult = await runAndPersistStrategyEvaluation(
      env.TRADINGBOT_DB,
      user.id,
      settings,
      buildManualRefreshStrategyTrigger({
        contractAddress,
        externalId: `manual-refresh:${user.id}:${contractAddress}:${nowMs()}`,
      }),
      marketSnapshot,
      {
        author: user.username,
        changeNote: 'Manual market snapshot refresh',
        origin: 'settings-sync',
      },
    );
    if (strategyResult) {
      strategyEvaluationSummary = `Strategy v${strategyResult.version.versionNo}: ${summarizeStrategyRuntime(strategyResult.runtime)}`;
      strategyEvaluationPayload = {
        versionNo: strategyResult.version.versionNo,
        status: strategyResult.runtime.evaluation.status,
        qualified: strategyResult.runtime.evaluation.qualified,
        shouldExecute: strategyResult.runtime.evaluation.shouldExecute,
        dryRun: strategyResult.runtime.evaluation.dryRun,
        reasons: strategyResult.runtime.evaluation.reasons,
      };
    }
  } catch (err: unknown) {
    console.warn(`Strategy evaluation failed after manual refresh for ${contractAddress}:`, err);
  }

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'market_snapshot.force_refreshed',
    contractAddress,
    strategyEvaluationSummary
      ? `Forced a live market snapshot refresh and stored a new historical record. ${strategyEvaluationSummary} Window transactions ${windowCompleteness.expectedTransactions}, complete before ${windowCompleteness.completeTransactionsBefore}, enriched ${windowCompleteness.enrichedTransactions}, complete after ${windowCompleteness.completeTransactionsAfter}. RPC reconciliation scanned ${rpcReconciliation.scannedSignatures} signatures and inserted ${rpcReconciliation.insertedSignals} missing transactions. ${holderSyncAuditDetails}`
      : `Forced a live market snapshot refresh and stored a new historical record. Window transactions ${windowCompleteness.expectedTransactions}, complete before ${windowCompleteness.completeTransactionsBefore}, enriched ${windowCompleteness.enrichedTransactions}, complete after ${windowCompleteness.completeTransactionsAfter}. RPC reconciliation scanned ${rpcReconciliation.scannedSignatures} signatures and inserted ${rpcReconciliation.insertedSignals} missing transactions. ${holderSyncAuditDetails}`,
  );

  return jsonResponse({
    marketSnapshot,
    strategyEvaluation: strategyEvaluationPayload,
    rpcReconciliation,
    windowCompleteness,
    holderSyncSummary,
  });
}

// POST /api/rpc-endpoints
async function handleAddRpcEndpoint(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = parseRpcEndpointCreateRequest(
    await parseJsonBody<unknown>(request),
  );
  const endpoint = await dbAddRpcEndpoint(env.TRADINGBOT_DB, user.id, body);
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'rpc.endpoint_added',
    endpoint.url,
    `Added ${endpoint.network} RPC endpoint`,
  );
  return jsonResponse({ endpoint }, 201);
}

// DELETE /api/rpc-endpoints/{id}
async function handleDeleteRpcEndpoint(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const idText = url.pathname.split('/').pop();
  const endpointId = Number.parseInt(idText ?? '', 10);
  if (!Number.isInteger(endpointId) || endpointId <= 0) {
    throw new ApiError(400, 'RPC endpoint id is invalid');
  }
  const endpoint = await dbDeleteRpcEndpoint(
    env.TRADINGBOT_DB,
    user.id,
    endpointId,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'rpc.endpoint_deleted',
    endpoint.url,
    `Removed ${endpoint.network} RPC endpoint`,
  );
  return jsonResponse({ success: true });
}

// POST /api/accounts/import
async function handleImportAccount(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = await request.json<{ label: string; address: string }>();
  const account = await dbImportWatchAccount(
    env.TRADINGBOT_DB,
    user.id,
    body.label,
    body.address,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'account.imported',
    account.address,
    `Imported watch-only account '${account.label}'.`,
  );
  return jsonResponse({ account }, 201);
}

// POST /api/trade
async function handleTrade(request: Request, env: Env): Promise<Response> {
  if (!env.PRIVATE_KEY_ENCRYPTION_KEY) {
    throw new ApiError(503, 'PRIVATE_KEY_ENCRYPTION_KEY is not configured — cannot decrypt signing key');
  }

  const user = await requireAdmin(request, env);
  const body = await request.json<{
    action?: string;
    contractAddress?: string;
    walletAddress?: string;
    /** Amount in USDC for BUY; amount in the base token for SELL */
    requestedAmount?: number;
  }>();

  const action = (body.action ?? '').toUpperCase();
  if (action !== 'BUY' && action !== 'SELL') {
    throw new ApiError(400, 'action must be BUY or SELL');
  }
  if (typeof body.requestedAmount !== 'number' || !Number.isFinite(body.requestedAmount) || body.requestedAmount <= 0) {
    throw new ApiError(400, 'requestedAmount must be a positive number');
  }

  const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  const targetMint = normalizePubkey(
    typeof body.contractAddress === 'string' && body.contractAddress.trim().length > 0
      ? body.contractAddress
      : settings.contractAddress,
  );
  if (!targetMint) {
    throw new ApiError(400, 'No active trading token configured');
  }

  // Resolve the managed wallet to sign with
  const signerAddress = normalizePubkey(
    typeof body.walletAddress === 'string' && body.walletAddress.trim().length > 0
      ? body.walletAddress
      : '',
  );
  // Find first managed wallet if none specified
  let resolvedSignerAddress = signerAddress;
  if (!resolvedSignerAddress) {
    const managed = await dbListManagedAccountAddresses(env.TRADINGBOT_DB, user.id);
    if (managed.length === 0) {
      throw new ApiError(400, 'No managed wallet imported — import a private key first');
    }
    resolvedSignerAddress = managed[0];
  }

  // Load the managed keypair for signing
  const keypairBytes = await dbLoadManagedKeypairBytes(
    env.TRADINGBOT_DB,
    user.id,
    resolvedSignerAddress,
    env.PRIVATE_KEY_ENCRYPTION_KEY,
  );

  // Resolve token decimals for amount calculation
  const tokenRecord = await env.TRADINGBOT_DB
    .prepare('SELECT decimals FROM tradable_tokens WHERE network = ?1 AND contract_address = ?2')
    .bind('solana', targetMint)
    .first<{ decimals: number | null }>();
  const tokenDecimals = tokenRecord?.decimals ?? 6;

  // Calculate atomic units for the quote
  const USDC_DECIMALS = 6;
  let inputMint: string;
  let outputMint: string;
  let amountAtomicUnits: string;

  if (action === 'BUY') {
    // Spend USDC → receive target token
    inputMint = SOLANA_USDC_MINT;
    outputMint = targetMint;
    amountAtomicUnits = String(Math.round(body.requestedAmount * 10 ** USDC_DECIMALS));
  } else {
    // Spend target token → receive USDC
    inputMint = targetMint;
    outputMint = SOLANA_USDC_MINT;
    amountAtomicUnits = String(Math.round(body.requestedAmount * 10 ** tokenDecimals));
  }

  const slippageBps = Math.round(settings.maxSlippage * 100); // % → bps

  // Resolve the token record for audit
  const tokenId = await dbResolveTradableTokenId(env.TRADINGBOT_DB, targetMint);
  const setupId = await dbGetLatestHistoricalSetupId(env.TRADINGBOT_DB, user.id);

  let tradeLogId: number | null = null;
  if (tokenId) {
    const logRow = await env.TRADINGBOT_DB
      .prepare(
        `INSERT INTO trade_logs (
           token_id, setup_id, wallet_address, action,
           requested_amount, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', ?6, ?6)
         RETURNING id`,
      )
      .bind(tokenId, setupId, resolvedSignerAddress, action, body.requestedAmount, nowTs())
      .first<{ id: number }>();
    tradeLogId = logRow?.id ?? null;
  }

  try {
    // 1. Get swap quote from Jupiter
    const quote = await fetchJupiterSwapQuote(
      inputMint,
      outputMint,
      amountAtomicUnits,
      slippageBps,
    );

    // 2. Build the transaction via Jupiter
    const unsignedTxBytes = await buildJupiterSwapTransaction(quote, resolvedSignerAddress);

    // 3. Sign with the managed keypair
    const signedTxBytes = signSolanaTransaction(unsignedTxBytes, keypairBytes);

    // 4. Broadcast to Solana
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );
    const txSignature = await sendSolanaTransaction(rpcUrls, signedTxBytes);

    // 5. Compute the executed amounts from the quote
    const executedAmountRaw = Number(action === 'BUY' ? quote.outAmount : quote.inAmount);
    const executedDecimals = action === 'BUY' ? tokenDecimals : USDC_DECIMALS;
    const executedAmount = executedAmountRaw / 10 ** executedDecimals;

    // 6. Update trade log with success
    if (tradeLogId != null) {
      await env.TRADINGBOT_DB
        .prepare(
          `UPDATE trade_logs
           SET status = 'PENDING', tx_signature = ?2, executed_amount = ?3, updated_at = ?4
           WHERE id = ?1`,
        )
        .bind(tradeLogId, txSignature, executedAmount, nowTs())
        .run();
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'trade.submitted',
      txSignature,
      `${action} ${body.requestedAmount} (${action === 'BUY' ? 'USDC → ' + targetMint : targetMint + ' → USDC'}) via Jupiter. Tx: ${txSignature}`,
    );

    return jsonResponse({
      txSignature,
      action,
      inputMint,
      outputMint,
      requestedAmount: body.requestedAmount,
      executedAmount,
      slippageBps,
      status: 'PENDING',
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (tradeLogId != null) {
      await env.TRADINGBOT_DB
        .prepare(
          `UPDATE trade_logs SET status = 'FAILED', error_message = ?2, updated_at = ?3 WHERE id = ?1`,
        )
        .bind(tradeLogId, errorMessage, nowTs())
        .run();
    }
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'trade.failed',
      targetMint,
      `${action} trade failed: ${errorMessage}`,
    );
    throw err instanceof ApiError ? err : new ApiError(502, `Trade failed: ${errorMessage}`);
  }
}

// POST /api/admin/password - Change admin password
async function handleAdminChangePassword(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const currentToken = sessionTokenFromCookie(request.headers.get('Cookie'));
  const body = await request.json<{ oldPassword: string; newPassword: string }>();

  if (!body.oldPassword || !body.newPassword) {
    throw new ApiError(400, 'Old and new passwords are required');
  }

  // Verify old password
  const dbUser = await env.TRADINGBOT_DB
    .prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(user.id)
    .first<{ password_hash: string }>();

  if (!dbUser) throw new ApiError(401, 'User not found');

  const oldPasswordValid = await verifyPassword(body.oldPassword, dbUser.password_hash);
  if (!oldPasswordValid) throw new ApiError(401, 'Old password is incorrect');

  validatePassword(body.newPassword);
  const newPasswordHash = await hashPassword(body.newPassword);

  // Update password
  await env.TRADINGBOT_DB
    .prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2')
    .bind(newPasswordHash, user.id)
    .run();
  await dbDeleteOtherSessions(env.TRADINGBOT_DB, user.id, currentToken);

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'admin.password_changed',
    user.username,
    'Admin password was changed',
  );

  return jsonResponse({ success: true, message: 'Password updated successfully' }, 200);
}

// GET /api/wallets/{address}/balance
async function handleGetWalletBalance(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireUser(request, env);
  const addressPath = decodeURIComponent(url.pathname.split('/')[3] ?? '');
  const address = normalizePubkey(addressPath);
  const ownsAccount = await dbUserOwnsAccount(
    env.TRADINGBOT_DB,
    user.id,
    address,
  );
  if (!ownsAccount) {
    throw new ApiError(404, 'Wallet not found for the current user');
  }
  const [settings, tradableTokens] = await Promise.all([
    dbLoadSettings(env.TRADINGBOT_DB, user.id),
    dbListTradableTokens(env.TRADINGBOT_DB),
  ]);
  const rpcUrls = await dbResolveSolanaRpcUrls(
    env.TRADINGBOT_DB,
    user.id,
    env.SOLANA_RPC_URL,
  );
  const balance = await loadWalletBalance(
    address,
    settings,
    tradableTokens,
    rpcUrls,
  );
  return jsonResponse(balance);
}

// DELETE /api/admin/private-keys/{address} - Delete imported private key
async function handleAdminDeletePrivateKey(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const adminPasswordHeader = request.headers.get('Authorization')?.trim();
  if (adminPasswordHeader) {
    const passwordValid = await dbVerifyUserPassword(
      env.TRADINGBOT_DB,
      user.id,
      adminPasswordHeader,
    );
    if (!passwordValid) {
      throw new ApiError(401, 'Admin password is incorrect');
    }
  }
  const addressPath = url.pathname.split('/').pop();

  if (!addressPath) {
    throw new ApiError(400, 'Wallet address is required');
  }

  // Verify the wallet exists and belongs to this user
  const account = await env.TRADINGBOT_DB
    .prepare(
      "SELECT id, label FROM accounts WHERE user_id = ?1 AND wallet_address = ?2 AND type = 'managed'",
    )
    .bind(user.id, addressPath)
    .first<{ id: number; label: string }>();

  if (!account) {
    throw new ApiError(404, 'Wallet not found or does not belong to this user');
  }

  // Delete the account
  await env.TRADINGBOT_DB
    .prepare('DELETE FROM accounts WHERE id = ?1')
    .bind(account.id)
    .run();

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'admin.private_key_deleted',
    addressPath,
    `Deleted managed key '${account.label}'`,
  );

  return jsonResponse({ success: true, message: 'Wallet deleted successfully' }, 200);
}

// ─── API router ───────────────────────────────────────────────────────────────

async function handleApi(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = url;
  const { method } = request;

  try {
    if (method === 'GET' && pathname === '/api/health')
      return await handleHealth(request, env);
    if (method === 'GET' && pathname === '/api/debug/webhook-transactions')
      return await handleDebugWebhookTransactions(request, url, env);
    if (method === 'GET' && pathname === '/api/auth/status')
      return await handleAuthStatus(request, env);
    if (method === 'POST' && pathname === '/api/auth/bootstrap')
      return await handleBootstrap(request, env);
    if (method === 'POST' && pathname === '/api/auth/login')
      return await handleLogin(request, env);
    if (method === 'POST' && pathname === '/api/auth/logout')
      return await handleLogout(request, env);
    if (method === 'GET' && pathname === '/api/state')
      return await handleGetState(request, env);
    if (method === 'POST' && pathname === '/api/webhooks/alchemy/notify')
      return await handleAlchemyNotifyWebhook(request, url, env, ctx);
    if (method === 'POST' && pathname === '/api/settings/active-token')
      return await handleSaveActiveToken(request, env);
    if (method === 'POST' && pathname === '/api/settings')
      return await handleSaveSettings(request, env);
    if (method === 'POST' && pathname === '/api/strategy/active')
      return await handleSaveActiveStrategy(request, env);
    if (method === 'POST' && pathname === '/api/strategy/versions/cleanup')
      return await handleCleanupStrategyVersions(request, env);
    if (method === 'POST' && pathname === '/api/tradable-tokens')
      return await handleAddTradableToken(request, env);
    if (method === 'POST' && pathname === '/api/market-snapshot/refresh')
      return await handleForceRefreshMarketSnapshot(request, env);
    if (method === 'GET' && pathname === '/api/market-snapshots')
      return await handleGetMarketSnapshotsByTimeRange(request, url, env);
    if (method === 'POST' && pathname === '/api/rpc-endpoints')
      return await handleAddRpcEndpoint(request, env);
    if (method === 'POST' && pathname === '/api/private-keys/import')
      return await handleImportManagedWallet(request, env);
    if (method === 'POST' && pathname === '/api/admin/private-keys')
      return await handleImportManagedWallet(request, env);
    if (method === 'POST' && pathname === '/api/accounts/import')
      return await handleImportAccount(request, env);
    if (method === 'POST' && pathname === '/api/trade')
      return await handleTrade(request, env);
    if (method === 'POST' && pathname === '/api/admin/password')
      return await handleAdminChangePassword(request, env);
    if (method === 'GET' && /^\/api\/wallets\/[^/]+\/balance$/.test(pathname))
      return await handleGetWalletBalance(request, url, env);
    if (method === 'DELETE' && /^\/api\/rpc-endpoints\/\d+$/.test(pathname))
      return await handleDeleteRpcEndpoint(request, url, env);
    if (method === 'DELETE' && pathname.startsWith('/api/admin/private-keys/'))
      return await handleAdminDeletePrivateKey(request, url, env);
    return jsonResponse({ error: 'Not found' }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── Worker entry point ───────────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env, ctx);
    }

    // Pass all other requests through to the static assets binding
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
