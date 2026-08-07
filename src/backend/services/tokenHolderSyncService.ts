import { ApiError } from '../errors';
import { fetchJupiterTokenMetadata } from '../jupiter';
import { nowTs } from '../time';
import {
  dbApplyTokenHolderBalanceShardDelta,
  dbCountTokenHolderSyncStageHolders,
  dbFinalizePagedTokenHolderSync,
  dbGetTokenHolderSyncState,
  dbPutTokenHolderSyncState,
  dbRecomputeTokenHolderAggregate,
  dbStartOrResumeTokenHolderSync,
  dbSyncTokenHolderBalances,
} from '../tokenHolders';
import {
  base58Encode,
  buildTokenHolderSyncSummary,
  decodeBase64Bytes,
  dedupeStrings,
  fetchSolanaMintDecimals,
  getTokenHolderSyncShardCursor,
  isHeliusRpcUrl,
  isSolanaRpcRateLimitError,
  normalizeHeliusRpcUrl,
  readNonEmptyString,
  readUint64LittleEndian,
  solanaRpc,
  tryNormalizeSolanaPubkey,
} from '../workerCore';
import {
  SOLANA_SPL_TOKEN_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT,
  TOKEN_HOLDER_SYNC_PROGRAM_IDS,
  TOKEN_HOLDER_SYNC_SHARDS_PER_REFRESH,
  TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
  type TokenHolderSyncStateRecord,
  type TokenHolderSyncSummary,
} from '../workerShared';

const HOLDER_SYNC_PROGRAM_ACCOUNTS_PRIMARY_RPC_URL =
  'https://api.mainnet-beta.solana.com';
const HOLDER_SYNC_ACCOUNT_DETAILS_PRIMARY_RPC_URL =
  'https://mainnet.helius-rpc.com/?api-key=fda76be1-7d09-4880-80db-837831934193';
const HOLDER_SYNC_DAS_PAGE_LIMIT = 1000;
const HOLDER_SYNC_PROGRAM_ACCOUNTS_INTERVAL_MS = 10_000;
const HOLDER_SYNC_ACCOUNT_DETAILS_REQUESTS_PER_SECOND = 4;
const HOLDER_SYNC_ACCOUNT_DETAILS_INTERVAL_MS = Math.ceil(
  1000 / HOLDER_SYNC_ACCOUNT_DETAILS_REQUESTS_PER_SECOND,
);

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HeliusDasTokenAccountsResult {
  total?: number;
  limit?: number;
  cursor?: unknown;
  token_accounts?: Array<{
    owner?: unknown;
    amount?: unknown;
  }>;
}

function normalizeHolderRpcUrls(rpcUrls: string | string[]): string[] {
  return dedupeStrings(
    (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls])
      .map((url) => url.trim())
      .filter((url) => url.length > 0),
  );
}

function preferHeliusRpcUrls(urls: string[]): string[] {
  return [...urls].sort((left, right) => {
    const leftScore = isHeliusRpcUrl(left) ? 0 : 1;
    const rightScore = isHeliusRpcUrl(right) ? 0 : 1;
    return leftScore - rightScore;
  });
}

function buildHolderDasRpcUrls(rpcUrls: string | string[]): string[] {
  const heliusUrls = preferHeliusRpcUrls(
    normalizeHolderRpcUrls(rpcUrls)
      .filter((url) => isHeliusRpcUrl(url))
      .map((url) => normalizeHeliusRpcUrl(url)),
  );

  if (heliusUrls.length > 0) {
    return heliusUrls;
  }

  return [normalizeHeliusRpcUrl(HOLDER_SYNC_ACCOUNT_DETAILS_PRIMARY_RPC_URL)];
}

function readUnsignedBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

function buildHolderProgramAccountsRpcUrls(
  rpcUrls: string | string[],
): string[] {
  const urls = normalizeHolderRpcUrls(rpcUrls).filter(
    (url) => !isHeliusRpcUrl(url),
  );

  if (urls.length > 0) {
    return urls;
  }

  return [HOLDER_SYNC_PROGRAM_ACCOUNTS_PRIMARY_RPC_URL];
}

function buildHolderAccountDetailsRpcUrls(
  rpcUrls: string | string[],
): string[] {
  const urls = preferHeliusRpcUrls(normalizeHolderRpcUrls(rpcUrls));

  if (urls.length > 0) {
    return urls;
  }

  return [HOLDER_SYNC_ACCOUNT_DETAILS_PRIMARY_RPC_URL];
}

function buildHolderDasRpcUrl(rpcUrls: string | string[]): string {
  return buildHolderDasRpcUrls(rpcUrls)[0] ??
    normalizeHeliusRpcUrl(HOLDER_SYNC_ACCOUNT_DETAILS_PRIMARY_RPC_URL);
}

