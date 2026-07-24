-- Add total_holders persistence for Jupiter holder-count snapshots.

ALTER TABLE token_market_snapshots
ADD COLUMN total_holders INTEGER;
