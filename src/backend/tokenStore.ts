import { ApiError } from './errors';
import { fetchJupiterTokenMetadata } from './jupiter';
import { nowTs, normalizeTimestampMs } from './time';
import { dedupeStrings, normalizePubkey, normalizeRpcUrl } from './workerCore';
import { dbEnsureTradeDomainSchema } from './workerSchema';
import type {
  RpcEndpoint,
  RpcEndpointCreateRequest,
  TokenMarketSnapshot,
  TradableToken,
  TradableTokenCreateRequest,
} from './workerShared';

export async function dbListRpcEndpoints(
  db: D1Database,
  userId: number,
  network = 'solana',
): Promise<RpcEndpoint[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      'SELECT id, network, url, created_at FROM rpc_endpoints WHERE user_id = ?1 AND network = ?2 ORDER BY created_at DESC, id DESC',
    )
    .bind(userId, network)
    .all<{
      id: number;
      network: string;
      url: string;
      created_at: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    network: row.network,
    url: row.url,
    createdAt: row.created_at,
  }));
}

export async function dbResolveSolanaRpcUrls(
  db: D1Database,
  userId: number,
  envRpcUrl?: string,
): Promise<string[]> {
  const endpoints = await dbListRpcEndpoints(db, userId, 'solana');
  return dedupeStrings([
    ...endpoints.map((endpoint) => endpoint.url),
    envRpcUrl ?? '',
  ]);
}

export async function dbAddRpcEndpoint(
  db: D1Database,
  userId: number,
  input: RpcEndpointCreateRequest,
): Promise<RpcEndpoint> {
  await dbEnsureTradeDomainSchema(db);
  const network = input.network.trim().toLowerCase();
  if (network !== 'solana') {
    throw new ApiError(400, 'Only the solana network is supported right now');
  }
  const url = normalizeRpcUrl(input.url);
  const createdAt = nowTs();
  try {
    await db
      .prepare(
        'INSERT INTO rpc_endpoints (user_id, network, url, created_at) VALUES (?1, ?2, ?3, ?4)',
      )
      .bind(userId, network, url, createdAt)
      .run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      throw new ApiError(409, 'This RPC endpoint has already been added');
    }
    throw err;
  }
  const row = await db
    .prepare(
      'SELECT id, network, url, created_at FROM rpc_endpoints WHERE user_id = ?1 AND network = ?2 AND url = ?3',
    )
    .bind(userId, network, url)
    .first<{
      id: number;
      network: string;
      url: string;
      created_at: number;
    }>();
  if (!row) throw new ApiError(500, 'Failed to load the saved RPC endpoint');
  return {
    id: row.id,
    network: row.network,
    url: row.url,
    createdAt: row.created_at,
  };
}

export async function dbDeleteRpcEndpoint(
  db: D1Database,
  userId: number,
  endpointId: number,
): Promise<RpcEndpoint> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      'SELECT id, network, url, created_at FROM rpc_endpoints WHERE id = ?1 AND user_id = ?2',
    )
    .bind(endpointId, userId)
    .first<{
      id: number;
      network: string;
      url: string;
      created_at: number;
    }>();
  if (!row) {
    throw new ApiError(404, 'RPC endpoint not found');
  }
  await db.prepare('DELETE FROM rpc_endpoints WHERE id = ?1').bind(endpointId).run();
  return {
    id: row.id,
    network: row.network,
    url: row.url,
    createdAt: row.created_at,
  };
}

export async function dbListTradableTokens(db: D1Database): Promise<TradableToken[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      'SELECT id, network, contract_address, symbol, name, decimals, is_active FROM tradable_tokens ORDER BY id ASC',
    )
    .all<{
      id: number;
      network: string;
      contract_address: string;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      is_active: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    network: row.network,
    contractAddress: row.contract_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    isActive: row.is_active === 1,
  }));
}

export async function dbCreateTradableToken(
  db: D1Database,
  input: TradableTokenCreateRequest,
  decimals: number | null,
): Promise<TradableToken> {
  await dbEnsureTradeDomainSchema(db);
  const network = input.network.trim().toLowerCase();
  if (network !== 'solana') {
    throw new ApiError(400, 'Only the solana network is supported right now');
  }
  const contractAddress = normalizePubkey(input.contractAddress);
  const createdAt = nowTs();

  // Enrich with Jupiter token metadata (name, symbol, decimals)
  let jupiterName: string | null = null;
  let jupiterSymbol: string | null = null;
  let resolvedDecimals = decimals;
  try {
    const jupiterMeta = await fetchJupiterTokenMetadata(contractAddress);
    if (jupiterMeta) {
      jupiterName = jupiterMeta.name;
      jupiterSymbol = jupiterMeta.symbol;
      if (resolvedDecimals == null && jupiterMeta.decimals != null) {
        resolvedDecimals = jupiterMeta.decimals;
      }
    }
  } catch {
    // non-fatal: token may not be in Jupiter's verified list yet
  }

  await db
    .prepare(
      `INSERT INTO tradable_tokens (
         network,
         contract_address,
         symbol,
         name,
         decimals,
         is_active,
         created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
       ON CONFLICT(network, contract_address) DO UPDATE SET
         is_active = 1,
         symbol = COALESCE(?3, tradable_tokens.symbol),
         name = COALESCE(?4, tradable_tokens.name),
         decimals = COALESCE(?5, tradable_tokens.decimals)`,
    )
    .bind(network, contractAddress, jupiterSymbol, jupiterName, resolvedDecimals, createdAt)
    .run();
  const row = await db
    .prepare(
      'SELECT id, network, contract_address, symbol, name, decimals, is_active FROM tradable_tokens WHERE network = ?1 AND contract_address = ?2',
    )
    .bind(network, contractAddress)
    .first<{
      id: number;
      network: string;
      contract_address: string;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      is_active: number;
    }>();
  if (!row) throw new ApiError(500, 'Failed to load the saved token');
  return {
    id: row.id,
    network: row.network,
    contractAddress: row.contract_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    isActive: row.is_active === 1,
  };
}

