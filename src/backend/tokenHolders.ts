import { nowTs } from './time';
import { buildTokenHolderSyncSummary } from './workerCore';
import { dbEnsureTradeDomainSchema } from './workerSchema';
import type {
  OutsideTokenHolderRecord,
  OutsideTokenHolderPageRecord,
  OutsideTokenHolderSort,
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

  // 1. 清空当前 token_id 在暂存表里的脏数据
  await db
    .prepare('DELETE FROM token_holder_sync_stage WHERE token_id = ?1')
    .bind(tokenId)
    .run();

  // 【核心修复】：移除了此处对 token_holder_addresses 表的提前清零操作，
  // 保持旧数据可读，直至 dbFinalizePagedTokenHolderSync 统一覆盖，解决“同步时查询为空”的问题。

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

  await db
    .prepare(
      `DELETE FROM token_holder_sync_stage
       WHERE token_id = ?1 AND run_id = ?2 AND shard_index = ?3`,
    )
    .bind(tokenId, runId, shardIndex)
    .run();

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
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        // 【核心修复】：补充绑定第 7 个参数 timestamp，解决 SQL 参数不匹配导致的 Crash
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

export async function dbApplyTokenHolderBalanceShardDelta(
  db: D1Database,
  tokenId: number,
  runId: string,
  shardIndex: number,
  balances: Map<string, number>,
  source = 'rpc_owner_prefix_shards_progress',
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  const existingRows = await db
    .prepare(
      `SELECT wallet_address, amount_holding
       FROM token_holder_sync_stage
       WHERE token_id = ?1 AND run_id = ?2 AND shard_index = ?3`,
    )
    .bind(tokenId, runId, shardIndex)
    .all<{ wallet_address: string; amount_holding: number }>();
  const previous = new Map<string, number>();
  for (const row of existingRows.results) {
    previous.set(row.wallet_address, row.amount_holding);
  }

  const deltas = new Map<string, number>();
  for (const [address, nextAmount] of balances.entries()) {
    const prevAmount = previous.get(address) ?? 0;
    const delta = nextAmount - prevAmount;
    if (Math.abs(delta) > 1e-12) {
      deltas.set(address, delta);
    }
  }
  for (const [address, prevAmount] of previous.entries()) {
    if (!balances.has(address) && Math.abs(prevAmount) > 1e-12) {
      deltas.set(address, -prevAmount);
    }
  }

  const timestamp = nowTs();

  await db
    .prepare(
      `DELETE FROM token_holder_sync_stage
       WHERE token_id = ?1 AND run_id = ?2 AND shard_index = ?3`,
    )
    .bind(tokenId, runId, shardIndex)
    .run();

  if (balances.size > 0) {
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
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          // 【核心修复】：补充绑定第 7 个参数 timestamp
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

  if (deltas.size === 0) {
    return;
  }

  await dbRunBatchesInChunks(
    db,
    [...deltas.entries()].map(([address, deltaAmount]) =>
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
             amount_holding = CASE
               WHEN token_holder_addresses.amount_holding + excluded.amount_holding < 0
                 THEN 0
               ELSE token_holder_addresses.amount_holding + excluded.amount_holding
             END,
             source = excluded.source,
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(tokenId, address, deltaAmount, source, timestamp),
    ),
  );

  await db
    .prepare(
      `UPDATE token_holder_addresses
       SET amount_holding = 0,
           source = ?3,
           last_seen_at = ?4
       WHERE token_id = ?1
         AND wallet_address IN (
           SELECT wallet_address
           FROM token_holder_sync_stage
           WHERE token_id = ?1 AND run_id = ?2
           GROUP BY wallet_address
           HAVING SUM(amount_holding) <= 0
         )`,
    )
    .bind(tokenId, runId, source, timestamp)
    .run();
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
  limit: number | null = 200,
): Promise<OutsideTokenHolderRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const baseQuery = `SELECT
     tha.wallet_address,
     tha.amount_holding,
     tha.source,
      tha.first_seen_at,
     tha.last_seen_at,
     a.type AS account_type,
     a.label AS account_label
   FROM token_holder_addresses tha
   LEFT JOIN accounts a
     ON a.user_id = ?1
    AND a.wallet_address = tha.wallet_address
   WHERE tha.token_id = ?2
     AND tha.amount_holding > 0
   ORDER BY tha.amount_holding DESC, tha.last_seen_at DESC, tha.wallet_address ASC`;
  const rows = limit == null
    ? await db
        .prepare(baseQuery)
        .bind(userId, tokenId)
        .all<{
          wallet_address: string;
          amount_holding: number;
          source: string;
          first_seen_at: number | null;
          last_seen_at: number;
          account_type: string | null;
          account_label: string | null;
        }>()
    : await db
        .prepare(`${baseQuery}\n   LIMIT ?3`)
        .bind(userId, tokenId, limit)
        .all<{
          wallet_address: string;
          amount_holding: number;
          source: string;
          first_seen_at: number | null;
          last_seen_at: number;
          account_type: string | null;
          account_label: string | null;
        }>();
  return rows.results.map((row) => ({
    address: row.wallet_address,
    label: row.account_label,
    amountHolding: row.amount_holding,
    source: row.source,
    ownership:
      row.account_type === 'managed'
        ? 'internal'
        : row.account_type === 'watch'
          ? 'watch'
          : 'outside',
    firstSeenAt: row.first_seen_at,
    updatedAt: row.last_seen_at,
  }));
}

export async function dbListOutsideTokenHoldersFromStage(
  db: D1Database,
  userId: number,
  tokenId: number,
  runId: string,
  limit: number | null = 200,
): Promise<OutsideTokenHolderRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const baseQuery = `WITH holder_rows AS (
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
     COALESCE(tha.first_seen_at, hr.updated_at) AS first_seen_at,
     hr.updated_at,
     a.type AS account_type,
     a.label AS account_label
   FROM holder_rows hr
   LEFT JOIN token_holder_addresses tha
     ON tha.token_id = ?2
    AND tha.wallet_address = hr.wallet_address
   LEFT JOIN accounts a
     ON a.user_id = ?1
    AND a.wallet_address = hr.wallet_address
   ORDER BY hr.amount_holding DESC, hr.updated_at DESC, hr.wallet_address ASC`;
  const rows = limit == null
    ? await db
        .prepare(baseQuery)
        .bind(userId, tokenId, runId)
        .all<{
          wallet_address: string;
          amount_holding: number;
          first_seen_at: number | null;
          updated_at: number;
          account_type: string | null;
          account_label: string | null;
        }>()
    : await db
        .prepare(`${baseQuery}\n   LIMIT ?4`)
        .bind(userId, tokenId, runId, limit)
        .all<{
          wallet_address: string;
          amount_holding: number;
          first_seen_at: number | null;
          updated_at: number;
          account_type: string | null;
          account_label: string | null;
        }>();
  return rows.results.map((row) => ({
    address: row.wallet_address,
    label: row.account_label,
    amountHolding: row.amount_holding,
    source: 'rpc_owner_prefix_shards',
    ownership:
      row.account_type === 'managed'
        ? 'internal'
        : row.account_type === 'watch'
          ? 'watch'
          : 'outside',
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  }));
}

