CREATE TABLE IF NOT EXISTS transaction_log_refresh_states (
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
);

CREATE INDEX IF NOT EXISTS idx_transaction_log_refresh_states_user_status_updated
  ON transaction_log_refresh_states(user_id, status, updated_at DESC);