CREATE INDEX IF NOT EXISTS idx_token_holder_addresses_token_usdc
  ON token_holder_addresses(token_id, wallet_usdc_balance DESC, wallet_address ASC);

CREATE INDEX IF NOT EXISTS idx_token_holder_addresses_token_sol
  ON token_holder_addresses(token_id, wallet_sol_balance DESC, wallet_address ASC);