import { ApiError } from './errors';
import { fetchJupiterTokenMetadata } from './jupiter';
import { nowTs } from './time';
import {
  dedupeStrings,
  isHeliusRpcUrl,
  normalizeHeliusRpcUrl,
  normalizePubkey,
  normalizeRpcUrl,
  solanaRpc,
} from './workerCore';
import type {
  RpcEndpoint,
  RpcEndpointCreateRequest,
  TokenMarketSnapshot,
  TradableToken,
  TradableTokenCreateRequest,
} from './workerShared';
import { SOLANA_USDC_MINT } from './workerShared';
import { dbTableHasColumn } from './workerSchema';

function sortRpcEndpointsByPreference(endpoints: RpcEndpoint[]): RpcEndpoint[] {
  return [...endpoints].sort((left, right) => {
    if (left.isActive !== right.isActive) {
      return Number(right.isActive) - Number(left.isActive);
    }
    const leftIsHelius = isHeliusRpcUrl(left.url);
    const rightIsHelius = isHeliusRpcUrl(right.url);
    if (leftIsHelius !== rightIsHelius) {
      return leftIsHelius ? -1 : 1;
    }
    return right.createdAt - left.createdAt || right.id - left.id;
  });
}

export async function dbListRpcEndpoints(
  db: D1Database,
  userId: number,
  network = 'solana',
): Promise<RpcEndpoint[]> {
  const rows = await db
    .prepare(
      'SELECT id, network, url, is_active, created_at FROM rpc_endpoints WHERE user_id = ?1 AND network = ?2 ORDER BY created_at DESC, id DESC',
    )
    .bind(userId, network)
    .all<{
      id: number;
      network: string;
      url: string;
      is_active: number;
      created_at: number;
    }>();
  return sortRpcEndpointsByPreference(
    rows.results.map((row) => ({
      id: row.id,
      network: row.network,
      url: row.url,
      isActive: row.is_active !== 0,
      createdAt: row.created_at,
    })),
  );
}

export async function dbResolveSolanaRpcUrls(
  db: D1Database,
  userId: number,
  envRpcUrl?: string,
): Promise<string[]> {
  const endpoints = (await dbListRpcEndpoints(db, userId, 'solana')).filter(
    (endpoint) => endpoint.isActive,
  );
  return dedupeStrings([
    ...endpoints.map((endpoint) => normalizeHeliusRpcUrl(endpoint.url)),
    envRpcUrl ? normalizeHeliusRpcUrl(envRpcUrl) : '',
  ]);
}

export async function dbAddRpcEndpoint(
  db: D1Database,
  userId: number,
  input: RpcEndpointCreateRequest,
): Promise<RpcEndpoint> {
  const network = input.network.trim().toLowerCase();
  if (network !== 'solana') {
    throw new ApiError(400, 'Only the solana network is supported right now');
  }
  const url = normalizeRpcUrl(input.url);
  const createdAt = nowTs();
  try {
    await db
      .prepare(
        'INSERT INTO rpc_endpoints (user_id, network, url, created_at, is_active) VALUES (?1, ?2, ?3, ?4, 1)',
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
      'SELECT id, network, url, is_active, created_at FROM rpc_endpoints WHERE user_id = ?1 AND network = ?2 AND url = ?3',
    )
    .bind(userId, network, url)
    .first<{
      id: number;
      network: string;
      url: string;
      is_active: number;
      created_at: number;
    }>();
  if (!row) throw new ApiError(500, 'Failed to load the saved RPC endpoint');
  return {
    id: row.id,
    network: row.network,
    url: row.url,
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
  };
}

export async function dbDeleteRpcEndpoint(
  db: D1Database,
  userId: number,
  endpointId: number,
): Promise<RpcEndpoint> {
  const row = await db
    .prepare(
      'SELECT id, network, url, is_active, created_at FROM rpc_endpoints WHERE id = ?1 AND user_id = ?2',
    )
    .bind(endpointId, userId)
    .first<{
      id: number;
      network: string;
      url: string;
      is_active: number;
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
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
  };
}

export async function dbListTradableTokens(db: D1Database): Promise<TradableToken[]> {
  const rows = await db
    .prepare(
      `SELECT
         id,
         network,
        base_token_address,
         quote_token_address,
         amm_pool_address,
         symbol,
         name,
         decimals,
         quote_token_symbol,
         quote_token_name,
         quote_token_decimals,
         is_active
       FROM tradable_tokens
       WHERE is_active = 1
       ORDER BY id ASC`,
    )
    .all<{
      id: number;
      network: string;
      base_token_address: string;
      quote_token_address: string;
      amm_pool_address: string | null;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      quote_token_symbol: string | null;
      quote_token_name: string | null;
      quote_token_decimals: number | null;
      is_active: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    network: row.network,
    baseTokenAddress: row.base_token_address,
    quoteTokenAddress: row.quote_token_address,
    ammPoolAddress: row.amm_pool_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    quoteTokenSymbol: row.quote_token_symbol,
    quoteTokenName: row.quote_token_name,
    quoteTokenDecimals: row.quote_token_decimals,
    isActive: row.is_active === 1,
  }));
}