export async function dbUpdateTradableTokenMetadata(
  db: D1Database,
  tokenId: number,
  snapshot: TokenMarketSnapshot,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  await db
    .prepare(
      `UPDATE tradable_tokens
       SET symbol = COALESCE(?2, symbol),
           name = COALESCE(?3, name)
       WHERE id = ?1`,
    )
    .bind(tokenId, snapshot.tokenSymbol, snapshot.tokenName)
    .run();
}

export async function dbResolveTradableTokenId(
  db: D1Database,
  contractAddress: string,
): Promise<number | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      'SELECT id FROM tradable_tokens WHERE network = ?1 AND contract_address = ?2 LIMIT 1',
    )
    .bind('solana', normalizePubkey(contractAddress))
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function dbGetLatestTokenMarketSnapshot(
  db: D1Database,
  tokenId: number,
): Promise<TokenMarketSnapshot | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `SELECT
         network,
         contract_address,
         token_name,
         token_symbol,
         price_usd,
         liquidity_usd,
         fdv,
         volume_24h,
         total_transactions_24h,
         outsiders_over_one_usd,
         dex_id,
         pair_address,
         fetched_at
       FROM token_market_snapshots
       WHERE token_id = ?1
       ORDER BY CASE
         WHEN fetched_at < 1000000000000 THEN fetched_at * 1000
         ELSE fetched_at
       END DESC, id DESC
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      network: string;
      contract_address: string;
      token_name: string | null;
      token_symbol: string | null;
      price_usd: number | null;
      liquidity_usd: number | null;
      fdv: number | null;
      volume_24h: number | null;
      total_transactions_24h: number | null;
      outsiders_over_one_usd: number | null;
      dex_id: string | null;
      pair_address: string | null;
      fetched_at: number;
    }>();
  if (!row) {
    return null;
  }
  return {
    network: row.network,
    contractAddress: row.contract_address,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    priceUsd: row.price_usd,
    liquidityUsd: row.liquidity_usd,
    fdv: row.fdv,
    volume24h: row.volume_24h,
    totalTransactions24h: row.total_transactions_24h,
    outsidersOverOneUsd: row.outsiders_over_one_usd,
    dexId: row.dex_id,
    pairAddress: row.pair_address,
    fetchedAt: normalizeTimestampMs(row.fetched_at),
  };
}

export async function dbInsertTokenMarketSnapshot(
  db: D1Database,
  tokenId: number,
  snapshot: TokenMarketSnapshot,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  await db
    .prepare(
      `INSERT INTO token_market_snapshots (
        token_id,
        network,
        contract_address,
        token_name,
        token_symbol,
        price_usd,
        liquidity_usd,
        fdv,
        volume_24h,
        total_transactions_24h,
        outsiders_over_one_usd,
        dex_id,
        pair_address,
        fetched_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
    .bind(
      tokenId,
      snapshot.network,
      snapshot.contractAddress,
      snapshot.tokenName,
      snapshot.tokenSymbol,
      snapshot.priceUsd,
      snapshot.liquidityUsd,
      snapshot.fdv,
      snapshot.volume24h,
      snapshot.totalTransactions24h,
      snapshot.outsidersOverOneUsd,
      snapshot.dexId,
      snapshot.pairAddress,
      snapshot.fetchedAt,
    )
    .run();
}

// Query market snapshots within a time range
export async function dbGetTokenMarketSnapshotsByTimeRange(
  db: D1Database,
  tokenId: number,
  startTime: number,
  endTime: number,
  limit: number = 100,
): Promise<TokenMarketSnapshot[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `SELECT
         network,
         contract_address,
         token_name,
         token_symbol,
         price_usd,
         liquidity_usd,
         fdv,
         volume_24h,
         total_transactions_24h,
         outsiders_over_one_usd,
         dex_id,
         pair_address,
         fetched_at
       FROM token_market_snapshots
       WHERE token_id = ?1
         AND CASE
           WHEN fetched_at < 1000000000000 THEN fetched_at * 1000
           ELSE fetched_at
         END >= ?2
         AND CASE
           WHEN fetched_at < 1000000000000 THEN fetched_at * 1000
           ELSE fetched_at
         END <= ?3
       ORDER BY CASE
         WHEN fetched_at < 1000000000000 THEN fetched_at * 1000
         ELSE fetched_at
       END DESC, id DESC
       LIMIT ?4`,
    )
    .bind(tokenId, startTime, endTime, limit)
    .all<{
      network: string;
      contract_address: string;
      token_name: string | null;
      token_symbol: string | null;
      price_usd: number | null;
      liquidity_usd: number | null;
      fdv: number | null;
      volume_24h: number | null;
      total_transactions_24h: number | null;
      outsiders_over_one_usd: number | null;
      dex_id: string | null;
      pair_address: string | null;
      fetched_at: number;
    }>();

  return rows.results.map((row) => ({
    network: row.network,
    contractAddress: row.contract_address,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    priceUsd: row.price_usd,
    liquidityUsd: row.liquidity_usd,
    fdv: row.fdv,
    volume24h: row.volume_24h,
    totalTransactions24h: row.total_transactions_24h,
    outsidersOverOneUsd: row.outsiders_over_one_usd,
    dexId: row.dex_id,
    pairAddress: row.pair_address,
    fetchedAt: normalizeTimestampMs(row.fetched_at),
  }));
}

