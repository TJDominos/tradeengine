import { ApiError } from './errors';
import type {
  ActiveTokenUpdateRequest,
  ManagedWalletImportRequest,
  RpcEndpointCreateRequest,
  TradableTokenCreateRequest,
} from './workerShared';

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
    symbol TEXT,
    name TEXT,
    decimals INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(network, contract_address)
  )`,
  `CREATE TABLE IF NOT EXISTS token_market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    network TEXT NOT NULL DEFAULT 'solana',
    contract_address TEXT NOT NULL,
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
    token_id INTEGER NOT NULL,
    signal_id INTEGER,
    setup_id INTEGER,
    wallet_address TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('BUY', 'SELL')),
    requested_amount REAL NOT NULL,
    executed_amount REAL,
    executed_price REAL,
    tx_signature TEXT,
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
    contract_address TEXT,
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
    contract_address TEXT NOT NULL,
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
  'CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address)',
  'CREATE INDEX IF NOT EXISTS idx_signals_processed_created ON signals(processed, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source)',
  'CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_token_fetched ON token_market_snapshots(token_id, fetched_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_contract_fetched ON token_market_snapshots(network, contract_address, fetched_at DESC)',
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
  'CREATE INDEX IF NOT EXISTS idx_token_holder_transaction_deltas_token_sig ON token_holder_transaction_deltas(token_id, tx_signature)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_aggregates_updated ON token_holder_aggregates(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_sync_states_status_updated ON token_holder_sync_states(status, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_holder_sync_stage_token_run_updated ON token_holder_sync_stage(token_id, run_id, shard_index, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_rpc_endpoints_user_network_created ON rpc_endpoints(user_id, network, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_market_refresh_states_user_status_updated ON market_refresh_states(user_id, status, updated_at DESC)',
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

export async function dbEnsureTableColumn(
  db: D1Database,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  const rows = await db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all<{
      name: string;
    }>();
  if (rows.results.some((row) => row.name === columnName)) {
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
          'rpc_endpoints',
          'is_active',
          'INTEGER NOT NULL DEFAULT 1',
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
    throw new ApiError(400, 'Network and contract address are required');
  }
  const { network, contractAddress } = body as {
    network?: unknown;
    contractAddress?: unknown;
  };
  if (typeof network !== 'string' || typeof contractAddress !== 'string') {
    throw new ApiError(400, 'Network and contract address are required');
  }
  return { network, contractAddress };
}

export function parseActiveTokenUpdateRequest(
  body: unknown,
): ActiveTokenUpdateRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Contract address is required');
  }
  const { contractAddress } = body as {
    contractAddress?: unknown;
  };
  if (typeof contractAddress !== 'string') {
    throw new ApiError(400, 'Contract address is required');
  }
  return { contractAddress };
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
