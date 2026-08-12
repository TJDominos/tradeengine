CREATE INDEX IF NOT EXISTS idx_trade_logs_strategy_run
  ON trade_logs(strategy_run_id, created_at ASC, id ASC);