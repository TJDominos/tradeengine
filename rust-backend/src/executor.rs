use reqwest::blocking::Client;
use base64::Engine;
use serde::{Deserialize, Serialize};
use solana_sdk::signature::Keypair;
use solana_sdk::transaction::VersionedTransaction;
use std::thread;
use std::time::Duration;

use crate::planner::OrderSide;
use crate::{ApiError, bad_request, internal_error};

#[derive(Debug, Clone)]
pub struct ExecutionTaskInput {
    pub task_id: i64,
    pub run_id: i64,
    pub plan_version: i64,
    pub intent_id: String,
    pub side: OrderSide,
    pub amount: f64,
    pub quote_decimals: u8,
    pub base_decimals: u8,
    pub slippage_bps: u64,
    pub base_mint: String,
    pub quote_mint: String,
    pub account_id: String,
    pub paired_account_id: Option<String>,
    pub notes: String,
    pub wallet_address: String,
    pub decrypted_private_key: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOutcome {
    pub status: String,
    pub tx_signature: Option<String>,
    pub error_message: Option<String>,
}

pub trait TaskExecutor {
    fn execute(&self, input: &ExecutionTaskInput) -> Result<ExecutionOutcome, ApiError>;
}

#[derive(Debug, Deserialize)]
struct JupiterQuoteResponse {
    #[serde(rename = "inputMint")]
    input_mint: String,
    #[serde(rename = "outputMint")]
    output_mint: String,
    #[serde(rename = "inAmount")]
    in_amount: String,
    #[serde(rename = "outAmount")]
    out_amount: String,
    #[serde(rename = "slippageBps")]
    slippage_bps: u64,
}

impl Serialize for JupiterQuoteResponse {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let value = serde_json::json!({
            "inputMint": self.input_mint,
            "outputMint": self.output_mint,
            "inAmount": self.in_amount,
            "outAmount": self.out_amount,
            "slippageBps": self.slippage_bps,
        });
        value.serialize(serializer)
    }
}

#[derive(Debug, Deserialize)]
struct JupiterSwapResponse {
    #[serde(rename = "swapTransaction")]
    swap_transaction: Option<String>,
    error: Option<String>,
}

pub struct MainnetExecutor {
    pub rpc_url: String,
}

impl TaskExecutor for MainnetExecutor {
    fn execute(&self, input: &ExecutionTaskInput) -> Result<ExecutionOutcome, ApiError> {
        let client = Client::new();
        let keypair = Keypair::from_bytes(&input.decrypted_private_key)
            .map_err(|_| bad_request("Managed private key must decode to a valid 64-byte Solana keypair"))?;

        let (input_mint, output_mint, atomic_amount) = match input.side {
            OrderSide::Buy => {
                let amount_atomic = amount_to_atomic(input.amount, input.quote_decimals)?;
                (input.quote_mint.clone(), input.base_mint.clone(), amount_atomic)
            }
            OrderSide::Sell => {
                let amount_atomic = amount_to_atomic(input.amount, input.base_decimals)?;
                (input.base_mint.clone(), input.quote_mint.clone(), amount_atomic)
            }
        };

        let quote = fetch_jupiter_quote(
            &client,
            &input_mint,
            &output_mint,
            &atomic_amount,
            input.slippage_bps,
        )?;
        let swap_transaction = fetch_jupiter_swap_transaction(
            &client,
            &quote,
            &input.wallet_address,
        )?;

        let transaction_bytes = base64::engine::general_purpose::STANDARD
            .decode(swap_transaction)
            .map_err(|_| bad_request("Jupiter swap transaction payload is not valid base64"))?;
        let versioned_transaction: VersionedTransaction = bincode::deserialize(&transaction_bytes)
            .map_err(|error| internal_error(format!("Failed to decode Jupiter swap transaction: {error}")))?;
        let signed_transaction = VersionedTransaction::try_new(versioned_transaction.message, &[&keypair])
            .map_err(|error| internal_error(format!("Failed to sign Jupiter swap transaction: {error}")))?;
        let serialized_transaction = bincode::serialize(&signed_transaction)
            .map_err(|error| internal_error(format!("Failed to serialize signed Jupiter transaction: {error}")))?;
        let encoded_transaction = base64::engine::general_purpose::STANDARD.encode(serialized_transaction);

        let tx_signature = send_transaction(&client, &self.rpc_url, &encoded_transaction)?;
        wait_for_confirmation(&client, &self.rpc_url, &tx_signature)?;

        Ok(ExecutionOutcome {
            status: "executed".to_string(),
            tx_signature: Some(tx_signature),
            error_message: None,
        })
    }
}

