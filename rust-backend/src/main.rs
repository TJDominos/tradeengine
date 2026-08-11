mod actor_runtime;
mod planner;
mod executor;
mod strategy;

use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::RngCore;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use std::convert::Infallible;
use std::env;
use std::fs;
use std::path::Path;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use warp::http::header::{CONTENT_TYPE, SET_COOKIE};
use warp::http::{HeaderValue, Response, StatusCode};
use warp::{Filter, Reply};

const SQLITE_CONSTRAINT_PRIMARY_KEY: i32 = 1555;
const SQLITE_CONSTRAINT_UNIQUE: i32 = 2067;

#[derive(Clone)]
struct AppContext {
    db: Arc<Mutex<Database>>,
    config: Arc<Config>,
    actors: actor_runtime::ActorRuntime,
}

#[derive(Clone)]
struct Config {
    bind_addr: String,
    database_path: String,
    static_dir: String,
    session_ttl_hours: u64,
    cookie_secure: bool,
    private_key_encryption_key: Option<[u8; 32]>,
    solana_rpc_url: Option<String>,
}

struct ResolvedExecutionSettings {
    base_mint: String,
    quote_mint: String,
    base_decimals: u8,
    quote_decimals: u8,
    slippage_bps: u64,
}

struct Database {
    conn: Connection,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Clone)]
struct SessionUser {
    id: i64,
    username: String,
    role: String,
}

#[derive(Clone, Serialize)]
struct AuthSummary {
    username: String,
    role: String,
}

#[derive(Clone, Serialize)]
struct AuthStatusResponse {
    #[serde(rename = "setupRequired")]
    setup_required: bool,
    authenticated: bool,
    user: Option<AuthSummary>,
}

#[derive(Deserialize)]
struct CredentialsRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct AuthResponse {
    authenticated: bool,
    user: AuthSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SettingsState {
    #[serde(rename = "contractAddress")]
    contract_address: String,
    #[serde(rename = "volatilityTarget")]
    volatility_target: f64,
    #[serde(rename = "pullbackTarget")]
    pullback_target: f64,
    #[serde(rename = "volumeTarget")]
    volume_target: f64,
    #[serde(rename = "netBuyinTarget")]
    net_buyin_target: f64,
    #[serde(rename = "timeRangeTarget")]
    time_range_target: String,
    #[serde(rename = "maxTransactions")]
    max_transactions: u64,
    #[serde(rename = "maxSlippage")]
    max_slippage: f64,
    #[serde(rename = "strategyNotes")]
    strategy_notes: String,
    #[serde(rename = "macroObjective")]
    macro_objective: String,
    #[serde(rename = "triggerThresholdUsd")]
    trigger_threshold_usd: f64,
    #[serde(rename = "minOrderSize")]
    min_order_size: f64,
    #[serde(rename = "maxOrderSize")]
    max_order_size: f64,
    #[serde(rename = "absorbRatio")]
    absorb_ratio: f64,
    #[serde(rename = "followSellRatio")]
    follow_sell_ratio: f64,
    #[serde(rename = "dumpRatio")]
    dump_ratio: f64,
    #[serde(rename = "managedKeyCount")]
    managed_key_count: usize,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            contract_address: String::new(),
            volatility_target: 4.5,
            pullback_target: 2.0,
            volume_target: 0.0,
            net_buyin_target: 0.0,
            time_range_target: "24h".to_string(),
            max_transactions: 100,
            max_slippage: 1.0,
            strategy_notes: "Trading execution is intentionally disabled until a real execution engine is implemented and reviewed.".to_string(),
            macro_objective: "accumulation".to_string(),
            trigger_threshold_usd: 1.0,
            min_order_size: 1.0,
            max_order_size: 25.0,
            absorb_ratio: 1.0,
            follow_sell_ratio: 0.5,
            dump_ratio: 0.75,
            managed_key_count: 0,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SettingsUpdateRequest {
    #[serde(rename = "contractAddress")]
    contract_address: String,
    #[serde(rename = "volatilityTarget")]
    volatility_target: f64,
    #[serde(rename = "pullbackTarget")]
    pullback_target: f64,
    #[serde(rename = "volumeTarget")]
    volume_target: f64,
    #[serde(rename = "netBuyinTarget")]
    net_buyin_target: f64,
    #[serde(rename = "timeRangeTarget")]
    time_range_target: String,
    #[serde(rename = "maxTransactions")]
    max_transactions: u64,
    #[serde(rename = "maxSlippage")]
    max_slippage: f64,
    #[serde(rename = "strategyNotes")]
    strategy_notes: String,
    #[serde(rename = "macroObjective")]
    macro_objective: Option<String>,
    #[serde(rename = "triggerThresholdUsd")]
    trigger_threshold_usd: Option<f64>,
    #[serde(rename = "minOrderSize")]
    min_order_size: Option<f64>,
    #[serde(rename = "maxOrderSize")]
    max_order_size: Option<f64>,
    #[serde(rename = "absorbRatio")]
    absorb_ratio: Option<f64>,
    #[serde(rename = "followSellRatio")]
    follow_sell_ratio: Option<f64>,
    #[serde(rename = "dumpRatio")]
    dump_ratio: Option<f64>,
}

#[derive(Clone, Serialize)]
struct AccountRecord {
    id: i64,
    label: String,
    address: String,
    #[serde(rename = "type")]
    account_type: String,
    #[serde(rename = "createdAt")]
    created_at: u64,
}

#[derive(Clone, Serialize)]
struct AuditLogRecord {
    id: i64,
    action: String,
    target: String,
    details: String,
    actor: String,
    #[serde(rename = "createdAt")]
    created_at: u64,
}

#[derive(Serialize)]
struct StatsState {
    #[serde(rename = "managedAccounts")]
    managed_accounts: usize,
    #[serde(rename = "watchedAccounts")]
    watched_accounts: usize,
    #[serde(rename = "tradeExecutionEnabled")]
    trade_execution_enabled: bool,
}

#[derive(Serialize)]
struct SystemState {
    backend: &'static str,
    #[serde(rename = "databasePath")]
    database_path: String,
    #[serde(rename = "databaseConnected")]
    database_connected: bool,
}

#[derive(Serialize)]
struct EngineStateResponse {
    auth: AuthSummary,
    settings: SettingsState,
    #[serde(rename = "internalAccs")]
    internal_accs: Vec<AccountRecord>,
    #[serde(rename = "outsiderAccs")]
    outsider_accs: Vec<AccountRecord>,
    logs: Vec<AuditLogRecord>,
    stats: StatsState,
    system: SystemState,
}

#[derive(Deserialize)]
struct ImportPrivateKeyRequest {
    label: String,
    #[serde(rename = "privateKey")]
    private_key: String,
}

#[derive(Deserialize)]
struct ImportAccountRequest {
    label: String,
    address: String,
}

#[derive(Serialize)]
struct ImportResponse {
    account: AccountRecord,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    backend: &'static str,
    #[serde(rename = "databaseConnected")]
    database_connected: bool,
    #[serde(rename = "databasePath")]
    database_path: String,
}

#[derive(Serialize)]
struct StatusResponse {
    ok: bool,
}

#[derive(Clone, Serialize)]
struct StrategyExecutionRunRecord {
    id: i64,
    #[serde(rename = "baseSymbol")]
    base_symbol: String,
    #[serde(rename = "baseMint")]
    base_mint: String,
    #[serde(rename = "baseDecimals")]
    base_decimals: u8,
    #[serde(rename = "quoteSymbol")]
    quote_symbol: String,
    #[serde(rename = "quoteMint")]
    quote_mint: String,
    #[serde(rename = "quoteDecimals")]
    quote_decimals: u8,
    #[serde(rename = "targetBuyVolume")]
    target_buy_volume: f64,
    #[serde(rename = "targetSellVolume")]
    target_sell_volume: f64,
    #[serde(rename = "targetTotalVolume")]
    target_total_volume: f64,
    #[serde(rename = "microTaskSizeHint")]
    micro_task_size_hint: f64,
    status: String,
    #[serde(rename = "latestPlanVersion")]
    latest_plan_version: i64,
    #[serde(rename = "createdAt")]
    created_at: u64,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

#[derive(Clone, Serialize)]
struct StrategyExecutionTaskRecord {
    id: i64,
    #[serde(rename = "runId")]
    run_id: i64,
    #[serde(rename = "planVersion")]
    plan_version: i64,
    #[serde(rename = "intentId")]
    intent_id: String,
    #[serde(rename = "intentType")]
    intent_type: String,
    side: String,
    amount: f64,
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "pairedAccountId")]
    paired_account_id: Option<String>,
    notes: String,
    status: String,
    #[serde(rename = "createdAt")]
    created_at: u64,
}

#[derive(Serialize)]
struct StrategyExecutionQueueResponse {
    #[serde(rename = "activeRun")]
    active_run: Option<StrategyExecutionRunRecord>,
    tasks: Vec<StrategyExecutionTaskRecord>,
}

#[derive(Clone, Serialize)]
struct StrategyExecutionTaskAttemptRecord {
    id: i64,
    #[serde(rename = "taskId")]
    task_id: i64,
    #[serde(rename = "runId")]
    run_id: i64,
    #[serde(rename = "planVersion")]
    plan_version: i64,
    status: String,
    #[serde(rename = "txSignature")]
    tx_signature: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
    #[serde(rename = "startedAt")]
    started_at: u64,
    #[serde(rename = "finishedAt")]
    finished_at: u64,
}

#[derive(Deserialize)]
struct StrategyExecutionConsumeRequest {
    #[serde(rename = "runId")]
    run_id: Option<i64>,
    #[serde(rename = "maxTasks")]
    max_tasks: Option<usize>,
}

#[derive(Deserialize)]
struct StrategyExternalTradeEventRequest {
    #[serde(rename = "eventId")]
    event_id: Option<String>,
    #[serde(rename = "eventType")]
    event_type: String,
    #[serde(rename = "amountUsd")]
    amount_usd: f64,
    #[serde(rename = "contractAddress")]
    contract_address: Option<String>,
    #[serde(rename = "walletAddress")]
    wallet_address: Option<String>,
    #[serde(rename = "txSignature")]
    tx_signature: Option<String>,
    #[serde(rename = "isLossCut")]
    is_loss_cut: Option<bool>,
    execute: Option<bool>,
}

#[derive(Serialize)]
struct StrategyEventAcceptedResponse {
    accepted: bool,
    #[serde(rename = "eventId")]
    event_id: String,
}

#[derive(Serialize)]
struct StrategyExecutionConsumeResponse {
    #[serde(rename = "activeRun")]
    active_run: Option<StrategyExecutionRunRecord>,
    results: Vec<StrategyExecutionTaskAttemptRecord>,
    #[serde(rename = "executedCount")]
    executed_count: usize,
    #[serde(rename = "failedCount")]
    failed_count: usize,
}

#[derive(Deserialize)]
struct TradeRequest {
    #[serde(rename = "baseSymbol")]
    base_symbol: String,
    #[serde(rename = "baseMint")]
    base_mint: String,
    #[serde(rename = "baseDecimals")]
    base_decimals: u8,
    #[serde(rename = "quoteSymbol")]
    quote_symbol: String,
    #[serde(rename = "quoteMint")]
    quote_mint: String,
    #[serde(rename = "quoteDecimals")]
    quote_decimals: u8,
    #[serde(rename = "targetBuyVolume")]
    target_buy_volume: f64,
    #[serde(rename = "targetSellVolume")]
    target_sell_volume: f64,
    #[serde(rename = "targetTotalVolume")]
    target_total_volume: f64,
    #[serde(rename = "microTaskSizeHint")]
    micro_task_size_hint: Option<f64>,
    #[serde(rename = "confirmStrategy")]
    confirm_strategy: bool,
    #[serde(rename = "confirmPlan")]
    confirm_plan: bool,
    #[serde(rename = "externalDelayMs")]
    external_delay_ms: Option<u64>,
}


#[tokio::main]
async fn main() {
    env_logger::init();
    dotenv::dotenv().ok();

    let config = Config::from_env();
    let database = Database::open(&config.database_path).expect("failed to open database");
    let db = Arc::new(Mutex::new(database));
    let config = Arc::new(config.clone());
    let actors = actor_runtime::spawn_actor_runtime(db.clone(), config.clone());
    let context = AppContext {
        db,
        config: config.clone(),
        actors,
    };

    let api = api_routes(context.clone());
    let static_routes = static_routes(context.config.static_dir.clone());
    let routes = api.or(static_routes).with(warp::log("tradeengine"));

    let bind_addr = parse_bind_addr(&config.bind_addr).expect("invalid BIND_ADDR");
    log::info!(
        "tradeengine rust backend listening on {} with database {}",
        config.bind_addr,
        config.database_path
    );
    warp::serve(routes).run(bind_addr).await;
}

impl Config {
    fn from_env() -> Self {
        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_string());
        let database_path = env::var("DATABASE_PATH").unwrap_or_else(|_| "./data/tradeengine.db".to_string());
        let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "../dist".to_string());
        let session_ttl_hours = env::var("SESSION_TTL_HOURS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(12);
        let cookie_secure = env::var("COOKIE_SECURE")
            .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);
        let private_key_encryption_key = env::var("PRIVATE_KEY_ENCRYPTION_KEY")
            .ok()
            .and_then(|value| parse_encryption_key(&value).ok());
        let solana_rpc_url = env::var("SOLANA_RPC_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self {
            bind_addr,
            database_path,
            static_dir,
            session_ttl_hours,
            cookie_secure,
            private_key_encryption_key,
            solana_rpc_url,
        }
    }
}

