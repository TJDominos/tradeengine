<<<<<<< HEAD
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
=======
# Trade Engine

A Solana trading dashboard with a **Cloudflare Worker + D1** production backend and a React/Vite frontend.

---

## Architecture

```
Browser (React + Vite)
        │
        ├─► Cloudflare Worker  (production backend)
        │       ├─ D1 SQLite   (settings, accounts, trade logs, signals)
        │       └─ Helius webhook endpoint  (/webhook)
        │
        └─► Express dev server (local development only)
                └─ /api/relay  (CORS proxy → Cloudflare Worker)
```

### Backend: Cloudflare Worker (`cloudflare-worker/`)
* Handles all API requests in production (`/api/state`, `/api/settings`, `/api/trade`).
* Persists configuration, account data, and trade logs in **Cloudflare D1**.
* Receives real-time Helius webhook events at `/webhook`.
* Authenticated via a `FRONTEND_TOKEN` bearer token.

### Local dev server: `server.ts`
* Serves the React SPA via Vite middleware.
* Provides `/api/relay` – a CORS proxy that forwards requests to the Cloudflare Worker.
* Exposes `/api/state` (in-memory, with Solana RPC balance sync) so the dashboard is usable during local development without a deployed Worker.
* **Does not execute real trades** – `/api/trade` returns `501 Not Implemented`.

---

## Quick Start (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env and fill in BOT_SECRET_KEY, FRONTEND_TOKEN, and optional RPC endpoints.

# 3. Start the dev server (Vite + Express)
npm run dev
# Open http://localhost:3000

# 4. (Optional) Set the Worker URL in the dashboard UI to point at your deployed Worker.
#    All API requests will then be proxied through /api/relay to the Worker.
```

---

## Cloudflare Worker Deployment

### Prerequisites
* A Cloudflare account with Workers and D1 enabled.
* `CF_API_TOKEN` GitHub Actions secret with Workers Scripts + D1 permissions.

### First-time setup
>>>>>>> origin/main

```bash
cd cloudflare-worker
npm install
<<<<<<< HEAD
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
=======

# 1. Create the D1 database (only needed once)
npx wrangler d1 create tradingbot
# Copy the returned database_id into wrangler.toml [[d1_databases]].

# 2. Apply the initial schema migration
npx wrangler d1 migrations apply tradingbot --remote

# 3. Set production secrets
npx wrangler secret put FRONTEND_TOKEN   # ****** used by the frontend/relay
npx wrangler secret put BOT_SECRET_KEY   # Solana wallet private key (base58 or JSON)

# 4. Deploy
npx wrangler deploy
```

### Subsequent deployments

Pushing to `main` triggers the GitHub Actions workflow (`.github/workflows/deploy.yml`), which:
1. Applies any pending D1 migrations.
2. Deploys the updated Worker.

---

## Database Migrations

Schema is managed via Wrangler D1 migrations in `cloudflare-worker/migrations/`.

| File | Description |
|------|-------------|
| `0001_init.sql` | Initial schema – settings, accounts, trade_logs, signals, historic_setups |

All migrations are **idempotent** (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`).

To add a new migration:
```bash
cd cloudflare-worker
npx wrangler d1 migrations create tradingbot <migration-name>
# Edit the generated file, then apply:
npx wrangler d1 migrations apply tradingbot --remote
>>>>>>> origin/main
```

---

<<<<<<< HEAD
## GitHub Actions

The `.github/workflows/deploy.yml` workflow automatically deploys the Cloudflare Worker on pushes to `main` that modify files under `cloudflare-worker/`.

**Required GitHub secret:** `CF_API_TOKEN` (Cloudflare API token with Worker deploy permissions).
=======
## Environment Variables

### Cloudflare Worker secrets (`wrangler secret put <NAME>`)
| Name | Required | Description |
|------|----------|-------------|
| `FRONTEND_TOKEN` | Yes | ****** to authenticate dashboard/relay requests |
| `BOT_SECRET_KEY` | Yes | Solana wallet private key (base58 or JSON byte-array) |

### Cloudflare Worker vars (`wrangler.toml [vars]`)
| Name | Default | Description |
|------|---------|-------------|
| `RPC_URL` | Solana public mainnet | Solana RPC endpoint used by the Worker |

### Local dev server (`.env` – see `.env.example`)
| Name | Description |
|------|-------------|
| `FRONTEND_TOKEN` | Must match the Worker secret (forwarded by `/api/relay`) |
| `BOT_SECRET_KEY` | Local wallet key for blockchain sync |
| `CHAINSTACK_RPC_URL` | Optional paid RPC (Chainstack) |
| `HELIUS_RPC_URL` | Optional paid RPC (Helius) |
| `TATUM_RPC_URL` / `TATUM_API_KEY` | Optional paid RPC (Tatum) |

---

## Trade Execution Status

Real on-chain trade execution is **not yet implemented**.

* `/api/trade` returns `501 Not Implemented` on both the Worker and the local dev server.
* The Helius webhook handler (`/webhook`) logs incoming swap events to D1 and detects whale buys (> 1 SOL), but does not submit on-chain transactions.

**Follow-up work needed:**
- Implement signed `VersionedTransaction` building and submission in `cloudflare-worker/src/index.ts`.
- Add risk management / order sizing logic.
- Wire up the `tradingAlgorithm` strategy stored in D1 settings.
>>>>>>> origin/main
