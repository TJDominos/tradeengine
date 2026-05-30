import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

export interface Env {
  // Configured in Cloudflare Dashboard -> Settings -> Variables
  RPC_URL: string;
  BOT_SECRET_KEY: string; 
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    // 1. Verify it's a POST request (Helius Webhook)
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      // 2. Parse the payload pushed by Helius
      const payload: any[] = await request.json();

      // 3. Instantly return a 200 OK so Helius knows we received it
      // We will perform the heavy trading logic in the background!
      const response = new Response('Webhook received', { status: 200 });

      // 4. Use ctx.waitUntil to process the trade asynchronously without making Helius wait
      ctx.waitUntil(processTradingLogic(payload, env));

      return response;

    } catch (e) {
      console.error(e);
      return new Response('Bad Request', { status: 400 });
    }
  }
};

async function processTradingLogic(txs: any[], env: Env) {
  // Loop through all transactions provided in this webhook batch
  for (const tx of txs) {
    console.log(`Processing Tx: ${tx.signature}`);
    
    // Example: Check if the transaction represents a massive buy order
    // Helius parses token transfers safely for you to inspect 
    const nativeInputAmount = tx?.events?.swap?.nativeInput?.amount;
    
    if (nativeInputAmount > 1000000000) { // e.g. > 1000 USDC (6 decimals)
      console.log('Whale Buy Detected! Executing algorithm pullback protocol...');
      
      const connection = new Connection(env.RPC_URL);
      const secretKey = Uint8Array.from(JSON.parse(env.BOT_SECRET_KEY));
      const botKeypair = Keypair.fromSecretKey(secretKey);

      // Build & Send the transaction using your standard Logic here
      // ...
    }
  }
}
