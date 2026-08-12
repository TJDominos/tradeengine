-- Pre-create token-holder sync tables and market refresh state in D1.
-- These were previously created lazily at runtime by dbEnsureTradeDomainSchema.

CREATE TABLE IF NOT EXISTS token_holder_addresses (
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
);

CREATE TABLE IF NOT EXISTS token_holder_transaction_deltas (
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
);

CREATE TABLE IF NOT EXISTS token_holder_aggregates (
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
);

CREATE TABLE IF NOT EXISTS token_holder_sync_states (
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
);

CREATE TABLE IF NOT EXISTS token_holder_sync_stage (
  token_id INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  amount_holding REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'rpc_owner_prefix_shards',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(token_id, run_id, shard_index, wallet_address),
  FOREIGN KEY(token_id) REFERENCES tradable_tokens(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS market_refresh_states (
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
);

CREATE INDEX IF NOT EXISTS idx_token_holder_addresses_token_wallet
  ON token_holder_addresses(token_id, wallet_address);

CREATE INDEX IF NOT EXISTS idx_token_holder_addresses_token_amount
  ON token_holder_addresses(token_id, amount_holding DESC);

CREATE INDEX IF NOT EXISTS idx_token_holder_transaction_deltas_token_sig
  ON token_holder_transaction_deltas(token_id, tx_signature);

CREATE INDEX IF NOT EXISTS idx_token_holder_aggregates_updated
  ON token_holder_aggregates(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_holder_sync_states_status_updated
  ON token_holder_sync_states(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_holder_sync_stage_token_run_updated
  ON token_holder_sync_stage(token_id, run_id, shard_index, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_refresh_states_user_status_updated
  ON market_refresh_states(user_id, status, updated_at DESC);