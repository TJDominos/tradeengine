# WLT Trading Engine - Rust Backend

This is the Rust implementation of the WLT trading strategy execution engine and API backend.

* **`main.rs`** — Initializes the Tokio runtime, establishes the Solana RPC connection, starts the HTTP API server (`warp` on port 3000), and spawns background tasks.
* **`strategy.rs`** — Strategy loop: evaluates Volatility Target Rebalancing and Outsider Pull Back conditions. Execution stubs are present but not yet wired to Solana transactions.
* **`monitor.rs`** — WebSocket monitor that subscribes to on-chain transaction logs for a configured contract address.
* **`models.rs`** — API response DTOs and warp request handlers.

## Requirements

* `cargo` and `rustc` installed on your host machine.

## Configuration

Copy and edit the example env file, or export variables directly:

| Variable | Description | Default |
|---|---|---|
| `RPC_URL` | Solana HTTPS RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `WSS_URL` | Solana WebSocket endpoint | `wss://api.mainnet-beta.solana.com` |
| `CONTRACT_ADDRESS` | Token contract address to monitor (optional) | _(empty)_ |

## How to run locally

1. Open a terminal and navigate to this directory:
   ```
   cd rust-backend
   ```
2. Build:
   ```
   cargo build
   ```
3. Run:
   ```
   cargo run
   ```

The server starts on `http://0.0.0.0:3000`.

To run the React dashboard, open a second terminal from the repository root and run:
```
npm install && npm run dev
```

Then set the **Backend URL** in the dashboard Settings tab to `http://localhost:3000`.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/state` | Returns `{ stats: { price, ma_price } }` |
