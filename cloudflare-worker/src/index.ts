import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>;
<<<<<<< HEAD
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1Result>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1Result {
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface Env {
  /**
   * Solana RPC endpoint. Set in wrangler.toml [vars] or via Cloudflare Dashboard.
   * Override with a paid RPC for better reliability (Helius, Chainstack, etc.).
   */
  RPC_URL: string;
  /**
   * Bot wallet private key – base58-encoded or JSON byte-array string.
   * Set as a secret in the Cloudflare Dashboard (never in wrangler.toml).
   * wrangler secret put BOT_SECRET_KEY
   */
  BOT_SECRET_KEY: string;
  /**
   * ****** used by the frontend/relay to authenticate with this worker.
   * Set as a secret: wrangler secret put FRONTEND_TOKEN
   */
  FRONTEND_TOKEN: string;
  /** D1 database binding – configured in wrangler.toml [[d1_databases]]. */
  TRADINGBOT_DB: D1Database;
=======
  exec(query: string): Promise<D1Result>;
}

export interface Env {
  // Var bindings (declared in wrangler.toml [vars])
  RPC_URL: string;
  // D1 database binding (declared in wrangler.toml [[d1_databases]])
  TRADINGBOT_DB: D1Database;
  // Secrets (set via `wrangler secret put <NAME>`)
  BOT_SECRET_KEY?: string;
  PVK3?: string;
  FRONTEND?: string;
>>>>>>> origin/main
}

// Helper to build engineState from D1
async function getEngineStateFromD1(db: D1Database) {
  // 1. Fetch settings
  const { results: settingsRows } = await db.prepare("SELECT key, value FROM settings").all();
  const settings = {
    volatilityTarget: 0,
    pullbackTarget: 0,
    volumeTarget: 0,
    netBuyinTarget: 0,
    timeRangeTarget: '24h',
    maxTransactions: 100,
    maxSlippage: 0.0100,
    tradingAlgorithm: '// Enter your trading algorithm here\nfunction executeTrade(state) {\n  // return action\n}',
    secretLoaded: false,
    secretName: 'Loaded via Cloudflare ENV',
    contractAddress: ""
  };
  
  settingsRows?.forEach((row: any) => {
    if (row.key === 'volatilityTarget' || row.key === 'pullbackTarget' || row.key === 'netBuyinTarget' || row.key === 'volumeTarget' || row.key === 'maxTransactions' || row.key === 'maxSlippage') {
      (settings as any)[row.key] = parseFloat(row.value);
    } else {
      (settings as any)[row.key] = row.value; // handles timeRangeTarget, contractAddress, secretName, tradingAlgorithm
    }
  });

  // 2. Fetch accounts
  const { results: accRows } = await db.prepare("SELECT * FROM accounts ORDER BY type, id LIMIT 100").all();
  const internalAccs = accRows?.filter((a: any) => a.type === 'internal').map((a: any) => ({
    id: a.id,
    wallet: "Derived Sub-Account",
    address: a.wallet_address,
    tag: a.tag,
    usdc: a.usdc_balance,
    sol: a.sol_balance,
    profit: a.profit_pnl,
    selected: false,
    mint: "Native SOL", wlt: 0, deposit: 0, usdcWithdraw: 0, wltWithdraw: 0
  })) || [];

  const outsiderAccs = accRows?.filter((a: any) => a.type === 'outsider').map((a: any) => ({
    id: a.id,
    address: a.wallet_address,
    tag: a.tag,
    usdc: a.usdc_balance,
    sol: a.sol_balance,
    profit: a.profit_pnl
  })) || [];

  // 3. Fetch trade logs
  const { results: logRows } = await db.prepare("SELECT * FROM trade_logs ORDER BY created_at DESC LIMIT 50").all();
  const logs = logRows?.map((l: any) => ({
    id: l.id,
    time: l.created_at,
    tag: l.symbol,
    address: l.wallet_address,
    action: l.action,
    amount: l.amount.toString(),
    status: l.status,
    txId: l.tx_signature || "pending"
  })) || [];

  return {
    settings,
    internalAccs,
    outsiderAccs,
    logs,
    stats: {
      price: 0, maPrice: 0, totalWlt: 1000000000, liqUsdc: 0, fdv: 0, totalOutsiders: outsiderAccs.length
    }
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret",
  "Access-Control-Max-Age": "86400",
};

// Configuration is loaded from D1 or ENV

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }
    
    // Authenticate non-webhook requests with the FRONTEND_TOKEN bearer token.
    // Set this secret via: wrangler secret put FRONTEND_TOKEN
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      const authHeader = request.headers.get("Authorization");
<<<<<<< HEAD
      if (!env.FRONTEND_TOKEN || authHeader !== `Bearer ${env.FRONTEND_TOKEN}`) {
=======
      if (authHeader !== `Bearer ${env.FRONTEND}`) {
>>>>>>> origin/main
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        });
      }
    }

    // Your existing request handling logic here
    const response = await handleRequest(request, env, ctx);

    // Add CORS headers to every response
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
        newHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }
};

