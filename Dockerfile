FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM rust:1.89-bookworm AS backend
WORKDIR /app/rust-backend
COPY rust-backend/Cargo.toml rust-backend/Cargo.lock ./
COPY rust-backend/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=frontend /app/dist /app/dist
COPY --from=backend /app/rust-backend/target/release/wlt-trading-engine /usr/local/bin/wlt-trading-engine
ENV BIND_ADDR=0.0.0.0:3000
ENV DATABASE_PATH=/data/tradeengine.db
ENV STATIC_DIR=/app/dist
EXPOSE 3000
CMD ["/usr/local/bin/wlt-trading-engine"]
