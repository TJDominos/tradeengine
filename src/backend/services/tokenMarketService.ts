import { ApiError } from '../errors';
import {
  fetchJupiterPriceViaQuote,
  fetchJupiterTokenMetadata,
  type JupiterTokenMetadata,
} from '../jupiter';
import { nowMs } from '../time';
import {
  dbGetLatestTokenMarketSnapshot,
  dbInsertTokenMarketSnapshot,
  dbResolveTradableTokenId,
  dbUpdateTradableTokenMetadata,
} from '../tokenStore';
import { dbListManagedAccountAddresses } from '../userStore';
import {
  fetchSolanaMintDecimals,
  formatTokenAmount,
  normalizePubkey,
  readTokenMarketCache,
  solanaRpc,
  tokenMarketCacheKey,
  writeTokenMarketCache,
} from '../workerCore';
import {
  SOLANA_SPL_TOKEN_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  TOKEN_MARKET_CACHE_TTL_MS,
  type TokenMarketSnapshot,
} from '../workerShared';

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const programIds = [SOLANA_SPL_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID];
  const programResults: PromiseSettledResult<
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
  >[] = [];

  for (let index = 0; index < programIds.length; index += 1) {
    const programId = programIds[index];
    try {
      const rows = await solanaRpc<
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
      ]);
      programResults.push({ status: 'fulfilled', value: rows });
    } catch (err: unknown) {
      programResults.push({ status: 'rejected', reason: err });
    }

    if (index < programIds.length - 1) {
      await waitMs(3000);
    }
  }

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

export async function syncTokenMarketSnapshotForUser(
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

  const storedDecimals: number | null = tokenId
    ? ((await db
        .prepare('SELECT decimals FROM tradable_tokens WHERE id = ?1')
        .bind(tokenId)
        .first<{ decimals: number | null }>())?.decimals ?? null)
    : null;

  let liveSnapshot: TokenMarketSnapshot | null = null;
  let jupiterMeta: JupiterTokenMetadata | null = null;
  try {
    jupiterMeta = await fetchJupiterTokenMetadata(normalizedAddress);

    let resolvedDecimals = storedDecimals ?? jupiterMeta?.decimals ?? null;
    if (resolvedDecimals == null) {
      try {
        resolvedDecimals = await fetchSolanaMintDecimals(rpcUrls, normalizedAddress);
      } catch {
        // Non-fatal.
      }
    }

    let jupiterPrice = jupiterMeta?.usdPrice ?? null;
    if (jupiterPrice == null && resolvedDecimals != null) {
      jupiterPrice = await fetchJupiterPriceViaQuote(normalizedAddress, resolvedDecimals);
    }

    if (jupiterPrice != null || jupiterMeta != null) {
      liveSnapshot = {
        network: normalizedNetwork,
        baseTokenAddress: normalizedAddress,
        tokenName: jupiterMeta?.name ?? latestStoredSnapshot?.tokenName ?? null,
        tokenSymbol: jupiterMeta?.symbol ?? latestStoredSnapshot?.tokenSymbol ?? null,
        priceUsd: jupiterPrice,
        liquidityUsd: jupiterMeta?.liquidityUsd ?? null,
        fdv: jupiterMeta?.fdv ?? null,
        volume24h: jupiterMeta?.volume24h ?? null,
        totalTransactions24h: jupiterMeta?.totalTransactions24h ?? null,
        totalHolders: jupiterMeta?.totalHolders ?? latestStoredSnapshot?.totalHolders ?? null,
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

    if (jupiterMeta?.totalHolders != null && jupiterMeta.totalHolders > 0) {
      outsidersOverOneUsd = Math.max(
        0,
        jupiterMeta.totalHolders - managedAccountAddresses.length,
      );
    } else if (liveSnapshot?.priceUsd != null) {
      outsidersOverOneUsd = await fetchSolanaOutsiderHolderCountOverOneUsd(
        rpcUrls,
        normalizedAddress,
        managedAccountAddresses,
        liveSnapshot.priceUsd,
      );
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

export async function loadStoredMarketSnapshotByContractAddress(
  db: D1Database,
  contractAddress: string,
  quoteTokenAddress?: string,
): Promise<TokenMarketSnapshot | null> {
  const tokenId = await dbResolveTradableTokenId(db, contractAddress, quoteTokenAddress);
  if (!tokenId) {
    return null;
  }
  return dbGetLatestTokenMarketSnapshot(db, tokenId);
}