async function handleRequest(request: Request, env: Env, ctx: any): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (!env.TRADINGBOT_DB) {
         return new Response(JSON.stringify({ error: "D1 Database binding 'TRADINGBOT_DB' is missing" }), {
           status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
         });
      }

      // --- DASHBOARD API ENDPOINTS ---
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const state = await getEngineStateFromD1(env.TRADINGBOT_DB);
        
        const envKey = state.settings.secretName;
        let rawKey = envKey && (env as any)[envKey] ? (env as any)[envKey] : null;

        if (!rawKey && envKey && (envKey.startsWith('[') || envKey.length > 30)) {
           rawKey = envKey;
        }
        if (!rawKey) {
           rawKey = env.BOT_SECRET_KEY || null;
        }
        
        state.settings.secretLoaded = !!rawKey;
        
        // Compute internal sub-accounts if secret is configured and missing from DB
        if (rawKey && state.internalAccs.length === 0) {
          try {
             const secretRaw = rawKey.trim();
             let secretKey = secretRaw.startsWith('[') ? new Uint8Array(JSON.parse(secretRaw)) : bs58.decode(secretRaw);
             
             if (secretKey) {
               const primaryWallet = Keypair.fromSecretKey(secretKey);
               const seed = primaryWallet.secretKey.slice(0, 32);
               
               for (let i = 0; i < 5; i++) {
                  const data = new Uint8Array(seed.length + 1);
                  data.set(seed, 0);
                  data.set([i], seed.length);
                  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                  const hashArray = new Uint8Array(hashBuffer);
                  const k = Keypair.fromSeed(hashArray.slice(0, 32));
                  await env.TRADINGBOT_DB.prepare("INSERT OR IGNORE INTO accounts (id, type, wallet_address, tag) VALUES (?, ?, ?, ?)")
                    .bind(`int-${i}`, 'internal', k.publicKey.toBase58(), `Trading Bot #${i + 1}`)
                    .run();
               }
               // Refresh state after inserting
               const refreshed = await getEngineStateFromD1(env.TRADINGBOT_DB);
               state.internalAccs = refreshed.internalAccs;
             }
          } catch(e) {
             console.error("Error generating sub-accounts", e);
          }
        }

        return new Response(JSON.stringify(state), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      if (url.pathname === '/api/settings' && request.method === 'POST') {
        try {
          const body: any = await request.json();
          const stmts = [];
          
          if (body.volatilityTarget) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('volatilityTarget', ?)").bind(parseFloat(body.volatilityTarget) / 100));
          }
          if (body.pullbackTarget) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pullbackTarget', ?)").bind(parseFloat(body.pullbackTarget) / 100));
          }
          if (body.contractAddress !== undefined) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('contractAddress', ?)").bind(body.contractAddress));
          }
          if (body.secretName !== undefined) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('secretName', ?)").bind(body.secretName));
          }
          if (body.volumeTarget !== undefined) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('volumeTarget', ?)").bind(body.volumeTarget));
          }
          if (body.netBuyinTarget !== undefined) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('netBuyinTarget', ?)").bind(body.netBuyinTarget));
          }
          if (body.timeRangeTarget !== undefined) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('timeRangeTarget', ?)").bind(body.timeRangeTarget));
          }
          if (body.maxTransactions !== undefined) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('maxTransactions', ?)").bind(body.maxTransactions));
          }
          if (body.maxSlippage !== undefined) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('maxSlippage', ?)").bind(body.maxSlippage));
          }
          if (body.tradingAlgorithm !== undefined) {
             stmts.push(env.TRADINGBOT_DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tradingAlgorithm', ?)").bind(body.tradingAlgorithm));
          }
          
          if (stmts.length > 0) {
             await env.TRADINGBOT_DB.batch(stmts);
          }

          return new Response(JSON.stringify({ success: true }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        } catch (e) {
          return new Response('Invalid JSON', { status: 400, headers: corsHeaders });
        }
      }

      if (url.pathname === '/api/trade' && request.method === 'POST') {
        // Real on-chain trade execution is not yet implemented.
        // Returning 501 instead of pretending success with mock data.
        // TODO: Implement signed transaction building and submission via Solana RPC.
        return new Response(
          JSON.stringify({
            success: false,
            error: "Trade execution is not yet implemented. Configure your trading strategy and ensure BOT_SECRET_KEY is set to enable real on-chain execution.",
            code: "NOT_IMPLEMENTED"
          }),
          { status: 501, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // --- HELIUS WEBHOOK RECEIVER ---
      if (url.pathname === '/webhook' && request.method === 'POST') {
        try {
          const payload: any[] = await request.json();
          const response = new Response('Webhook received', { status: 200, headers: corsHeaders });
          
          // Log Webhook to D1 immediately
          await env.TRADINGBOT_DB.prepare("INSERT INTO signals (id, source, event_type, payload) VALUES (?, ?, ?, ?)")
            .bind(Date.now().toString() + Math.random().toString(36).slice(2), "helius", "SWAP", JSON.stringify(payload))
            .run();
            
          ctx.waitUntil(processTradingLogic(payload, env));
          return response;
        } catch (e) {
          console.error(e);
          return new Response('Bad Request', { status: 400, headers: corsHeaders });
        }
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (err: any) {
      console.error(err);
      return new Response(JSON.stringify({ error: err.message }), { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }
}

async function processTradingLogic(txs: any[], env: Env) {
  const state = await getEngineStateFromD1(env.TRADINGBOT_DB);
  const envKey = state.settings.secretName;
  let rawKey: string | null = envKey && (env as any)[envKey] ? (env as any)[envKey] : null;
  if (!rawKey && envKey && (envKey.startsWith('[') || envKey.length > 30)) {
     rawKey = envKey;
  }
  if (!rawKey) {
     rawKey = env.BOT_SECRET_KEY || null;
  }

  // Loop through all transactions provided in this webhook batch
  for (const tx of txs) {
    console.log(`Processing Tx: ${tx.signature}`);
    const nativeInputAmount = tx?.events?.swap?.nativeInput?.amount;
    
    if (nativeInputAmount > 1000000000) { 
      console.log('Whale Buy Detected (>1 SOL). On-chain execution not yet implemented.');
      // TODO: Implement signed transaction building and submission.
      // The bot keypair can be loaded below once trade execution logic is ready.
      if (rawKey) {
        try {
          const secretRaw = rawKey.trim();
          const secretKey = secretRaw.startsWith('[') ? Uint8Array.from(JSON.parse(secretRaw)) : bs58.decode(secretRaw);
          const _botKeypair = Keypair.fromSecretKey(secretKey);
          // Use _botKeypair and env.RPC_URL to build and submit a VersionedTransaction.
          void _botKeypair; // suppress unused variable warning until implemented
        } catch(e) {
          console.error("Invalid BOT_SECRET_KEY in Worker ENV");
        }
      } else {
        console.warn("BOT_SECRET_KEY not configured; skipping trade.");
      }
    }
  }
}