async function fetchHeliusTokenHolderBalances(
  rpcUrls: string | string[],
  mint: string,
  decimals: number,
): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  const rpcUrl = buildHolderDasRpcUrl(rpcUrls);
  const seenCursors = new Set<string>();
  const denominator = 10 ** decimals;
  let cursor: string | null = null;
  let page = 1;

  for (;;) {
    const result = await solanaRpc<HeliusDasTokenAccountsResult>(
      [rpcUrl],
      'getTokenAccounts',
      {
        mint,
        page,
        limit: HOLDER_SYNC_DAS_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
        options: { showZeroBalance: false },
      },
    );

    const tokenAccounts = Array.isArray(result.token_accounts)
      ? result.token_accounts
      : [];

    for (const tokenAccount of tokenAccounts) {
      const owner = tryNormalizeSolanaPubkey(tokenAccount.owner);
      const rawAmount = readUnsignedBigInt(tokenAccount.amount);
      if (!owner || rawAmount == null || rawAmount <= 0n) {
        continue;
      }
      const amountHolding = Number(rawAmount) / denominator;
      if (!Number.isFinite(amountHolding) || amountHolding <= 0) {
        continue;
      }
      balances.set(owner, (balances.get(owner) ?? 0) + amountHolding);
    }

    const nextCursor = readNonEmptyString(result.cursor);
    if (!nextCursor || tokenAccounts.length === 0 || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    page += 1;
  }

  return balances;
}

async function listSolanaTokenHolderAccountPubkeys(
  rpcUrls: string | string[],
  mint: string,
): Promise<string[]> {
  const filters = [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }];
  const tokenAccountPubkeys = new Set<string>();
  let successfulProgramCalls = 0;
  let lastListError: unknown = null;
  const programIds = [SOLANA_SPL_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID];
  const holderProgramAccountsRpcUrls = buildHolderProgramAccountsRpcUrls(rpcUrls);

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

  return [...tokenAccountPubkeys];
}

async function fetchSolanaTokenHolderBalancesForPubkeys(
  rpcUrls: string | string[],
  tokenAccountPubkeys: string[],
  decimals: number,
): Promise<Map<string, number>> {
  const holderAccountDetailsRpcUrls = buildHolderAccountDetailsRpcUrls(rpcUrls);
  const balances = new Map<string, number>();
  const chunkSize = 100;
  for (let index = 0; index < tokenAccountPubkeys.length; index += chunkSize) {
    const chunk = tokenAccountPubkeys.slice(index, index + chunkSize);
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

    if (index + chunkSize < tokenAccountPubkeys.length) {
      await waitMs(HOLDER_SYNC_ACCOUNT_DETAILS_INTERVAL_MS);
    }
  }

  return balances;
}

async function fetchSolanaTokenHolderBalances(
  rpcUrls: string | string[],
  mint: string,
  decimals: number,
): Promise<Map<string, number>> {
  const tokenAccountPubkeys = await listSolanaTokenHolderAccountPubkeys(
    rpcUrls,
    mint,
  );
  return fetchSolanaTokenHolderBalancesForPubkeys(
    rpcUrls,
    tokenAccountPubkeys,
    decimals,
  );
}

