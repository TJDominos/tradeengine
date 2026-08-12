-- Trade-domain tables for tradeengine.
-- Models token onboarding: tokens are added by network + contract address.
-- USDC on Solana is the implicit quote asset; trades are executed via Jupiter.

-- ─── tradable_tokens ─────────────────────────────────────────────────────────
-- Tokens configured by the admin via network + contract address.
-- Metadata fields (symbol, name, decimals) are populated after the backend
-- fetches token info from on-chain.  Trades are always executed against USDC
-- on the same network via the Jupiter aggregator (jup.ag).
CREATE TABLE IF NOT EXISTS tradable_tokens (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  network          TEXT    NOT NULL DEFAULT 'solana',   -- 'solana' (only value for MVP)
  contract_address TEXT    NOT NULL,                    -- token mint address on Solana
  base_token_address TEXT,
  quote_token_address TEXT NOT NULL DEFAULT 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amm_pool_address TEXT,
  symbol           TEXT,                                -- fetched from on-chain metadata
  name             TEXT,                                -- fetched from on-chain metadata
  decimals         INTEGER,                             -- fetched from on-chain metadata
  quote_token_symbol TEXT,
  quote_token_name TEXT,
  quote_token_decimals INTEGER,
  is_active        INTEGER NOT NULL DEFAULT 1,          -- 1 = enabled, 0 = disabled
  created_at       INTEGER NOT NULL,
  UNIQUE(network, contract_address)
);

-- ─── positions ───────────────────────────────────────────────────────────────
-- Current holdings per wallet address and tradable token.
-- Updated after each confirmed trade; amounts are in the token's native units.
CREATE TABLE IF NOT EXISTS positions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT    NOT NULL,
  token_id       INTEGER NOT NULL,
  quantity       REAL    NOT NULL DEFAULT 0,  -- token holdings
  avg_cost       REAL    NOT NULL DEFAULT 0,  -- average entry price in USDC
  realized_pnl   REAL    NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  UNIQUE(wallet_address, token_id),
  FOREIGN KEY(token_id) REFERENCES tradable_tokens(id)
);

-- ─── signals ─────────────────────────────────────────────────────────────────
-- Append-only log of incoming webhook events (e.g. from Helius).
-- external_id is required (NOT NULL) so the UNIQUE(source, external_id)
-- constraint reliably prevents duplicate processing across all rows.
CREATE TABLE IF NOT EXISTS signals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT    NOT NULL,           -- e.g. 'helius'
  external_id    TEXT    NOT NULL,           -- provider-assigned deduplication key
  event_type     TEXT    NOT NULL,           -- e.g. 'SWAP', 'TRANSFER'
  wallet_address TEXT,
  tx_signature   TEXT,
  payload        TEXT    NOT NULL,           -- full JSON from the webhook
  details_json   TEXT,
  processed      INTEGER NOT NULL DEFAULT 0, -- 0 = pending, 1 = done
  processed_at   INTEGER,
  error_message  TEXT,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS webhook_transaction_logs (
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
);

-- ─── trade_logs ──────────────────────────────────────────────────────────────
-- One row per proposed or executed trade, linked to a tradable token.
-- Preserves both what was requested and what actually executed on-chain.
-- Trades are executed via Jupiter (jup.ag) against USDC on Solana.
CREATE TABLE IF NOT EXISTS trade_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id         INTEGER NOT NULL,
  signal_id        INTEGER,                    -- FK to signals if triggered by webhook
  setup_id         INTEGER,                    -- FK to historic_setups used at execution
  wallet_address   TEXT    NOT NULL,
  action           TEXT    NOT NULL CHECK(action IN ('BUY', 'SELL')),
  requested_amount REAL    NOT NULL,
  executed_amount  REAL,                       -- NULL until confirmed
  executed_price   REAL,                       -- NULL until confirmed
  tx_signature     TEXT,
  chain_time_ms    INTEGER,
  execution_trace_json TEXT,
  strategy_run_id  TEXT,
  status           TEXT    NOT NULL DEFAULT 'PENDING'
                           CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED')),
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY(token_id)  REFERENCES tradable_tokens(id),
  FOREIGN KEY(signal_id) REFERENCES signals(id),
  FOREIGN KEY(setup_id)  REFERENCES historic_setups(id)
);

-- ─── historic_setups ─────────────────────────────────────────────────────────
-- Snapshot of strategy parameters saved by the admin, optionally scoped to a
-- specific tradable token.  token_id = NULL means the snapshot was global
-- (applies to whichever token is active at the time).
CREATE TABLE IF NOT EXISTS historic_setups (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  token_id          INTEGER,                  -- NULL = not scoped to a specific token
  time_range_target TEXT    NOT NULL,
  max_transactions  INTEGER NOT NULL,
  max_slippage      REAL    NOT NULL,
  volume_target     REAL    NOT NULL DEFAULT 0,
  net_buyin_target  REAL    NOT NULL DEFAULT 0,
  volatility_target REAL    NOT NULL DEFAULT 0,
  pullback_target   REAL    NOT NULL DEFAULT 0,
  contract_address  TEXT,
  base_token_address TEXT,
  metadata          TEXT,                     -- JSON blob for optional / future fields
  created_at        INTEGER NOT NULL,
  FOREIGN KEY(user_id)   REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(token_id)  REFERENCES tradable_tokens(id)
);

-- ─── indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_positions_wallet          ON positions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_signals_processed_created ON signals(processed, created_at);
-- The UNIQUE constraint covers (source, external_id) lookups; add source-only index for
-- queries that filter by source without specifying external_id.
CREATE INDEX IF NOT EXISTS idx_signals_source            ON signals(source);
-- Note: no separate index on (source, external_id) — the UNIQUE constraint already covers it.
CREATE INDEX IF NOT EXISTS idx_trade_logs_token_created  ON trade_logs(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_logs_wallet_created ON trade_logs(wallet_address, created_at DESC);
