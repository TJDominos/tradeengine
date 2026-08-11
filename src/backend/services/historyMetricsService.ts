import { nowTs } from '../time';
import { dbResolveTradableTokenId } from '../tokenStore';
import type { HistoricalSetupRecord, SettingsState } from '../workerShared';

export async function dbCreateHistoricalSetupSnapshot(
  db: D1Database,
  userId: number,
  settings: SettingsState,
): Promise<void> {
  const tokenId = settings.baseTokenAddress.trim()
    ? await dbResolveTradableTokenId(db, settings.baseTokenAddress)
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
      settings.baseTokenAddress.trim() || null,
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
  baseTokenAddress: string,
  currentPriceUsd: number | null,
): Promise<number> {
  const profit = await dbComputeManagedTradeLogProfit(
    db,
    userId,
    baseTokenAddress,
    currentPriceUsd,
  );
  return profit.totalPnlUsdc;
}

export type ManagedTradeLogProfit = {
  realizedPnlUsdc: number;
  unrealizedPnlUsdc: number;
  totalPnlUsdc: number;
  remainingTokenAmount: number;
  successfulTradeCount: number;
};

export type ManagedProfitTradeRow = {
  wallet_address: string;
  action: 'BUY' | 'SELL';
  executed_amount: number | null;
  executed_price: number | null;
};

export function calculateManagedTradeLogProfit(
  rows: ManagedProfitTradeRow[],
  currentPriceUsd: number | null,
): ManagedTradeLogProfit {
  const positions = new Map<string, { quantity: number; costBasisUsdc: number }>();
  let realizedPnlUsdc = 0;
  let successfulTradeCount = 0;
  for (const row of rows) {
    const executedAmount = row.executed_amount ?? 0;
    const executedPrice = row.executed_price ?? 0;
    if (executedAmount <= 0 || executedPrice <= 0) {
      continue;
    }
    successfulTradeCount += 1;
    const position = positions.get(row.wallet_address) ?? {
      quantity: 0,
      costBasisUsdc: 0,
    };
    if (row.action === 'BUY') {
      position.quantity += executedAmount;
      position.costBasisUsdc += executedAmount * executedPrice;
    } else {
      const soldQuantity = executedAmount / executedPrice;
      const averageCost = position.quantity > 0
        ? position.costBasisUsdc / position.quantity
        : 0;
      const matchedQuantity = Math.min(position.quantity, soldQuantity);
      realizedPnlUsdc += matchedQuantity * (executedPrice - averageCost);
      position.quantity = Math.max(0, position.quantity - matchedQuantity);
      position.costBasisUsdc = Math.max(
        0,
        position.costBasisUsdc - averageCost * matchedQuantity,
      );
    }
    positions.set(row.wallet_address, position);
  }

  let remainingTokenAmount = 0;
  let remainingCostBasisUsdc = 0;
  for (const position of positions.values()) {
    remainingTokenAmount += position.quantity;
    remainingCostBasisUsdc += position.costBasisUsdc;
  }
  const unrealizedPnlUsdc = currentPriceUsd != null && currentPriceUsd > 0
    ? remainingTokenAmount * currentPriceUsd - remainingCostBasisUsdc
    : 0;
  return {
    realizedPnlUsdc,
    unrealizedPnlUsdc,
    totalPnlUsdc: realizedPnlUsdc + unrealizedPnlUsdc,
    remainingTokenAmount,
    successfulTradeCount,
  };
}

export async function dbComputeManagedTradeLogProfit(
  db: D1Database,
  userId: number,
  baseTokenAddress: string,
  currentPriceUsd: number | null,
  strategyRunId?: string,
): Promise<ManagedTradeLogProfit> {
  const tokenId = await dbResolveTradableTokenId(db, baseTokenAddress);
  if (!tokenId) {
    return {
      realizedPnlUsdc: 0,
      unrealizedPnlUsdc: 0,
      totalPnlUsdc: 0,
      remainingTokenAmount: 0,
      successfulTradeCount: 0,
    };
  }

  const rows = await db
    .prepare(
      `SELECT
         tl.wallet_address,
         tl.action,
         tl.executed_amount,
         tl.executed_price
       FROM trade_logs tl
       WHERE tl.token_id = ?2
         AND tl.status = 'SUCCESS'
         AND (?3 IS NULL OR tl.strategy_run_id = ?3)
         AND EXISTS (
           SELECT 1
           FROM accounts a
           WHERE a.user_id = ?1
             AND a.type = 'managed'
             AND a.wallet_address = tl.wallet_address
         )
       ORDER BY COALESCE(tl.chain_time_ms, tl.created_at) ASC, tl.id ASC`,
    )
    .bind(userId, tokenId, strategyRunId ?? null)
    .all<ManagedProfitTradeRow>();

  return calculateManagedTradeLogProfit(rows.results, currentPriceUsd);
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
    baseTokenAddress: row.contract_address,
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
