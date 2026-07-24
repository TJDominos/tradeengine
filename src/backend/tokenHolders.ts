import { nowTs } from './time';
import { buildTokenHolderSyncSummary } from './workerCore';
import { dbEnsureTradeDomainSchema } from './workerSchema';
import type {
  OutsideTokenHolderRecord,
  TokenHolderAggregateRecord,
  TokenHolderSyncStateRecord,
  TokenHolderSyncStatus,
  TokenHolderSyncSummary,
} from './workerShared';
import {
  TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT,
  TOKEN_HOLDER_SYNC_PROGRAM_IDS,
  TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
} from './workerShared';

const D1_BATCH_WRITE_CHUNK_SIZE = 100;

async function dbRunBatchesInChunks(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = D1_BATCH_WRITE_CHUNK_SIZE,
): Promise<void> {
  for (let index = 0; index < statements.length; index += chunkSize) {
    await db.batch(statements.slice(index, index + chunkSize));
  }
}

export async function dbUpsertTokenHolderAddresses(
  db: D1Database,
  tokenId: number,
  addresses: string[],
  source = 'rpc_scan',
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  if (addresses.length === 0) {
    return;
  }
  const timestamp = nowTs();
  await dbRunBatchesInChunks(
    db,
    addresses.map((address) =>
      db
        .prepare(
          `INSERT INTO token_holder_addresses (
             token_id,
             wallet_address,
             source,
             first_seen_at,
             last_seen_at
           ) VALUES (?1, ?2, ?3, ?4, ?4)
           ON CONFLICT(token_id, wallet_address)
           DO UPDATE SET
             source = excluded.source,
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(tokenId, address, source, timestamp),
    ),
  );
}

export async function dbSyncTokenHolderBalances(
  db: D1Database,
  tokenId: number,
  balances: Map<string, number>,
  source = 'rpc_full_sync',
): Promise<{
  activeHolderCount: number;
  upsertedCount: number;
  zeroedCount: number;
}> {
  await dbEnsureTradeDomainSchema(db);
  const timestamp = nowTs();
  const existingRows = await db
    .prepare(
      'SELECT wallet_address FROM token_holder_addresses WHERE token_id = ?1 AND amount_holding > 0',
    )
    .bind(tokenId)
    .all<{ wallet_address: string }>();
  const existingAddresses = new Set(existingRows.results.map((row) => row.wallet_address));
  const nextAddresses = new Set([...balances.keys()]);
  const zeroedAddresses = [...existingAddresses].filter((address) => !nextAddresses.has(address));

  const upserts = [...balances.entries()].map(([address, amountHolding]) =>
    db
      .prepare(
        `INSERT INTO token_holder_addresses (
           token_id,
           wallet_address,
           amount_holding,
           source,
           first_seen_at,
           last_seen_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(token_id, wallet_address)
         DO UPDATE SET
           amount_holding = excluded.amount_holding,
           source = excluded.source,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(tokenId, address, amountHolding, source, timestamp),
  );
  const zeroes = zeroedAddresses.map((address) =>
    db
      .prepare(
        `UPDATE token_holder_addresses
         SET amount_holding = 0,
             source = ?3,
             last_seen_at = ?4
         WHERE token_id = ?1 AND wallet_address = ?2`,
      )
      .bind(tokenId, address, source, timestamp),
  );

  if (upserts.length > 0 || zeroes.length > 0) {
    await dbRunBatchesInChunks(db, [...upserts, ...zeroes]);
  }

  return {
    activeHolderCount: balances.size,
    upsertedCount: upserts.length,
    zeroedCount: zeroes.length,
  };
}

export async function dbGetTokenHolderSyncState(
  db: D1Database,
  tokenId: number,
): Promise<TokenHolderSyncStateRecord | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `SELECT
         token_id,
         run_id,
         status,
         source,
         next_shard_index,
         processed_shard_count,
         total_shard_count,
         staged_holder_count,
         last_program_id,
         last_owner_prefix,
         error_message,
         started_at,
         updated_at,
         last_completed_at
       FROM token_holder_sync_states
       WHERE token_id = ?1
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      token_id: number;
      run_id: string | null;
      status: TokenHolderSyncStatus;
      source: string;
      next_shard_index: number;
      processed_shard_count: number;
      total_shard_count: number;
      staged_holder_count: number;
      last_program_id: string | null;
      last_owner_prefix: number | null;
      error_message: string | null;
      started_at: number | null;
      updated_at: number;
      last_completed_at: number | null;
    }>();
  if (!row) {
    return null;
  }
  return {
    tokenId: row.token_id,
    runId: row.run_id,
    status: row.status,
    source: row.source,
    nextShardIndex: row.next_shard_index,
    processedShardCount: row.processed_shard_count,
    totalShardCount: row.total_shard_count,
    stagedHolderCount: row.staged_holder_count,
    lastProgramId: row.last_program_id,
    lastOwnerPrefix: row.last_owner_prefix,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    lastCompletedAt: row.last_completed_at,
  };
}

export async function dbPutTokenHolderSyncState(
  db: D1Database,
  state: TokenHolderSyncStateRecord,
): Promise<TokenHolderSyncStateRecord> {
  await dbEnsureTradeDomainSchema(db);
  await db
    .prepare(
      `INSERT INTO token_holder_sync_states (
         token_id,
         run_id,
         status,
         source,
         next_shard_index,
         processed_shard_count,
         total_shard_count,
         staged_holder_count,
         last_program_id,
         last_owner_prefix,
         error_message,
         started_at,
         updated_at,
         last_completed_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(token_id)
       DO UPDATE SET
         run_id = excluded.run_id,
         status = excluded.status,
         source = excluded.source,
         next_shard_index = excluded.next_shard_index,
         processed_shard_count = excluded.processed_shard_count,
         total_shard_count = excluded.total_shard_count,
         staged_holder_count = excluded.staged_holder_count,
         last_program_id = excluded.last_program_id,
         last_owner_prefix = excluded.last_owner_prefix,
         error_message = excluded.error_message,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at,
         last_completed_at = excluded.last_completed_at`,
    )
    .bind(
      state.tokenId,
      state.runId,
      state.status,
      state.source,
      state.nextShardIndex,
      state.processedShardCount,
      state.totalShardCount,
      state.stagedHolderCount,
      state.lastProgramId,
      state.lastOwnerPrefix,
      state.errorMessage,
      state.startedAt,
      state.updatedAt,
      state.lastCompletedAt,
    )
    .run();
  return state;
}

export async function dbStartOrResumeTokenHolderSync(
  db: D1Database,
  tokenId: number,
): Promise<TokenHolderSyncStateRecord> {
  const existing = await dbGetTokenHolderSyncState(db, tokenId);
  const timestamp = nowTs();
  if (
    existing?.runId &&
    existing.nextShardIndex <= existing.totalShardCount &&
    (existing.status === 'running' || existing.status === 'failed')
  ) {
    return await dbPutTokenHolderSyncState(db, {
      ...existing,
      status: 'running',
      errorMessage: null,
      updatedAt: timestamp,
    });
  }

  await db
    .prepare('DELETE FROM token_holder_sync_stage WHERE token_id = ?1')
    .bind(tokenId)
    .run();

  return await dbPutTokenHolderSyncState(db, {
    tokenId,
    runId: crypto.randomUUID(),
    status: 'running',
    source: 'rpc_owner_prefix_shards',
    nextShardIndex: 0,
    processedShardCount: 0,
    totalShardCount: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
    stagedHolderCount: 0,
    lastProgramId: null,
    lastOwnerPrefix: null,
    errorMessage: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    lastCompletedAt: existing?.lastCompletedAt ?? null,
  });
}

export async function dbCountTokenHolderSyncStageHolders(
  db: D1Database,
  tokenId: number,
  runId: string,
): Promise<number> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS holder_count
       FROM (
         SELECT wallet_address
         FROM token_holder_sync_stage
         WHERE token_id = ?1 AND run_id = ?2
         GROUP BY wallet_address
         HAVING SUM(amount_holding) > 0
       )`,
    )
    .bind(tokenId, runId)
    .first<{ holder_count: number }>();
  return row?.holder_count ?? 0;
}

export async function dbStageTokenHolderBalanceShard(
  db: D1Database,
  tokenId: number,
  runId: string,
  shardIndex: number,
  balances: Map<string, number>,
  source = 'rpc_owner_prefix_shards',
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  if (balances.size === 0) {
    return;
  }
  const timestamp = nowTs();
  await dbRunBatchesInChunks(
    db,
    [...balances.entries()].map(([address, amountHolding]) =>
      db
        .prepare(
          `INSERT INTO token_holder_sync_stage (
             token_id,
             run_id,
             shard_index,
             wallet_address,
             amount_holding,
             source,
             updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(token_id, run_id, shard_index, wallet_address)
           DO UPDATE SET
             amount_holding = excluded.amount_holding,
             source = excluded.source,
             updated_at = excluded.updated_at`,
        )
        .bind(
          tokenId,
          runId,
          shardIndex,
          address,
          amountHolding,
          source,
          timestamp,
        ),
    ),
  );
}

export async function dbFinalizePagedTokenHolderSync(
  db: D1Database,
  userId: number,
  state: TokenHolderSyncStateRecord,
  source = 'rpc_owner_prefix_shards',
): Promise<TokenHolderSyncSummary> {
  await dbEnsureTradeDomainSchema(db);
  if (!state.runId) {
    return buildTokenHolderSyncSummary(state, {
      status: 'failed',
      errorMessage: 'Token holder sync run id is missing',
    });
  }

  const timestamp = nowTs();
  const activeHolderRow = await db
    .prepare(
      `SELECT COUNT(*) AS active_holder_count
       FROM (
         SELECT wallet_address
         FROM token_holder_sync_stage
         WHERE token_id = ?1 AND run_id = ?2
         GROUP BY wallet_address
         HAVING SUM(amount_holding) > 0
       )`,
    )
    .bind(state.tokenId, state.runId)
    .first<{ active_holder_count: number }>();
  const zeroedCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS zeroed_count
       FROM token_holder_addresses
       WHERE token_id = ?1
         AND amount_holding > 0
         AND wallet_address NOT IN (
           SELECT wallet_address
           FROM token_holder_sync_stage
           WHERE token_id = ?1 AND run_id = ?2
           GROUP BY wallet_address
           HAVING SUM(amount_holding) > 0
         )`,
    )
    .bind(state.tokenId, state.runId)
    .first<{ zeroed_count: number }>();

  await db
    .prepare(
      `INSERT INTO token_holder_addresses (
         token_id,
         wallet_address,
         amount_holding,
         source,
         first_seen_at,
         last_seen_at
       )
       SELECT
         ?1,
         wallet_address,
         SUM(amount_holding) AS amount_holding,
         ?3,
         ?4,
         ?4
       FROM token_holder_sync_stage
       WHERE token_id = ?1 AND run_id = ?2
       GROUP BY wallet_address
       HAVING SUM(amount_holding) > 0
       ON CONFLICT(token_id, wallet_address)
       DO UPDATE SET
         amount_holding = excluded.amount_holding,
         source = excluded.source,
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(state.tokenId, state.runId, source, timestamp)
    .run();

  await db
    .prepare(
      `UPDATE token_holder_addresses
       SET amount_holding = 0,
           source = ?3,
           last_seen_at = ?4
       WHERE token_id = ?1
         AND amount_holding > 0
         AND wallet_address NOT IN (
           SELECT wallet_address
           FROM token_holder_sync_stage
           WHERE token_id = ?1 AND run_id = ?2
           GROUP BY wallet_address
           HAVING SUM(amount_holding) > 0
         )`,
    )
    .bind(state.tokenId, state.runId, source, timestamp)
    .run();

  await dbRecomputeTokenHolderAggregate(db, userId, state.tokenId, {
    source,
    fullSyncAt: timestamp,
  });

  const activeHolderCount = activeHolderRow?.active_holder_count ?? 0;
  const zeroedCount = zeroedCountRow?.zeroed_count ?? 0;
  const completedState = await dbPutTokenHolderSyncState(db, {
    ...state,
    status: 'completed',
    source,
    nextShardIndex: state.totalShardCount,
    processedShardCount: state.totalShardCount,
    stagedHolderCount: activeHolderCount,
    lastProgramId:
      TOKEN_HOLDER_SYNC_PROGRAM_IDS[TOKEN_HOLDER_SYNC_PROGRAM_IDS.length - 1],
    lastOwnerPrefix: TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT - 1,
    errorMessage: null,
    updatedAt: timestamp,
    lastCompletedAt: timestamp,
  });

  await db
    .prepare(
      'DELETE FROM token_holder_sync_stage WHERE token_id = ?1 AND run_id = ?2',
    )
    .bind(state.tokenId, state.runId)
    .run();

  return buildTokenHolderSyncSummary(completedState, {
    activeHolderCount,
    stagedHolderCount: activeHolderCount,
    upsertedCount: activeHolderCount,
    zeroedCount,
  });
}


export async function dbRecomputeTokenHolderAggregate(
  db: D1Database,
  userId: number,
  tokenId: number,
  options?: {
    source?: string;
    fullSyncAt?: number | null;
    deltaSyncAt?: number | null;
  },
): Promise<TokenHolderAggregateRecord> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `SELECT
         COUNT(CASE WHEN tha.amount_holding > 0 THEN 1 END) AS active_holder_count,
         COUNT(CASE WHEN tha.amount_holding > 0 AND a.type = 'managed' THEN 1 END) AS internal_holder_count,
         COUNT(CASE WHEN tha.amount_holding > 0 AND a.type = 'watch' THEN 1 END) AS watched_holder_count,
         COALESCE(SUM(CASE WHEN tha.amount_holding > 0 THEN tha.amount_holding ELSE 0 END), 0) AS total_amount_holding,
         COALESCE(SUM(CASE WHEN tha.amount_holding > 0 AND a.type = 'managed' THEN tha.amount_holding ELSE 0 END), 0) AS internal_amount_holding,
         COALESCE(SUM(CASE WHEN tha.amount_holding > 0 AND a.type = 'watch' THEN tha.amount_holding ELSE 0 END), 0) AS watched_amount_holding
       FROM token_holder_addresses tha
       LEFT JOIN accounts a
         ON a.wallet_address = tha.wallet_address
        AND a.user_id = ?1
        AND a.type IN ('managed', 'watch')
       WHERE tha.token_id = ?2`,
    )
    .bind(userId, tokenId)
    .first<{
      active_holder_count: number;
      internal_holder_count: number;
      watched_holder_count: number;
      total_amount_holding: number;
      internal_amount_holding: number;
      watched_amount_holding: number;
    }>();

  const aggregate: TokenHolderAggregateRecord = {
    tokenId,
    activeHolderCount: row?.active_holder_count ?? 0,
    internalHolderCount: row?.internal_holder_count ?? 0,
    watchedHolderCount: row?.watched_holder_count ?? 0,
    outsiderHolderCount: Math.max(0, (row?.active_holder_count ?? 0) - (row?.internal_holder_count ?? 0)),
    totalAmountHolding: row?.total_amount_holding ?? 0,
    internalAmountHolding: row?.internal_amount_holding ?? 0,
    watchedAmountHolding: row?.watched_amount_holding ?? 0,
    lastFullSyncAt: options?.fullSyncAt ?? null,
    lastDeltaSyncAt: options?.deltaSyncAt ?? null,
    updatedAt: nowTs(),
    source: options?.source ?? 'recompute',
  };

  const existing = await db
    .prepare(
      `SELECT last_full_sync_at, last_delta_sync_at
       FROM token_holder_aggregates
       WHERE token_id = ?1
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      last_full_sync_at: number | null;
      last_delta_sync_at: number | null;
    }>();

  const nextLastFullSyncAt =
    options?.fullSyncAt ?? existing?.last_full_sync_at ?? null;
  const nextLastDeltaSyncAt =
    options?.deltaSyncAt ?? existing?.last_delta_sync_at ?? null;

  await db
    .prepare(
      `INSERT INTO token_holder_aggregates (
         token_id,
         active_holder_count,
         internal_holder_count,
         watched_holder_count,
         outsider_holder_count,
         total_amount_holding,
         internal_amount_holding,
         watched_amount_holding,
         last_full_sync_at,
         last_delta_sync_at,
         updated_at,
         source
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(token_id)
       DO UPDATE SET
         active_holder_count = excluded.active_holder_count,
         internal_holder_count = excluded.internal_holder_count,
         watched_holder_count = excluded.watched_holder_count,
         outsider_holder_count = excluded.outsider_holder_count,
         total_amount_holding = excluded.total_amount_holding,
         internal_amount_holding = excluded.internal_amount_holding,
         watched_amount_holding = excluded.watched_amount_holding,
         last_full_sync_at = excluded.last_full_sync_at,
         last_delta_sync_at = excluded.last_delta_sync_at,
         updated_at = excluded.updated_at,
         source = excluded.source`,
    )
    .bind(
      aggregate.tokenId,
      aggregate.activeHolderCount,
      aggregate.internalHolderCount,
      aggregate.watchedHolderCount,
      aggregate.outsiderHolderCount,
      aggregate.totalAmountHolding,
      aggregate.internalAmountHolding,
      aggregate.watchedAmountHolding,
      nextLastFullSyncAt,
      nextLastDeltaSyncAt,
      aggregate.updatedAt,
      aggregate.source,
    )
    .run();

  return {
    ...aggregate,
    lastFullSyncAt: nextLastFullSyncAt,
    lastDeltaSyncAt: nextLastDeltaSyncAt,
  };
}

export async function dbGetTokenHolderAggregate(
  db: D1Database,
  tokenId: number,
): Promise<TokenHolderAggregateRecord | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `SELECT
         token_id,
         active_holder_count,
         internal_holder_count,
         watched_holder_count,
         outsider_holder_count,
         total_amount_holding,
         internal_amount_holding,
         watched_amount_holding,
         last_full_sync_at,
         last_delta_sync_at,
         updated_at,
         source
       FROM token_holder_aggregates
       WHERE token_id = ?1
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      token_id: number;
      active_holder_count: number;
      internal_holder_count: number;
      watched_holder_count: number;
      outsider_holder_count: number;
      total_amount_holding: number;
      internal_amount_holding: number;
      watched_amount_holding: number;
      last_full_sync_at: number | null;
      last_delta_sync_at: number | null;
      updated_at: number;
      source: string;
    }>();
  if (!row) {
    return null;
  }
  return {
    tokenId: row.token_id,
    activeHolderCount: row.active_holder_count,
    internalHolderCount: row.internal_holder_count,
    watchedHolderCount: row.watched_holder_count,
    outsiderHolderCount: row.outsider_holder_count,
    totalAmountHolding: row.total_amount_holding,
    internalAmountHolding: row.internal_amount_holding,
    watchedAmountHolding: row.watched_amount_holding,
    lastFullSyncAt: row.last_full_sync_at,
    lastDeltaSyncAt: row.last_delta_sync_at,
    updatedAt: row.updated_at,
    source: row.source,
  };
}

export async function dbHasTokenHolderRows(
  db: D1Database,
  tokenId: number,
): Promise<boolean> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `SELECT 1 AS has_rows
       FROM token_holder_addresses
       WHERE token_id = ?1
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<{ has_rows: number }>();
  return row?.has_rows === 1;
}

export async function dbComputeTokenHolderAggregateFromStage(
  db: D1Database,
  userId: number,
  tokenId: number,
  runId: string,
  updatedAt: number,
): Promise<TokenHolderAggregateRecord | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `WITH holder_rows AS (
         SELECT wallet_address, SUM(amount_holding) AS amount_holding
         FROM token_holder_sync_stage
         WHERE token_id = ?2 AND run_id = ?3
         GROUP BY wallet_address
         HAVING SUM(amount_holding) > 0
       )
       SELECT
         COUNT(CASE WHEN hr.amount_holding > 0 THEN 1 END) AS active_holder_count,
         COUNT(CASE WHEN hr.amount_holding > 0 AND a.type = 'managed' THEN 1 END) AS internal_holder_count,
         COUNT(CASE WHEN hr.amount_holding > 0 AND a.type = 'watch' THEN 1 END) AS watched_holder_count,
         COALESCE(SUM(CASE WHEN hr.amount_holding > 0 THEN hr.amount_holding ELSE 0 END), 0) AS total_amount_holding,
         COALESCE(SUM(CASE WHEN hr.amount_holding > 0 AND a.type = 'managed' THEN hr.amount_holding ELSE 0 END), 0) AS internal_amount_holding,
         COALESCE(SUM(CASE WHEN hr.amount_holding > 0 AND a.type = 'watch' THEN hr.amount_holding ELSE 0 END), 0) AS watched_amount_holding
       FROM holder_rows hr
       LEFT JOIN accounts a
         ON a.wallet_address = hr.wallet_address
        AND a.user_id = ?1
        AND a.type IN ('managed', 'watch')`,
    )
    .bind(userId, tokenId, runId)
    .first<{
      active_holder_count: number;
      internal_holder_count: number;
      watched_holder_count: number;
      total_amount_holding: number;
      internal_amount_holding: number;
      watched_amount_holding: number;
    }>();
  if (!row || (row.active_holder_count ?? 0) === 0) {
    return null;
  }
  return {
    tokenId,
    activeHolderCount: row.active_holder_count ?? 0,
    internalHolderCount: row.internal_holder_count ?? 0,
    watchedHolderCount: row.watched_holder_count ?? 0,
    outsiderHolderCount: Math.max(
      0,
      (row.active_holder_count ?? 0) - (row.internal_holder_count ?? 0),
    ),
    totalAmountHolding: row.total_amount_holding ?? 0,
    internalAmountHolding: row.internal_amount_holding ?? 0,
    watchedAmountHolding: row.watched_amount_holding ?? 0,
    lastFullSyncAt: null,
    lastDeltaSyncAt: null,
    updatedAt,
    source: 'rpc_owner_prefix_shards_partial',
  };
}

export async function dbListOutsideTokenHoldersFromFinal(
  db: D1Database,
  userId: number,
  tokenId: number,
  limit = 200,
): Promise<OutsideTokenHolderRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `SELECT
         tha.wallet_address,
         tha.amount_holding,
         tha.source,
         tha.last_seen_at,
         a.type AS account_type,
         a.label AS account_label
       FROM token_holder_addresses tha
       LEFT JOIN accounts a
         ON a.user_id = ?1
        AND a.wallet_address = tha.wallet_address
       WHERE tha.token_id = ?2
         AND tha.amount_holding > 0
         AND COALESCE(a.type, '') != 'managed'
       ORDER BY tha.amount_holding DESC, tha.last_seen_at DESC, tha.wallet_address ASC
       LIMIT ?3`,
    )
    .bind(userId, tokenId, limit)
    .all<{
      wallet_address: string;
      amount_holding: number;
      source: string;
      last_seen_at: number;
      account_type: string | null;
      account_label: string | null;
    }>();
  return rows.results.map((row) => ({
    address: row.wallet_address,
    label: row.account_label,
    amountHolding: row.amount_holding,
    source: row.source,
    ownership: row.account_type === 'watch' ? 'watch' : 'outside',
    updatedAt: row.last_seen_at,
  }));
}

export async function dbListOutsideTokenHoldersFromStage(
  db: D1Database,
  userId: number,
  tokenId: number,
  runId: string,
  limit = 200,
): Promise<OutsideTokenHolderRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `WITH holder_rows AS (
         SELECT
           wallet_address,
           SUM(amount_holding) AS amount_holding,
           MAX(updated_at) AS updated_at
         FROM token_holder_sync_stage
         WHERE token_id = ?2 AND run_id = ?3
         GROUP BY wallet_address
         HAVING SUM(amount_holding) > 0
       )
       SELECT
         hr.wallet_address,
         hr.amount_holding,
         hr.updated_at,
         a.type AS account_type,
         a.label AS account_label
       FROM holder_rows hr
       LEFT JOIN accounts a
         ON a.user_id = ?1
        AND a.wallet_address = hr.wallet_address
       WHERE COALESCE(a.type, '') != 'managed'
       ORDER BY hr.amount_holding DESC, hr.updated_at DESC, hr.wallet_address ASC
       LIMIT ?4`,
    )
    .bind(userId, tokenId, runId, limit)
    .all<{
      wallet_address: string;
      amount_holding: number;
      updated_at: number;
      account_type: string | null;
      account_label: string | null;
    }>();
  return rows.results.map((row) => ({
    address: row.wallet_address,
    label: row.account_label,
    amountHolding: row.amount_holding,
    source: 'rpc_owner_prefix_shards',
    ownership: row.account_type === 'watch' ? 'watch' : 'outside',
    updatedAt: row.updated_at,
  }));
}

export async function dbListOutsideTokenHolders(
  db: D1Database,
  userId: number,
  tokenId: number,
  limit = 200,
): Promise<OutsideTokenHolderRecord[]> {
  const syncState = await dbGetTokenHolderSyncState(db, tokenId);
  if (
    syncState?.runId &&
    syncState.stagedHolderCount > 0 &&
    (syncState.status === 'running' || syncState.status === 'failed')
  ) {
    return dbListOutsideTokenHoldersFromStage(
      db,
      userId,
      tokenId,
      syncState.runId,
      limit,
    );
  }
  return dbListOutsideTokenHoldersFromFinal(db, userId, tokenId, limit);
}

