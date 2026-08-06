import { ApiError } from '../errors';
import { nowTs } from '../time';
import { normalizePubkey } from '../workerCore';
import { dbEnsureTradeDomainSchema } from '../workerSchema';
import type { MarketRefreshStatusRecord } from '../workerShared';

const MARKET_REFRESH_RUNNING_STALE_AFTER_SEC = 15 * 60;

export async function dbGetMarketRefreshState(
  db: D1Database,
  userId: number,
  contractAddress: string,
): Promise<MarketRefreshStatusRecord | null> {
  await dbEnsureTradeDomainSchema(db);
  const normalizedContractAddress = normalizePubkey(contractAddress);
  const row = await db
    .prepare(
      `SELECT
         contract_address,
         status,
         request_id,
         error_message,
         summary_text,
         started_at,
         updated_at,
         completed_at
       FROM market_refresh_states
       WHERE user_id = ?1 AND contract_address = ?2
       LIMIT 1`,
    )
    .bind(userId, normalizedContractAddress)
    .first<{
      contract_address: string;
      status: MarketRefreshStatusRecord['status'];
      request_id: string | null;
      error_message: string | null;
      summary_text: string | null;
      started_at: number | null;
      updated_at: number;
      completed_at: number | null;
    }>();
  if (!row) {
    return null;
  }
  return {
    contractAddress: row.contract_address,
    status: row.status,
    requestId: row.request_id,
    errorMessage: row.error_message,
    summaryText: row.summary_text,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export async function dbTryStartMarketRefresh(
  db: D1Database,
  userId: number,
  contractAddress: string,
): Promise<{ acquired: boolean; state: MarketRefreshStatusRecord }> {
  await dbEnsureTradeDomainSchema(db);
  const normalizedContractAddress = normalizePubkey(contractAddress);
  const requestId = crypto.randomUUID();
  const now = nowTs();
  const staleBefore = now - MARKET_REFRESH_RUNNING_STALE_AFTER_SEC;

  await db
    .prepare(
      `INSERT INTO market_refresh_states (
         user_id,
         contract_address,
         status,
         request_id,
         error_message,
         summary_text,
         started_at,
         updated_at,
         completed_at
       ) VALUES (?1, ?2, 'running', ?3, NULL, NULL, ?4, ?4, NULL)
       ON CONFLICT(user_id, contract_address)
       DO UPDATE SET
         status = CASE
           WHEN market_refresh_states.status != 'running' OR market_refresh_states.updated_at < ?5
             THEN 'running'
           ELSE market_refresh_states.status
         END,
         request_id = CASE
           WHEN market_refresh_states.status != 'running' OR market_refresh_states.updated_at < ?5
             THEN excluded.request_id
           ELSE market_refresh_states.request_id
         END,
         error_message = CASE
           WHEN market_refresh_states.status != 'running' OR market_refresh_states.updated_at < ?5
             THEN NULL
           ELSE market_refresh_states.error_message
         END,
         summary_text = CASE
           WHEN market_refresh_states.status != 'running' OR market_refresh_states.updated_at < ?5
             THEN NULL
           ELSE market_refresh_states.summary_text
         END,
         started_at = CASE
           WHEN market_refresh_states.status != 'running' OR market_refresh_states.updated_at < ?5
             THEN excluded.started_at
           ELSE market_refresh_states.started_at
         END,
         updated_at = CASE
           WHEN market_refresh_states.status != 'running' OR market_refresh_states.updated_at < ?5
             THEN excluded.updated_at
           ELSE market_refresh_states.updated_at
         END,
         completed_at = CASE
           WHEN market_refresh_states.status != 'running' OR market_refresh_states.updated_at < ?5
             THEN NULL
           ELSE market_refresh_states.completed_at
         END`,
    )
    .bind(userId, normalizedContractAddress, requestId, now, staleBefore)
    .run();

  const state = await dbGetMarketRefreshState(db, userId, normalizedContractAddress);
  if (!state) {
    throw new ApiError(500, 'Failed to load market refresh state');
  }

  return {
    acquired: state.requestId === requestId && state.status === 'running',
    state,
  };
}

export async function dbCompleteMarketRefresh(
  db: D1Database,
  userId: number,
  contractAddress: string,
  requestId: string,
  summaryText: string,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  const now = nowTs();
  await db
    .prepare(
      `UPDATE market_refresh_states
       SET status = 'completed',
           error_message = NULL,
           summary_text = ?4,
           updated_at = ?5,
           completed_at = ?5
       WHERE user_id = ?1 AND contract_address = ?2 AND request_id = ?3`,
    )
    .bind(userId, normalizePubkey(contractAddress), requestId, summaryText, now)
    .run();
}

export async function dbFailMarketRefresh(
  db: D1Database,
  userId: number,
  contractAddress: string,
  requestId: string,
  errorMessage: string,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  const now = nowTs();
  await db
    .prepare(
      `UPDATE market_refresh_states
       SET status = 'failed',
           error_message = ?4,
           summary_text = NULL,
           updated_at = ?5,
           completed_at = ?5
       WHERE user_id = ?1 AND contract_address = ?2 AND request_id = ?3`,
    )
    .bind(userId, normalizePubkey(contractAddress), requestId, errorMessage, now)
    .run();
}

export async function dbCancelMarketRefresh(
  db: D1Database,
  userId: number,
  contractAddress: string,
  requestId: string,
  reason: string,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  const now = nowTs();
  await db
    .prepare(
      `UPDATE market_refresh_states
       SET status = 'failed',
           error_message = ?4,
           summary_text = NULL,
           updated_at = ?5,
           completed_at = ?5
       WHERE user_id = ?1 AND contract_address = ?2 AND request_id = ?3`,
    )
    .bind(userId, normalizePubkey(contractAddress), requestId, reason, now)
    .run();
}

export async function assertMarketRefreshLeaseActive(
  db: D1Database,
  userId: number,
  contractAddress: string,
  requestId: string,
): Promise<void> {
  const state = await dbGetMarketRefreshState(db, userId, contractAddress);
  const active =
    state &&
    state.status === 'running' &&
    state.requestId === requestId;
  if (!active) {
    throw new Error('Market refresh canceled: request was superseded or browser session ended');
  }
}
