import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export interface Env {
  // Configured in Cloudflare Dashboard -> Settings -> Variables
  RPC_URL: string;
  BOT_SECRET_KEY: string; 
  PVK3: string;
  Frontend: string;
  TRADING_KV: any; // Cloudflare KV Namespace
}

const corsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Max-Age": "86400",
});

function handleOptions(request: Request) {
  const headers = request.headers;
  if (
    headers.get("Origin") !== null &&
    headers.get("Access-Control-Request-Method") !== null &&
    headers.get("Access-Control-Request-Headers") !== null
  ) {
    return new Response(null, { headers: corsHeaders(headers.get("Origin")) });
  }
  return new Response(null, { headers: { Allow: "GET,HEAD,POST,PUT,DELETE,OPTIONS" } });
}

// Stateless mock of the state for the worker (in a real app, use Cloudflare KV or D1)
let memoryState: any = {
  settings: {
    volatilityTarget: 0.045,
    pullbackTarget: 0.02,
    netBuyinTarget: 50000,
    secretLoaded: false,
    secretName: 'Loaded via Cloudflare ENV',
    contractAddress: ""
  },
  internalAccs: [],
  outsiderAccs: [],
  logs: [],
  stats: {
    price: 0,
    maPrice: 0,
    totalWlt: 1000000000,
    liqUsdc: 0,
    fdv: 0,
    totalOutsiders: 0
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }
    
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.Frontend}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
          },
        });
      }
    }

    // Your existing request handling logic here
    const response = await handleRequest(request, env, ctx);

    // Add CORS headers to every response
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", request.headers.get("Origin") || "*");
    newHeaders.append("Vary", "Origin");

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

      // Load from KV if available, else use memory mock
      let state = memoryState;
      if (env.TRADING_KV) {
        const storedState = await env.TRADING_KV.get('engineState', 'json');
        if (storedState) {
          state = { ...memoryState, ...storedState };
        }
      }

      // --- DASHBOARD API ENDPOINTS ---
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const envKey = state.settings.secretName;
        // If the secretName matches an ENV key
        let rawKey = envKey && (env as any)[envKey] ? (env as any)[envKey] : null;

        if (!rawKey && envKey && (envKey.startsWith('[') || envKey.length > 30)) {
           // If the user pasted the actual key or array
           rawKey = envKey;
        }
        if (!rawKey) {
           // fallback
           rawKey = (env as any).PVK3 || (env as any).BOT_SECRET_KEY;
        }
        
        state.settings.secretLoaded = !!rawKey;
        
        // Compute internal sub-accounts if secret is configured and not yet parsed
        if (rawKey && state.internalAccs.length === 0) {
          try {
             const secretRaw = rawKey.trim();
             let secretKey;
             if (secretRaw.startsWith('[')) {
               secretKey = new Uint8Array(JSON.parse(secretRaw));
             } else {
               secretKey = bs58.decode(secretRaw);
             }
             
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
                  state.internalAccs.push({
                      id: `int-${i}`,
                      wallet: "Derived Sub-Account",
                      address: k.publicKey.toBase58(),
                      mint: "Native SOL",
                      tag: `Trading Bot #${i + 1}`,
                      usdc: 0, 
                      sol: 0, 
                      wlt: 0, 
                      deposit: 0,
                      profit: 0,
                      usdcWithdraw: 0,
                      wltWithdraw: 0,
                      selected: false 
                  });
               }
             }
          } catch(e) {
             console.error("Error generating sub-accounts", e);
          }
        }

        return new Response(JSON.stringify(state), { 
          headers: { ...corsHeaders(request.headers.get("Origin")), 'Content-Type': 'application/json' } 
        });
      }

      if (url.pathname === '/api/settings' && request.method === 'POST') {
        try {
          const body: any = await request.json();
          if (body.volatilityTarget) state.settings.volatilityTarget = parseFloat(body.volatilityTarget) / 100;
          if (body.pullbackTarget) state.settings.pullbackTarget = parseFloat(body.pullbackTarget) / 100;
          if (body.contractAddress) state.settings.contractAddress = body.contractAddress;
          if (body.secretName) state.settings.secretName = body.secretName;

          if (env.TRADING_KV) {
             await env.TRADING_KV.put('engineState', JSON.stringify(state));
          } else {
             memoryState = state;
          }

          return new Response(JSON.stringify({ success: true }), { 
            headers: { ...corsHeaders(request.headers.get("Origin")), 'Content-Type': 'application/json' } 
          });
        } catch (e) {
          return new Response('Invalid JSON', { status: 400, headers: corsHeaders(request.headers.get("Origin")) });
        }
      }

      if (url.pathname === '/api/trade' && request.method === 'POST') {
        try {
          const body: any = await request.json();
          console.log("Trade Request Received:", body);
          
          // Log the transaction
          const newLog = {
            id: Date.now().toString(),
            time: new Date().toISOString().split('T')[1].slice(0, 8),
            tag: body.symbol || "Unknown",
            address: "Worker API Test",
            action: body.action || "Trade",
            amount: "N/A",
            status: "Success",
            txId: "local-" + Math.random().toString(36).substring(7)
          };
          
          state.logs.unshift(newLog);
          if (state.logs.length > 50) state.logs.pop(); // keep last 50
          
          if (env.TRADING_KV) {
             await env.TRADING_KV.put('engineState', JSON.stringify(state));
          } else {
             memoryState = state;
          }

          return new Response(JSON.stringify({ success: true, message: `Trade executed & logged for ${body.symbol}` }), {
            headers: { ...corsHeaders(request.headers.get("Origin")), 'Content-Type': 'application/json' }
          });
        } catch (e) {
          return new Response('Invalid JSON', { status: 400, headers: corsHeaders(request.headers.get("Origin")) });
        }
      }

      // --- HELIUS WEBHOOK RECEIVER ---
      if (url.pathname === '/webhook' && request.method === 'POST') {
        try {
          const payload: any[] = await request.json();
          const response = new Response('Webhook received', { status: 200, headers: corsHeaders(request.headers.get("Origin")) });
          ctx.waitUntil(processTradingLogic(payload, env));
          return response;
        } catch (e) {
          console.error(e);
          return new Response('Bad Request', { status: 400, headers: corsHeaders(request.headers.get("Origin")) });
        }
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders(request.headers.get("Origin")) });
    } catch (err: any) {
      console.error(err);
      return new Response(JSON.stringify({ error: err.message }), { 
        status: 500, 
        headers: { ...corsHeaders(request.headers.get("Origin")), 'Content-Type': 'application/json' } 
      });
    }
}

