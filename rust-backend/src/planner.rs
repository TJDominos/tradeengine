use rusqlite::{params, Connection};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentType {
    NetPosition,
    VolumeCyclingSelf,
    VolumeCyclingHedge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Base,
    Quote,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetDefinition {
    pub symbol: String,
    pub mint: String,
    pub decimals: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TradePlanningInput {
    pub target_buy_volume: f64,
    pub target_sell_volume: f64,
    pub target_total_volume: f64,
    pub micro_task_size_hint: f64,
    pub base_asset: AssetDefinition,
    pub quote_asset: AssetDefinition,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AccountSnapshot {
    pub account_id: String,
    pub wallet_address: String,
    pub label: String,
    pub is_available: bool,
    pub has_any_asset_pair_enabled: bool,
    pub base_free: f64,
    pub quote_free: f64,
}

impl AccountSnapshot {
    pub fn can_fund(&self, side: OrderSide, required_amount: f64) -> bool {
        if !self.is_available || required_amount <= 0.0 {
            return false;
        }

        match side {
            OrderSide::Buy => self.quote_free >= required_amount,
            OrderSide::Sell => self.base_free >= required_amount,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderIntent {
    pub intent_id: String,
    pub intent_type: IntentType,
    pub side: OrderSide,
    pub amount: f64,
    pub account_id: String,
    pub paired_account_id: Option<String>,
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedPlan {
    pub available_pool: Vec<AccountSnapshot>,
    pub intents: Vec<OrderIntent>,
    pub total_planned_volume: f64,
    pub total_planned_buy_volume: f64,
    pub total_planned_sell_volume: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlannerError {
    InvalidInput(String),
    AccountPoolUnavailable(String),
    InsufficientLiquidity(String),
    Unsupported(String),
}

impl fmt::Display for PlannerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlannerError::InvalidInput(message)
            | PlannerError::AccountPoolUnavailable(message)
            | PlannerError::InsufficientLiquidity(message)
            | PlannerError::Unsupported(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for PlannerError {}

pub trait AccountProvider {
    fn load_account_pool(
        &self,
        base_asset: &AssetDefinition,
        quote_asset: &AssetDefinition,
    ) -> Result<Vec<AccountSnapshot>, PlannerError>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteAccountProviderConfig {
    pub include_watch_only_accounts: bool,
}

impl Default for SqliteAccountProviderConfig {
    fn default() -> Self {
        Self {
            include_watch_only_accounts: false,
        }
    }
}

#[derive(Debug)]
struct SqliteAccountRow {
    id: i64,
    label: String,
    wallet_address: String,
    account_type: String,
    encrypted_private_key: Option<String>,
    has_any_asset_pair_enabled: bool,
    base_free: f64,
    quote_free: f64,
}

#[derive(Debug)]
pub struct SqliteAccountProvider<'conn> {
    conn: &'conn Connection,
    user_id: i64,
    config: SqliteAccountProviderConfig,
}

impl<'conn> SqliteAccountProvider<'conn> {
    pub fn new(conn: &'conn Connection, user_id: i64) -> Self {
        Self {
            conn,
            user_id,
            config: SqliteAccountProviderConfig::default(),
        }
    }

    pub fn with_config(
        conn: &'conn Connection,
        user_id: i64,
        config: SqliteAccountProviderConfig,
    ) -> Self {
        Self { conn, user_id, config }
    }

    fn query_rows(
        &self,
        base_asset: &AssetDefinition,
        quote_asset: &AssetDefinition,
    ) -> Result<Vec<SqliteAccountRow>, PlannerError> {
        let normalized_base_mint = normalize_asset_mint(&base_asset.mint)?;
        let normalized_quote_mint = normalize_asset_mint(&quote_asset.mint)?;

        let sql = if self.config.include_watch_only_accounts {
            "SELECT
                a.id,
                a.label,
                a.wallet_address,
                a.type,
                a.encrypted_private_key,
                EXISTS(
                    SELECT 1
                    FROM account_pair_capabilities apc
                    WHERE apc.account_id = a.id
                      AND apc.base_mint = ?4
                      AND apc.quote_mint = ?5
                      AND apc.is_enabled = 1
                ) AS has_any_asset_pair_enabled,
                COALESCE((
                    SELECT abs.free_amount
                    FROM account_balance_snapshots abs
                    WHERE abs.account_id = a.id AND abs.asset_mint = ?2
                    LIMIT 1
                ), 0.0) AS base_free,
                COALESCE((
                    SELECT abs.free_amount
                    FROM account_balance_snapshots abs
                    WHERE abs.account_id = a.id AND abs.asset_mint = ?3
                    LIMIT 1
                ), 0.0) AS quote_free
             FROM accounts a
             WHERE a.user_id = ?1
             ORDER BY a.created_at DESC, a.id DESC"
        } else {
            "SELECT
                a.id,
                a.label,
                a.wallet_address,
                a.type,
                a.encrypted_private_key,
                EXISTS(
                    SELECT 1
                    FROM account_pair_capabilities apc
                    WHERE apc.account_id = a.id
                      AND apc.base_mint = ?4
                      AND apc.quote_mint = ?5
                      AND apc.is_enabled = 1
                ) AS has_any_asset_pair_enabled,
                COALESCE((
                    SELECT abs.free_amount
                    FROM account_balance_snapshots abs
                    WHERE abs.account_id = a.id AND abs.asset_mint = ?2
                    LIMIT 1
                ), 0.0) AS base_free,
                COALESCE((
                    SELECT abs.free_amount
                    FROM account_balance_snapshots abs
                    WHERE abs.account_id = a.id AND abs.asset_mint = ?3
                    LIMIT 1
                ), 0.0) AS quote_free
             FROM accounts a
             WHERE a.user_id = ?1 AND a.type = 'managed'
             ORDER BY a.created_at DESC, a.id DESC"
        };

        let mut stmt = self.conn.prepare(sql).map_err(|error| {
            PlannerError::AccountPoolUnavailable(format!(
                "Failed to prepare SQLite account pool query: {error}"
            ))
        })?;

        let rows = stmt
            .query_map(
                params![
                    self.user_id,
                    normalize_asset_mint(&base_asset.mint)?,
                    normalize_asset_mint(&quote_asset.mint)?,
                    normalized_base_mint,
                    normalized_quote_mint,
                ],
                |row| {
                    Ok(SqliteAccountRow {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        wallet_address: row.get(2)?,
                        account_type: row.get(3)?,
                        encrypted_private_key: row.get(4)?,
                        has_any_asset_pair_enabled: row.get::<_, i64>(5)? != 0,
                        base_free: row.get(6)?,
                        quote_free: row.get(7)?,
                    })
                },
            )
            .map_err(|error| {
                PlannerError::AccountPoolUnavailable(format!(
                    "Failed to load SQLite account pool rows: {error}"
                ))
            })?;

        let mut output = Vec::new();
        for row in rows {
            output.push(row.map_err(|error| {
                PlannerError::AccountPoolUnavailable(format!(
                    "Failed to decode SQLite account row: {error}"
                ))
            })?);
        }
        Ok(output)
    }
}

fn normalize_asset_symbol(symbol: &str) -> Result<String, PlannerError> {
    let normalized = symbol.trim().to_uppercase();
    if normalized.is_empty() {
        return Err(PlannerError::InvalidInput(
            "asset symbol must not be empty".to_string(),
        ));
    }
    Ok(normalized)
}

fn normalize_asset_mint(mint: &str) -> Result<String, PlannerError> {
    let normalized = mint.trim().to_string();
    if normalized.is_empty() {
        return Err(PlannerError::InvalidInput(
            "asset mint must not be empty".to_string(),
        ));
    }
    Ok(normalized)
}

impl<'conn> AccountProvider for SqliteAccountProvider<'conn> {
    fn load_account_pool(
        &self,
        base_asset: &AssetDefinition,
        quote_asset: &AssetDefinition,
    ) -> Result<Vec<AccountSnapshot>, PlannerError> {
        let rows = self.query_rows(base_asset, quote_asset)?;

        let mut output = Vec::with_capacity(rows.len());
        for row in rows {
            let derived_is_available = match row.account_type.as_str() {
                "managed" => row.encrypted_private_key.is_some(),
                _ => self.config.include_watch_only_accounts,
            };

            output.push(AccountSnapshot {
                account_id: row.id.to_string(),
                wallet_address: row.wallet_address,
                label: row.label,
                is_available: derived_is_available,
                has_any_asset_pair_enabled: row.has_any_asset_pair_enabled,
                base_free: row.base_free.max(0.0),
                quote_free: row.quote_free.max(0.0),
            });
        }

        Ok(output)
    }
}

#[derive(Debug, Clone)]
pub struct TradePlanner {
    micro_task_floor: f64,
    max_micro_tasks: usize,
}

impl Default for TradePlanner {
    fn default() -> Self {
        Self {
            micro_task_floor: 1.0,
            max_micro_tasks: 256,
        }
    }
}

impl TradePlanner {
    pub fn new(micro_task_floor: f64, max_micro_tasks: usize) -> Self {
        Self {
            micro_task_floor: micro_task_floor.max(0.0),
            max_micro_tasks: max_micro_tasks.max(1),
        }
    }

    pub fn generate_plan<P: AccountProvider>(
        &self,
        provider: &P,
        input: &TradePlanningInput,
    ) -> Result<Vec<OrderIntent>, PlannerError> {
        self.validate_input(input)?;

        let available_pool = self.load_available_pool(provider, input)?;
        if available_pool.is_empty() {
            return Err(PlannerError::AccountPoolUnavailable(
                "No available accounts with any enabled asset pair were found for planning"
                    .to_string(),
            ));
        }

        let mut intents = Vec::new();

        let buy_slices =
            self.slice_target_volume(input.target_buy_volume, input.micro_task_size_hint)?;
        let sell_slices =
            self.slice_target_volume(input.target_sell_volume, input.micro_task_size_hint)?;

        for amount in buy_slices {
            let candidate = self
                .select_account_for_side(&available_pool, OrderSide::Buy, amount)
                .ok_or_else(|| {
                    PlannerError::InsufficientLiquidity(format!(
                        "No eligible account can fund buy slice amount {amount}"
                    ))
                })?;

            intents.push(OrderIntent {
                intent_id: format!("net-buy-{}-{}", candidate.account_id, intents.len() + 1),
                intent_type: IntentType::NetPosition,
                side: OrderSide::Buy,
                amount,
                account_id: candidate.account_id.clone(),
                paired_account_id: None,
                notes: "Net position buy intent planned from available_pool".to_string(),
            });
        }

        for amount in sell_slices {
            let candidate = self
                .select_account_for_side(&available_pool, OrderSide::Sell, amount)
                .ok_or_else(|| {
                    PlannerError::InsufficientLiquidity(format!(
                        "No eligible account can fund sell slice amount {amount}"
                    ))
                })?;

            intents.push(OrderIntent {
                intent_id: format!("net-sell-{}-{}", candidate.account_id, intents.len() + 1),
                intent_type: IntentType::NetPosition,
                side: OrderSide::Sell,
                amount,
                account_id: candidate.account_id.clone(),
                paired_account_id: None,
                notes: "Net position sell intent planned from available_pool".to_string(),
            });
        }

        let planned_total_volume: f64 = intents.iter().map(|intent| intent.amount).sum();
        if planned_total_volume < input.target_total_volume {
            let remaining_total_gap = input.target_total_volume - planned_total_volume;

            let cycling_intents =
                self.build_volume_cycling_intents(&available_pool, remaining_total_gap)?;
            intents.extend(cycling_intents);
        }

        Ok(intents)
    }

    fn validate_input(&self, input: &TradePlanningInput) -> Result<(), PlannerError> {
        if input.target_buy_volume < 0.0 {
            return Err(PlannerError::InvalidInput(
                "target_buy_volume must be non-negative".to_string(),
            ));
        }
        if input.target_sell_volume < 0.0 {
            return Err(PlannerError::InvalidInput(
                "target_sell_volume must be non-negative".to_string(),
            ));
        }
        if input.target_total_volume < 0.0 {
            return Err(PlannerError::InvalidInput(
                "target_total_volume must be non-negative".to_string(),
            ));
        }
        if input.target_total_volume < input.target_buy_volume + input.target_sell_volume {
            return Err(PlannerError::InvalidInput(
                "target_total_volume cannot be smaller than buy plus sell targets"
                    .to_string(),
            ));
        }
        if input.base_asset.symbol.trim().is_empty() || input.quote_asset.symbol.trim().is_empty() {
            return Err(PlannerError::InvalidInput(
                "base and quote asset symbols are required".to_string(),
            ));
        }
        if input.base_asset.mint.trim().is_empty() || input.quote_asset.mint.trim().is_empty() {
            return Err(PlannerError::InvalidInput(
                "base and quote asset mints are required".to_string(),
            ));
        }
        Ok(())
    }

    fn load_available_pool<P: AccountProvider>(
        &self,
        provider: &P,
        input: &TradePlanningInput,
    ) -> Result<Vec<AccountSnapshot>, PlannerError> {
        let pool = provider.load_account_pool(&input.base_asset, &input.quote_asset)?;

        let available_pool = pool
            .into_iter()
            .filter(|account| account.is_available && account.has_any_asset_pair_enabled)
            .collect::<Vec<_>>();

        Ok(available_pool)
    }

    fn slice_target_volume(
        &self,
        target_volume: f64,
        size_hint: f64,
    ) -> Result<Vec<f64>, PlannerError> {
        if target_volume <= 0.0 {
            return Ok(Vec::new());
        }

        let normalized_hint = size_hint.max(self.micro_task_floor).max(1.0);
        let mut remaining = target_volume;
        let mut slices = Vec::new();

        while remaining > 0.0 && slices.len() < self.max_micro_tasks {
            let next = remaining.min(normalized_hint);
            slices.push(next);
            remaining -= next;
        }

        if remaining > 0.0 {
            return Err(PlannerError::Unsupported(
                "target volume exceeded current max_micro_tasks planner guardrail"
                    .to_string(),
            ));
        }

        Ok(slices)
    }

    fn select_account_for_side<'a>(
        &self,
        available_pool: &'a [AccountSnapshot],
        side: OrderSide,
        amount: f64,
    ) -> Option<&'a AccountSnapshot> {
        available_pool
            .iter()
            .find(|account| account.can_fund(side, amount))
    }

    fn build_volume_cycling_intents(
        &self,
        available_pool: &[AccountSnapshot],
        remaining_total_gap: f64,
    ) -> Result<Vec<OrderIntent>, PlannerError> {
        if available_pool.is_empty() {
            return Err(PlannerError::AccountPoolUnavailable(
                "Cannot build volume cycling intents without any available account".to_string(),
            ));
        }
        if remaining_total_gap <= 0.0 {
            return Ok(Vec::new());
        }

        // Skeleton only:
        // 1. Detect accounts that can self-cycle (enough base and quote balance).
        // 2. If none, pair accounts into A/B hedge candidates.
        // 3. Emit alternating BUY/SELL intents until the remaining total gap is filled.
        // 4. Reserve balances and rotate accounts fairly to avoid overusing a single wallet.
        todo!("implement volume cycling routing and fairness rotation")
    }
}

#[cfg(test)]
mod tests {
    use super::{AccountProvider, AssetDefinition, SqliteAccountProvider, SqliteAccountProviderConfig};
    use rusqlite::{params, Connection};

    fn setup_accounts_table(conn: &Connection) {
        conn.execute_batch(
            "
            CREATE TABLE accounts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              type TEXT NOT NULL,
              label TEXT NOT NULL,
              wallet_address TEXT NOT NULL,
              encrypted_private_key TEXT,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE account_balance_snapshots (
              account_id INTEGER NOT NULL,
                            asset_mint TEXT NOT NULL,
              free_amount REAL NOT NULL DEFAULT 0,
              locked_amount REAL NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL,
                            PRIMARY KEY (account_id, asset_mint)
            );
            CREATE TABLE account_pair_capabilities (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              account_id INTEGER NOT NULL,
                            base_mint TEXT NOT NULL,
                            quote_mint TEXT NOT NULL,
              is_enabled INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
                            UNIQUE(account_id, base_mint, quote_mint)
            );
            ",
        )
        .expect("create planner tables");
    }

    #[test]
    fn sqlite_account_provider_loads_managed_account_pool_from_existing_tables() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        setup_accounts_table(&conn);

        conn.execute(
            "INSERT INTO accounts (user_id, type, label, wallet_address, encrypted_private_key, created_at)
             VALUES (?1, 'managed', ?2, ?3, ?4, ?5)",
            params![1_i64, "Managed A", "So11111111111111111111111111111111111111112", "ciphertext-a", 10_i64],
        )
        .expect("insert managed account");
        conn.execute(
            "INSERT INTO accounts (user_id, type, label, wallet_address, encrypted_private_key, created_at)
             VALUES (?1, 'watch', ?2, ?3, NULL, ?4)",
            params![1_i64, "Watch A", "Vote111111111111111111111111111111111111111", 9_i64],
        )
        .expect("insert watch account");
        conn.execute(
            "INSERT INTO account_pair_capabilities (account_id, base_mint, quote_mint, is_enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)",
            params![1_i64, "So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 10_i64],
        )
        .expect("insert pair capability");
        conn.execute(
            "INSERT INTO account_balance_snapshots (account_id, asset_mint, free_amount, locked_amount, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![1_i64, "So11111111111111111111111111111111111111112", 125.0_f64, 0.0_f64, 10_i64],
        )
        .expect("insert base balance");
        conn.execute(
            "INSERT INTO account_balance_snapshots (account_id, asset_mint, free_amount, locked_amount, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![1_i64, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 300.0_f64, 0.0_f64, 10_i64],
        )
        .expect("insert quote balance");

        let provider = SqliteAccountProvider::with_config(
            &conn,
            1,
            SqliteAccountProviderConfig::default(),
        );
        let base_asset = AssetDefinition {
            symbol: "SOL".to_string(),
            mint: "So11111111111111111111111111111111111111112".to_string(),
            decimals: 9,
        };
        let quote_asset = AssetDefinition {
            symbol: "USDC".to_string(),
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
            decimals: 6,
        };

        let pool = provider
            .load_account_pool(&base_asset, &quote_asset)
            .expect("load account pool");
        assert_eq!(pool.len(), 1);
        assert_eq!(pool[0].account_id, "1");
        assert_eq!(
            pool[0].wallet_address,
            "So11111111111111111111111111111111111111112"
        );
        assert!(pool[0].is_available);
        assert!(pool[0].has_any_asset_pair_enabled);
        assert_eq!(pool[0].base_free, 125.0);
        assert_eq!(pool[0].quote_free, 300.0);
    }
}