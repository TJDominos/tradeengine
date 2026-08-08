-- Backfill semantic rename columns from legacy contract_address storage.
-- This migration is intentionally idempotent so it can be re-applied safely.

ALTER TABLE tradable_tokens ADD COLUMN base_token_address TEXT;
ALTER TABLE token_market_snapshots ADD COLUMN base_token_address TEXT;
ALTER TABLE historic_setups ADD COLUMN base_token_address TEXT;
ALTER TABLE strategy_evaluations ADD COLUMN base_token_address TEXT;

UPDATE tradable_tokens
SET base_token_address = contract_address
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> '';

UPDATE token_market_snapshots
SET base_token_address = contract_address
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> '';

UPDATE historic_setups
SET base_token_address = contract_address
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> '';

UPDATE strategy_evaluations
SET base_token_address = contract_address
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> '';

CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_contract_fetched
  ON token_market_snapshots(network, base_token_address, fetched_at DESC);