export async function dbCreateTradableToken(
  db: D1Database,
  input: TradableTokenCreateRequest,
  decimals: number | null,
): Promise<TradableToken> {
  const network = input.network.trim().toLowerCase();
  if (network !== 'solana') {
    throw new ApiError(400, 'Only the solana network is supported right now');
  }
  const contractAddress = normalizePubkey(input.baseTokenAddress);
  const quoteTokenAddress = normalizePubkey(input.quoteTokenAddress);
  const ammPoolAddress = input.ammPoolAddress?.trim()
    ? normalizePubkey(input.ammPoolAddress)
    : null;
  if (contractAddress === quoteTokenAddress) {
    throw new ApiError(400, 'Base and quote token addresses must be different');
  }
  const createdAt = nowTs();

  // Enrich with Jupiter token metadata (name, symbol, decimals)
  let jupiterName: string | null = null;
  let jupiterSymbol: string | null = null;
  let resolvedDecimals = decimals;
  let quoteTokenName: string | null = null;
  let quoteTokenSymbol: string | null = null;
  let quoteTokenDecimals: number | null = null;
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

  try {
    const quoteTokenMeta = await fetchJupiterTokenMetadata(quoteTokenAddress);
    if (quoteTokenMeta) {
      quoteTokenName = quoteTokenMeta.name;
      quoteTokenSymbol = quoteTokenMeta.symbol;
      quoteTokenDecimals = quoteTokenMeta.decimals;
    }
  } catch {
    // non-fatal
  }

  const findExistingTokenId = async (): Promise<number | null> => {
    const pairRow = await db
      .prepare(
        `SELECT id
         FROM tradable_tokens
         WHERE network = ?1 AND base_token_address = ?2 AND quote_token_address = ?3
         LIMIT 1`,
      )
      .bind(network, contractAddress, quoteTokenAddress)
      .first<{ id: number }>();
    if (pairRow?.id != null) {
      return pairRow.id;
    }
    return null;
  };

  const persistExistingToken = async (tokenId: number): Promise<void> => {
    await db
      .prepare(
        `UPDATE tradable_tokens
         SET base_token_address = ?2,
             quote_token_address = ?3,
             amm_pool_address = COALESCE(?4, amm_pool_address),
             symbol = COALESCE(?5, symbol),
             name = COALESCE(?6, name),
             decimals = COALESCE(?7, decimals),
             quote_token_symbol = COALESCE(?8, quote_token_symbol),
             quote_token_name = COALESCE(?9, quote_token_name),
             quote_token_decimals = COALESCE(?10, quote_token_decimals),
             is_active = 1
         WHERE id = ?1`,
      )
      .bind(
        tokenId,
        contractAddress,
        quoteTokenAddress,
        ammPoolAddress,
        jupiterSymbol,
        jupiterName,
        resolvedDecimals,
        quoteTokenSymbol,
        quoteTokenName,
        quoteTokenDecimals,
      )
      .run();
  };

  const insertNewToken = async (): Promise<void> => {
    await db
      .prepare(
        `INSERT INTO tradable_tokens (
           network,
           base_token_address,
           quote_token_address,
           amm_pool_address,
           symbol,
           name,
           decimals,
           quote_token_symbol,
           quote_token_name,
           quote_token_decimals,
           is_active,
           created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11)`,
      )
      .bind(
        network,
        contractAddress,
        quoteTokenAddress,
        ammPoolAddress,
        jupiterSymbol,
        jupiterName,
        resolvedDecimals,
        quoteTokenSymbol,
        quoteTokenName,
        quoteTokenDecimals,
        createdAt,
      )
      .run();
  };

  const existingTokenId = await findExistingTokenId();
  if (existingTokenId != null) {
    await persistExistingToken(existingTokenId);
  } else {
    try {
      await insertNewToken();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('UNIQUE constraint failed')) {
        throw err;
      }

      const conflictingTokenId = await findExistingTokenId();
      if (conflictingTokenId == null) {
        throw err;
      }
      await persistExistingToken(conflictingTokenId);
    }
  }

  const row = await db
    .prepare(
      `SELECT id, network, base_token_address, quote_token_address, amm_pool_address, symbol, name, decimals,
              quote_token_symbol, quote_token_name, quote_token_decimals, is_active
       FROM tradable_tokens
       WHERE network = ?1 AND base_token_address = ?2 AND quote_token_address = ?3`,
    )
    .bind(network, contractAddress, quoteTokenAddress)
    .first<{
      id: number;
      network: string;
      base_token_address: string;
      quote_token_address: string;
      amm_pool_address: string | null;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      quote_token_symbol: string | null;
      quote_token_name: string | null;
      quote_token_decimals: number | null;
      is_active: number;
    }>();
  if (!row) throw new ApiError(500, 'Failed to load the saved token');
  return {
    id: row.id,
    network: row.network,
    baseTokenAddress: row.base_token_address,
    quoteTokenAddress: row.quote_token_address,
    ammPoolAddress: row.amm_pool_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    quoteTokenSymbol: row.quote_token_symbol,
    quoteTokenName: row.quote_token_name,
    quoteTokenDecimals: row.quote_token_decimals,
    isActive: row.is_active === 1,
  };
}

