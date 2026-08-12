-- Cover managed-account pagination filters and fixed sort orders.

CREATE INDEX IF NOT EXISTS idx_accounts_managed_newest
  ON accounts(
    user_id,
    type,
    COALESCE(is_active, 1) DESC,
    created_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_accounts_managed_usdc
  ON accounts(
    user_id,
    type,
    COALESCE(wallet_usdc_balance, 0) DESC,
    COALESCE(is_active, 1) DESC,
    created_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_accounts_managed_sol
  ON accounts(
    user_id,
    type,
    COALESCE(wallet_sol_balance, 0) DESC,
    COALESCE(is_active, 1) DESC,
    created_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_accounts_managed_token
  ON accounts(
    user_id,
    type,
    wallet_active_token_mint,
    COALESCE(wallet_active_token_balance, 0) DESC,
    COALESCE(is_active, 1) DESC,
    created_at DESC,
    id DESC
  );