type OutsideTokenHolderPageOptions = {
  page: number;
  pageSize: number;
  searchTerm?: string | null;
  sort?: OutsideTokenHolderSort;
};

function normalizeOutsideTokenHolderPageOptions(
  options?: OutsideTokenHolderPageOptions,
): Required<OutsideTokenHolderPageOptions> {
  return {
    page: Math.max(1, options?.page ?? 1),
    pageSize: Math.max(1, options?.pageSize ?? 20),
    searchTerm: (options?.searchTerm ?? '').trim().toLowerCase(),
    sort: options?.sort === 'largest' ? 'largest' : 'newest',
  };
}

function buildOutsideTokenHolderOrderBy(
  sort: OutsideTokenHolderSort,
  columns: {
    amountHolding: string;
    firstSeenAt: string;
    lastSeenAt: string;
    walletAddress: string;
  },
): string {
  if (sort === 'largest') {
    return `${columns.amountHolding} DESC, ${columns.firstSeenAt} DESC, ${columns.lastSeenAt} DESC, ${columns.walletAddress} ASC`;
  }
  return `${columns.firstSeenAt} DESC, ${columns.lastSeenAt} DESC, ${columns.amountHolding} DESC, ${columns.walletAddress} ASC`;
}

function mapOutsideTokenHolderRow(row: {
  wallet_address: string;
  amount_holding: number;
  source: string;
  first_seen_at: number | null;
  last_seen_at: number;
  account_type: string | null;
  account_label: string | null;
}): OutsideTokenHolderRecord {
  return {
    address: row.wallet_address,
    label: row.account_label,
    amountHolding: row.amount_holding,
    source: row.source,
    ownership:
      row.account_type === 'managed'
        ? 'internal'
        : row.account_type === 'watch'
          ? 'watch'
          : 'outside',
    firstSeenAt: row.first_seen_at,
    updatedAt: row.last_seen_at,
  };
}

