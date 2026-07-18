# tradeengine Rust backend

This directory now contains the active backend for the repository.

## Responsibilities

- Serve the built React admin UI from the same origin.
- Initialize and connect to the SQLite database configured by `DATABASE_PATH`.
- Bootstrap and authenticate the admin user.
- Protect configuration, account import, and private-key import endpoints behind authenticated admin sessions.
- Encrypt imported managed private keys at rest.
- Return `501 Not Implemented` for trade execution until a real executor exists.

## Local run

From `/home/runner/work/tradeengine/tradeengine`:

```bash
npm install
npm run build
cargo run --manifest-path rust-backend/Cargo.toml
```

The backend reads the same environment variables documented in the repository root `README.md`.