export async function dbDeleteTradableToken(
  db: D1Database,
  tokenId: number,
): Promise<TradableToken> {
  const row = await db
    .prepare(
      `SELECT id, network, base_token_address, quote_token_address, amm_pool_address, symbol, name, decimals,
              quote_token_symbol, quote_token_name, quote_token_decimals, is_active
       FROM tradable_tokens WHERE id = ?1 LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      id: number;
      network: string;
      base_token_address: string;
      quote_token_address: string;
      amm_pool_address: string | null;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      quote_token_symbol: string | null;
      quote_token_name: string | null;
      quote_token_decimals: number | null;
      is_active: number;
    }>();
  if (!row || row.is_active === 0) {
    throw new ApiError(404, 'Tracked pair not found');
  }

  await db
    .prepare(
      `UPDATE tradable_tokens
       SET is_active = 0
       WHERE id = ?1`,
    )
    .bind(tokenId)
    .run();

  return {
    id: row.id,
    network: row.network,
    baseTokenAddress: row.base_token_address,
    quoteTokenAddress: row.quote_token_address,
    ammPoolAddress: row.amm_pool_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    quoteTokenSymbol: row.quote_token_symbol,
    quoteTokenName: row.quote_token_name,
    quoteTokenDecimals: row.quote_token_decimals,
    isActive: false,
  };
}

export async function dbUpdateTradableToken(
  db: D1Database,
  tokenId: number,
  input: Pick<TradableTokenCreateRequest, 'ammPoolAddress'>,
): Promise<TradableToken> {
  const ammPoolAddress = input.ammPoolAddress?.trim()
    ? normalizePubkey(input.ammPoolAddress)
    : null;

  await db
    .prepare(
      `UPDATE tradable_tokens
       SET amm_pool_address = ?2
       WHERE id = ?1 AND is_active = 1`,
    )
    .bind(tokenId, ammPoolAddress)
    .run();

  const row = await db
    .prepare(
      `SELECT id, network, base_token_address, quote_token_address, amm_pool_address, symbol, name, decimals,
              quote_token_symbol, quote_token_name, quote_token_decimals, is_active
       FROM tradable_tokens WHERE id = ?1 LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      id: number;
      network: string;
      base_token_address: string;
      quote_token_address: string;
      amm_pool_address: string | null;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      quote_token_symbol: string | null;
      quote_token_name: string | null;
      quote_token_decimals: number | null;
      is_active: number;
    }>();
  if (!row || row.is_active === 0) {
    throw new ApiError(404, 'Tracked pair not found');
  }

  return {
    id: row.id,
    network: row.network,
    baseTokenAddress: row.base_token_address,
    quoteTokenAddress: row.quote_token_address,
    ammPoolAddress: row.amm_pool_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    quoteTokenSymbol: row.quote_token_symbol,
    quoteTokenName: row.quote_token_name,
    quoteTokenDecimals: row.quote_token_decimals,
    isActive: row.is_active === 1,
  };
}

