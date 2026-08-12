-- User-scoped Solana RPC endpoint pool for admin-configurable failover.

CREATE TABLE IF NOT EXISTS rpc_endpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  network    TEXT    NOT NULL DEFAULT 'solana',
  url        TEXT    NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, network, url),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rpc_endpoints_user_network_created
  ON rpc_endpoints(user_id, network, created_at DESC);