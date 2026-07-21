-- Historical token market snapshots for dashboard metrics and event-triggered refreshes.

CREATE TABLE IF NOT EXISTS token_market_snapshots (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id                INTEGER NOT NULL,
  network                 TEXT    NOT NULL DEFAULT 'solana',
  contract_address        TEXT    NOT NULL,
  token_name              TEXT,
  token_symbol            TEXT,
  price_usd               REAL,
  liquidity_usd           REAL,
  fdv                     REAL,
  volume_24h              REAL,
  total_transactions_24h  INTEGER,
  outsiders_over_one_usd  INTEGER,
  dex_id                  TEXT,
  pair_address            TEXT,
  fetched_at              INTEGER NOT NULL,
  FOREIGN KEY(token_id) REFERENCES tradable_tokens(id)
);

CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_token_fetched
  ON token_market_snapshots(token_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_contract_fetched
  ON token_market_snapshots(network, contract_address, fetched_at DESC);