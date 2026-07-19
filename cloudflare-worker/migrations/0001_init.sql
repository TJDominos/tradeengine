-- Migration: 0001_init
-- Applied automatically by Wrangler: `wrangler d1 migrations apply tradingbot --remote`
-- All statements are idempotent (CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE).

-- 1. SETTINGS TABLE
-- Stores global configuration: volatility targets, slippage, contract address, trading algorithm, etc.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed default settings (safe to re-run; existing rows are left unchanged)
INSERT OR IGNORE INTO settings (key, value) VALUES ('volatilityTarget', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('pullbackTarget', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('volumeTarget', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('timeRangeTarget', '24h');
INSERT OR IGNORE INTO settings (key, value) VALUES ('maxTransactions', '100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('maxSlippage', '0.0100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('tradingAlgorithm', '// Enter your trading algorithm here\nfunction executeTrade(state) {\n  // return action\n}');
INSERT OR IGNORE INTO settings (key, value) VALUES ('netBuyinTarget', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('contractAddress', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('secretName', 'Loaded via Cloudflare ENV');

-- 2. ACCOUNTS TABLE
-- Tracks connected wallets: internal derived addresses and significant outsider/whale addresses.
CREATE TABLE IF NOT EXISTS accounts (
    id             TEXT PRIMARY KEY,
    type           TEXT NOT NULL,           -- 'internal' | 'outsider'
    wallet_address TEXT NOT NULL UNIQUE,
    tag            TEXT,                    -- e.g. 'Trading Bot #1', 'Whale #1'
    sol_balance    REAL DEFAULT 0.0,
    usdc_balance   REAL DEFAULT 0.0,
    profit_pnl     REAL DEFAULT 0.0,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. TRADE LOGS TABLE
-- Append-only ledger of every trade proposed or executed by the engine.
CREATE TABLE IF NOT EXISTS trade_logs (
    id             TEXT PRIMARY KEY,
    setup_id       TEXT,                    -- ID of the setup that generated this log
    wallet_address TEXT NOT NULL,
    symbol         TEXT NOT NULL,           -- e.g. 'SOL/USDC', 'WIF/SOL'
    action         TEXT NOT NULL,           -- 'BUY' | 'SELL'
    price          REAL,                    -- Execution price (if known)
    amount         REAL NOT NULL,           -- Amount swapped
    tx_signature   TEXT,                    -- Solana transaction hash
    status         TEXT NOT NULL,           -- 'PENDING' | 'SUCCESS' | 'FAILED'
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trade_logs_address ON trade_logs(wallet_address);
CREATE INDEX IF NOT EXISTS idx_trade_logs_setup    ON trade_logs(setup_id);
CREATE INDEX IF NOT EXISTS idx_trade_logs_created  ON trade_logs(created_at);

-- 4. SIGNALS / WEBHOOKS TABLE
-- Append-only log of real-time events from Helius or other providers.
CREATE TABLE IF NOT EXISTS signals (
    id         TEXT PRIMARY KEY,
    source     TEXT NOT NULL,               -- e.g. 'helius'
    event_type TEXT NOT NULL,               -- e.g. 'SWAP', 'TRANSFER'
    payload    JSON NOT NULL,               -- Raw webhook body
    processed  BOOLEAN DEFAULT 0,           -- 0 = unprocessed, 1 = processed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_signals_processed ON signals(processed, created_at);

-- 5. HISTORIC SETUPS TABLE
-- Stores historical configurations for tracking and rollback.
CREATE TABLE IF NOT EXISTS historic_setups (
    id                  TEXT PRIMARY KEY,
    time_range_target   TEXT NOT NULL,
    max_transactions    TEXT NOT NULL,
    max_slippage        TEXT NOT NULL,
    volume_target       TEXT NOT NULL,
    net_buyin_target    TEXT NOT NULL,
    volatility_target   TEXT NOT NULL,
    pullback_target     TEXT NOT NULL,
    contract_address    TEXT,
    metadata            JSON,               -- optional extensibility
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
