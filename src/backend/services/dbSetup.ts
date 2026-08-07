import { dbEnsureSchema, dbEnsureTradeDomainSchema } from '../workerSchema';
import type { Env } from '../workerShared';

let isDbInitialized = false;

export async function initializeAllSchemas(env: Env): Promise<void> {
  if (isDbInitialized) {
    return;
  }

  await dbEnsureSchema(env.TRADINGBOT_DB);
  await dbEnsureTradeDomainSchema(env.TRADINGBOT_DB);

  isDbInitialized = true;
}