export async function checkTradableTokenWebhookSupport(
  rpcUrls: string | string[],
  contractAddress: string,
): Promise<{
  ok: boolean;
  checkedAt: number;
  latestSignature: string | null;
  errorMessage: string | null;
}> {
  const normalizedContractAddress = normalizePubkey(contractAddress);
  const checkedAt = nowTs();

  try {
    const results = await solanaRpc<Array<{ signature?: string | null }>>(
      rpcUrls,
      'getSignaturesForAddress',
      [normalizedContractAddress, { limit: 1 }],
    );
    return {
      ok: true,
      checkedAt,
      latestSignature: results[0]?.signature ?? null,
      errorMessage: null,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      checkedAt,
      latestSignature: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function dbUpdateTradableTokenMetadata(
  db: D1Database,
  tokenId: number,
  snapshot: TokenMarketSnapshot,
): Promise<void> {
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
  quoteTokenAddress?: string,
): Promise<number | null> {
  const normalizedContractAddress = normalizePubkey(contractAddress);
  const normalizedQuoteTokenAddress = quoteTokenAddress?.trim()
    ? normalizePubkey(quoteTokenAddress)
    : null;
  const row = normalizedQuoteTokenAddress
    ? await db
        .prepare(
          `SELECT id
           FROM tradable_tokens
           WHERE network = ?1 AND base_token_address = ?2 AND quote_token_address = ?3
           LIMIT 1`,
        )
        .bind('solana', normalizedContractAddress, normalizedQuoteTokenAddress)
        .first<{ id: number }>()
    : await db
        .prepare(
          `SELECT id
           FROM tradable_tokens
           WHERE network = ?1 AND base_token_address = ?2
           ORDER BY CASE WHEN quote_token_address = ?3 THEN 0 ELSE 1 END, id ASC
           LIMIT 1`,
        )
        .bind('solana', normalizedContractAddress, SOLANA_USDC_MINT)
        .first<{ id: number }>();
  return row?.id ?? null;
}

export async function dbFindTradableTokenByPair(
  db: D1Database,
  contractAddress: string,
  quoteTokenAddress: string,
): Promise<TradableToken | null> {
  const normalizedContractAddress = normalizePubkey(contractAddress);
  const normalizedQuoteTokenAddress = normalizePubkey(quoteTokenAddress);
  const row = await db
    .prepare(
      `SELECT id, network, base_token_address, quote_token_address, amm_pool_address, symbol, name, decimals,
              quote_token_symbol, quote_token_name, quote_token_decimals, is_active
       FROM tradable_tokens
       WHERE network = ?1 AND base_token_address = ?2 AND quote_token_address = ?3 AND is_active = 1
       LIMIT 1`,
    )
    .bind('solana', normalizedContractAddress, normalizedQuoteTokenAddress)
    .first<{
      id: number;
      network: string;
      base_token_address: string;
      quote_token_address: string;
      amm_pool_address: string | null;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      quote_token_symbol: string | null;
      quote_token_name: string | null;
      quote_token_decimals: number | null;
      is_active: number;
    }>();
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    network: row.network,
    baseTokenAddress: row.base_token_address,
    quoteTokenAddress: row.quote_token_address,
    ammPoolAddress: row.amm_pool_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    quoteTokenSymbol: row.quote_token_symbol,
    quoteTokenName: row.quote_token_name,
    quoteTokenDecimals: row.quote_token_decimals,
    isActive: row.is_active === 1,
  };
}

export async function dbFindTradableTokenById(
  db: D1Database,
  tokenId: number,
): Promise<TradableToken | null> {
  const row = await db
    .prepare(
      `SELECT id, network, base_token_address, quote_token_address, amm_pool_address, symbol, name, decimals,
              quote_token_symbol, quote_token_name, quote_token_decimals, is_active
       FROM tradable_tokens
       WHERE id = ?1 AND is_active = 1
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      id: number;
      network: string;
      base_token_address: string;
      quote_token_address: string;
      amm_pool_address: string | null;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      quote_token_symbol: string | null;
      quote_token_name: string | null;
      quote_token_decimals: number | null;
      is_active: number;
    }>();
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    network: row.network,
    baseTokenAddress: row.base_token_address,
    quoteTokenAddress: row.quote_token_address,
    ammPoolAddress: row.amm_pool_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    quoteTokenSymbol: row.quote_token_symbol,
    quoteTokenName: row.quote_token_name,
    quoteTokenDecimals: row.quote_token_decimals,
    isActive: row.is_active === 1,
  };
}

export async function dbGetLatestTokenMarketSnapshot(
  db: D1Database,
  tokenId: number,
): Promise<TokenMarketSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT
         network,
         base_token_address,
         token_name,
         token_symbol,
         price_usd,
         liquidity_usd,
         fdv,
         volume_24h,
        total_holders,
         total_transactions_24h,
         outsiders_over_one_usd,
         dex_id,
         pair_address,
         fetched_at
       FROM token_market_snapshots
       WHERE token_id = ?1
       ORDER BY fetched_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      network: string;
      base_token_address: string;
      token_name: string | null;
      token_symbol: string | null;
      price_usd: number | null;
      liquidity_usd: number | null;
      fdv: number | null;
      volume_24h: number | null;
      total_holders: number | null;
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
    baseTokenAddress: row.base_token_address,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    priceUsd: row.price_usd,
    liquidityUsd: row.liquidity_usd,
    fdv: row.fdv,
    volume24h: row.volume_24h,
    totalTransactions24h: row.total_transactions_24h,
    totalHolders: row.total_holders,
    outsidersOverOneUsd: row.outsiders_over_one_usd,
    dexId: row.dex_id,
    pairAddress: row.pair_address,
    fetchedAt: row.fetched_at,
  };
}

export async function dbInsertTokenMarketSnapshot(
  db: D1Database,
  tokenId: number,
  snapshot: TokenMarketSnapshot,
): Promise<void> {
  const hasLegacyContractAddress = await dbTableHasColumn(
    db,
    'token_market_snapshots',
    'contract_address',
  );
  const addressColumns = hasLegacyContractAddress
    ? 'contract_address, base_token_address'
    : 'base_token_address';
  const addressPlaceholders = hasLegacyContractAddress ? '?3, ?3' : '?3';
  await db
    .prepare(
      `INSERT INTO token_market_snapshots (
        token_id,
        network,
        ${addressColumns},
        token_name,
        token_symbol,
        price_usd,
        liquidity_usd,
        fdv,
        volume_24h,
        total_holders,
        total_transactions_24h,
        outsiders_over_one_usd,
        dex_id,
        pair_address,
        fetched_at
      ) VALUES (?1, ?2, ${addressPlaceholders}, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
    .bind(
      tokenId,
      snapshot.network,
      snapshot.baseTokenAddress,
      snapshot.tokenName,
      snapshot.tokenSymbol,
      snapshot.priceUsd,
      snapshot.liquidityUsd,
      snapshot.fdv,
      snapshot.volume24h,
      snapshot.totalHolders,
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
  const rows = await db
    .prepare(
      `SELECT
         network,
         base_token_address,
         token_name,
         token_symbol,
         price_usd,
         liquidity_usd,
         fdv,
         volume_24h,
        total_holders,
         total_transactions_24h,
         outsiders_over_one_usd,
         dex_id,
         pair_address,
         fetched_at
       FROM token_market_snapshots
       WHERE token_id = ?1
         AND fetched_at BETWEEN ?2 AND ?3
       ORDER BY fetched_at DESC, id DESC
       LIMIT ?4`,
    )
    .bind(tokenId, startTime, endTime, limit)
    .all<{
      network: string;
      base_token_address: string;
      token_name: string | null;
      token_symbol: string | null;
      price_usd: number | null;
      liquidity_usd: number | null;
      fdv: number | null;
      volume_24h: number | null;
      total_holders: number | null;
      total_transactions_24h: number | null;
      outsiders_over_one_usd: number | null;
      dex_id: string | null;
      pair_address: string | null;
      fetched_at: number;
    }>();

  return rows.results.map((row) => ({
    network: row.network,
    baseTokenAddress: row.base_token_address,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    priceUsd: row.price_usd,
    liquidityUsd: row.liquidity_usd,
    fdv: row.fdv,
    volume24h: row.volume_24h,
    totalTransactions24h: row.total_transactions_24h,
    totalHolders: row.total_holders,
    outsidersOverOneUsd: row.outsiders_over_one_usd,
    dexId: row.dex_id,
    pairAddress: row.pair_address,
    fetchedAt: row.fetched_at,
  }));
}

export type TokenMarketFdvRange = {
  earliestFdv: number | null;
  latestFdv: number | null;
  earliestLiquidityUsd: number | null;
  latestLiquidityUsd: number | null;
  hasMultipleSnapshots: boolean;
};

export async function dbGetTokenMarketFdvRange(
  db: D1Database,
  tokenId: number,
  startTime: number,
  endTime: number,
): Promise<TokenMarketFdvRange> {
  const row = await db
    .prepare(
      `WITH earliest AS (
         SELECT id, fdv, liquidity_usd
         FROM token_market_snapshots
         WHERE token_id = ?1 AND fetched_at BETWEEN ?2 AND ?3
         ORDER BY fetched_at ASC, id ASC
         LIMIT 1
       ),
       latest AS (
         SELECT id, fdv, liquidity_usd
         FROM token_market_snapshots
         WHERE token_id = ?1 AND fetched_at BETWEEN ?2 AND ?3
         ORDER BY fetched_at DESC, id DESC
         LIMIT 1
       )
       SELECT
         (SELECT fdv FROM earliest) AS earliest_fdv,
         (SELECT fdv FROM latest) AS latest_fdv,
         (SELECT liquidity_usd FROM earliest) AS earliest_liquidity_usd,
         (SELECT liquidity_usd FROM latest) AS latest_liquidity_usd,
         (SELECT id FROM earliest) AS earliest_id,
         (SELECT id FROM latest) AS latest_id`,
    )
    .bind(tokenId, startTime, endTime)
    .first<{
      earliest_fdv: number | null;
      latest_fdv: number | null;
      earliest_liquidity_usd: number | null;
      latest_liquidity_usd: number | null;
      earliest_id: number | null;
      latest_id: number | null;
    }>();

  return {
    earliestFdv: row?.earliest_fdv ?? null,
    latestFdv: row?.latest_fdv ?? null,
    earliestLiquidityUsd: row?.earliest_liquidity_usd ?? null,
    latestLiquidityUsd: row?.latest_liquidity_usd ?? null,
    hasMultipleSnapshots:
      row?.earliest_id != null &&
      row.latest_id != null &&
      row.earliest_id !== row.latest_id,
  };
}

