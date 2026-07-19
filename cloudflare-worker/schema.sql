-- cloudflare-worker/schema.sql
-- Run with: wrangler d1 execute tradingbot --file=schema.sql

-- 1. SETTINGS TABLE
-- Stores global configuration like volatility targets, active contract addresses, and feature flags.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Initialize default settings (idempotent)
INSERT OR IGNORE INTO settings (key, value) VALUES ('volatilityTarget', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('pullbackTarget', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('volumeTarget', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('timeRangeTarget', '24h');
INSERT OR IGNORE INTO settings (key, value) VALUES ('maxTransactions', '100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('maxSlippage', '0.0100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('tradingAlgorithm', '// Enter your trading algorithm here\nfunction executeTrade(state) {\n  // return action\n}');
INSERT OR IGNORE INTO settings (key, value) VALUES ('netBuyinTarget', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('contractAddress', '');

-- 2. ACCOUNTS TABLE
-- Tracks connected wallets, internal derived addresses, and significant whale/outsider addresses.
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,          -- 'internal' or 'outsider'
    wallet_address TEXT NOT NULL,
    tag TEXT,                    -- E.g., 'Trading Bot #1', 'Whale #1'
    sol_balance REAL DEFAULT 0.0,
    usdc_balance REAL DEFAULT 0.0,
    profit_pnl REAL DEFAULT 0.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(wallet_address)
);

-- 3. TRADE LOGS TABLE
-- Complete historical ledger of every trade proposed or executed by the engine.
CREATE TABLE IF NOT EXISTS trade_logs (
    id TEXT PRIMARY KEY,
    setup_id TEXT,               -- ID of the setup that generated this log
    wallet_address TEXT NOT NULL,
    symbol TEXT NOT NULL,        -- e.g., 'SOL/USDC', 'WIF/SOL'
    action TEXT NOT NULL,        -- 'BUY' or 'SELL'
    price REAL,                  -- Execution price (if known)
    amount REAL NOT NULL,        -- Amount swapped
    tx_signature TEXT,           -- Transaction hash on Solana
    status TEXT NOT NULL,        -- 'PENDING', 'SUCCESS', 'FAILED'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trade_logs_address ON trade_logs(wallet_address);
CREATE INDEX IF NOT EXISTS idx_trade_logs_setup ON trade_logs(setup_id);
CREATE INDEX IF NOT EXISTS idx_trade_logs_created ON trade_logs(created_at);

-- 4. SIGNALS / WEBHOOKS TABLE
-- Append-only log of real-time events from Helius or other providers. Used for backtesting and async processing.
CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,        -- e.g., 'helius'
    event_type TEXT NOT NULL,    -- e.g., 'SWAP', 'TRANSFER'
    payload JSON NOT NULL,       -- Raw webhook body
    processed BOOLEAN DEFAULT 0, -- 0 = Unprocessed, 1 = Processed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_signals_processed ON signals(processed, created_at);

-- 5. HISTORIC SETUPS TABLE
-- Stores historical configurations for tracking and rollback
CREATE TABLE IF NOT EXISTS historic_setups (
    id TEXT PRIMARY KEY,
    time_range_target TEXT NOT NULL,
    max_transactions TEXT NOT NULL,
    max_slippage TEXT NOT NULL,
    volume_target TEXT NOT NULL,
    net_buyin_target TEXT NOT NULL,
    volatility_target TEXT NOT NULL,
    pullback_target TEXT NOT NULL,
    contract_address TEXT,
    metadata JSON,               -- for optional inputs/extensibility 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