async function fetchSolanaTokenHolderBalanceShard(
  rpcUrls: string | string[],
  mint: string,
  programId: (typeof TOKEN_HOLDER_SYNC_PROGRAM_IDS)[number],
  ownerPrefix: number,
  decimals: number,
): Promise<Map<string, number>> {
  const holderProgramAccountsRpcUrls = buildHolderProgramAccountsRpcUrls(rpcUrls);
  const ownerPrefixFilter = base58Encode(Uint8Array.of(ownerPrefix));
  const filters =
    programId === SOLANA_TOKEN_2022_PROGRAM_ID
      ? [
          { memcmp: { offset: 0, bytes: mint } },
          { memcmp: { offset: 32, bytes: ownerPrefixFilter } },
        ]
      : [
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
  >(holderProgramAccountsRpcUrls, 'getProgramAccounts', [
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

async function completeTokenHolderBalanceSync(
  db: D1Database,
  userId: number,
  tokenId: number,
  balances: Map<string, number>,
  source: string,
  timestamp: number,
  existingState: TokenHolderSyncStateRecord | null,
  shardsProcessedThisRun = 0,
): Promise<TokenHolderSyncSummary> {
  const { activeHolderCount, upsertedCount, zeroedCount } =
    await dbSyncTokenHolderBalances(db, tokenId, balances, source);

  await dbRecomputeTokenHolderAggregate(db, userId, tokenId, {
    source,
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
    source,
    nextShardIndex: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
    processedShardCount: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
    totalShardCount: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
    stagedHolderCount: activeHolderCount,
    lastProgramId:
      source === 'helius_das'
        ? null
        : TOKEN_HOLDER_SYNC_PROGRAM_IDS[TOKEN_HOLDER_SYNC_PROGRAM_IDS.length - 1],
    lastOwnerPrefix:
      source === 'helius_das'
        ? null
        : TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT - 1,
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
    shardsProcessedThisRun,
  });
}

async function trySyncSolanaTokenHolderBalancesWithHeliusDas(
  db: D1Database,
  userId: number,
  tokenId: number,
  mint: string,
  rpcUrls: string | string[],
  decimals: number,
  existingState: TokenHolderSyncStateRecord | null,
): Promise<TokenHolderSyncSummary | null> {
  try {
    const balances = await fetchHeliusTokenHolderBalances(rpcUrls, mint, decimals);
    if (balances.size === 0) {
      return null;
    }
    return await completeTokenHolderBalanceSync(
      db,
      userId,
      tokenId,
      balances,
      'helius_das',
      nowTs(),
      existingState,
      1,
    );
  } catch (err: unknown) {
    console.warn(`Helius DAS holder sync failed for ${mint}:`, err);
    return null;
  }
}

export async function syncSolanaTokenHolderBalancesPaged(
  db: D1Database,
  userId: number,
  tokenId: number,
  mint: string,
  rpcUrls: string | string[],
  options?: {
    maxShards?: number;
    continueUntilFirstStage?: boolean;
    timeBudgetMs?: number;
    ensureActive?: () => Promise<void>;
  },
): Promise<TokenHolderSyncSummary> {
  const maxShards = options?.maxShards ?? TOKEN_HOLDER_SYNC_SHARDS_PER_REFRESH;
  const state = await dbStartOrResumeTokenHolderSync(db, tokenId);
  const decimals = await resolveHolderSyncTokenDecimals(
    db,
    tokenId,
    mint,
    rpcUrls,
  );
  if (decimals == null) {
    const failedState = await dbPutTokenHolderSyncState(db, {
      ...state,
      status: 'failed',
      errorMessage: 'Failed to resolve token mint decimals for holder sync',
      updatedAt: nowTs(),
    });
    return buildTokenHolderSyncSummary(failedState);
  }

  const heliusDasSummary = await trySyncSolanaTokenHolderBalancesWithHeliusDas(
    db,
    userId,
    tokenId,
    mint,
    rpcUrls,
    decimals,
    state,
  );
  if (heliusDasSummary) {
    return heliusDasSummary;
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

      if (options?.ensureActive) {
        await options.ensureActive();
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
        await dbApplyTokenHolderBalanceShardDelta(
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
    let completedSummary = await dbFinalizePagedTokenHolderSync(
      db,
      userId,
      currentState,
    );
    if (completedSummary.activeHolderCount === 0) {
      const fullSyncSummary = await syncSolanaTokenHolderBalancesFull(
        db,
        userId,
        tokenId,
        mint,
        rpcUrls,
      );
      if (fullSyncSummary.activeHolderCount > 0) {
        completedSummary = fullSyncSummary;
      }
    }
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

export async function syncSolanaTokenHolderBalancesFull(
  db: D1Database,
  userId: number,
  tokenId: number,
  mint: string,
  rpcUrls: string | string[],
): Promise<TokenHolderSyncSummary> {
  const timestamp = nowTs();
  const existingState = await dbGetTokenHolderSyncState(db, tokenId);

  try {
    const decimals = await resolveHolderSyncTokenDecimals(
      db,
      tokenId,
      mint,
      rpcUrls,
    );
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
    let balances: Map<string, number> | null = null;
    let source = 'helius_das';
    try {
      balances = await fetchHeliusTokenHolderBalances(rpcUrls, mint, decimals);
      if (balances.size === 0) {
        balances = null;
      }
    } catch (err: unknown) {
      console.warn(`Helius DAS full holder sync failed for ${mint}:`, err);
      balances = null;
    }
    if (!balances) {
      source = 'rpc_full_sync';
      balances = await fetchSolanaTokenHolderBalances(rpcUrls, mint, decimals);
    }

    return await completeTokenHolderBalanceSync(
      db,
      userId,
      tokenId,
      balances,
      source,
      timestamp,
      existingState,
      source === 'helius_das' ? 1 : TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
    );
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

async function resolveHolderSyncTokenDecimals(
  db: D1Database,
  tokenId: number,
  mint: string,
  rpcUrls: string | string[],
): Promise<number | null> {
  const storedDecimals = (
    await db
      .prepare('SELECT decimals FROM tradable_tokens WHERE id = ?1')
      .bind(tokenId)
      .first<{ decimals: number | null }>()
  )?.decimals;
  if (storedDecimals != null) {
    return storedDecimals;
  }

  try {
    const jupiterMeta = await fetchJupiterTokenMetadata(mint);
    if (jupiterMeta?.decimals != null) {
      return jupiterMeta.decimals;
    }
  } catch (err: unknown) {
    console.warn(`Failed to resolve holder sync decimals from Jupiter for ${mint}:`, err);
  }

  try {
    return await fetchSolanaMintDecimals(
      buildHolderProgramAccountsRpcUrls(rpcUrls),
      mint,
    );
  } catch (err: unknown) {
    console.warn(`Failed to resolve holder sync decimals from Solana RPC for ${mint}:`, err);
    return null;
  }
}

