import { nowTs } from '../time';
import { dbResolveTradableTokenId } from '../tokenStore';
import type { HistoricalSetupRecord, SettingsState } from '../workerShared';

export async function dbCreateHistoricalSetupSnapshot(
  db: D1Database,
  userId: number,
  settings: SettingsState,
): Promise<void> {
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

export async function dbGetLatestHistoricalSetupId(
  db: D1Database,
  userId: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      'SELECT id FROM historic_setups WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .bind(userId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function dbComputeManagedProfitUsdc(
  db: D1Database,
  userId: number,
  contractAddress: string,
  currentPriceUsd: number | null,
): Promise<number> {
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

export async function dbListHistoricalSetups(
  db: D1Database,
  userId: number,
): Promise<HistoricalSetupRecord[]> {
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
