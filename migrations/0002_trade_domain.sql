-- Trade-domain tables for tradeengine.
-- Introduces the concept of trading pairs so the MVP can be modelled as a
-- single pair (WLT/USDC on Solana) while remaining easy to extend later by
-- inserting additional rows into trading_pairs.

-- ─── trading_pairs ────────────────────────────────────────────────────────────
-- Canonical list of supported pairs.  Only one pair is active in the initial
-- MVP: WLT/USDC on Solana.  Add more rows here when expanding to other pairs.
CREATE TABLE IF NOT EXISTS trading_pairs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT    NOT NULL UNIQUE,              -- e.g. 'WLT/USDC'
  base_mint  TEXT    NOT NULL,                     -- Solana mint address of base token
  quote_mint TEXT    NOT NULL,                     -- Solana mint address of quote token
  network    TEXT    NOT NULL DEFAULT 'solana',    -- 'solana' (only value for MVP)
  is_active  INTEGER NOT NULL DEFAULT 1,           -- 1 = enabled, 0 = disabled
  created_at INTEGER NOT NULL
);

-- Seed the initial WLT/USDC pair.
-- IMPORTANT: Replace base_mint with the real WLT token mint address before executing live trades.
-- The current value is an intentionally invalid placeholder that will fail Solana validation
-- so accidental use against a live RPC is caught immediately.
-- The quote_mint is the canonical USDC mint on Solana mainnet.
INSERT OR IGNORE INTO trading_pairs (symbol, base_mint, quote_mint, network, is_active, created_at)
VALUES (
  'WLT/USDC',
  'PLACEHOLDER_WLT_MINT_REPLACE_BEFORE_USE',                -- TODO: replace with real WLT mint
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',           -- USDC mainnet mint
  'solana',
  1,
  unixepoch()
);

-- ─── positions ───────────────────────────────────────────────────────────────
-- Current holdings per wallet address and trading pair.
-- Updated after each confirmed trade; amounts are in the base token.
CREATE TABLE IF NOT EXISTS positions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT    NOT NULL,
  pair_id        INTEGER NOT NULL,
  quantity       REAL    NOT NULL DEFAULT 0,  -- base-token holdings
  avg_cost       REAL    NOT NULL DEFAULT 0,  -- average entry price in quote token
  realized_pnl   REAL    NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  UNIQUE(wallet_address, pair_id),
  FOREIGN KEY(pair_id) REFERENCES trading_pairs(id)
);

-- ─── signals ─────────────────────────────────────────────────────────────────
-- Append-only log of incoming webhook events (e.g. from Helius).
-- external_id + source must be unique to prevent duplicate processing.
CREATE TABLE IF NOT EXISTS signals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT    NOT NULL,           -- e.g. 'helius'
  external_id    TEXT,                       -- provider-assigned deduplication key
  event_type     TEXT    NOT NULL,           -- e.g. 'SWAP', 'TRANSFER'
  wallet_address TEXT,
  tx_signature   TEXT,
  payload        TEXT    NOT NULL,           -- full JSON from the webhook
  processed      INTEGER NOT NULL DEFAULT 0, -- 0 = pending, 1 = done
  processed_at   INTEGER,
  error_message  TEXT,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE(source, external_id)
);

-- ─── trade_logs ──────────────────────────────────────────────────────────────
-- One row per proposed or executed trade, linked to a trading pair.
-- Preserves both what was requested and what actually executed on-chain.
CREATE TABLE IF NOT EXISTS trade_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id          INTEGER NOT NULL,
  signal_id        INTEGER,                    -- FK to signals if triggered by webhook
  setup_id         INTEGER,                    -- FK to historic_setups used at execution
  wallet_address   TEXT    NOT NULL,
  action           TEXT    NOT NULL CHECK(action IN ('BUY', 'SELL')),
  requested_amount REAL    NOT NULL,
  executed_amount  REAL,                       -- NULL until confirmed
  executed_price   REAL,                       -- NULL until confirmed
  tx_signature     TEXT,
  status           TEXT    NOT NULL DEFAULT 'PENDING'
                           CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED')),
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY(pair_id) REFERENCES trading_pairs(id)
);

-- ─── historic_setups ─────────────────────────────────────────────────────────
-- Snapshot of strategy parameters saved by the admin, optionally scoped to a
-- specific trading pair.  pair_id = NULL means the snapshot was global
-- (applies to whichever pair is active at the time).
CREATE TABLE IF NOT EXISTS historic_setups (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  pair_id           INTEGER,                  -- NULL = not scoped to a specific pair
  time_range_target TEXT    NOT NULL,
  max_transactions  INTEGER NOT NULL,
  max_slippage      REAL    NOT NULL,
  volume_target     REAL    NOT NULL DEFAULT 0,
  net_buyin_target  REAL    NOT NULL DEFAULT 0,
  volatility_target REAL    NOT NULL DEFAULT 0,
  pullback_target   REAL    NOT NULL DEFAULT 0,
  contract_address  TEXT,
  metadata          TEXT,                     -- JSON blob for optional / future fields
  created_at        INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(pair_id) REFERENCES trading_pairs(id)
);

-- ─── indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_positions_wallet          ON positions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_signals_processed_created ON signals(processed, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_source_ext        ON signals(source, external_id);
CREATE INDEX IF NOT EXISTS idx_trade_logs_pair_created   ON trade_logs(pair_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_logs_wallet_created ON trade_logs(wallet_address, created_at DESC);
