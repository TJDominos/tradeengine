-- Rebuild rpc_endpoints with an activation flag and normalize provider preference.

CREATE TABLE IF NOT EXISTS rpc_endpoints__next (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  network    TEXT    NOT NULL DEFAULT 'solana',
  url        TEXT    NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, network, url),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT OR REPLACE INTO rpc_endpoints__next (
  id,
  user_id,
  network,
  url,
  is_active,
  created_at
)
SELECT
  id,
  user_id,
  network,
  CASE
    WHEN network = 'solana' AND lower(url) LIKE '%mainnet.helius-rpc.com%'
      THEN 'https://mainnet.helius-rpc.com/?api-key=fda76be1-7d09-4880-80db-837831934193'
    ELSE url
  END,
  CASE
    WHEN network = 'solana' AND lower(url) LIKE '%alchemy%'
      THEN 0
    WHEN network = 'solana' AND lower(url) LIKE '%mainnet.helius-rpc.com%'
      THEN 1
    ELSE 1
  END,
  created_at
FROM rpc_endpoints
ORDER BY created_at ASC, id ASC;

DROP TABLE rpc_endpoints;
ALTER TABLE rpc_endpoints__next RENAME TO rpc_endpoints;

INSERT OR IGNORE INTO rpc_endpoints (
  user_id,
  network,
  url,
  is_active,
  created_at
)
SELECT
  users.id,
  'solana',
  'https://mainnet.helius-rpc.com/?api-key=fda76be1-7d09-4880-80db-837831934193',
  1,
  CAST(strftime('%s', 'now') AS INTEGER)
FROM users
WHERE NOT EXISTS (
  SELECT 1
  FROM rpc_endpoints endpoints
  WHERE endpoints.user_id = users.id
    AND endpoints.network = 'solana'
    AND lower(endpoints.url) LIKE '%mainnet.helius-rpc.com%'
);

CREATE INDEX IF NOT EXISTS idx_rpc_endpoints_user_network_created
  ON rpc_endpoints(user_id, network, created_at DESC);