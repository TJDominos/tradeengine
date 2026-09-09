export type MarketWindowMetrics = {
  windowMinutes: number;
  volumeUsd: number;
  transactionCount: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  externalVolumeUsd: number;
  externalTransactionCount: number;
  externalBuyVolumeUsd: number;
  externalSellVolumeUsd: number;
  externalNetBuyinUsd: number;
};

export async function dbGetMarketWindowMetrics(
  db: D1Database,
  userId: number,
  tokenId: number,
  windowMinutes: number,
  endTimeMs: number,
): Promise<MarketWindowMetrics> {
  const normalizedWindowMinutes = Number.isFinite(windowMinutes) && windowMinutes > 0
    ? windowMinutes
    : 24 * 60;
  const startTimeMs = endTimeMs - normalizedWindowMinutes * 60 * 1000;
  const row = await db
    .prepare(
      `WITH eligible AS (
         SELECT
           wtl.*,
           COALESCE(NULLIF(TRIM(wtl.tx_signature), ''), wtl.group_key) AS dedupe_key
         FROM webhook_transaction_logs wtl
         WHERE wtl.user_id = ?1
           AND wtl.token_id = ?2
           AND wtl.action IN ('BUY', 'SELL')
           AND wtl.status = 'CONFIRMED'
           AND COALESCE(
             wtl.chain_time_ms,
             CASE
               WHEN wtl.created_at >= 1000000000000 THEN wtl.created_at
               ELSE wtl.created_at * 1000
             END
           ) BETWEEN ?3 AND ?4
       ),
       deduped AS (
         SELECT
           eligible.*,
           ROW_NUMBER() OVER (
             PARTITION BY dedupe_key
             ORDER BY updated_at DESC, id DESC
           ) AS row_rank
         FROM eligible
       ),
       classified AS (
         SELECT
           deduped.*,
           CASE WHEN NOT EXISTS (
             SELECT 1
             FROM accounts managed_from
             WHERE managed_from.user_id = deduped.user_id
               AND managed_from.wallet_address = deduped.from_wallet_address
           ) AND NOT EXISTS (
             SELECT 1
             FROM accounts managed_to
             WHERE managed_to.user_id = deduped.user_id
               AND managed_to.wallet_address = deduped.to_wallet_address
           ) THEN 1 ELSE 0 END AS is_external
         FROM deduped
         WHERE row_rank = 1
       )
       SELECT
         COALESCE(SUM(CASE
           WHEN usdc_amount IS NOT NULL AND usdc_amount >= 0
           THEN usdc_amount ELSE 0 END), 0) AS volume_usd,
         COUNT(*) AS transaction_count,
         COALESCE(SUM(CASE
           WHEN action = 'BUY' AND usdc_amount IS NOT NULL AND usdc_amount >= 0
           THEN usdc_amount ELSE 0 END), 0) AS buy_volume_usd,
         COALESCE(SUM(CASE
           WHEN action = 'SELL' AND usdc_amount IS NOT NULL AND usdc_amount >= 0
           THEN usdc_amount ELSE 0 END), 0) AS sell_volume_usd,
         COALESCE(SUM(CASE
           WHEN is_external = 1 AND usdc_amount IS NOT NULL AND usdc_amount >= 0
           THEN usdc_amount ELSE 0 END), 0) AS external_volume_usd,
         COALESCE(SUM(CASE WHEN is_external = 1 THEN 1 ELSE 0 END), 0) AS external_transaction_count,
         COALESCE(SUM(CASE
           WHEN is_external = 1 AND action = 'BUY' AND usdc_amount IS NOT NULL AND usdc_amount >= 0
           THEN usdc_amount ELSE 0 END), 0) AS external_buy_volume_usd,
         COALESCE(SUM(CASE
           WHEN is_external = 1 AND action = 'SELL' AND usdc_amount IS NOT NULL AND usdc_amount >= 0
           THEN usdc_amount ELSE 0 END), 0) AS external_sell_volume_usd
       FROM classified`,
    )
    .bind(userId, tokenId, startTimeMs, endTimeMs)
    .first<{
      volume_usd: number | null;
      transaction_count: number | null;
      buy_volume_usd: number | null;
      sell_volume_usd: number | null;
      external_volume_usd: number | null;
      external_transaction_count: number | null;
      external_buy_volume_usd: number | null;
      external_sell_volume_usd: number | null;
    }>();

  const volumeUsd = Number.isFinite(row?.volume_usd)
    ? Math.max(0, row?.volume_usd ?? 0)
    : 0;
  const transactionCount = Number.isFinite(row?.transaction_count)
    ? Math.max(0, Math.trunc(row?.transaction_count ?? 0))
    : 0;
  const buyVolumeUsd = Number.isFinite(row?.buy_volume_usd)
    ? Math.max(0, row?.buy_volume_usd ?? 0)
    : 0;
  const sellVolumeUsd = Number.isFinite(row?.sell_volume_usd)
    ? Math.max(0, row?.sell_volume_usd ?? 0)
    : 0;
  const externalVolumeUsd = Number.isFinite(row?.external_volume_usd)
    ? Math.max(0, row?.external_volume_usd ?? 0)
    : 0;
  const externalTransactionCount = Number.isFinite(row?.external_transaction_count)
    ? Math.max(0, Math.trunc(row?.external_transaction_count ?? 0))
    : 0;
  const externalBuyVolumeUsd = Number.isFinite(row?.external_buy_volume_usd)
    ? Math.max(0, row?.external_buy_volume_usd ?? 0)
    : 0;
  const externalSellVolumeUsd = Number.isFinite(row?.external_sell_volume_usd)
    ? Math.max(0, row?.external_sell_volume_usd ?? 0)
    : 0;

  return {
    windowMinutes: normalizedWindowMinutes,
    volumeUsd,
    transactionCount,
    buyVolumeUsd,
    sellVolumeUsd,
    externalVolumeUsd,
    externalTransactionCount,
    externalBuyVolumeUsd,
    externalSellVolumeUsd,
    externalNetBuyinUsd: externalBuyVolumeUsd - externalSellVolumeUsd,
  };
}