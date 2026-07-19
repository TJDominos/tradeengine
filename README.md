# tradeengine

A Cloudflare Workers-native trading admin panel backed by **Cloudflare D1** (SQLite-compatible serverless database).

## Architecture

- **Frontend** – React / Vite SPA served as Cloudflare static assets.
- **Backend** – Cloudflare Worker (`src/worker.ts`) handling all `/api/*` routes.
- **Database** – Cloudflare D1 (`TRADINGBOT_DB` binding, database `tradingbot`).

## What this build does

- Serves the React admin UI from the same Cloudflare Worker origin.
- Stores admin users, sessions, settings, imported accounts, and encrypted managed private keys in D1.
- Requires authenticated login before any configuration, private-key import, or account import action is allowed.
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

### Apply the schema migration

Run this once to initialise the D1 tables:

```bash
# remote (production)
npx wrangler d1 migrations apply tradingbot --remote

# local dev (uses a local SQLite file under .wrangler/)
npx wrangler d1 migrations apply tradingbot --local
```

Migrations are located in `migrations/`.

## Cloudflare secrets

The following secret **must** be set before private-key import will work:

| Secret | Description |
|--------|-------------|
| `PRIVATE_KEY_ENCRYPTION_KEY` | 32-byte value encoded as base64 or hex. Used to AES-256-GCM encrypt managed private keys at rest. |

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
| GET | `/api/state` | Yes | Full engine state |
| POST | `/api/settings` | Admin | Save trading settings |
| POST | `/api/private-keys/import` | Admin | Import + encrypt a managed private key |
| POST | `/api/accounts/import` | Admin | Import a watch-only account |
| POST | `/api/trade` | Admin | Trade (returns 501 – not implemented) |

## Security notes

- Passwords are hashed with **PBKDF2-SHA256** (210 000 iterations) via the Web Crypto API.
- Sessions use an opaque `HttpOnly` cookie (`te_session`); only the SHA-256 token hash is stored in D1.
- Imported managed private keys are encrypted at rest with **AES-256-GCM** using `PRIVATE_KEY_ENCRYPTION_KEY` and are never returned by the API.
- Settings and imported account records are scoped to the authenticated user.
- Trade execution remains blocked until a real execution engine is implemented and reviewed.

## Follow-up work for production hardening

- Add a reviewed trade executor with explicit policy enforcement and signing controls.
- Rotate and manage `PRIVATE_KEY_ENCRYPTION_KEY` using Cloudflare Secrets or a dedicated secret manager.
- Add CSRF protection if the UI will be hosted cross-site.
- Add user management flows beyond single-admin bootstrap when multi-operator access is needed.
