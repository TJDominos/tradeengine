import { ApiError } from '../errors';
import { nowTs } from '../time';
import { normalizePubkey } from '../workerCore';
import type { TransactionLogRefreshStatusRecord } from '../workerShared';

const TRANSACTION_LOG_REFRESH_STALE_AFTER_SEC = 15 * 60;

let tableEnsured = false;

export async function dbEnsureTransactionLogRefreshTable(db: D1Database): Promise<void> {
  if (tableEnsured) {
    return;
  }
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS transaction_log_refresh_states (
           user_id INTEGER NOT NULL,
           contract_address TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'idle'
             CHECK(status IN ('idle', 'running', 'completed', 'failed')),
           request_id TEXT,
           error_message TEXT,
           summary_text TEXT,
           scanned_transactions INTEGER NOT NULL DEFAULT 0,
           inserted_transactions INTEGER NOT NULL DEFAULT 0,
           holder_deltas_applied INTEGER NOT NULL DEFAULT 0,
           enriched_transactions INTEGER NOT NULL DEFAULT 0,
           started_at INTEGER,
           updated_at INTEGER NOT NULL,
           completed_at INTEGER,
           PRIMARY KEY(user_id, contract_address),
           FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
         )`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_transaction_log_refresh_states_user_status_updated
           ON transaction_log_refresh_states(user_id, status, updated_at DESC)`,
      )
      .run()
      .catch(() => {});
    tableEnsured = true;
  } catch (err: unknown) {
    console.warn('Failed to ensure transaction_log_refresh_states table:', err);
  }
}

export async function dbGetTransactionLogRefreshState(
  db: D1Database,
  userId: number,
  contractAddress: string,
): Promise<TransactionLogRefreshStatusRecord | null> {
  const normalizedContractAddress = normalizePubkey(contractAddress);
  try {
    const row = await db
      .prepare(
        `SELECT
           contract_address,
           status,
           request_id,
           error_message,
           summary_text,
           scanned_transactions,
           inserted_transactions,
           holder_deltas_applied,
           enriched_transactions,
           started_at,
           updated_at,
           completed_at
         FROM transaction_log_refresh_states
         WHERE user_id = ?1 AND contract_address = ?2
         LIMIT 1`,
      )
      .bind(userId, normalizedContractAddress)
      .first<{
        contract_address: string;
        status: TransactionLogRefreshStatusRecord['status'];
        request_id: string | null;
        error_message: string | null;
        summary_text: string | null;
        scanned_transactions: number;
        inserted_transactions: number;
        holder_deltas_applied: number;
        enriched_transactions: number;
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
      scannedTransactions: row.scanned_transactions,
      insertedTransactions: row.inserted_transactions,
      holderDeltasApplied: row.holder_deltas_applied,
      enrichedTransactions: row.enriched_transactions,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('no such table: transaction_log_refresh_states')) {
      await dbEnsureTransactionLogRefreshTable(db);
      return null;
    }
    throw err;
  }
}

export async function dbTryStartTransactionLogRefresh(
  db: D1Database,
  userId: number,
  contractAddress: string,
): Promise<{ acquired: boolean; state: TransactionLogRefreshStatusRecord }> {
  await dbEnsureTransactionLogRefreshTable(db);
  const normalizedContractAddress = normalizePubkey(contractAddress);
  const requestId = crypto.randomUUID();
  const timestamp = nowTs();
  const staleBefore = timestamp - TRANSACTION_LOG_REFRESH_STALE_AFTER_SEC;
  await db
    .prepare(
      `INSERT INTO transaction_log_refresh_states (
         user_id,
         contract_address,
         status,
         request_id,
         error_message,
         summary_text,
         scanned_transactions,
         inserted_transactions,
         holder_deltas_applied,
         enriched_transactions,
         started_at,
         updated_at,
         completed_at
       ) VALUES (?1, ?2, 'running', ?3, NULL, NULL, 0, 0, 0, 0, ?4, ?4, NULL)
       ON CONFLICT(user_id, contract_address)
       DO UPDATE SET
         status = 'running',
         request_id = excluded.request_id,
         error_message = NULL,
         summary_text = NULL,
         scanned_transactions = 0,
         inserted_transactions = 0,
         holder_deltas_applied = 0,
         enriched_transactions = 0,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at,
         completed_at = NULL
       WHERE transaction_log_refresh_states.status != 'running'
          OR transaction_log_refresh_states.updated_at < ?5`,
    )
    .bind(userId, normalizedContractAddress, requestId, timestamp, staleBefore)
    .run();
  const state = await dbGetTransactionLogRefreshState(db, userId, normalizedContractAddress);
  if (!state) {
    throw new ApiError(500, 'Failed to initialize transaction log refresh state');
  }
  return {
    acquired: state.status === 'running' && state.requestId === requestId,
    state,
  };
}

export async function dbCompleteTransactionLogRefresh(
  db: D1Database,
  userId: number,
  contractAddress: string,
  requestId: string,
  input: {
    summaryText: string;
    scannedTransactions: number;
    insertedTransactions: number;
    holderDeltasApplied: number;
    enrichedTransactions: number;
  },
): Promise<void> {
  const timestamp = nowTs();
  await db
    .prepare(
      `UPDATE transaction_log_refresh_states
       SET status = 'completed',
           error_message = NULL,
           summary_text = ?4,
           scanned_transactions = ?5,
           inserted_transactions = ?6,
           holder_deltas_applied = ?7,
           enriched_transactions = ?8,
           updated_at = ?9,
           completed_at = ?9
       WHERE user_id = ?1 AND contract_address = ?2 AND request_id = ?3`,
    )
    .bind(
      userId,
      normalizePubkey(contractAddress),
      requestId,
      input.summaryText,
      input.scannedTransactions,
      input.insertedTransactions,
      input.holderDeltasApplied,
      input.enrichedTransactions,
      timestamp,
    )
    .run();
}

export async function dbFailTransactionLogRefresh(
  db: D1Database,
  userId: number,
  contractAddress: string,
  requestId: string,
  errorMessage: string,
): Promise<void> {
  const timestamp = nowTs();
  await db
    .prepare(
      `UPDATE transaction_log_refresh_states
       SET status = 'failed',
           error_message = ?4,
           summary_text = NULL,
           updated_at = ?5,
           completed_at = ?5
       WHERE user_id = ?1 AND contract_address = ?2 AND request_id = ?3`,
    )
    .bind(userId, normalizePubkey(contractAddress), requestId, errorMessage, timestamp)
    .run();
}