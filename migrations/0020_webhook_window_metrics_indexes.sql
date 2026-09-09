CREATE INDEX IF NOT EXISTS idx_webhook_transaction_logs_user_token_status_chain_time
  ON webhook_transaction_logs(user_id, token_id, status, chain_time_ms);

CREATE INDEX IF NOT EXISTS idx_accounts_user_wallet
  ON accounts(user_id, wallet_address);