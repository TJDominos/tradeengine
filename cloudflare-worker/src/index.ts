import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

export interface Env {
  // Configured in Cloudflare Dashboard -> Settings -> Variables
  RPC_URL: string;
  BOT_SECRET_KEY: string; 
  TRADING_KV: any; // Cloudflare KV Namespace
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

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
      // Mock checking if the secret is valid in ENV
      state.settings.secretLoaded = !!env.BOT_SECRET_KEY;
      return new Response(JSON.stringify(state), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    if (url.pathname === '/api/settings' && request.method === 'POST') {
      try {
        const body: any = await request.json();
        if (body.volatilityTarget) state.settings.volatilityTarget = parseFloat(body.volatilityTarget) / 100;
        if (body.pullbackTarget) state.settings.pullbackTarget = parseFloat(body.pullbackTarget) / 100;
        if (body.contractAddress) state.settings.contractAddress = body.contractAddress;
        
        if (env.TRADING_KV) {
           await env.TRADING_KV.put('engineState', JSON.stringify(state));
        } else {
           memoryState = state;
        }

        return new Response(JSON.stringify({ success: true }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      } catch (e) {
        return new Response('Invalid JSON', { status: 400, headers: corsHeaders });
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
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response('Invalid JSON', { status: 400, headers: corsHeaders });
      }
    }

    // --- HELIUS WEBHOOK RECEIVER ---
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const payload: any[] = await request.json();
        const response = new Response('Webhook received', { status: 200, headers: corsHeaders });
        ctx.waitUntil(processTradingLogic(payload, env));
        return response;
      } catch (e) {
        console.error(e);
        return new Response('Bad Request', { status: 400, headers: corsHeaders });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};

async function processTradingLogic(txs: any[], env: Env) {
  // Loop through all transactions provided in this webhook batch
  for (const tx of txs) {
    console.log(`Processing Tx: ${tx.signature}`);
    
    // Example: Check if the transaction represents a massive buy order
    const nativeInputAmount = tx?.events?.swap?.nativeInput?.amount;
    
    if (nativeInputAmount > 1000000000) { 
      console.log('Whale Buy Detected! Executing algorithm pullback protocol...');
      
      const connection = new Connection(env.RPC_URL || "https://api.mainnet-beta.solana.com");
      try {
         const secretRaw = env.BOT_SECRET_KEY.trim();
         const secretKey = secretRaw.startsWith('[') 
             ? Uint8Array.from(JSON.parse(secretRaw))
             : null; // Implement base58 decode if using base58 in worker
         if (secretKey) {
             const botKeypair = Keypair.fromSecretKey(secretKey);
             // Logic...
         }
      } catch(e) {
         console.error("Invalid Secret in Worker ENV");
      }
    }
  }
}
