-- Normalize legacy second timestamps once; all snapshot writes and reads use milliseconds.
UPDATE token_market_snapshots
SET fetched_at = fetched_at * 1000
WHERE fetched_at > 0
  AND fetched_at < 1000000000000;