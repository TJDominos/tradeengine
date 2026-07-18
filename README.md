# tradeengine

This PR standardizes the active backend direction on the Rust service in `/rust-backend` and removes the old Node.js backend path from the default build and runtime flow.

## What this build now does

- Serves the React admin UI from the Rust backend.
- Stores admin users, sessions, settings, imported accounts, and encrypted managed private keys in SQLite.
- Requires authenticated login before any configuration, private-key import, or account import action is allowed.
- Returns `501 Not Implemented` for trade execution instead of fake success.

## Required environment variables

Copy `/home/runner/work/tradeengine/tradeengine/.env.example` and set:

- `BIND_ADDR` - bind address for the Rust backend, default `0.0.0.0:3000`
- `DATABASE_PATH` - SQLite database path, default `./data/tradeengine.db`
- `STATIC_DIR` - built frontend directory, default `../dist`
- `SESSION_TTL_HOURS` - session lifetime, default `12`
- `COOKIE_SECURE` - set to `true` behind HTTPS in production
- `PRIVATE_KEY_ENCRYPTION_KEY` - **required for private-key import**; must decode to exactly 32 bytes (base64 or hex)
- `RUST_LOG` - optional, for example `info`

## Local development

1. Install frontend dependencies:
   ```bash
   npm install
   ```
2. Build the frontend:
   ```bash
   npm run build
   ```
3. Start the Rust backend:
   ```bash
   cargo run --manifest-path /home/runner/work/tradeengine/tradeengine/rust-backend/Cargo.toml
   ```
4. Open `http://localhost:3000`.
5. On first launch, create the initial admin username and password in the bootstrap screen.

## Database initialization and binding

- The Rust service creates the SQLite schema automatically on startup using `CREATE TABLE IF NOT EXISTS` migrations.
- The application does **not** drop tables during startup.
- The backend reports its active database path from `/api/health` and the authenticated admin dashboard.
- Use a persistent volume for the directory containing `DATABASE_PATH` when deploying.

## Deployment workflow

The repository workflow now builds the Vite frontend, runs Rust tests, builds the Rust release binary, and builds the Docker image for the unified deployment path.

If you want GitHub Actions to trigger an actual deployment, set the repository secret `DEPLOY_WEBHOOK_URL` to your hosting platform's deploy hook. The workflow will POST to that hook after a successful build.

## Docker deployment

Build the container:

```bash
docker build -t tradeengine-rust-admin /home/runner/work/tradeengine/tradeengine
```

Run it with a persistent database directory:

```bash
docker run --rm -p 3000:3000 \
  -e PRIVATE_KEY_ENCRYPTION_KEY="replace-with-base64-or-hex-32-byte-secret" \
  -e COOKIE_SECURE=false \
  -v $(pwd)/data:/data \
  tradeengine-rust-admin
```

The image defaults `DATABASE_PATH` to `/data/tradeengine.db` and serves the built frontend from `/app/dist`.

## Security notes

- Passwords are hashed with Argon2.
- Sessions use an opaque `HttpOnly` cookie; only the SHA-256 token hash is stored in the database.
- Imported managed private keys are encrypted at rest and are never echoed back to the browser.
- Settings and imported account records are scoped to the authenticated user.
- Trade execution remains blocked until a real execution engine is implemented and reviewed.

## Follow-up work for production hardening

- Add a reviewed trade executor with explicit policy enforcement and signing controls.
- Rotate and manage `PRIVATE_KEY_ENCRYPTION_KEY` using a dedicated secret manager.
- Add CSRF protection if the UI will be hosted cross-site instead of same-origin with the Rust backend.
- Add user management flows beyond single-admin bootstrap when multi-operator access is needed.