async function processTradingLogic(txs: any[], env: Env) {
  // Load from KV if available, else use memory mock
  let state = memoryState;
  if (env.TRADING_KV) {
    const storedState = await env.TRADING_KV.get('engineState', 'json');
    if (storedState) {
      state = { ...memoryState, ...storedState };
    }
  }

  const envKey = state.settings.secretName;
  let rawKey = envKey && (env as any)[envKey] ? (env as any)[envKey] : null;
  if (!rawKey && envKey && (envKey.startsWith('[') || envKey.length > 30)) {
     rawKey = envKey;
  }
  if (!rawKey) {
     rawKey = (env as any).PVK3 || (env as any).BOT_SECRET_KEY;
  }

  // Loop through all transactions provided in this webhook batch
  for (const tx of txs) {
    console.log(`Processing Tx: ${tx.signature}`);
    
    // Example: Check if the transaction represents a massive buy order
    const nativeInputAmount = tx?.events?.swap?.nativeInput?.amount;
    
    if (nativeInputAmount > 1000000000) { 
      console.log('Whale Buy Detected! Executing algorithm pullback protocol...');
      
      const connection = new Connection(env.RPC_URL || "https://api.mainnet-beta.solana.com");
      try {
         if (rawKey) {
             const secretRaw = rawKey.trim();
             const secretKey = secretRaw.startsWith('[') 
                 ? Uint8Array.from(JSON.parse(secretRaw))
                 : bs58.decode(secretRaw);
             if (secretKey) {
                 const botKeypair = Keypair.fromSecretKey(secretKey);
                 // Logic...
             }
         }
      } catch(e) {
         console.error("Invalid Secret in Worker ENV");
      }
    }
  }
}
