CREATE INDEX IF NOT EXISTS idx_webhook_transaction_logs_user_event_chain_time
  ON webhook_transaction_logs(user_id, event_type, chain_time_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_transaction_logs_user_action_chain_time
  ON webhook_transaction_logs(user_id, action, chain_time_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_trade_logs_action_chain_time
  ON trade_logs(action, chain_time_ms DESC, id DESC);
