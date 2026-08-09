CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  config TEXT NOT NULL,
  report TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategy_evaluations (
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
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategies_status_created
  ON strategies(status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_strategies_updated
  ON strategies(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_version_created
  ON strategy_evaluations(strategy_version_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_user_created
  ON strategy_evaluations(user_id, created_at DESC);
