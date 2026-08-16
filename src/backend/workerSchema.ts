import { ApiError } from './errors';
import type {
  ActiveTokenUpdateRequest,
  ManagedWalletImportRequest,
  RpcEndpointCreateRequest,
  TradableTokenCreateRequest,
  TradableTokenUpdateRequest,
} from './workerShared';
import { SOLANA_USDC_MINT } from './workerShared';

// ─── D1 schema + request parsers ─────────────────────────────────────────────

const D1_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    encrypted_private_key TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, type, wallet_address),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_accounts_user_type ON accounts(user_id, type)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created_at ON audit_logs(user_id, created_at DESC)',
];

const D1_TRADE_DOMAIN_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tradable_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network TEXT NOT NULL DEFAULT 'solana',
    contract_address TEXT NOT NULL,
    base_token_address TEXT NOT NULL,
    quote_token_address TEXT NOT NULL DEFAULT '${SOLANA_USDC_MINT}',
    amm_pool_address TEXT,
    symbol TEXT,
    name TEXT,
    decimals INTEGER,
    quote_token_symbol TEXT,
    quote_token_name TEXT,
    quote_token_decimals INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(network, base_token_address, quote_token_address)
  )`,
  `CREATE TABLE IF NOT EXISTS token_market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    network TEXT NOT NULL DEFAULT 'solana',
    base_token_address TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    price_usd REAL,
    liquidity_usd REAL,
    fdv REAL,
    volume_24h REAL,
    total_holders INTEGER,
    total_transactions_24h INTEGER,
    outsiders_over_one_usd INTEGER,
    dex_id TEXT,
    pair_address TEXT,
    fetched_at INTEGER NOT NULL,
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id)
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    wallet_address TEXT,
    tx_signature TEXT,
    payload TEXT NOT NULL,
    details_json TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    processed_at INTEGER,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(source, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_transaction_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    group_key TEXT NOT NULL,
    token_id INTEGER,
    token_contract_address TEXT NOT NULL,
    wallet_address TEXT,
    from_wallet_address TEXT,
    to_wallet_address TEXT,
    action TEXT CHECK(action IN ('BUY', 'SELL', 'TRANSFER')),
    usdc_amount REAL,
    token_amount REAL,
    fee_amount_usd REAL,
    source TEXT NOT NULL DEFAULT 'webhook'
      CHECK(source IN ('webhook', 'rpc_reconcile')),
    event_type TEXT NOT NULL,
    tx_signature TEXT,
    chain_time_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING', 'CONFIRMED', 'FAILED')),
    error_message TEXT,
    detail_source TEXT NOT NULL DEFAULT 'unknown'
      CHECK(detail_source IN ('payload', 'rpc', 'payload+rpc', 'unknown')),
    details_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, group_key),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    token_id INTEGER NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    avg_cost REAL NOT NULL DEFAULT 0,
    realized_pnl REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(wallet_address, token_id),
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id)
  )`,
  `CREATE TABLE IF NOT EXISTS trade_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_run_id TEXT,
    token_id INTEGER NOT NULL,
    signal_id INTEGER,
    setup_id INTEGER,
    wallet_address TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('BUY', 'SELL')),
    requested_amount REAL NOT NULL,
    executed_amount REAL,
    executed_price REAL,
    tx_signature TEXT,
    chain_time_ms INTEGER,
    execution_trace_json TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED')),
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id),
    FOREIGN KEY(setup_id) REFERENCES historic_setups(id)
  )`,
  `CREATE TABLE IF NOT EXISTS historic_setups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_id INTEGER,
    time_range_target TEXT NOT NULL,
    max_transactions INTEGER NOT NULL,
    max_slippage REAL NOT NULL,
    volume_target REAL NOT NULL DEFAULT 0,
    net_buyin_target REAL NOT NULL DEFAULT 0,
    volatility_target REAL NOT NULL DEFAULT 0,
    pullback_target REAL NOT NULL DEFAULT 0,
    base_token_address TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id)
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    strategy_type TEXT NOT NULL,
    current_version_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, strategy_type),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    engine_version TEXT NOT NULL,
    strategy_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    params_json TEXT NOT NULL,
    triggers_json TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    risk_json TEXT NOT NULL,
    execution_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    checksum TEXT NOT NULL,
    change_note TEXT,
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    UNIQUE(strategy_id, version_no),
    FOREIGN KEY(strategy_id) REFERENCES strategy_definitions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    strategy_version_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    external_id TEXT,
    base_token_address TEXT NOT NULL,
    wallet_address TEXT,
    tx_signature TEXT,
    status TEXT NOT NULL,
    should_execute INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(strategy_version_id) REFERENCES strategy_versions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    config TEXT NOT NULL,
    report TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS token_holder_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    amount_holding REAL NOT NULL DEFAULT 0,
    wallet_usdc_balance REAL,
    wallet_sol_balance REAL,
    wallet_balance_updated_at INTEGER,
    source TEXT NOT NULL DEFAULT 'rpc_scan',
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(token_id, wallet_address),
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS token_holder_transaction_deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    tx_signature TEXT NOT NULL,
    wallet_from TEXT,
    wallet_to TEXT,
    token_amount REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'tx_delta',
    applied_at INTEGER NOT NULL,
    UNIQUE(token_id, tx_signature),
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS token_holder_aggregates (
    token_id INTEGER PRIMARY KEY,
    active_holder_count INTEGER NOT NULL DEFAULT 0,
    internal_holder_count INTEGER NOT NULL DEFAULT 0,
    watched_holder_count INTEGER NOT NULL DEFAULT 0,
    outsider_holder_count INTEGER NOT NULL DEFAULT 0,
    total_amount_holding REAL NOT NULL DEFAULT 0,
    internal_amount_holding REAL NOT NULL DEFAULT 0,
    watched_amount_holding REAL NOT NULL DEFAULT 0,
    last_full_sync_at INTEGER,
    last_delta_sync_at INTEGER,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'rpc_full_sync',
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS token_holder_sync_states (
    token_id INTEGER PRIMARY KEY,
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK(status IN ('idle', 'running', 'completed', 'failed')),
    source TEXT NOT NULL DEFAULT 'rpc_owner_prefix_shards',
    next_shard_index INTEGER NOT NULL DEFAULT 0,
    processed_shard_count INTEGER NOT NULL DEFAULT 0,
    total_shard_count INTEGER NOT NULL DEFAULT 512,
    staged_holder_count INTEGER NOT NULL DEFAULT 0,
    last_program_id TEXT,
    last_owner_prefix INTEGER,
    error_message TEXT,
    started_at INTEGER,
    updated_at INTEGER NOT NULL,
    last_completed_at INTEGER,
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS token_holder_sync_stage (
    token_id INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    shard_index INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    amount_holding REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'rpc_owner_prefix_shards',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(token_id, run_id, shard_index, wallet_address),
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS rpc_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    network TEXT NOT NULL DEFAULT 'solana',
    url TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, network, url),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS market_refresh_states (
    user_id INTEGER NOT NULL,
    contract_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK(status IN ('idle', 'running', 'completed', 'failed')),
    request_id TEXT,
    error_message TEXT,
    summary_text TEXT,
    started_at INTEGER,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY(user_id, contract_address),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
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
  'CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address)',
  'CREATE INDEX IF NOT EXISTS idx_signals_processed_created ON signals(processed, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source)',
  'CREATE INDEX IF NOT EXISTS idx_webhook_transaction_logs_user_created ON webhook_transaction_logs(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_webhook_transaction_logs_user_tx ON webhook_transaction_logs(user_id, tx_signature)',
  'CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_token_fetched ON token_market_snapshots(token_id, fetched_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_contract_fetched ON token_market_snapshots(network, base_token_address, fetched_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_trade_logs_token_created ON trade_logs(token_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_trade_logs_wallet_created ON trade_logs(wallet_address, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_strategy_definitions_user_type ON strategy_definitions(user_id, strategy_type)',
  'CREATE INDEX IF NOT EXISTS idx_strategy_versions_strategy_created ON strategy_versions(strategy_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_version_created ON strategy_evaluations(strategy_version_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_user_created ON strategy_evaluations(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_strategies_status_created ON strategies(status, created_at ASC)',
  'CREATE INDEX IF NOT EXISTS idx_strategies_updated ON strategies(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_addresses_token_wallet ON token_holder_addresses(token_id, wallet_address)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_addresses_token_amount ON token_holder_addresses(token_id, amount_holding DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_addresses_token_usdc ON token_holder_addresses(token_id, wallet_usdc_balance DESC, wallet_address ASC)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_addresses_token_sol ON token_holder_addresses(token_id, wallet_sol_balance DESC, wallet_address ASC)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_transaction_deltas_token_sig ON token_holder_transaction_deltas(token_id, tx_signature)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_aggregates_updated ON token_holder_aggregates(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_sync_states_status_updated ON token_holder_sync_states(status, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_sync_stage_token_run_updated ON token_holder_sync_stage(token_id, run_id, shard_index, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_rpc_endpoints_user_network_created ON rpc_endpoints(user_id, network, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_market_refresh_states_user_status_updated ON market_refresh_states(user_id, status, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_transaction_log_refresh_states_user_status_updated ON transaction_log_refresh_states(user_id, status, updated_at DESC)',
];

const D1_TRADE_DOMAIN_TABLE_STATEMENTS = D1_TRADE_DOMAIN_SCHEMA_STATEMENTS.filter(
  (statement) => !statement.startsWith('CREATE INDEX'),
);

const D1_TRADE_DOMAIN_INDEX_STATEMENTS = D1_TRADE_DOMAIN_SCHEMA_STATEMENTS.filter(
  (statement) => statement.startsWith('CREATE INDEX'),
);

export interface CredentialsBody {
  username: string;
  password: string;
}

let schemaInitPromise: Promise<void> | undefined;
let tradeDomainSchemaInitPromise: Promise<void> | undefined;

export async function dbTableHasColumn(
  db: D1Database,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all<{
      name: string;
    }>();
  return rows.results.some((row) => row.name === columnName);
}

async function dbGetTableSql(
  db: D1Database,
  tableName: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT sql
       FROM sqlite_master
       WHERE type = 'table' AND name = ?1
       LIMIT 1`,
    )
    .bind(tableName)
    .first<{ sql: string | null }>();
  return row?.sql ?? null;
}

export async function dbTradableTokensUseLegacyContractUniqueness(
  db: D1Database,
): Promise<boolean> {
  const sql = await dbGetTableSql(db, 'tradable_tokens');
  if (!sql) {
    return false;
  }

  const normalizedSql = sql.replace(/\s+/g, ' ').toLowerCase();
  return normalizedSql.includes('unique(network, contract_address)')
    && !normalizedSql.includes('unique(network, base_token_address, quote_token_address)');
}

async function dbBackfillRenamedColumn(
  db: D1Database,
  tableName: string,
  legacyColumnName: string,
  nextColumnName: string,
): Promise<void> {
  if (!(await dbTableHasColumn(db, tableName, legacyColumnName))) {
    return;
  }
  if (!(await dbTableHasColumn(db, tableName, nextColumnName))) {
    return;
  }

  await db
    .prepare(
      `UPDATE ${tableName}
       SET ${nextColumnName} = ${legacyColumnName}
       WHERE (${nextColumnName} IS NULL OR TRIM(${nextColumnName}) = '')
         AND ${legacyColumnName} IS NOT NULL
         AND TRIM(${legacyColumnName}) <> ''`,
    )
    .run();
}

export async function dbEnsureTableColumn(
  db: D1Database,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  if (await dbTableHasColumn(db, tableName, columnName)) {
    return;
  }
  await db
    .prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
    .run();
}

export async function dbEnsureSchema(db: D1Database): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = db
      .batch(D1_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
      .then(async () => {
        await dbEnsureTableColumn(
          db,
          'accounts',
          'is_active',
          'INTEGER NOT NULL DEFAULT 1',
        );
        await dbEnsureTableColumn(db, 'accounts', 'capability_base_mint', 'TEXT');
        await dbEnsureTableColumn(db, 'accounts', 'capability_quote_mint', 'TEXT');
        await dbEnsureTableColumn(db, 'accounts', 'wallet_usdc_balance', 'REAL');
        await dbEnsureTableColumn(db, 'accounts', 'wallet_sol_balance', 'REAL');
        await dbEnsureTableColumn(db, 'accounts', 'wallet_active_token_mint', 'TEXT');
        await dbEnsureTableColumn(db, 'accounts', 'wallet_active_token_balance', 'REAL');
        await dbEnsureTableColumn(db, 'accounts', 'wallet_balance_updated_at', 'INTEGER');
      })
      .catch((err) => {
        schemaInitPromise = undefined;
        throw err;
      });
  }
  await schemaInitPromise;
}

export async function dbEnsureTradeDomainSchema(db: D1Database): Promise<void> {
  await dbEnsureSchema(db);
  if (!tradeDomainSchemaInitPromise) {
    tradeDomainSchemaInitPromise = db
      .batch(
        D1_TRADE_DOMAIN_TABLE_STATEMENTS.map((statement) =>
          db.prepare(statement),
        ),
      )
      .then(async () => {
        await dbEnsureTableColumn(db, 'signals', 'details_json', 'TEXT');
        await dbEnsureTableColumn(
          db,
          'token_holder_addresses',
          'amount_holding',
          'REAL NOT NULL DEFAULT 0',
        );
        await dbEnsureTableColumn(
          db,
          'token_holder_addresses',
          'wallet_usdc_balance',
          'REAL',
        );
        await dbEnsureTableColumn(
          db,
          'token_holder_addresses',
          'wallet_sol_balance',
          'REAL',
        );
        await dbEnsureTableColumn(
          db,
          'token_holder_addresses',
          'wallet_balance_updated_at',
          'INTEGER',
        );
        await dbEnsureTableColumn(
          db,
          'token_holder_addresses',
          'source',
          "TEXT NOT NULL DEFAULT 'rpc_scan'",
        );
        await dbEnsureTableColumn(
          db,
          'token_holder_addresses',
          'first_seen_at',
          'INTEGER NOT NULL DEFAULT 0',
        );
        await dbEnsureTableColumn(
          db,
          'token_holder_addresses',
          'last_seen_at',
          'INTEGER NOT NULL DEFAULT 0',
        );
        await dbEnsureTableColumn(
          db,
          'token_market_snapshots',
          'total_holders',
          'INTEGER',
        );
        await dbEnsureTableColumn(
          db,
          'tradable_tokens',
          'contract_address',
          'TEXT',
        );
        await dbEnsureTableColumn(
          db,
          'tradable_tokens',
          'base_token_address',
          'TEXT',
        );
        await dbEnsureTableColumn(
          db,
          'token_market_snapshots',
          'base_token_address',
          'TEXT',
        );
        await dbEnsureTableColumn(
          db,
          'historic_setups',
          'base_token_address',
          'TEXT',
        );
        await dbEnsureTableColumn(
          db,
          'strategy_evaluations',
          'base_token_address',
          'TEXT',
        );
        await dbEnsureTableColumn(
          db,
          'tradable_tokens',
          'quote_token_address',
          `TEXT NOT NULL DEFAULT '${SOLANA_USDC_MINT}'`,
        );
        await dbEnsureTableColumn(db, 'tradable_tokens', 'amm_pool_address', 'TEXT');
        await dbEnsureTableColumn(db, 'tradable_tokens', 'quote_token_symbol', 'TEXT');
        await dbEnsureTableColumn(db, 'tradable_tokens', 'quote_token_name', 'TEXT');
        await dbEnsureTableColumn(db, 'tradable_tokens', 'quote_token_decimals', 'INTEGER');
        // Legacy deployments may still store the old contract_address columns.
        // Backfill the renamed base_token_address columns during lazy schema setup.
        await dbBackfillRenamedColumn(
          db,
          'tradable_tokens',
          'contract_address',
          'base_token_address',
        );
        await db
          .prepare(
            `UPDATE tradable_tokens
             SET contract_address = base_token_address
             WHERE (contract_address IS NULL OR TRIM(contract_address) = '')
               AND base_token_address IS NOT NULL
               AND TRIM(base_token_address) <> ''`,
          )
          .run();
        await dbBackfillRenamedColumn(
          db,
          'token_market_snapshots',
          'contract_address',
          'base_token_address',
        );
        await dbBackfillRenamedColumn(
          db,
          'historic_setups',
          'contract_address',
          'base_token_address',
        );
        await dbBackfillRenamedColumn(
          db,
          'strategy_evaluations',
          'contract_address',
          'base_token_address',
        );
        await db
          .prepare(
            `UPDATE tradable_tokens
             SET quote_token_address = ?1
             WHERE quote_token_address IS NULL OR TRIM(quote_token_address) = ''`,
          )
          .bind(SOLANA_USDC_MINT)
          .run();
        await dbEnsureTableColumn(
          db,
          'trade_logs',
          'strategy_run_id',
          'TEXT',
        );
        await dbEnsureTableColumn(
          db,
          'trade_logs',
          'chain_time_ms',
          'INTEGER',
        );
        await dbEnsureTableColumn(
          db,
          'trade_logs',
          'execution_trace_json',
          'TEXT',
        );
        await dbEnsureTableColumn(
          db,
          'rpc_endpoints',
          'is_active',
          'INTEGER NOT NULL DEFAULT 1',
        );
        await dbEnsureTableColumn(
          db,
          'webhook_transaction_logs',
          'chain_time_ms',
          'INTEGER',
        );
        await db.batch(
          D1_TRADE_DOMAIN_INDEX_STATEMENTS.map((statement) =>
            db.prepare(statement),
          ),
        );
      })
      .catch((err) => {
        tradeDomainSchemaInitPromise = undefined;
        throw err;
      });
  }
  await tradeDomainSchemaInitPromise;
}

export async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json<T>();
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON');
  }
}

export function parseJsonText<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON');
  }
}

export function parseCredentialsBody(body: unknown): CredentialsBody {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Username and password are required');
  }
  const { username, password } = body as {
    username?: unknown;
    password?: unknown;
  };
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new ApiError(400, 'Username and password are required');
  }
  return { username, password };
}

export function parseManagedWalletImportRequest(
  body: unknown,
): ManagedWalletImportRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(
      400,
      'Wallet label and either a private key or recovery phrase are required',
    );
  }
  const {
    label,
    adminPassword,
    privateKey,
    recoveryPhrase,
    derivationPath,
    derivedAccountCount,
  } = body as {
    label?: unknown;
    adminPassword?: unknown;
    privateKey?: unknown;
    recoveryPhrase?: unknown;
    derivationPath?: unknown;
    derivedAccountCount?: unknown;
  };
  if (typeof label !== 'string') {
    throw new ApiError(400, 'Wallet label is required');
  }
  const hasPrivateKey =
    typeof privateKey === 'string' && privateKey.trim().length > 0;
  const hasRecoveryPhrase =
    typeof recoveryPhrase === 'string' && recoveryPhrase.trim().length > 0;
  if (hasPrivateKey === hasRecoveryPhrase) {
    throw new ApiError(
      400,
      'Provide exactly one of privateKey or recoveryPhrase',
    );
  }
  if (derivationPath != null && typeof derivationPath !== 'string') {
    throw new ApiError(400, 'Derivation path must be a string');
  }
  if (
    derivedAccountCount != null &&
    (!Number.isInteger(derivedAccountCount) || (derivedAccountCount as number) <= 0)
  ) {
    throw new ApiError(400, 'Derived account count must be a positive integer');
  }
  if (adminPassword != null && typeof adminPassword !== 'string') {
    throw new ApiError(400, 'Admin password must be a string');
  }
  return {
    label,
    adminPassword:
      typeof adminPassword === 'string' && adminPassword.trim().length > 0
        ? adminPassword
        : undefined,
    privateKey: hasPrivateKey ? (privateKey as string) : undefined,
    recoveryPhrase: hasRecoveryPhrase ? (recoveryPhrase as string) : undefined,
    derivationPath: typeof derivationPath === 'string' ? derivationPath : undefined,
    derivedAccountCount:
      typeof derivedAccountCount === 'number' && Number.isInteger(derivedAccountCount)
        ? derivedAccountCount
        : undefined,
  };
}

export function parseTradableTokenCreateRequest(
  body: unknown,
): TradableTokenCreateRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Network, contract address, and quote token address are required');
  }
  const { network, contractAddress, baseTokenAddress, quoteTokenAddress, ammPoolAddress } = body as {
    network?: unknown;
    contractAddress?: unknown;
    baseTokenAddress?: unknown;
    quoteTokenAddress?: unknown;
    ammPoolAddress?: unknown;
  };
  if (
    typeof network !== 'string' ||
    (typeof contractAddress !== 'string' && typeof baseTokenAddress !== 'string') ||
    typeof quoteTokenAddress !== 'string'
  ) {
    throw new ApiError(400, 'Network, contract address, and quote token address are required');
  }
  if (ammPoolAddress != null && typeof ammPoolAddress !== 'string') {
    throw new ApiError(400, 'AMM pool address must be a string');
  }
  return {
    network,
    baseTokenAddress:
      typeof baseTokenAddress === 'string' ? baseTokenAddress : (contractAddress as string),
    quoteTokenAddress,
    ammPoolAddress: typeof ammPoolAddress === 'string' ? ammPoolAddress : undefined,
  };
}

export function parseActiveTokenUpdateRequest(
  body: unknown,
): ActiveTokenUpdateRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Contract address is required');
  }
  const { contractAddress, baseTokenAddress, quoteTokenAddress } = body as {
    contractAddress?: unknown;
    baseTokenAddress?: unknown;
    quoteTokenAddress?: unknown;
  };
  if (typeof contractAddress !== 'string' && typeof baseTokenAddress !== 'string') {
    throw new ApiError(400, 'Contract address is required');
  }
  if (quoteTokenAddress != null && typeof quoteTokenAddress !== 'string') {
    throw new ApiError(400, 'Quote token address must be a string');
  }
  return {
    baseTokenAddress:
      typeof baseTokenAddress === 'string' ? baseTokenAddress : (contractAddress as string),
    quoteTokenAddress: typeof quoteTokenAddress === 'string' ? quoteTokenAddress : undefined,
  };
}

export function parseRpcEndpointCreateRequest(
  body: unknown,
): RpcEndpointCreateRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Network and RPC URL are required');
  }
  const { network, url } = body as {
    network?: unknown;
    url?: unknown;
  };
  if (typeof network !== 'string' || typeof url !== 'string') {
    throw new ApiError(400, 'Network and RPC URL are required');
  }
  return { network, url };
}

export function parseTradableTokenUpdateRequest(
  body: unknown,
): TradableTokenUpdateRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Tracked pair update body is required');
  }
  const { ammPoolAddress } = body as {
    ammPoolAddress?: unknown;
  };
  if (ammPoolAddress != null && typeof ammPoolAddress !== 'string') {
    throw new ApiError(400, 'AMM pool address must be a string');
  }
  return {
    ammPoolAddress: typeof ammPoolAddress === 'string' ? ammPoolAddress : undefined,
  };
}