async function dbListOutsideTokenHoldersPageFromFinal(
  db: D1Database,
  userId: number,
  tokenId: number,
  options?: OutsideTokenHolderPageOptions,
): Promise<OutsideTokenHolderPageRecord> {
  await dbEnsureTradeDomainSchema(db);
  const normalized = normalizeOutsideTokenHolderPageOptions(options);
  const offset = (normalized.page - 1) * normalized.pageSize;
  const likeSearch = `%${normalized.searchTerm}%`;
  const orderBy = buildOutsideTokenHolderOrderBy(normalized.sort, {
    amountHolding: 'tha.amount_holding',
    firstSeenAt: 'tha.first_seen_at',
    lastSeenAt: 'tha.last_seen_at',
    walletAddress: 'tha.wallet_address',
  });

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM token_holder_addresses tha
       LEFT JOIN accounts a
         ON a.user_id = ?1
        AND a.wallet_address = tha.wallet_address
       WHERE tha.token_id = ?2
         AND tha.amount_holding > 0
           AND (a.type IS NULL OR a.type != 'managed')
         AND (
           ?3 = ''
           OR LOWER(tha.wallet_address) LIKE ?4
           OR LOWER(COALESCE(a.label, '')) LIKE ?4
         )`,
    )
    .bind(userId, tokenId, normalized.searchTerm, likeSearch)
    .first<{ cnt: number }>();

  const rows = await db
    .prepare(
      `SELECT
         tha.wallet_address,
         tha.amount_holding,
         tha.source,
         tha.first_seen_at,
         tha.last_seen_at,
         a.type AS account_type,
         a.label AS account_label
       FROM token_holder_addresses tha
       LEFT JOIN accounts a
         ON a.user_id = ?1
        AND a.wallet_address = tha.wallet_address
       WHERE tha.token_id = ?2
         AND tha.amount_holding > 0
         AND (a.type IS NULL OR a.type != 'managed')
         AND (
           ?3 = ''
           OR LOWER(tha.wallet_address) LIKE ?4
           OR LOWER(COALESCE(a.label, '')) LIKE ?4
         )
       ORDER BY ${orderBy}
       LIMIT ?5 OFFSET ?6`,
    )
    .bind(
      userId,
      tokenId,
      normalized.searchTerm,
      likeSearch,
      normalized.pageSize,
      offset,
    )
    .all<{
      wallet_address: string;
      amount_holding: number;
      source: string;
      first_seen_at: number | null;
      last_seen_at: number;
      account_type: string | null;
      account_label: string | null;
    }>();

  return {
    items: rows.results.map(mapOutsideTokenHolderRow),
    page: normalized.page,
    pageSize: normalized.pageSize,
    totalItems: countRow?.cnt ?? 0,
  };
}

async function dbListOutsideTokenHoldersPageFromStage(
  db: D1Database,
  userId: number,
  tokenId: number,
  runId: string,
  options?: OutsideTokenHolderPageOptions,
): Promise<OutsideTokenHolderPageRecord> {
  await dbEnsureTradeDomainSchema(db);
  const normalized = normalizeOutsideTokenHolderPageOptions(options);
  const offset = (normalized.page - 1) * normalized.pageSize;
  const likeSearch = `%${normalized.searchTerm}%`;
  const orderBy = buildOutsideTokenHolderOrderBy(normalized.sort, {
    amountHolding: 'hr.amount_holding',
    firstSeenAt: 'first_seen_at',
    lastSeenAt: 'last_seen_at',
    walletAddress: 'hr.wallet_address',
  });

  const countRow = await db
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
       SELECT COUNT(*) AS cnt
       FROM holder_rows hr
       LEFT JOIN accounts a
         ON a.user_id = ?1
        AND a.wallet_address = hr.wallet_address
       WHERE
         (a.type IS NULL OR a.type != 'managed')
         AND (
           ?4 = ''
           OR LOWER(hr.wallet_address) LIKE ?5
           OR LOWER(COALESCE(a.label, '')) LIKE ?5
         )`,
    )
    .bind(userId, tokenId, runId, normalized.searchTerm, likeSearch)
    .first<{ cnt: number }>();

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
         'rpc_owner_prefix_shards' AS source,
         COALESCE(tha.first_seen_at, hr.updated_at) AS first_seen_at,
         hr.updated_at AS last_seen_at,
         a.type AS account_type,
         a.label AS account_label
       FROM holder_rows hr
       LEFT JOIN token_holder_addresses tha
         ON tha.token_id = ?2
        AND tha.wallet_address = hr.wallet_address
       LEFT JOIN accounts a
         ON a.user_id = ?1
        AND a.wallet_address = hr.wallet_address
       WHERE
         (a.type IS NULL OR a.type != 'managed')
         AND (
           ?4 = ''
           OR LOWER(hr.wallet_address) LIKE ?5
           OR LOWER(COALESCE(a.label, '')) LIKE ?5
         )
       ORDER BY ${orderBy}
       LIMIT ?6 OFFSET ?7`,
    )
    .bind(
      userId,
      tokenId,
      runId,
      normalized.searchTerm,
      likeSearch,
      normalized.pageSize,
      offset,
    )
    .all<{
      wallet_address: string;
      amount_holding: number;
      source: string;
      first_seen_at: number | null;
      last_seen_at: number;
      account_type: string | null;
      account_label: string | null;
    }>();

  return {
    items: rows.results.map(mapOutsideTokenHolderRow),
    page: normalized.page,
    pageSize: normalized.pageSize,
    totalItems: countRow?.cnt ?? 0,
  };
}

export async function dbListOutsideTokenHoldersPage(
  db: D1Database,
  userId: number,
  tokenId: number,
  options?: OutsideTokenHolderPageOptions,
): Promise<OutsideTokenHolderPageRecord> {
  const syncState = await dbGetTokenHolderSyncState(db, tokenId);
  if (
    syncState?.runId &&
    (syncState.status === 'running' || syncState.status === 'failed')
  ) {
    const stagePage = await dbListOutsideTokenHoldersPageFromStage(
      db,
      userId,
      tokenId,
      syncState.runId,
      options,
    );
    if (stagePage.totalItems > 0) {
      return stagePage;
    }
  }
  return dbListOutsideTokenHoldersPageFromFinal(db, userId, tokenId, options);
}

export async function dbListOutsideTokenHolders(
  db: D1Database,
  userId: number,
  tokenId: number,
  limit: number | null = 200,
): Promise<OutsideTokenHolderRecord[]> {
  const page = await dbListOutsideTokenHoldersPage(db, userId, tokenId, {
    page: 1,
    pageSize: limit == null ? Number.MAX_SAFE_INTEGER : limit,
  });
  return page.items;
}

/**
 * 【辅助 RPC 函数】：专用于 Helius 或小代币 (~1000 Holder) 的高效率全量抓取
 */
export async function fetchTokenHoldersDirectly(
  endpointUrl: string,
  mintAddress: string,
): Promise<Map<string, number>> {
  const balances = new Map<string, number>();

  if (endpointUrl.includes('helius')) {
    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-token-accounts',
        method: 'getTokenAccounts',
        params: { mint: mintAddress, page: 1, limit: 1000 },
      }),
    });
    const json = (await res.json()) as any;
    if (json.result?.token_accounts) {
      for (const acc of json.result.token_accounts) {
        if (acc.amount > 0) {
          const realAmount = acc.amount / Math.pow(10, acc.decimals || 0);
          balances.set(acc.owner, (balances.get(acc.owner) ?? 0) + realAmount);
        }
      }
      return balances;
    }
  }

  // 通用单次 getProgramAccounts 回退逻辑
  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'get-program-accounts',
      method: 'getProgramAccounts',
      params: [
        TOKEN_HOLDER_SYNC_PROGRAM_IDS[0],
        {
          encoding: 'jsonParsed',
          filters: [
            { dataSize: 165 },
            { memcmp: { offset: 0, bytes: mintAddress } },
          ],
        },
      ],
    }),
  });
  const json = (await res.json()) as any;
  if (Array.isArray(json.result)) {
    for (const item of json.result) {
      const info = item.account?.data?.parsed?.info;
      if (info && info.tokenAmount?.uiAmount > 0) {
        balances.set(
          info.owner,
          (balances.get(info.owner) ?? 0) + info.tokenAmount.uiAmount,
        );
      }
    }
  }

  return balances;
}