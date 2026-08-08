-- Verify that renamed base_token_address columns were backfilled from legacy contract_address data.
-- All result rows should report zero missing values after migrations/0009 and runtime backfill.

SELECT 'tradable_tokens' AS table_name,
       COUNT(*) AS missing_rows
FROM tradable_tokens
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> ''

UNION ALL

SELECT 'token_market_snapshots' AS table_name,
       COUNT(*) AS missing_rows
FROM token_market_snapshots
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> ''

UNION ALL

SELECT 'historic_setups' AS table_name,
       COUNT(*) AS missing_rows
FROM historic_setups
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> ''

UNION ALL

SELECT 'strategy_evaluations' AS table_name,
       COUNT(*) AS missing_rows
FROM strategy_evaluations
WHERE (base_token_address IS NULL OR TRIM(base_token_address) = '')
  AND contract_address IS NOT NULL
  AND TRIM(contract_address) <> '';