#[derive(Debug, Deserialize)]
struct RpcSendTransactionResponse {
    result: Option<String>,
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RpcSignatureStatusesResponse {
    result: RpcSignatureStatusesResult,
}

#[derive(Debug, Deserialize)]
struct RpcSignatureStatusesResult {
    value: Vec<Option<RpcSignatureStatusValue>>,
}

#[derive(Debug, Deserialize)]
struct RpcSignatureStatusValue {
    #[serde(rename = "confirmationStatus")]
    confirmation_status: Option<String>,
    err: Option<serde_json::Value>,
}

fn amount_to_atomic(amount: f64, decimals: u8) -> Result<String, ApiError> {
    if !amount.is_finite() || amount <= 0.0 {
        return Err(bad_request("Execution amount must be a positive finite number"));
    }

    let scaled = amount * 10_f64.powi(i32::from(decimals));
    if !scaled.is_finite() || scaled <= 0.0 {
        return Err(bad_request("Execution amount could not be converted to atomic units"));
    }

    Ok(scaled.round().max(1.0).to_string())
}

fn fetch_jupiter_quote(
    client: &Client,
    input_mint: &str,
    output_mint: &str,
    amount_atomic: &str,
    slippage_bps: u64,
) -> Result<JupiterQuoteResponse, ApiError> {
    let response = client
        .get("https://quote-api.jup.ag/v6/quote")
        .query(&[
            ("inputMint", input_mint),
            ("outputMint", output_mint),
            ("amount", amount_atomic),
            ("slippageBps", &slippage_bps.to_string()),
        ])
        .send()
        .map_err(|error| internal_error(format!("Failed to request Jupiter quote: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(internal_error(format!(
            "Jupiter quote request failed with status {status}: {body}"
        )));
    }

    response
        .json::<JupiterQuoteResponse>()
        .map_err(|error| internal_error(format!("Failed to decode Jupiter quote response: {error}")))
}

fn fetch_jupiter_swap_transaction(
    client: &Client,
    quote: &JupiterQuoteResponse,
    user_public_key: &str,
) -> Result<String, ApiError> {
    let response = client
        .post("https://quote-api.jup.ag/v6/swap")
        .json(&serde_json::json!({
            "quoteResponse": quote,
            "userPublicKey": user_public_key,
            "wrapAndUnwrapSol": true,
            "dynamicComputeUnitLimit": true,
        }))
        .send()
        .map_err(|error| internal_error(format!("Failed to request Jupiter swap transaction: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(internal_error(format!(
            "Jupiter swap request failed with status {status}: {body}"
        )));
    }

    let body = response
        .json::<JupiterSwapResponse>()
        .map_err(|error| internal_error(format!("Failed to decode Jupiter swap response: {error}")))?;
    if let Some(error) = body.error {
        return Err(bad_request(format!("Jupiter swap error: {error}")));
    }

    body.swap_transaction
        .ok_or_else(|| internal_error("Jupiter swap response missing swapTransaction"))
}

fn send_transaction(client: &Client, rpc_url: &str, transaction_base64: &str) -> Result<String, ApiError> {
    let response = client
        .post(rpc_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendTransaction",
            "params": [
                transaction_base64,
                {
                    "encoding": "base64",
                    "skipPreflight": false,
                    "maxRetries": 3,
                    "preflightCommitment": "confirmed"
                }
            ]
        }))
        .send()
        .map_err(|error| internal_error(format!("Failed to send Solana transaction: {error}")))?;

    let body = response
        .json::<RpcSendTransactionResponse>()
        .map_err(|error| internal_error(format!("Failed to decode sendTransaction response: {error}")))?;

    if let Some(error) = body.error {
        return Err(internal_error(format!("Solana sendTransaction RPC error: {error}")));
    }

    body.result
        .ok_or_else(|| internal_error("Solana sendTransaction response missing transaction signature"))
}

fn wait_for_confirmation(client: &Client, rpc_url: &str, tx_signature: &str) -> Result<(), ApiError> {
    for _ in 0..10 {
        let response = client
            .post(rpc_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getSignatureStatuses",
                "params": [[tx_signature], { "searchTransactionHistory": true }]
            }))
            .send()
            .map_err(|error| internal_error(format!("Failed to request transaction status: {error}")))?;

        let body = response
            .json::<RpcSignatureStatusesResponse>()
            .map_err(|error| internal_error(format!("Failed to decode getSignatureStatuses response: {error}")))?;

        if let Some(Some(status)) = body.result.value.first() {
            if let Some(error) = &status.err {
                return Err(internal_error(format!("Solana transaction failed on chain: {error}")));
            }
            if matches!(status.confirmation_status.as_deref(), Some("confirmed") | Some("finalized")) {
                return Ok(());
            }
        }

        thread::sleep(Duration::from_millis(800));
    }

    Err(internal_error(format!(
        "Timed out waiting for Solana confirmation for transaction {tx_signature}"
    )))
}