# tradeengine

A Cloudflare Workers-native trading admin panel backed by **Cloudflare D1** (SQLite-compatible serverless database).

## MVP scope: Solana token onboarding via contract address

The product is **Solana-first** and **token-onboarding-first**. There is no pre-seeded fixed trading pair.

### Intended flow

1. **Select network** — currently Solana only.
2. **Enter contract address** — the token mint address on Solana.
3. **Fetch token metadata** — the backend retrieves symbol, name, and decimals from on-chain.
4. **Trade** — the configured token is traded against **USDC on Solana** via the **Jupiter aggregator** ([jup.ag](https://jup.ag)).

| Field | Value |
|-------|-------|
| Network | **Solana** |
| Quote asset | **USDC** (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) |
| Execution path | **Jupiter (jup.ag)** |
| Execution status | Disabled (returns `501`) until the execution engine is implemented |

## Architecture

- **Frontend** – React / Vite SPA served as Cloudflare static assets.
- **Backend** – Cloudflare Worker (`src/worker.ts`) handling all `/api/*` routes.
- **Database** – Cloudflare D1 (`TRADINGBOT_DB` binding, database `tradingbot`).

## What this build does

- Serves the React admin UI from the same Cloudflare Worker origin.
- Stores admin users, sessions, settings, imported accounts, and encrypted managed private keys in D1.
- Requires authenticated login before any configuration, private-key import, or account import action is allowed.
- Exposes configured tradable tokens (added via network + contract address) via the `/api/state` endpoint and admin UI.
- Fetches and persists token market snapshots in D1, including price, FDV, liquidity, volume, transaction count, and outsider holder count.
- Automatically initializes token market data when the active trading token is saved or explicitly added from the setup UI.
- Accepts Alchemy Notify webhook events for the active trading token so on-chain activity is stored as signals and can trigger downstream strategy evaluation.
- Returns `501 Not Implemented` for trade execution until a real executor exists.

## D1 database binding

The Worker uses the following binding (already configured in `wrangler.jsonc`):

```jsonc
{
  "d1_databases": [
    {
      "binding": "TRADINGBOT_DB",
      "database_name": "tradingbot",
      "database_id": "b93f4c50-a519-422c-9b31-15244ef3184f"
    }
  ]
}
```

### Apply the schema migration (optional pre-provisioning)

The Worker now auto-initialises the D1 schema on first auth request (`/api/auth/status` or `/api/auth/bootstrap`) by running idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements that match `migrations/0001_init.sql`.

You can still run migrations manually to pre-provision environments:

```bash
# remote (production)
npx wrangler d1 migrations apply tradingbot --remote

# local dev (uses a local SQLite file under .wrangler/)
npx wrangler d1 migrations apply tradingbot --local
```

Migrations are located in `migrations/`:

| File | Description |
|------|-------------|
| `0001_init.sql` | Core tables: users, sessions, settings, accounts, audit_logs |
| `0002_trade_domain.sql` | Trade tables: tradable_tokens (network + contract address), trade_logs, signals, positions, historic_setups |
| `0003_rpc_endpoints.sql` | User-scoped Solana HTTP RPC failover pool |
| `0004_token_market_snapshots.sql` | Historical token market snapshots and related indexes |

> **Note:** `0002_trade_domain.sql` creates the `tradable_tokens` table. Tokens are added at runtime by providing a network and contract address; no rows are seeded by the migration.

## Cloudflare secrets

The following secret **must** be set before private-key import will work:

| Secret | Description |
|--------|-------------|
| `PRIVATE_KEY_ENCRYPTION_KEY` | 32-byte value encoded as base64 or hex. Used to AES-256-GCM encrypt managed private keys at rest. |

Optional environment variables:

| Variable | Description |
|----------|-------------|
| `SOLANA_RPC_URL` | Preferred Solana HTTP RPC endpoint for metadata, balances, and transaction enrichment. |
| `ALCHEMY_WEBHOOK_SECRET` | Shared secret required by `/api/webhooks/alchemy/notify`. Configure the same value in the webhook URL or send it as a bearer token. |

Set it with Wrangler:

```bash
npx wrangler secret put PRIVATE_KEY_ENCRYPTION_KEY
# then paste your 32-byte value (generate one with: openssl rand -base64 32)
```

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Apply migrations locally:
   ```bash
   npx wrangler d1 migrations apply tradingbot --local
   ```
3. Start the local Worker dev server (serves both the React UI and API):
   ```bash
   npm run dev
   ```
4. Open `http://localhost:5173` (or the port shown by Vite).
5. On first launch, create the initial admin username and password in the bootstrap screen.
   - Passwords shorter than 12 characters are rejected with a clear `400` error response.

> **Note:** For local development the `PRIVATE_KEY_ENCRYPTION_KEY` secret is read from a `.dev.vars` file.  
> Copy `.env.example` to `.dev.vars` and fill in your key:
> ```
> PRIVATE_KEY_ENCRYPTION_KEY=<your-32-byte-base64-or-hex-value>
> ```

## Deployment

```bash
# Build the frontend and deploy the Worker to Cloudflare
npm run deploy
```

The CI workflow (`.github/workflows/deploy.yml`) automatically deploys on push to `main` when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets are configured.

## API endpoints

| Method | Path | Auth required | Description |
|--------|------|--------------|-------------|
| GET | `/api/health` | No | Worker + D1 health check |
| GET | `/api/auth/status` | No | Check session / setup status |
| POST | `/api/auth/bootstrap` | No (once) | Create initial admin account |
| POST | `/api/auth/login` | No | Authenticate and create session |
| POST | `/api/auth/logout` | No | Delete session |
| GET | `/api/state` | Yes | Full engine state (includes configured tradable tokens) |
| POST | `/api/settings` | Admin | Save trading settings |
| POST | `/api/market-snapshot/refresh` | Admin | Force a live market fetch for the active trading token and store a new historical snapshot |
| POST | `/api/webhooks/alchemy/notify` | No | Ingest an Alchemy Notify webhook, persist `signals`, and trigger strategy evaluation for matching active tokens |
| POST | `/api/private-keys/import` | Admin | Import + encrypt a managed private key |
| POST | `/api/accounts/import` | Admin | Import a watch-only account |
| POST | `/api/trade` | Admin | Trade (returns 501 – not implemented) |

### Alchemy Notify webhook setup

Use an Alchemy Notify webhook URL in this shape:

```text
https://<your-worker-domain>/api/webhooks/alchemy/notify?secret=<ALCHEMY_WEBHOOK_SECRET>&contractAddress=<solana-token-mint>
```

- `secret` must match the Worker environment variable `ALCHEMY_WEBHOOK_SECRET`.
- `contractAddress` is recommended because webhook payloads vary by product and chain. If the payload does not include a parsable Solana mint, this query parameter lets the Worker route the event to users whose active trading token matches that mint.
- The endpoint stores the raw event in `signals`, refreshes market snapshots, and records a `strategy.triggered` audit log entry.

## Data model summary

### Current MVP tables

| Table | Purpose |
|-------|---------|
| `users` | Admin accounts |
| `sessions` | Authenticated sessions |
| `settings` | Per-user key-value strategy parameters |
| `accounts` | Managed (signing) and watch-only wallets |
| `audit_logs` | Immutable action log |
| `tradable_tokens` | Tokens configured via network + contract address; metadata fetched on-chain |
| `token_market_snapshots` | Historical token market snapshots with fetch time and outsider counts |
| `signals` | On-chain token activity events captured from Alchemy Notify webhooks |
| `trade_logs` | Every proposed/executed trade with token reference |
| `positions` | Current holdings per wallet and token |
| `historic_setups` | Saved strategy snapshots, optionally scoped to a token |

### Is the current model sufficient for a Solana token-onboarding MVP?

**Yes** — the trade domain tables plus the snapshot history migration are sufficient:

- `tradable_tokens` stores each token configured by the admin (network + contract address + fetched metadata).
- `trade_logs` records every order with amounts, price, tx hash, and status; each log references a `token_id`.
- `signals` gives deduplication-safe storage for Alchemy Notify or other webhook events (`external_id NOT NULL` ensures the `UNIQUE(source, external_id)` constraint is reliable).
- `token_market_snapshots` preserves incremental dashboard data points over time for both manual refreshes and event-driven refreshes.
- `positions` tracks per-wallet holdings for each configured token.
- `historic_setups` snapshots strategy parameters at each save so you can correlate outcomes.

### Adding a token at runtime

Insert a row directly into `tradable_tokens` (a future admin UI form will do this):

```sql
INSERT INTO tradable_tokens (network, contract_address, symbol, name, decimals, is_active, created_at)
VALUES ('solana', '<mint_address>', 'SYM', 'Token Name', 6, 1, unixepoch());
```

The system will trade this token against USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) on Solana via Jupiter.

**What is not yet covered** (planned for later phases):

- Balance synchronisation (on-chain → D1) — `accounts` holds no live balance; balances will be polled or pushed via webhooks when the executor is built.
- Real-time PnL — `positions.realized_pnl` is populated by the executor; the current schema stores the field but no code writes to it yet.
- Multi-user / role expansion — all tables are `user_id`-scoped, so adding roles is straightforward but not yet wired up.

## Security notes

- Passwords are hashed with **PBKDF2-SHA256** (210 000 iterations) via the Web Crypto API.
- Sessions use an opaque `HttpOnly` cookie (`te_session`); only the SHA-256 token hash is stored in D1.
- Imported managed private keys are encrypted at rest with **AES-256-GCM** using `PRIVATE_KEY_ENCRYPTION_KEY` and are never returned by the API.
- Settings and imported account records are scoped to the authenticated user.
- Trade execution remains blocked until a real execution engine is implemented and reviewed.

## Follow-up work for production hardening

- Implement the trade executor: sign transactions with managed keys, submit to Solana via Jupiter, update `trade_logs` and `positions`.
- Build the add-token form in the UI: select network, enter contract address, trigger on-chain metadata fetch.
- Add balance-sync job (e.g. Helius webhook → `accounts` cache) to keep displayed balances fresh.
- Add CSRF protection if the UI will be hosted cross-site.
- Rotate and manage `PRIVATE_KEY_ENCRYPTION_KEY` using Cloudflare Secrets or a dedicated secret manager.
