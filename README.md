# WLT Trading Engine

A Solana trading dashboard with a **Rust backend** for strategy execution and a **Cloudflare Worker** for real-time webhook processing.

## Architecture

```
[React Dashboard (Vite static)]
         │
         │  direct HTTP (CORS)
         ▼
[Rust Backend — rust-backend/]
  • GET /api/state  (price, strategy state)
  • Volatility target rebalancing loop
  • WebSocket contract monitor

[Cloudflare Worker — cloudflare-worker/]
  • POST /webhook   (Helius webhook receiver → D1)
  • POST /api/trade (logs request; execution not yet implemented)
  • D1 persistent storage for signals, accounts, settings
```

## Frontend Dashboard

The React dashboard connects **directly** to the Rust backend URL. Set the **Backend URL** in the Settings tab of the dashboard (e.g. `http://localhost:3000` for local dev).

**No Node.js relay server is used.**

### Run Locally

**Prerequisites:** Node.js ≥ 20, npm

```bash
npm install
npm run dev        # starts Vite dev server at http://localhost:5173
```

Then set the Backend URL in the dashboard Settings tab to point at your running Rust backend.

### Build for Production (static site)

```bash
npm run build      # outputs to dist/
```

Deploy the `dist/` folder to any static host (Cloudflare Pages, Vercel, Netlify, etc.).

---

## Rust Backend

**Prerequisites:** Rust / Cargo

```bash
cd rust-backend
cargo build
```

**Configuration** (`.env` in `rust-backend/` or environment variables):

| Variable | Description | Default |
|---|---|---|
| `RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `WSS_URL` | Solana WebSocket endpoint | `wss://api.mainnet-beta.solana.com` |
| `CONTRACT_ADDRESS` | Token contract to monitor | _(empty — monitor disabled)_ |

**Run:**

```bash
cd rust-backend
RPC_URL=https://your-rpc-endpoint.com cargo run
```

The backend listens on port **3000** (`http://0.0.0.0:3000`).

**Endpoints:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/state` | Returns current price, MA, and strategy targets |

---

## Cloudflare Worker (Webhook Receiver)

The Worker receives Helius webhooks and persists signals to D1.

**Prerequisites:** Node.js ≥ 20, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

```bash
cd cloudflare-worker
npm install
```

### D1 Database Setup

Initialize the database schema (run once per new D1 database):

```bash
wrangler d1 execute tradingbot --file=schema.sql
```

### Secrets (Cloudflare Dashboard → Settings → Variables)

| Secret | Description |
|---|---|
| `BOT_SECRET_KEY` | Base58 or JSON-array private key for the trading bot wallet |
| `FRONTEND_TOKEN` | ****** to authenticate dashboard API requests |

### Deploy

```bash
cd cloudflare-worker
wrangler deploy
```

### Local Development

```bash
cd cloudflare-worker
wrangler dev
```

---

## GitHub Actions

The `.github/workflows/deploy.yml` workflow automatically deploys the Cloudflare Worker on pushes to `main` that modify files under `cloudflare-worker/`.

**Required GitHub secret:** `CF_API_TOKEN` (Cloudflare API token with Worker deploy permissions).