impl Database {
    fn planner_account_provider(&self, user_id: i64) -> planner::SqliteAccountProvider<'_> {
        planner::SqliteAccountProvider::new(&self.conn, user_id)
    }

    fn generate_trade_plan(
        &self,
        user_id: i64,
        input: &planner::TradePlanningInput,
    ) -> Result<Vec<planner::OrderIntent>, ApiError> {
        let provider = self.planner_account_provider(user_id);
        let trade_planner = planner::TradePlanner::default();
        trade_planner
            .generate_plan(&provider, input)
            .map_err(|error| bad_request(error.to_string()))
    }

    fn add_strategy_log(&mut self, user_id: i64, stage: &str, details: &str) -> Result<(), ApiError> {
        self.add_audit_log(user_id, "strategy.planner", stage, details)
    }

    fn get_latest_strategy_execution_run(
        &self,
        user_id: i64,
    ) -> Result<Option<StrategyExecutionRunRecord>, ApiError> {
        self.conn
            .query_row(
                "
                SELECT
                  id,
                  base_symbol,
                                    base_mint,
                                    base_decimals,
                  quote_symbol,
                                    quote_mint,
                                    quote_decimals,
                  target_buy_volume,
                  target_sell_volume,
                  target_total_volume,
                  micro_task_size_hint,
                  status,
                  latest_plan_version,
                  created_at,
                  updated_at
                FROM strategy_execution_runs
                WHERE user_id = ?1
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
                ",
                params![user_id],
                |row| {
                    Ok(StrategyExecutionRunRecord {
                        id: row.get(0)?,
                        base_symbol: row.get(1)?,
                        base_mint: row.get(2)?,
                        base_decimals: row.get(3)?,
                        quote_symbol: row.get(4)?,
                        quote_mint: row.get(5)?,
                        quote_decimals: row.get(6)?,
                        target_buy_volume: row.get(7)?,
                        target_sell_volume: row.get(8)?,
                        target_total_volume: row.get(9)?,
                        micro_task_size_hint: row.get(10)?,
                        status: row.get(11)?,
                        latest_plan_version: row.get(12)?,
                        created_at: row.get(13)?,
                        updated_at: row.get(14)?,
                    })
                },
            )
            .optional()
            .map_err(internal_error)
    }

    fn list_strategy_execution_tasks(
        &self,
        run_id: i64,
    ) -> Result<Vec<StrategyExecutionTaskRecord>, ApiError> {
        let mut stmt = self
            .conn
            .prepare(
                "
                SELECT
                  id,
                  run_id,
                  plan_version,
                  intent_id,
                  intent_type,
                  side,
                  amount,
                  account_id,
                  paired_account_id,
                  notes,
                  status,
                  created_at
                FROM strategy_execution_tasks
                WHERE run_id = ?1
                ORDER BY plan_version DESC, created_at ASC, id ASC
                ",
            )
            .map_err(internal_error)?;

        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok(StrategyExecutionTaskRecord {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    plan_version: row.get(2)?,
                    intent_id: row.get(3)?,
                    intent_type: row.get(4)?,
                    side: row.get(5)?,
                    amount: row.get(6)?,
                    account_id: row.get(7)?,
                    paired_account_id: row.get(8)?,
                    notes: row.get(9)?,
                    status: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })
            .map_err(internal_error)?;

        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row.map_err(internal_error)?);
        }
        Ok(tasks)
    }

    fn create_strategy_execution_run(
        &mut self,
        user_id: i64,
        input: &planner::TradePlanningInput,
    ) -> Result<i64, ApiError> {
        let base_symbol = normalize_asset_symbol(&input.base_asset.symbol)?;
        let quote_symbol = normalize_asset_symbol(&input.quote_asset.symbol)?;
        let now = now_ts();

        self.conn
            .execute(
                "
                INSERT INTO strategy_execution_runs (
                  user_id,
                  base_symbol,
                  base_mint,
                  base_decimals,
                  quote_symbol,
                  quote_mint,
                  quote_decimals,
                  target_buy_volume,
                  target_sell_volume,
                  target_total_volume,
                  micro_task_size_hint,
                  status,
                  latest_plan_version,
                  created_at,
                  updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'planned', 1, ?12, ?12)
                ",
                params![
                    user_id,
                    base_symbol,
                    input.base_asset.mint,
                    i64::from(input.base_asset.decimals),
                    quote_symbol,
                    input.quote_asset.mint,
                    i64::from(input.quote_asset.decimals),
                    input.target_buy_volume,
                    input.target_sell_volume,
                    input.target_total_volume,
                    input.micro_task_size_hint,
                    now,
                ],
            )
            .map_err(internal_error)?;

        Ok(self.conn.last_insert_rowid())
    }

    fn replace_strategy_execution_tasks(
        &mut self,
        run_id: i64,
        plan_version: i64,
        intents: &[planner::OrderIntent],
        status: &str,
    ) -> Result<(), ApiError> {
        let now = now_ts();
        let tx = self.conn.transaction().map_err(internal_error)?;
        tx.execute(
            "DELETE FROM strategy_execution_tasks WHERE run_id = ?1 AND plan_version = ?2",
            params![run_id, plan_version],
        )
        .map_err(internal_error)?;

        for intent in intents {
            tx.execute(
                "
                INSERT INTO strategy_execution_tasks (
                  run_id,
                  plan_version,
                  intent_id,
                  intent_type,
                  side,
                  amount,
                  account_id,
                  paired_account_id,
                  notes,
                  status,
                  created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ",
                params![
                    run_id,
                    plan_version,
                    intent.intent_id,
                    format!("{:?}", intent.intent_type),
                    format!("{:?}", intent.side),
                    intent.amount,
                    intent.account_id,
                    intent.paired_account_id,
                    intent.notes,
                    status,
                    now,
                ],
            )
            .map_err(internal_error)?;
        }

        tx.commit().map_err(internal_error)?;
        Ok(())
    }

    fn update_strategy_execution_run_status(
        &mut self,
        run_id: i64,
        latest_plan_version: i64,
        status: &str,
    ) -> Result<(), ApiError> {
        self.conn
            .execute(
                "
                UPDATE strategy_execution_runs
                SET latest_plan_version = ?2,
                    status = ?3,
                    updated_at = ?4
                WHERE id = ?1
                ",
                params![run_id, latest_plan_version, status, now_ts()],
            )
            .map_err(internal_error)?;
        Ok(())
    }

    fn insert_strategy_execution_task_attempt(
        &mut self,
        task_id: i64,
        run_id: i64,
        plan_version: i64,
        status: &str,
        tx_signature: Option<&str>,
        error_message: Option<&str>,
        started_at: u64,
        finished_at: u64,
    ) -> Result<i64, ApiError> {
        self.conn
            .execute(
                "
                INSERT INTO strategy_execution_task_attempts (
                  task_id,
                  run_id,
                  plan_version,
                  status,
                  tx_signature,
                  error_message,
                  started_at,
                  finished_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ",
                params![
                    task_id,
                    run_id,
                    plan_version,
                    status,
                    tx_signature,
                    error_message,
                    started_at,
                    finished_at,
                ],
            )
            .map_err(internal_error)?;
        Ok(self.conn.last_insert_rowid())
    }

    fn load_managed_wallet_material(
        &self,
        account_id: &str,
        encryption_key: [u8; 32],
    ) -> Result<(String, Vec<u8>), ApiError> {
        let parsed_account_id = account_id
            .parse::<i64>()
            .map_err(|_| bad_request("Planner account id must be a numeric managed account id"))?;

        self.conn
            .query_row(
                "SELECT wallet_address, encrypted_private_key FROM accounts WHERE id = ?1 AND type = 'managed' LIMIT 1",
                params![parsed_account_id],
                |row| {
                    let wallet_address: String = row.get(0)?;
                    let encrypted_private_key: String = row.get(1)?;
                    Ok((wallet_address, encrypted_private_key))
                },
            )
            .map_err(internal_error)
            .and_then(|(wallet_address, encrypted_private_key)| {
                let decrypted_private_key = decrypt_private_key(&encrypted_private_key, encryption_key)?;
                Ok((wallet_address, decrypted_private_key))
            })
    }

    fn load_execution_settings_for_run(
        &self,
        run_id: i64,
    ) -> Result<ResolvedExecutionSettings, ApiError> {
        let (base_mint, base_decimals, quote_mint, quote_decimals, user_id): (String, i64, String, i64, i64) = self
            .conn
            .query_row(
                "SELECT base_mint, base_decimals, quote_mint, quote_decimals, user_id FROM strategy_execution_runs WHERE id = ?1 LIMIT 1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(internal_error)?;

        let settings = self.load_settings(user_id)?;

        Ok(ResolvedExecutionSettings {
            base_mint,
            quote_mint,
            base_decimals: u8::try_from(base_decimals).map_err(|_| bad_request("base decimals out of range"))?,
            quote_decimals: u8::try_from(quote_decimals).map_err(|_| bad_request("quote decimals out of range"))?,
            slippage_bps: (settings.max_slippage * 100.0).round().max(1.0) as u64,
        })
    }

    fn consume_strategy_execution_tasks(
        &mut self,
        run_id: i64,
        max_tasks: usize,
        config: &Config,
    ) -> Result<Vec<StrategyExecutionTaskAttemptRecord>, ApiError> {
        if max_tasks == 0 {
            return Ok(Vec::new());
        }

        let latest_plan_version: i64 = self
            .conn
            .query_row(
                "SELECT latest_plan_version FROM strategy_execution_runs WHERE id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(internal_error)?;

        let pending_rows = {
            let mut stmt = self
                .conn
                .prepare(
                    "
                    SELECT id, intent_id, side, amount, account_id, paired_account_id, notes
                    FROM strategy_execution_tasks
                    WHERE run_id = ?1 AND plan_version = ?2 AND status = 'pending'
                    ORDER BY created_at ASC, id ASC
                    LIMIT ?3
                    ",
                )
                .map_err(internal_error)?;
            let rows = stmt
                .query_map(params![run_id, latest_plan_version, max_tasks as i64], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, f64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .map_err(internal_error)?;

            let mut values = Vec::new();
            for row in rows {
                values.push(row.map_err(internal_error)?);
            }
            values
        };

        let executor: Box<dyn executor::TaskExecutor> = Box::new(executor::MainnetExecutor {
            rpc_url: config
                .solana_rpc_url
                .clone()
                .ok_or_else(|| bad_request("SOLANA_RPC_URL is required for Jupiter execution"))?,
        });
        let encryption_key = config
            .private_key_encryption_key
            .ok_or_else(|| service_unavailable("PRIVATE_KEY_ENCRYPTION_KEY is required for task execution"))?;
        let execution_settings = self.load_execution_settings_for_run(run_id)?;

        let mut attempts = Vec::new();
        for (task_id, intent_id, side_text, amount, account_id, paired_account_id, notes) in pending_rows {
            let side = match side_text.as_str() {
                "Buy" => planner::OrderSide::Buy,
                "Sell" => planner::OrderSide::Sell,
                _ => return Err(bad_request(format!("Unsupported task side '{side_text}'"))),
            };

            let (wallet_address, decrypted_private_key) =
                self.load_managed_wallet_material(&account_id, encryption_key)?;
            let started_at = now_ts();
            let result = executor.execute(&executor::ExecutionTaskInput {
                task_id,
                run_id,
                plan_version: latest_plan_version,
                intent_id,
                side,
                amount,
                quote_decimals: execution_settings.quote_decimals,
                base_decimals: execution_settings.base_decimals,
                slippage_bps: execution_settings.slippage_bps,
                base_mint: execution_settings.base_mint.clone(),
                quote_mint: execution_settings.quote_mint.clone(),
                account_id,
                paired_account_id,
                notes,
                wallet_address,
                decrypted_private_key,
            });
            let finished_at = now_ts();

            match result {
                Ok(outcome) => {
                    self.conn
                        .execute(
                            "UPDATE strategy_execution_tasks SET status = ?2 WHERE id = ?1",
                            params![task_id, outcome.status],
                        )
                        .map_err(internal_error)?;
                    let attempt_id = self.insert_strategy_execution_task_attempt(
                        task_id,
                        run_id,
                        latest_plan_version,
                        &outcome.status,
                        outcome.tx_signature.as_deref(),
                        outcome.error_message.as_deref(),
                        started_at,
                        finished_at,
                    )?;
                    attempts.push(StrategyExecutionTaskAttemptRecord {
                        id: attempt_id,
                        task_id,
                        run_id,
                        plan_version: latest_plan_version,
                        status: outcome.status,
                        tx_signature: outcome.tx_signature,
                        error_message: outcome.error_message,
                        started_at,
                        finished_at,
                    });
                }
                Err(error) => {
                    self.conn
                        .execute(
                            "UPDATE strategy_execution_tasks SET status = 'failed' WHERE id = ?1",
                            params![task_id],
                        )
                        .map_err(internal_error)?;
                    let attempt_id = self.insert_strategy_execution_task_attempt(
                        task_id,
                        run_id,
                        latest_plan_version,
                        "failed",
                        None,
                        Some(error.message.as_str()),
                        started_at,
                        finished_at,
                    )?;
                    attempts.push(StrategyExecutionTaskAttemptRecord {
                        id: attempt_id,
                        task_id,
                        run_id,
                        plan_version: latest_plan_version,
                        status: "failed".to_string(),
                        tx_signature: None,
                        error_message: Some(error.message),
                        started_at,
                        finished_at,
                    });
                }
            }
        }

        let remaining_pending: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM strategy_execution_tasks WHERE run_id = ?1 AND plan_version = ?2 AND status = 'pending'",
                params![run_id, latest_plan_version],
                |row| row.get(0),
            )
            .map_err(internal_error)?;
        let failed_count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM strategy_execution_tasks WHERE run_id = ?1 AND plan_version = ?2 AND status = 'failed'",
                params![run_id, latest_plan_version],
                |row| row.get(0),
            )
            .map_err(internal_error)?;
        self.update_strategy_execution_run_status(
            run_id,
            latest_plan_version,
            if remaining_pending == 0 && failed_count == 0 {
                "completed"
            } else if failed_count > 0 {
                "failed"
            } else {
                "executing"
            },
        )?;

        Ok(attempts)
    }

    fn open(path: &str) -> Result<Self, ApiError> {
        if let Some(parent) = Path::new(path).parent() {
            fs::create_dir_all(parent).map_err(internal_error)?;
        }
        let conn = Connection::open(path).map_err(internal_error)?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'admin',
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              token_hash TEXT NOT NULL UNIQUE,
              expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS settings (
              user_id INTEGER NOT NULL,
              key TEXT NOT NULL,
              value TEXT NOT NULL,
              PRIMARY KEY (user_id, key),
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS accounts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              type TEXT NOT NULL,
              label TEXT NOT NULL,
              wallet_address TEXT NOT NULL,
              encrypted_private_key TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE(user_id, type, wallet_address),
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
                        CREATE TABLE IF NOT EXISTS account_balance_snapshots (
                            account_id INTEGER NOT NULL,
                            asset_mint TEXT NOT NULL,
                            free_amount REAL NOT NULL DEFAULT 0,
                            locked_amount REAL NOT NULL DEFAULT 0,
                            updated_at INTEGER NOT NULL,
                            PRIMARY KEY (account_id, asset_mint),
                            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
                        );
                        CREATE TABLE IF NOT EXISTS account_pair_capabilities (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            account_id INTEGER NOT NULL,
                            base_mint TEXT NOT NULL,
                            quote_mint TEXT NOT NULL,
                            is_enabled INTEGER NOT NULL DEFAULT 1,
                            created_at INTEGER NOT NULL,
                            updated_at INTEGER NOT NULL,
                            UNIQUE(account_id, base_mint, quote_mint),
                            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
                        );
                        CREATE TABLE IF NOT EXISTS strategy_execution_runs (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_id INTEGER NOT NULL,
                            base_symbol TEXT NOT NULL,
                            base_mint TEXT NOT NULL,
                            base_decimals INTEGER NOT NULL,
                            quote_symbol TEXT NOT NULL,
                            quote_mint TEXT NOT NULL,
                            quote_decimals INTEGER NOT NULL,
                            target_buy_volume REAL NOT NULL,
                            target_sell_volume REAL NOT NULL,
                            target_total_volume REAL NOT NULL,
                            micro_task_size_hint REAL NOT NULL,
                            status TEXT NOT NULL,
                            latest_plan_version INTEGER NOT NULL DEFAULT 1,
                            created_at INTEGER NOT NULL,
                            updated_at INTEGER NOT NULL,
                            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                        );
                        CREATE TABLE IF NOT EXISTS strategy_execution_tasks (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            run_id INTEGER NOT NULL,
                            plan_version INTEGER NOT NULL,
                            intent_id TEXT NOT NULL,
                            intent_type TEXT NOT NULL,
                            side TEXT NOT NULL,
                            amount REAL NOT NULL,
                            account_id TEXT NOT NULL,
                            paired_account_id TEXT,
                            notes TEXT NOT NULL,
                            status TEXT NOT NULL,
                            created_at INTEGER NOT NULL,
                            FOREIGN KEY(run_id) REFERENCES strategy_execution_runs(id) ON DELETE CASCADE
                        );
                        CREATE TABLE IF NOT EXISTS strategy_execution_task_attempts (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            task_id INTEGER NOT NULL,
                            run_id INTEGER NOT NULL,
                            plan_version INTEGER NOT NULL,
                            status TEXT NOT NULL,
                            tx_signature TEXT,
                            error_message TEXT,
                            started_at INTEGER NOT NULL,
                            finished_at INTEGER NOT NULL,
                            FOREIGN KEY(task_id) REFERENCES strategy_execution_tasks(id) ON DELETE CASCADE,
                            FOREIGN KEY(run_id) REFERENCES strategy_execution_runs(id) ON DELETE CASCADE
                        );
            CREATE TABLE IF NOT EXISTS audit_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              action TEXT NOT NULL,
              target TEXT NOT NULL,
              details TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
            CREATE INDEX IF NOT EXISTS idx_accounts_user_type ON accounts(user_id, type);
            CREATE INDEX IF NOT EXISTS idx_account_balance_snapshots_account_asset ON account_balance_snapshots(account_id, asset_mint);
            CREATE INDEX IF NOT EXISTS idx_account_pair_capabilities_account_enabled ON account_pair_capabilities(account_id, is_enabled);
            CREATE INDEX IF NOT EXISTS idx_strategy_execution_runs_user_status ON strategy_execution_runs(user_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_strategy_execution_tasks_run_version ON strategy_execution_tasks(run_id, plan_version, created_at ASC);
            CREATE INDEX IF NOT EXISTS idx_strategy_execution_task_attempts_task_started ON strategy_execution_task_attempts(task_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created_at ON audit_logs(user_id, created_at DESC);
            ",
        )
        .map_err(internal_error)?;
        Ok(Self { conn })
    }

    fn setup_required(&self) -> Result<bool, ApiError> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
            .map_err(internal_error)?;
        Ok(count == 0)
    }

    fn create_user(&mut self, username: &str, password: &str) -> Result<SessionUser, ApiError> {
        validate_username(username)?;
        validate_password(password)?;

        let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
        let password_hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(internal_error)?
            .to_string();
        let created_at = now_ts();

        self.conn
            .execute(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES (?1, ?2, 'admin', ?3)",
                params![username, password_hash, created_at],
            )
            .map_err(|error| conflict_or_internal(error, "Username already exists"))?;
        let user_id = self.conn.last_insert_rowid();
        Ok(SessionUser {
            id: user_id,
            username: username.to_string(),
            role: "admin".to_string(),
        })
    }

    fn authenticate_user(&mut self, username: &str, password: &str) -> Result<SessionUser, ApiError> {
        let row = self
            .conn
            .query_row(
                "SELECT id, username, password_hash, role FROM users WHERE username = ?1",
                params![username],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(internal_error)?;

        let (id, username, password_hash, role) = row.ok_or_else(|| unauthorized("Invalid username or password"))?;
        let parsed_hash = PasswordHash::new(&password_hash).map_err(internal_error)?;
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed_hash)
            .map_err(|error| {
                log::warn!("password verification failed for user '{}': {error}", username);
                unauthorized("Invalid username or password")
            })?;

        Ok(SessionUser { id, username, role })
    }

    fn create_session(&mut self, user: &SessionUser, ttl_hours: u64) -> Result<String, ApiError> {
        let mut token_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut token_bytes);
        let token = URL_SAFE_NO_PAD.encode(token_bytes);
        let token_hash = sha256_hex(token.as_bytes());
        let created_at = now_ts();
        let expires_at = created_at + ttl_hours.saturating_mul(3600);
        let session_id = format!("sess-{}", sha256_hex(token.as_bytes()));

        self.conn
            .execute(
                "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session_id, user.id, token_hash, expires_at, created_at],
            )
            .map_err(internal_error)?;
        Ok(token)
    }

    fn get_user_by_session_token(&mut self, token: &str) -> Result<Option<SessionUser>, ApiError> {
        let token_hash = sha256_hex(token.as_bytes());
        let now = now_ts();
        self.conn
            .execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])
            .map_err(internal_error)?;

        let row = self
            .conn
            .query_row(
                "
                SELECT users.id, users.username, users.role
                FROM sessions
                INNER JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2
                ",
                params![token_hash, now],
                |row| {
                    Ok(SessionUser {
                        id: row.get(0)?,
                        username: row.get(1)?,
                        role: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(internal_error)?;
        Ok(row)
    }

    fn delete_session(&mut self, token: &str) -> Result<(), ApiError> {
        let token_hash = sha256_hex(token.as_bytes());
        self.conn
            .execute("DELETE FROM sessions WHERE token_hash = ?1", params![token_hash])
            .map_err(internal_error)?;
        Ok(())
    }

    fn save_settings(&mut self, user_id: i64, update: SettingsUpdateRequest) -> Result<SettingsState, ApiError> {
        validate_contract_address(&update.contract_address)?;
        if !(0.0..=100.0).contains(&update.volatility_target) {
            return Err(bad_request("Volatility target must be between 0 and 100"));
        }
        if !(0.0..=100.0).contains(&update.pullback_target) {
            return Err(bad_request("Pullback target must be between 0 and 100"));
        }
        if update.max_slippage < 0.0 || update.max_slippage > 100.0 {
            return Err(bad_request("Max slippage must be between 0 and 100"));
        }
        if update.max_transactions == 0 {
            return Err(bad_request("Max transactions must be greater than zero"));
        }
        let allowed_ranges = ["1h", "6h", "12h", "24h", "3d", "1w"];
        if !allowed_ranges.contains(&update.time_range_target.as_str()) {
            return Err(bad_request("Unsupported time range target"));
        }

        let current = self.load_settings(user_id)?;
        let macro_objective = update
            .macro_objective
            .unwrap_or(current.macro_objective)
            .trim()
            .to_lowercase();
        if !matches!(macro_objective.as_str(), "accumulation" | "distribution" | "shakeout") {
            return Err(bad_request("macroObjective must be accumulation, distribution, or shakeout"));
        }
        let trigger_threshold_usd = update.trigger_threshold_usd.unwrap_or(current.trigger_threshold_usd);
        let min_order_size = update.min_order_size.unwrap_or(current.min_order_size);
        let max_order_size = update.max_order_size.unwrap_or(current.max_order_size);
        let absorb_ratio = update.absorb_ratio.unwrap_or(current.absorb_ratio);
        let follow_sell_ratio = update.follow_sell_ratio.unwrap_or(current.follow_sell_ratio);
        let dump_ratio = update.dump_ratio.unwrap_or(current.dump_ratio);
        if trigger_threshold_usd < 0.0 || !trigger_threshold_usd.is_finite() {
            return Err(bad_request("triggerThresholdUsd must be a non-negative finite number"));
        }
        if min_order_size <= 0.0 || !min_order_size.is_finite() {
            return Err(bad_request("minOrderSize must be a positive finite number"));
        }
        if max_order_size < min_order_size || !max_order_size.is_finite() {
            return Err(bad_request("maxOrderSize must be greater than or equal to minOrderSize"));
        }
        for (name, value) in [
            ("absorbRatio", absorb_ratio),
            ("followSellRatio", follow_sell_ratio),
            ("dumpRatio", dump_ratio),
        ] {
            if value < 0.0 || !value.is_finite() {
                return Err(bad_request(format!("{name} must be a non-negative finite number")));
            }
        }

        let pairs = vec![
            ("contractAddress", update.contract_address.clone()),
            ("volatilityTarget", update.volatility_target.to_string()),
            ("pullbackTarget", update.pullback_target.to_string()),
            ("volumeTarget", update.volume_target.to_string()),
            ("netBuyinTarget", update.net_buyin_target.to_string()),
            ("timeRangeTarget", update.time_range_target.clone()),
            ("maxTransactions", update.max_transactions.to_string()),
            ("maxSlippage", update.max_slippage.to_string()),
            ("strategyNotes", update.strategy_notes.trim().to_string()),
            ("macroObjective", macro_objective),
            ("triggerThresholdUsd", trigger_threshold_usd.to_string()),
            ("minOrderSize", min_order_size.to_string()),
            ("maxOrderSize", max_order_size.to_string()),
            ("absorbRatio", absorb_ratio.to_string()),
            ("followSellRatio", follow_sell_ratio.to_string()),
            ("dumpRatio", dump_ratio.to_string()),
        ];

        let tx = self.conn.transaction().map_err(internal_error)?;
        for (key, value) in pairs {
            tx.execute(
                "
                INSERT INTO settings (user_id, key, value) VALUES (?1, ?2, ?3)
                ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                ",
                params![user_id, key, value],
            )
            .map_err(internal_error)?;
        }
        tx.commit().map_err(internal_error)?;

        self.add_audit_log(
            user_id,
            "settings.updated",
            "settings",
            "Trading settings were updated",
        )?;

        self.load_settings(user_id)
    }

    fn load_settings(&self, user_id: i64) -> Result<SettingsState, ApiError> {
        let mut settings = SettingsState::default();
        let managed_count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM accounts WHERE user_id = ?1 AND type = 'managed'",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(internal_error)?;
        settings.managed_key_count = managed_count as usize;

        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM settings WHERE user_id = ?1")
            .map_err(internal_error)?;
        let mut rows = stmt.query(params![user_id]).map_err(internal_error)?;
        while let Some(row) = rows.next().map_err(internal_error)? {
            let key: String = row.get(0).map_err(internal_error)?;
            let value: String = row.get(1).map_err(internal_error)?;
            match key.as_str() {
                "contractAddress" => settings.contract_address = value,
                "volatilityTarget" => settings.volatility_target = value.parse::<f64>().unwrap_or(settings.volatility_target),
                "pullbackTarget" => settings.pullback_target = value.parse::<f64>().unwrap_or(settings.pullback_target),
                "volumeTarget" => settings.volume_target = value.parse::<f64>().unwrap_or(settings.volume_target),
                "netBuyinTarget" => settings.net_buyin_target = value.parse::<f64>().unwrap_or(settings.net_buyin_target),
                "timeRangeTarget" => settings.time_range_target = value,
                "maxTransactions" => settings.max_transactions = value.parse::<u64>().unwrap_or(settings.max_transactions),
                "maxSlippage" => settings.max_slippage = value.parse::<f64>().unwrap_or(settings.max_slippage),
                "strategyNotes" => settings.strategy_notes = value,
                "macroObjective" => settings.macro_objective = value,
                "triggerThresholdUsd" => settings.trigger_threshold_usd = value.parse::<f64>().unwrap_or(settings.trigger_threshold_usd),
                "minOrderSize" => settings.min_order_size = value.parse::<f64>().unwrap_or(settings.min_order_size),
                "maxOrderSize" => settings.max_order_size = value.parse::<f64>().unwrap_or(settings.max_order_size),
                "absorbRatio" => settings.absorb_ratio = value.parse::<f64>().unwrap_or(settings.absorb_ratio),
                "followSellRatio" => settings.follow_sell_ratio = value.parse::<f64>().unwrap_or(settings.follow_sell_ratio),
                "dumpRatio" => settings.dump_ratio = value.parse::<f64>().unwrap_or(settings.dump_ratio),
                _ => {}
            }
        }

        Ok(settings)
    }

    fn list_accounts(&self, user_id: i64, account_type: &str) -> Result<Vec<AccountRecord>, ApiError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, label, wallet_address, type, created_at FROM accounts WHERE user_id = ?1 AND type = ?2 ORDER BY created_at DESC, id DESC",
            )
            .map_err(internal_error)?;
        let rows = stmt
            .query_map(params![user_id, account_type], |row| {
                Ok(AccountRecord {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    address: row.get(2)?,
                    account_type: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(internal_error)?;

        let mut accounts = Vec::new();
        for row in rows {
            accounts.push(row.map_err(internal_error)?);
        }
        Ok(accounts)
    }

    fn upsert_account_balance_snapshot(
        &mut self,
        account_id: i64,
        asset_mint: &str,
        free_amount: f64,
        locked_amount: f64,
    ) -> Result<(), ApiError> {
        if account_id <= 0 {
            return Err(bad_request("Account id must be positive"));
        }
        let normalized_asset_mint = normalize_pubkey(asset_mint)?;
        if free_amount < 0.0 || locked_amount < 0.0 {
            return Err(bad_request("Account balances must be non-negative"));
        }

        let updated_at = now_ts();
        self.conn
            .execute(
                "
                INSERT INTO account_balance_snapshots (account_id, asset_mint, free_amount, locked_amount, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(account_id, asset_mint) DO UPDATE SET
                  free_amount = excluded.free_amount,
                  locked_amount = excluded.locked_amount,
                  updated_at = excluded.updated_at
                ",
                params![account_id, normalized_asset_mint, free_amount, locked_amount, updated_at],
            )
            .map_err(internal_error)?;
        Ok(())
    }

    fn upsert_account_pair_capability(
        &mut self,
        account_id: i64,
        base_mint: &str,
        quote_mint: &str,
        is_enabled: bool,
    ) -> Result<(), ApiError> {
        if account_id <= 0 {
            return Err(bad_request("Account id must be positive"));
        }

        let normalized_base_mint = normalize_pubkey(base_mint)?;
        let normalized_quote_mint = normalize_pubkey(quote_mint)?;
        let now = now_ts();

        self.conn
            .execute(
                "
                INSERT INTO account_pair_capabilities (
                  account_id,
                  base_mint,
                  quote_mint,
                  is_enabled,
                  created_at,
                  updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                ON CONFLICT(account_id, base_mint, quote_mint) DO UPDATE SET
                  is_enabled = excluded.is_enabled,
                  updated_at = excluded.updated_at
                ",
                params![
                    account_id,
                    normalized_base_mint,
                    normalized_quote_mint,
                    if is_enabled { 1_i64 } else { 0_i64 },
                    now,
                ],
            )
            .map_err(internal_error)?;
        Ok(())
    }

    fn import_watch_account(&mut self, user_id: i64, request: ImportAccountRequest) -> Result<AccountRecord, ApiError> {
        validate_label(&request.label)?;
        let address = normalize_pubkey(&request.address)?;
        let created_at = now_ts();
        self.conn
            .execute(
                "INSERT INTO accounts (user_id, type, label, wallet_address, encrypted_private_key, created_at) VALUES (?1, 'watch', ?2, ?3, NULL, ?4)",
                params![user_id, request.label.trim(), address, created_at],
            )
            .map_err(|error| conflict_or_internal(error, "Account already imported for this user"))?;
        let id = self.conn.last_insert_rowid();
        self.add_audit_log(
            user_id,
            "account.imported",
            &address,
            &format!("Imported watch-only account '{}'.", request.label.trim()),
        )?;
        Ok(AccountRecord {
            id,
            label: request.label.trim().to_string(),
            address,
            account_type: "watch".to_string(),
            created_at,
        })
    }

    fn import_private_key(
        &mut self,
        user_id: i64,
        request: ImportPrivateKeyRequest,
        encryption_key: [u8; 32],
    ) -> Result<AccountRecord, ApiError> {
        validate_label(&request.label)?;
        let secret_bytes = normalize_private_key(&request.private_key)?;
        let keypair = Keypair::from_bytes(&secret_bytes).map_err(|_| bad_request("Private key must decode to a 64-byte Solana keypair"))?;
        let address = keypair.pubkey().to_string();
        let encrypted_private_key = encrypt_private_key(&secret_bytes, encryption_key)?;
        let created_at = now_ts();

        self.conn
            .execute(
                "INSERT INTO accounts (user_id, type, label, wallet_address, encrypted_private_key, created_at) VALUES (?1, 'managed', ?2, ?3, ?4, ?5)",
                params![user_id, request.label.trim(), address, encrypted_private_key, created_at],
            )
            .map_err(|error| conflict_or_internal(error, "Managed account already imported for this user"))?;
        let id = self.conn.last_insert_rowid();
        self.add_audit_log(
            user_id,
            "private_key.imported",
            &address,
            &format!("Imported managed key '{}'. Private key material was encrypted at rest and is never returned by the API.", request.label.trim()),
        )?;
        self.upsert_account_balance_snapshot(id, "So11111111111111111111111111111111111111112", 0.0, 0.0)?;
        self.upsert_account_balance_snapshot(id, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 0.0, 0.0)?;
        self.upsert_account_pair_capability(
            id,
            "So11111111111111111111111111111111111111112",
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            true,
        )?;
        Ok(AccountRecord {
            id,
            label: request.label.trim().to_string(),
            address,
            account_type: "managed".to_string(),
            created_at,
        })
    }

    fn add_audit_log(&mut self, user_id: i64, action: &str, target: &str, details: &str) -> Result<(), ApiError> {
        self.conn
            .execute(
                "INSERT INTO audit_logs (user_id, action, target, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![user_id, action, target, details, now_ts()],
            )
            .map_err(internal_error)?;
        Ok(())
    }

    fn list_audit_logs(&self, user_id: i64, username: &str) -> Result<Vec<AuditLogRecord>, ApiError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, action, target, details, created_at FROM audit_logs WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 50",
            )
            .map_err(internal_error)?;
        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok(AuditLogRecord {
                    id: row.get(0)?,
                    action: row.get(1)?,
                    target: row.get(2)?,
                    details: row.get(3)?,
                    actor: username.to_string(),
                    created_at: row.get(4)?,
                })
            })
            .map_err(internal_error)?;

        let mut logs = Vec::new();
        for row in rows {
            logs.push(row.map_err(internal_error)?);
        }
        Ok(logs)
    }

    fn get_engine_state(&self, user: &SessionUser, config: &Config) -> Result<EngineStateResponse, ApiError> {
        let managed = self.list_accounts(user.id, "managed")?;
        let watch = self.list_accounts(user.id, "watch")?;
        let logs = self.list_audit_logs(user.id, &user.username)?;
        let settings = self.load_settings(user.id)?;

        Ok(EngineStateResponse {
            auth: AuthSummary {
                username: user.username.clone(),
                role: user.role.clone(),
            },
            settings,
            internal_accs: managed.clone(),
            outsider_accs: watch.clone(),
            logs,
            stats: StatsState {
                managed_accounts: managed.len(),
                watched_accounts: watch.len(),
                trade_execution_enabled: config.solana_rpc_url.is_some()
                    && config.private_key_encryption_key.is_some(),
            },
            system: SystemState {
                backend: "rust",
                database_path: config.database_path.clone(),
                database_connected: true,
            },
        })
    }
}

fn api_routes(context: AppContext) -> impl Filter<Extract = impl Reply, Error = warp::Rejection> + Clone {
    let health = warp::path!("api" / "health")
        .and(warp::get())
        .and(with_context(context.clone()))
        .and_then(handle_health);

    let auth_status = warp::path!("api" / "auth" / "status")
        .and(warp::get())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and_then(handle_auth_status);

    let bootstrap = warp::path!("api" / "auth" / "bootstrap")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(json_body::<CredentialsRequest>())
        .and_then(handle_bootstrap);

    let login = warp::path!("api" / "auth" / "login")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(json_body::<CredentialsRequest>())
        .and_then(handle_login);

    let logout = warp::path!("api" / "auth" / "logout")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and_then(handle_logout);

    let get_state = warp::path!("api" / "state")
        .and(warp::get())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and_then(handle_get_state);

    let get_strategy_execution = warp::path!("api" / "strategy" / "execution")
        .and(warp::get())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and_then(handle_get_strategy_execution);

    let consume_strategy_execution = warp::path!("api" / "strategy" / "execution" / "consume")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and(json_body::<StrategyExecutionConsumeRequest>())
        .and_then(handle_consume_strategy_execution);

    let external_trade_event = warp::path!("api" / "strategy" / "events" / "external-trade")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and(json_body::<StrategyExternalTradeEventRequest>())
        .and_then(handle_external_trade_event);

    let save_settings = warp::path!("api" / "settings")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and(json_body::<SettingsUpdateRequest>())
        .and_then(handle_save_settings);

    let import_private_key = warp::path!("api" / "private-keys" / "import")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and(json_body::<ImportPrivateKeyRequest>())
        .and_then(handle_import_private_key);

    let import_account = warp::path!("api" / "accounts" / "import")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and(json_body::<ImportAccountRequest>())
        .and_then(handle_import_account);

    let trade = warp::path!("api" / "trade")
        .and(warp::post())
        .and(with_context(context.clone()))
        .and(warp::header::optional::<String>("cookie"))
        .and(json_body::<TradeRequest>())
        .and_then(handle_trade);

    health
        .or(auth_status)
        .or(bootstrap)
        .or(login)
        .or(logout)
        .or(get_state)
        .or(get_strategy_execution)
        .or(consume_strategy_execution)
        .or(external_trade_event)
        .or(save_settings)
        .or(import_private_key)
        .or(import_account)
        .or(trade)
}

fn static_routes(static_dir: String) -> impl Filter<Extract = impl Reply, Error = warp::Rejection> + Clone {
    let index_path = format!("{}/index.html", static_dir);
    warp::path::end()
        .and(warp::get())
        .and(warp::fs::file(index_path))
        .or(warp::fs::dir(static_dir))
}

fn with_context(context: AppContext) -> impl Filter<Extract = (AppContext,), Error = Infallible> + Clone {
    warp::any().map(move || context.clone())
}

fn json_body<T: Send + serde::de::DeserializeOwned>() -> impl Filter<Extract = (T,), Error = warp::Rejection> + Clone {
    warp::body::content_length_limit(1024 * 1024).and(warp::body::json())
}

async fn handle_health(context: AppContext) -> Result<impl Reply, Infallible> {
    Ok(json_response(
        StatusCode::OK,
        &HealthResponse {
            ok: true,
            backend: "rust",
            database_connected: true,
            database_path: context.config.database_path.clone(),
        },
    ))
}

async fn handle_auth_status(context: AppContext, cookie_header: Option<String>) -> Result<impl Reply, Infallible> {
    let response = match auth_status_response(&context, cookie_header) {
        Ok(payload) => json_response(StatusCode::OK, &payload),
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_bootstrap(context: AppContext, request: CredentialsRequest) -> Result<impl Reply, Infallible> {
    let response = match bootstrap_user(&context, request) {
        Ok((payload, cookie)) => with_set_cookie(json_response(StatusCode::CREATED, &payload), &cookie),
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_login(context: AppContext, request: CredentialsRequest) -> Result<impl Reply, Infallible> {
    let response = match login_user(&context, request) {
        Ok((payload, cookie)) => with_set_cookie(json_response(StatusCode::OK, &payload), &cookie),
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_logout(context: AppContext, cookie_header: Option<String>) -> Result<impl Reply, Infallible> {
    let response = match logout_user(&context, cookie_header) {
        Ok(payload) => with_set_cookie(json_response(StatusCode::OK, &payload), &clear_session_cookie()),
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_get_state(context: AppContext, cookie_header: Option<String>) -> Result<impl Reply, Infallible> {
    let response = match require_user(&context, cookie_header) {
        Ok(user) => {
            let db = context.db.lock().expect("database mutex poisoned");
            match db.get_engine_state(&user, &context.config) {
                Ok(state) => json_response(StatusCode::OK, &state),
                Err(error) => error_response(error),
            }
        }
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_get_strategy_execution(
    context: AppContext,
    cookie_header: Option<String>,
    query: std::collections::HashMap<String, String>,
) -> Result<impl Reply, Infallible> {
    let response = match require_admin(&context, cookie_header) {
        Ok(user) => {
            let mut db = context.db.lock().expect("database mutex poisoned");
            match db.get_latest_strategy_execution_run(user.id) {
                Ok(active_run) => {
                    let execute_requested = query
                        .get("execute")
                        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
                        .unwrap_or(false);

                    if execute_requested {
                        if let Some(run) = &active_run {
                            if let Err(error) = db.consume_strategy_execution_tasks(run.id, 100, &context.config) {
                                return Ok(error_response(error));
                            }
                        }
                    }

                    let refreshed_run = match db.get_latest_strategy_execution_run(user.id) {
                        Ok(run) => run,
                        Err(error) => return Ok(error_response(error)),
                    };
                    let tasks = match &active_run {
                        Some(run) => db.list_strategy_execution_tasks(run.id),
                        None => Ok(Vec::new()),
                    };

                    match tasks {
                        Ok(tasks) => json_response(
                            StatusCode::OK,
                            &StrategyExecutionQueueResponse { active_run: refreshed_run, tasks },
                        ),
                        Err(error) => error_response(error),
                    }
                }
                Err(error) => error_response(error),
            }
        }
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_consume_strategy_execution(
    context: AppContext,
    cookie_header: Option<String>,
    request: StrategyExecutionConsumeRequest,
) -> Result<impl Reply, Infallible> {
    let response = match require_admin(&context, cookie_header) {
        Ok(user) => {
            let mut db = context.db.lock().expect("database mutex poisoned");
            let run = match request.run_id {
                Some(run_id) => db
                    .get_latest_strategy_execution_run(user.id)
                    .and_then(|latest| match latest {
                        Some(active) if active.id == run_id => Ok(Some(active)),
                        Some(_) => Err(bad_request("Requested runId is not the latest execution run for this user")),
                        None => Err(bad_request("No strategy execution run found for this user")),
                    }),
                None => db.get_latest_strategy_execution_run(user.id),
            };

            match run {
                Ok(Some(active_run)) => match db.consume_strategy_execution_tasks(
                    active_run.id,
                    request.max_tasks.unwrap_or(100),
                    &context.config,
                ) {
                    Ok(results) => {
                        let refreshed_run = match db.get_latest_strategy_execution_run(user.id) {
                            Ok(run) => run,
                            Err(error) => return Ok(error_response(error)),
                        };
                        let executed_count = results.iter().filter(|item| item.status == "executed").count();
                        let failed_count = results.iter().filter(|item| item.status == "failed").count();
                        json_response(
                            StatusCode::OK,
                            &StrategyExecutionConsumeResponse {
                                active_run: refreshed_run,
                                results,
                                executed_count,
                                failed_count,
                            },
                        )
                    }
                    Err(error) => error_response(error),
                },
                Ok(None) => error_response(bad_request("No strategy execution run found for this user")),
                Err(error) => error_response(error),
            }
        }
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_save_settings(
    context: AppContext,
    cookie_header: Option<String>,
    request: SettingsUpdateRequest,
) -> Result<impl Reply, Infallible> {
    let response = match require_admin(&context, cookie_header) {
        Ok(user) => {
            let mut db = context.db.lock().expect("database mutex poisoned");
            match db.save_settings(user.id, request) {
                Ok(settings) => {
                    context.actors.publish(actor_runtime::MarketEvent::SettingsUpdated(
                        actor_runtime::StrategySettings::from_settings(user.id, &settings),
                    ));
                    json_response(StatusCode::OK, &settings)
                }
                Err(error) => error_response(error),
            }
        }
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_external_trade_event(
    context: AppContext,
    cookie_header: Option<String>,
    request: StrategyExternalTradeEventRequest,
) -> Result<impl Reply, Infallible> {
    let response = match require_admin(&context, cookie_header) {
        Ok(user) => match actor_runtime::ExternalTradeSide::from_event_type(&request.event_type) {
            Some(side) => {
                if !request.amount_usd.is_finite() || request.amount_usd <= 0.0 {
                    return Ok(error_response(bad_request("amountUsd must be a positive finite number")));
                }

                let fallback_contract_address = {
                    let db = context.db.lock().expect("database mutex poisoned");
                    match db.load_settings(user.id) {
                        Ok(settings) => settings.contract_address,
                        Err(error) => return Ok(error_response(error)),
                    }
                };
                let contract_address = request
                    .contract_address
                    .as_deref()
                    .unwrap_or(fallback_contract_address.as_str())
                    .trim()
                    .to_string();
                if contract_address.is_empty() {
                    return Ok(error_response(bad_request("contractAddress is required when settings do not define one")));
                }
                if let Err(error) = validate_contract_address(&contract_address) {
                    return Ok(error_response(error));
                }

                let wallet_address = match request.wallet_address.as_deref() {
                    Some(value) if !value.trim().is_empty() => match normalize_pubkey(value) {
                        Ok(value) => Some(value),
                        Err(error) => return Ok(error_response(error)),
                    },
                    _ => None,
                };
                let event_id = request
                    .event_id
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| format!("external-trade-{}-{}", user.id, now_ts()));

                context.actors.publish(actor_runtime::MarketEvent::ExternalTrade(
                    actor_runtime::ExternalTradeEvent {
                        user_id: user.id,
                        event_id: event_id.clone(),
                        side,
                        amount_usd: request.amount_usd,
                        contract_address,
                        wallet_address,
                        tx_signature: request.tx_signature,
                        is_loss_cut: request.is_loss_cut.unwrap_or(false),
                        execute: request.execute.unwrap_or(true),
                        occurred_at: now_ts(),
                    },
                ));

                json_response(
                    StatusCode::ACCEPTED,
                    &StrategyEventAcceptedResponse {
                        accepted: true,
                        event_id,
                    },
                )
            }
            None => error_response(bad_request("eventType must be whale_buy or whale_sell")),
        },
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_import_private_key(
    context: AppContext,
    cookie_header: Option<String>,
    request: ImportPrivateKeyRequest,
) -> Result<impl Reply, Infallible> {
    let response = match require_admin(&context, cookie_header) {
        Ok(user) => match context.config.private_key_encryption_key {
            Some(key) => {
                let mut db = context.db.lock().expect("database mutex poisoned");
                match db.import_private_key(user.id, request, key) {
                    Ok(account) => json_response(StatusCode::CREATED, &ImportResponse { account }),
                    Err(error) => error_response(error),
                }
            }
            None => error_response(service_unavailable(
                "PRIVATE_KEY_ENCRYPTION_KEY is not configured on the server",
            )),
        },
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_import_account(
    context: AppContext,
    cookie_header: Option<String>,
    request: ImportAccountRequest,
) -> Result<impl Reply, Infallible> {
    let response = match require_admin(&context, cookie_header) {
        Ok(user) => {
            let mut db = context.db.lock().expect("database mutex poisoned");
            match db.import_watch_account(user.id, request) {
                Ok(account) => json_response(StatusCode::CREATED, &ImportResponse { account }),
                Err(error) => error_response(error),
            }
        }
        Err(error) => error_response(error),
    };
    Ok(response)
}

async fn handle_trade(
    context: AppContext,
    cookie_header: Option<String>,
    request: TradeRequest,
) -> Result<impl Reply, Infallible> {
    let response = match require_admin(&context, cookie_header) {
        Ok(user) => {
            let mut db = context.db.lock().expect("database mutex poisoned");
            match strategy::orchestrate_trade(&mut db, user.id, request) {
                Ok(result) => json_response(StatusCode::OK, &result),
                Err(error) => error_response(error),
            }
        }
        Err(error) => error_response(error),
    };
    Ok(response)
}

fn auth_status_response(context: &AppContext, cookie_header: Option<String>) -> Result<AuthStatusResponse, ApiError> {
    let setup_required = {
        let db = context.db.lock().expect("database mutex poisoned");
        db.setup_required()?
    };

    if setup_required {
        return Ok(AuthStatusResponse {
            setup_required: true,
            authenticated: false,
            user: None,
        });
    }

    let user = current_user(context, cookie_header)?;
    Ok(AuthStatusResponse {
        setup_required: false,
        authenticated: user.is_some(),
        user: user.map(|user| AuthSummary {
            username: user.username,
            role: user.role,
        }),
    })
}

fn bootstrap_user(context: &AppContext, request: CredentialsRequest) -> Result<(AuthResponse, String), ApiError> {
    let mut db = context.db.lock().expect("database mutex poisoned");
    if !db.setup_required()? {
        return Err(forbidden("Bootstrap is disabled because an admin user already exists"));
    }
    let user = db.create_user(request.username.trim(), request.password.as_str())?;
    let token = db.create_session(&user, context.config.session_ttl_hours)?;
    db.add_audit_log(
        user.id,
        "auth.bootstrap",
        &user.username,
        "Created initial admin account",
    )?;
    let response = AuthResponse {
        authenticated: true,
        user: AuthSummary {
            username: user.username.clone(),
            role: user.role.clone(),
        },
    };
    Ok((response, build_session_cookie(&token, context.config.cookie_secure, context.config.session_ttl_hours)))
}

fn login_user(context: &AppContext, request: CredentialsRequest) -> Result<(AuthResponse, String), ApiError> {
    let mut db = context.db.lock().expect("database mutex poisoned");
    let user = db.authenticate_user(request.username.trim(), request.password.as_str())?;
    let token = db.create_session(&user, context.config.session_ttl_hours)?;
    db.add_audit_log(user.id, "auth.login", &user.username, "Authenticated admin session")?;
    let response = AuthResponse {
        authenticated: true,
        user: AuthSummary {
            username: user.username.clone(),
            role: user.role.clone(),
        },
    };
    Ok((response, build_session_cookie(&token, context.config.cookie_secure, context.config.session_ttl_hours)))
}

fn logout_user(context: &AppContext, cookie_header: Option<String>) -> Result<StatusResponse, ApiError> {
    if let Some(token) = session_token_from_cookie(cookie_header.as_deref()) {
        let mut db = context.db.lock().expect("database mutex poisoned");
        let user = db.get_user_by_session_token(&token)?;
        db.delete_session(&token)?;
        if let Some(user) = user {
            db.add_audit_log(user.id, "auth.logout", &user.username, "Ended admin session")?;
        }
    }
    Ok(StatusResponse { ok: true })
}

fn require_admin(context: &AppContext, cookie_header: Option<String>) -> Result<SessionUser, ApiError> {
    let user = require_user(context, cookie_header)?;
    if user.role != "admin" {
        return Err(forbidden("Admin permissions are required for this action"));
    }
    Ok(user)
}

fn require_user(context: &AppContext, cookie_header: Option<String>) -> Result<SessionUser, ApiError> {
    current_user(context, cookie_header)?.ok_or_else(|| unauthorized("Login required"))
}

fn current_user(context: &AppContext, cookie_header: Option<String>) -> Result<Option<SessionUser>, ApiError> {
    let Some(token) = session_token_from_cookie(cookie_header.as_deref()) else {
        return Ok(None);
    };
    let mut db = context.db.lock().expect("database mutex poisoned");
    db.get_user_by_session_token(&token)
}

fn session_token_from_cookie(cookie_header: Option<&str>) -> Option<String> {
    cookie_header.and_then(|cookie| {
        cookie.split(';').find_map(|part| {
            let trimmed = part.trim();
            trimmed
                .strip_prefix("te_session=")
                .map(|value| value.to_string())
        })
    })
}

fn build_session_cookie(token: &str, secure: bool, ttl_hours: u64) -> String {
    let max_age = ttl_hours.saturating_mul(3600);
    format!(
        "te_session={token}; HttpOnly; Path=/; SameSite=Strict; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

fn clear_session_cookie() -> String {
    "te_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0".to_string()
}

fn json_response<T: Serialize>(status: StatusCode, payload: &T) -> Response<Vec<u8>> {
    let body = serde_json::to_vec(payload).expect("serializing JSON response should never fail");
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn with_set_cookie(mut response: Response<Vec<u8>>, cookie: &str) -> Response<Vec<u8>> {
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_str(cookie).expect("valid Set-Cookie header"),
    );
    response
}

fn error_response(error: ApiError) -> Response<Vec<u8>> {
    json_response(
        error.status,
        &ErrorBody {
            error: error.message,
        },
    )
}

fn normalize_private_key(raw: &str) -> Result<Vec<u8>, ApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(bad_request("Private key is required"));
    }
    if trimmed.starts_with('[') {
        let values: Vec<u8> = serde_json::from_str(trimmed)
            .map_err(|_| bad_request("Private key JSON array could not be parsed"))?;
        return Ok(values);
    }
    bs58::decode(trimmed)
        .into_vec()
        .map_err(|_| bad_request("Private key must be a base58 string or JSON array"))
}

fn encrypt_private_key(secret_bytes: &[u8], encryption_key: [u8; 32]) -> Result<String, ApiError> {
    let cipher = Aes256Gcm::new_from_slice(&encryption_key).map_err(internal_error)?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, secret_bytes)
        .map_err(|_| internal_error("Failed to encrypt private key material"))?;
    let mut payload = nonce_bytes.to_vec();
    payload.extend(ciphertext);
    Ok(BASE64_STANDARD.encode(payload))
}

fn decrypt_private_key(payload: &str, encryption_key: [u8; 32]) -> Result<Vec<u8>, ApiError> {
    let bytes = BASE64_STANDARD
        .decode(payload.trim())
        .map_err(|_| bad_request("Encrypted private key payload is not valid base64"))?;
    if bytes.len() <= 12 {
        return Err(bad_request("Encrypted private key payload is too short"));
    }

    let (nonce_bytes, ciphertext) = bytes.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(&encryption_key).map_err(internal_error)?;
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| internal_error("Failed to decrypt private key material"))
}

fn parse_encryption_key(value: &str) -> Result<[u8; 32], ApiError> {
    let trimmed = value.trim();
    let decoded = BASE64_STANDARD
        .decode(trimmed)
        .ok()
        .filter(|value| value.len() == 32)
        .or_else(|| hex::decode(trimmed).ok().filter(|value| value.len() == 32))
        .ok_or_else(|| {
            bad_request("PRIVATE_KEY_ENCRYPTION_KEY must be base64 or hex and decode to exactly 32 bytes")
        })?;
    let array: [u8; 32] = decoded
        .try_into()
        .map_err(|_| bad_request("PRIVATE_KEY_ENCRYPTION_KEY must be base64 or hex and decode to exactly 32 bytes"))?;
    Ok(array)
}

fn normalize_pubkey(value: &str) -> Result<String, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(bad_request("Account address is required"));
    }
    Ok(Pubkey::from_str(trimmed)
        .map_err(|_| bad_request("Account address must be a valid Solana public key"))?
        .to_string())
}

fn validate_contract_address(value: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() {
        return Ok(());
    }
    let _ = normalize_pubkey(value)?;
    Ok(())
}

fn normalize_asset_symbol(value: &str) -> Result<String, ApiError> {
    let normalized = value.trim().to_uppercase();
    if normalized.is_empty() {
        return Err(bad_request("Asset symbol is required"));
    }
    Ok(normalized)
}

fn validate_label(label: &str) -> Result<(), ApiError> {
    let trimmed = label.trim();
    if trimmed.len() < 3 || trimmed.len() > 80 {
        return Err(bad_request("Label must be between 3 and 80 characters"));
    }
    Ok(())
}

fn validate_username(username: &str) -> Result<(), ApiError> {
    let trimmed = username.trim();
    if trimmed.len() < 3 || trimmed.len() > 64 {
        return Err(bad_request("Username must be between 3 and 64 characters"));
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
    {
        return Err(bad_request("Username may only include letters, numbers, '.', '_' and '-'"));
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    if password.len() < 12 {
        return Err(bad_request("Password must be at least 12 characters"));
    }
    Ok(())
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX_EPOCH")
        .as_secs()
}

fn sha256_hex(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    hex::encode(hasher.finalize())
}

fn parse_bind_addr(bind_addr: &str) -> Result<([u8; 4], u16), ApiError> {
    let (host, port) = bind_addr
        .split_once(':')
        .ok_or_else(|| bad_request("BIND_ADDR must use host:port format"))?;
    let port = port.parse::<u16>().map_err(|_| bad_request("Invalid BIND_ADDR port"))?;
    let host = if host == "0.0.0.0" {
        [0, 0, 0, 0]
    } else if host == "127.0.0.1" {
        [127, 0, 0, 1]
    } else {
        return Err(bad_request("BIND_ADDR host must be 0.0.0.0 or 127.0.0.1"));
    };
    Ok((host, port))
}

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: message.into(),
    }
}

fn unauthorized(message: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: message.into(),
    }
}

fn forbidden(message: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::FORBIDDEN,
        message: message.into(),
    }
}

fn conflict(message: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::CONFLICT,
        message: message.into(),
    }
}

fn service_unavailable(message: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: message.into(),
    }
}

fn internal_error(error: impl std::fmt::Display) -> ApiError {
    log::error!("internal error: {error}");
    ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "Internal server error".to_string(),
    }
}

fn conflict_or_internal(error: rusqlite::Error, conflict_message: &str) -> ApiError {
    match error {
        rusqlite::Error::SqliteFailure(ref inner, _)
            if inner.code == ErrorCode::ConstraintViolation
                && (inner.extended_code == SQLITE_CONSTRAINT_UNIQUE
                    || inner.extended_code == SQLITE_CONSTRAINT_PRIMARY_KEY) =>
        {
            conflict(conflict_message)
        }
        other => internal_error(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_validation_rejects_bad_characters() {
        assert!(validate_username("admin.user").is_ok());
        assert!(validate_username("bad name").is_err());
    }

    #[test]
    fn password_validation_requires_length() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("averysecurepassword").is_ok());
    }

    #[test]
    fn encryption_key_parsing_accepts_hex_encoded_32_bytes() {
        let key = parse_encryption_key("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f").unwrap();
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn generate_trade_plan_uses_sqlite_balances_and_pair_capabilities() {
        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!("tradeengine-planner-test-{}.db", now_ts()));

        let mut db = Database::open(db_path.to_str().expect("db path to str")).expect("open db");
        let user = db.create_user("planner_admin", "averysecurepassword").expect("create user");

        let encryption_key = [7_u8; 32];
        let generated_keypair = Keypair::new();
        let private_key = bs58::encode(generated_keypair.to_bytes()).into_string();
        let imported = db
            .import_private_key(
                user.id,
                ImportPrivateKeyRequest {
                    label: "Planner Wallet".to_string(),
                    private_key,
                },
                encryption_key,
            )
            .expect("import managed key");

        db.upsert_account_balance_snapshot(imported.id, "So11111111111111111111111111111111111111112", 150.0, 0.0)
            .expect("seed base balance");
        db.upsert_account_balance_snapshot(imported.id, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 275.0, 0.0)
            .expect("seed quote balance");
        db.upsert_account_pair_capability(
            imported.id,
            "So11111111111111111111111111111111111111112",
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            true,
        )
            .expect("seed pair capability");

        let plan = db
            .generate_trade_plan(
                user.id,
                &planner::TradePlanningInput {
                    target_buy_volume: 50.0,
                    target_sell_volume: 25.0,
                    target_total_volume: 75.0,
                    micro_task_size_hint: 25.0,
                    base_asset: planner::AssetDefinition {
                        symbol: "SOL".to_string(),
                        mint: "So11111111111111111111111111111111111111112".to_string(),
                        decimals: 9,
                    },
                    quote_asset: planner::AssetDefinition {
                        symbol: "USDC".to_string(),
                        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
                        decimals: 6,
                    },
                },
            )
            .expect("generate trade plan");

        assert_eq!(plan.len(), 3);
        assert!(plan.iter().filter(|intent| intent.side == planner::OrderSide::Buy).count() >= 2);
        assert!(plan.iter().any(|intent| intent.side == planner::OrderSide::Sell));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn trade_orchestration_requires_two_confirmations_before_execution() {
        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!("tradeengine-strategy-confirm-{}.db", now_ts()));

        let mut db = Database::open(db_path.to_str().expect("db path to str")).expect("open db");
        let user = db.create_user("strategy_admin", "averysecurepassword").expect("create user");

        let request = TradeRequest {
            base_symbol: "SOL".to_string(),
            base_mint: "So11111111111111111111111111111111111111112".to_string(),
            base_decimals: 9,
            quote_symbol: "USDC".to_string(),
            quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
            quote_decimals: 6,
            target_buy_volume: 10.0,
            target_sell_volume: 0.0,
            target_total_volume: 10.0,
            micro_task_size_hint: Some(5.0),
            confirm_strategy: false,
            confirm_plan: false,
            external_delay_ms: None,
        };

        let preview_only = strategy::orchestrate_trade(&mut db, user.id, request).expect("preview only");
        assert!(!preview_only.strategy_confirmed);
        assert_eq!(preview_only.requires_confirmation_step, 1);
        assert!(preview_only.planned_intents.is_empty());

        let encryption_key = [9_u8; 32];
        let generated_keypair = Keypair::new();
        let private_key = bs58::encode(generated_keypair.to_bytes()).into_string();
        let imported = db
            .import_private_key(
                user.id,
                ImportPrivateKeyRequest {
                    label: "Strategy Wallet".to_string(),
                    private_key,
                },
                encryption_key,
            )
            .expect("import managed key");
        db.upsert_account_balance_snapshot(imported.id, "So11111111111111111111111111111111111111112", 50.0, 0.0)
            .expect("seed base balance");
        db.upsert_account_balance_snapshot(imported.id, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 50.0, 0.0)
            .expect("seed quote balance");

        let strategy_confirmed = strategy::orchestrate_trade(
            &mut db,
            user.id,
            TradeRequest {
                base_symbol: "SOL".to_string(),
                base_mint: "So11111111111111111111111111111111111111112".to_string(),
                base_decimals: 9,
                quote_symbol: "USDC".to_string(),
                quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
                quote_decimals: 6,
                target_buy_volume: 10.0,
                target_sell_volume: 0.0,
                target_total_volume: 10.0,
                micro_task_size_hint: Some(5.0),
                confirm_strategy: true,
                confirm_plan: false,
                external_delay_ms: None,
            },
        )
        .expect("strategy confirmed");

        assert!(strategy_confirmed.strategy_confirmed);
        assert!(!strategy_confirmed.plan_confirmed);
        assert_eq!(strategy_confirmed.requires_confirmation_step, 2);
        assert!(strategy_confirmed.execution_run_id.is_none());
        assert!(!strategy_confirmed.planned_intents.is_empty());

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn trade_orchestration_logs_replan_when_external_delay_is_present() {
        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!("tradeengine-strategy-replan-{}.db", now_ts()));

        let mut db = Database::open(db_path.to_str().expect("db path to str")).expect("open db");
        let user = db.create_user("replan_admin", "averysecurepassword").expect("create user");

        let encryption_key = [11_u8; 32];
        let generated_keypair = Keypair::new();
        let private_key = bs58::encode(generated_keypair.to_bytes()).into_string();
        let imported = db
            .import_private_key(
                user.id,
                ImportPrivateKeyRequest {
                    label: "Replan Wallet".to_string(),
                    private_key,
                },
                encryption_key,
            )
            .expect("import managed key");
        db.upsert_account_balance_snapshot(imported.id, "So11111111111111111111111111111111111111112", 60.0, 0.0)
            .expect("seed base balance");
        db.upsert_account_balance_snapshot(imported.id, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 120.0, 0.0)
            .expect("seed quote balance");

        let execution_started = strategy::orchestrate_trade(
            &mut db,
            user.id,
            TradeRequest {
                base_symbol: "SOL".to_string(),
                base_mint: "So11111111111111111111111111111111111111112".to_string(),
                base_decimals: 9,
                quote_symbol: "USDC".to_string(),
                quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
                quote_decimals: 6,
                target_buy_volume: 20.0,
                target_sell_volume: 10.0,
                target_total_volume: 30.0,
                micro_task_size_hint: Some(10.0),
                confirm_strategy: true,
                confirm_plan: true,
                external_delay_ms: Some(1500),
            },
        )
        .expect("execution started");

        assert!(execution_started.execution_started);
        assert_eq!(execution_started.plan_version, 2);
        let run_id = execution_started.execution_run_id.expect("execution run id");
        assert!(execution_started
            .execution_log
            .iter()
            .any(|entry| entry.stage == "replan_due_to_external_timing"));

        let persisted_run = db
            .conn
            .query_row(
                "SELECT status, latest_plan_version FROM strategy_execution_runs WHERE id = ?1",
                params![run_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("load execution run");
        assert_eq!(persisted_run.0, "replanned");
        assert_eq!(persisted_run.1, 2);

        let task_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM strategy_execution_tasks WHERE run_id = ?1 AND plan_version = 2",
                params![run_id],
                |row| row.get(0),
            )
            .expect("count execution tasks");
        assert!(task_count > 0);

        let logs = db.list_audit_logs(user.id, &user.username).expect("load audit logs");
        assert!(logs.iter().any(|entry| entry.target == "replan_due_to_external_timing"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn strategy_execution_query_contract_returns_active_run_and_tasks() {
        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!("tradeengine-execution-query-{}.db", now_ts()));

        let mut db = Database::open(db_path.to_str().expect("db path to str")).expect("open db");
        let user = db.create_user("query_admin", "averysecurepassword").expect("create user");

        let encryption_key = [13_u8; 32];
        let generated_keypair = Keypair::new();
        let private_key = bs58::encode(generated_keypair.to_bytes()).into_string();
        let imported = db
            .import_private_key(
                user.id,
                ImportPrivateKeyRequest {
                    label: "Query Wallet".to_string(),
                    private_key,
                },
                encryption_key,
            )
            .expect("import managed key");
        db.upsert_account_balance_snapshot(imported.id, "So11111111111111111111111111111111111111112", 40.0, 0.0)
            .expect("seed base balance");
        db.upsert_account_balance_snapshot(imported.id, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 80.0, 0.0)
            .expect("seed quote balance");

        let execution_started = strategy::orchestrate_trade(
            &mut db,
            user.id,
            TradeRequest {
                base_symbol: "SOL".to_string(),
                base_mint: "So11111111111111111111111111111111111111112".to_string(),
                base_decimals: 9,
                quote_symbol: "USDC".to_string(),
                quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
                quote_decimals: 6,
                target_buy_volume: 20.0,
                target_sell_volume: 10.0,
                target_total_volume: 30.0,
                micro_task_size_hint: Some(10.0),
                confirm_strategy: true,
                confirm_plan: true,
                external_delay_ms: None,
            },
        )
        .expect("start execution");

        let active_run = db
            .get_latest_strategy_execution_run(user.id)
            .expect("load latest run")
            .expect("active run present");
        let tasks = db
            .list_strategy_execution_tasks(active_run.id)
            .expect("load tasks");

        assert_eq!(active_run.id, execution_started.execution_run_id.expect("run id"));
        assert_eq!(active_run.base_symbol, "SOL");
        assert_eq!(active_run.base_mint, "So11111111111111111111111111111111111111112");
        assert_eq!(active_run.base_decimals, 9);
        assert_eq!(active_run.quote_symbol, "USDC");
        assert_eq!(active_run.quote_mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        assert_eq!(active_run.quote_decimals, 6);
        assert_eq!(active_run.latest_plan_version, 1);
        assert_eq!(active_run.status, "executing");
        assert!(!tasks.is_empty());
        assert!(tasks.iter().all(|task| task.run_id == active_run.id));
        assert!(tasks.iter().all(|task| task.plan_version == 1));
        assert!(tasks.iter().all(|task| task.status == "pending"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    #[ignore = "requires live Jupiter and Solana RPC execution"]
    fn task_consumer_advances_pending_tasks_to_executed() {
        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!("tradeengine-task-consumer-{}.db", now_ts()));

        let mut db = Database::open(db_path.to_str().expect("db path to str")).expect("open db");
        let user = db.create_user("consumer_admin", "averysecurepassword").expect("create user");

        let encryption_key = [17_u8; 32];
        let generated_keypair = Keypair::new();
        let private_key = bs58::encode(generated_keypair.to_bytes()).into_string();
        let imported = db
            .import_private_key(
                user.id,
                ImportPrivateKeyRequest {
                    label: "Consumer Wallet".to_string(),
                    private_key,
                },
                encryption_key,
            )
            .expect("import managed key");
        db.upsert_account_balance_snapshot(imported.id, "So11111111111111111111111111111111111111112", 40.0, 0.0)
            .expect("seed base balance");
        db.upsert_account_balance_snapshot(imported.id, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 90.0, 0.0)
            .expect("seed quote balance");

        let execution_started = strategy::orchestrate_trade(
            &mut db,
            user.id,
            TradeRequest {
                base_symbol: "SOL".to_string(),
                base_mint: "So11111111111111111111111111111111111111112".to_string(),
                base_decimals: 9,
                quote_symbol: "USDC".to_string(),
                quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string(),
                quote_decimals: 6,
                target_buy_volume: 20.0,
                target_sell_volume: 10.0,
                target_total_volume: 30.0,
                micro_task_size_hint: Some(10.0),
                confirm_strategy: true,
                confirm_plan: true,
                external_delay_ms: None,
            },
        )
        .expect("start execution");

        let run_id = execution_started.execution_run_id.expect("run id");
        let config = Config {
            bind_addr: "127.0.0.1:3000".to_string(),
            database_path: db_path.to_str().expect("db path to str").to_string(),
            static_dir: "../dist".to_string(),
            session_ttl_hours: 12,
            cookie_secure: false,
            private_key_encryption_key: Some(encryption_key),
            solana_rpc_url: Some("https://api.mainnet-beta.solana.com".to_string()),
        };
        let consumed = match db.consume_strategy_execution_tasks(run_id, 100, &config) {
            Ok(consumed) => consumed,
            Err(error) => panic!("consume tasks failed: {}", error.message),
        };
        assert!(!consumed.is_empty());

        let persisted_run = db
            .get_latest_strategy_execution_run(user.id)
            .expect("load latest run")
            .expect("active run present");
        assert_eq!(persisted_run.status, "completed");

        let tasks = db
            .list_strategy_execution_tasks(run_id)
            .expect("load tasks");
        assert!(tasks.iter().all(|task| task.status == "executed"));

        let _ = std::fs::remove_file(db_path);
    }
}
