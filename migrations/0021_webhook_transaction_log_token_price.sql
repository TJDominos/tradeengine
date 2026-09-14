ALTER TABLE webhook_transaction_logs ADD COLUMN token_price_usd REAL;

UPDATE webhook_transaction_logs
SET token_price_usd = usdc_amount / token_amount
WHERE action IN ('BUY', 'SELL')
  AND usdc_amount IS NOT NULL
  AND token_amount IS NOT NULL
  AND token_amount > 0;