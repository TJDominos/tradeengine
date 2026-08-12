-- Rebuild legacy token-address tables into the canonical base_token_address schema.
-- IDs are preserved so all existing foreign-key relationships remain valid.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE tradable_tokens__canonical (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network TEXT NOT NULL DEFAULT 'solana',
  base_token_address TEXT NOT NULL,
  quote_token_address TEXT NOT NULL DEFAULT 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
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
);

INSERT INTO tradable_tokens__canonical
SELECT id, network, base_token_address,
  COALESCE(NULLIF(TRIM(quote_token_address), ''), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  amm_pool_address, symbol, name, decimals, quote_token_symbol, quote_token_name,
  quote_token_decimals, is_active, created_at
FROM tradable_tokens;

DROP TABLE tradable_tokens;
ALTER TABLE tradable_tokens__canonical RENAME TO tradable_tokens;

CREATE TABLE token_market_snapshots__canonical (
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
);

INSERT INTO token_market_snapshots__canonical
SELECT id, token_id, network, base_token_address, token_name, token_symbol,
  price_usd, liquidity_usd, fdv, volume_24h, total_holders,
  total_transactions_24h, outsiders_over_one_usd, dex_id, pair_address, fetched_at
FROM token_market_snapshots;

DROP TABLE token_market_snapshots;
ALTER TABLE token_market_snapshots__canonical RENAME TO token_market_snapshots;
CREATE INDEX idx_token_market_snapshots_token_fetched
  ON token_market_snapshots(token_id, fetched_at DESC);
CREATE INDEX idx_token_market_snapshots_contract_fetched
  ON token_market_snapshots(network, base_token_address, fetched_at DESC);

CREATE TABLE historic_setups__canonical (
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
);

INSERT INTO historic_setups__canonical
SELECT id, user_id, token_id, time_range_target, max_transactions, max_slippage,
  volume_target, net_buyin_target, volatility_target, pullback_target,
  base_token_address, metadata, created_at
FROM historic_setups;

DROP TABLE historic_setups;
ALTER TABLE historic_setups__canonical RENAME TO historic_setups;

CREATE TABLE strategy_evaluations__canonical (
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
);

INSERT INTO strategy_evaluations__canonical
SELECT id, user_id, strategy_version_id, source, event_type, external_id,
  base_token_address,
  wallet_address, tx_signature, status, should_execute, summary_json, created_at
FROM strategy_evaluations;

DROP TABLE strategy_evaluations;
ALTER TABLE strategy_evaluations__canonical RENAME TO strategy_evaluations;
CREATE INDEX idx_strategy_evaluations_version_created
  ON strategy_evaluations(strategy_version_id, created_at DESC);
CREATE INDEX idx_strategy_evaluations_user_created
  ON strategy_evaluations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_logs_strategy_run
  ON trade_logs(strategy_run_id, created_at ASC, id ASC);

DROP TABLE IF EXISTS tradable_tokens_pair_registry_upgrade;