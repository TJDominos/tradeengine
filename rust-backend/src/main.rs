use solana_client::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use std::env;
use std::sync::Arc;
use tokio::sync::RwLock;
use warp::Filter;

mod strategy;
mod models;
mod monitor;

// Central State Structure
pub struct EngineState {
    pub current_price: f64,
    pub ma_price: f64,
    pub volatility_target: f64,
    pub pullback_target: f64,
}

#[tokio::main]
async fn main() {
    env_logger::init();
    dotenv::dotenv().ok();
    
    let rpc_url = env::var("RPC_URL").unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".to_string());
    log::info!("Connecting to Solana RPC at: {}", rpc_url);
    
    let rpc_client = Arc::new(RpcClient::new_with_commitment(
        rpc_url.clone(), 
        CommitmentConfig::confirmed()
    ));

    // Initialize shared state
    let state = Arc::new(RwLock::new(EngineState {
        current_price: 0.0,
        ma_price: 0.0,
        volatility_target: 0.045, // 4.5%
        pullback_target: 0.02,    // 2.0%
    }));

    // Start Trading Algorithms Loop in background
    let loop_state = state.clone();
    let loop_client = rpc_client.clone();
    tokio::spawn(async move {
        strategy::run_trading_loop(loop_client, loop_state).await;
    });

    // Start WSS Monitor loop for Contract Address
    let wss_url = env::var("WSS_URL").unwrap_or_else(|_| "wss://api.mainnet-beta.solana.com".to_string());
    let contract_address = env::var("CONTRACT_ADDRESS").unwrap_or_default();
    if !contract_address.is_empty() {
        let monitor_state = state.clone();
        tokio::spawn(async move {
            monitor::monitor_contract_websocket(wss_url, &contract_address, monitor_state).await;
        });
    } else {
        log::warn!("CONTRACT_ADDRESS not set; WebSocket monitor not started.");
    }

    // Setup API Endpoints for Dashboard Connection
    let api_state = state.clone();

    // CORS configuration
    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["GET", "POST", "OPTIONS"])
        .allow_headers(vec!["Content-Type", "Authorization"]);
    
    // GET /api/state
    let get_state = warp::path!("api" / "state")
        .and(warp::get())
        .and(warp::any().map(move || api_state.clone()))
        .and_then(models::handle_get_state);

    let routes = get_state.with(cors);
    
    log::info!("WLT Trading Engine (Rust) listening on 0.0.0.0:3000");
    warp::serve(routes).run(([0, 0, 0, 0], 3000)).await;
}
