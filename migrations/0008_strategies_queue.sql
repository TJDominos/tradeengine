CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  config TEXT NOT NULL,
  report TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_strategies_status_created
  ON strategies(status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_strategies_updated
  ON strategies(updated_at DESC);
