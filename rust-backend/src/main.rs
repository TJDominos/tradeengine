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
}

#[derive(Clone)]
struct Config {
    bind_addr: String,
    database_path: String,
    static_dir: String,
    session_ttl_hours: u64,
    cookie_secure: bool,
    private_key_encryption_key: Option<[u8; 32]>,
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

#[derive(Deserialize)]
struct TradeRequest {
    symbol: Option<String>,
    action: Option<String>,
}


#[tokio::main]
async fn main() {
    env_logger::init();
    dotenv::dotenv().ok();

    let config = Config::from_env();
    let database = Database::open(&config.database_path).expect("failed to open database");
    let context = AppContext {
        db: Arc::new(Mutex::new(database)),
        config: Arc::new(config.clone()),
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

        Self {
            bind_addr,
            database_path,
            static_dir,
            session_ttl_hours,
            cookie_secure,
            private_key_encryption_key,
        }
    }
}

impl Database {
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
                trade_execution_enabled: false,
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

async fn handle_save_settings(
    context: AppContext,
    cookie_header: Option<String>,
    request: SettingsUpdateRequest,
) -> Result<impl Reply, Infallible> {
    let response = match require_admin(&context, cookie_header) {
        Ok(user) => {
            let mut db = context.db.lock().expect("database mutex poisoned");
            match db.save_settings(user.id, request) {
                Ok(settings) => json_response(StatusCode::OK, &settings),
                Err(error) => error_response(error),
            }
        }
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
            let symbol = request.symbol.unwrap_or_else(|| "unknown".to_string());
            let action = request.action.unwrap_or_else(|| "unspecified".to_string());
            let _ = db.add_audit_log(
                user.id,
                "trade.execution_blocked",
                &symbol,
                &format!(
                    "Received blocked trade execution request for action '{}'. Real trade execution is not implemented in the Rust backend yet.",
                    action
                ),
            );
            error_response(ApiError {
                status: StatusCode::NOT_IMPLEMENTED,
                message: "Trade execution is intentionally not implemented in this Rust backend yet.".to_string(),
            })
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
}
