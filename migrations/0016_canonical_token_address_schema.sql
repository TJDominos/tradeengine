-- Converge legacy address data without rebuilding tables that are referenced by
-- existing foreign keys. The original rebuild cannot run with D1's migration
-- transaction because dropping tradable_tokens performs an immediate delete.

UPDATE tradable_tokens
SET base_token_address = contract_address
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tradable_tokens_network_base_quote
  ON tradable_tokens(network, base_token_address, quote_token_address);

CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_token_fetched
  ON token_market_snapshots(token_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_contract_fetched
  ON token_market_snapshots(network, base_token_address, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_version_created
  ON strategy_evaluations(strategy_version_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_user_created
  ON strategy_evaluations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_logs_strategy_run
  ON trade_logs(strategy_run_id, created_at ASC, id ASC);

DROP TABLE IF EXISTS tradable_tokens_pair_registry_upgrade;