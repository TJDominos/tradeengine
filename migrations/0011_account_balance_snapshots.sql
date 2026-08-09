ALTER TABLE accounts ADD COLUMN wallet_usdc_balance REAL;
ALTER TABLE accounts ADD COLUMN wallet_sol_balance REAL;
ALTER TABLE accounts ADD COLUMN wallet_active_token_mint TEXT;
ALTER TABLE accounts ADD COLUMN wallet_active_token_balance REAL;
ALTER TABLE accounts ADD COLUMN wallet_balance_updated_at INTEGER;