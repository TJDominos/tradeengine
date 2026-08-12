-- Backfill semantic rename columns from legacy contract_address storage.
-- Canonical columns are created by the base table migrations. This migration
-- only converges data and indexes, so it is safe for pre-existing schemas.

UPDATE tradable_tokens
SET base_token_address = contract_address
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> '';

CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_contract_fetched
  ON token_market_snapshots(network, base_token_address, fetched_at DESC);
