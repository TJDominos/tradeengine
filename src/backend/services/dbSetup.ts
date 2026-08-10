import { dbEnsureSchema, dbEnsureTradeDomainSchema } from '../workerSchema';
import type { Env } from '../workerShared';

let isCoreDbInitialized = false;
let coreDbInitializationPromise: Promise<void> | null = null;
let isTradeDbInitialized = false;
let tradeDbInitializationPromise: Promise<void> | null = null;

export async function initializeCoreSchemas(env: Env): Promise<void> {
  if (isCoreDbInitialized) {
    return;
  }

  if (!coreDbInitializationPromise) {
    coreDbInitializationPromise = dbEnsureSchema(env.TRADINGBOT_DB)
      .then(() => {
        isCoreDbInitialized = true;
      })
      .catch((err) => {
        coreDbInitializationPromise = null;
        throw err;
      });
  }

  await coreDbInitializationPromise;
}

export async function initializeAllSchemas(env: Env): Promise<void> {
  if (isTradeDbInitialized) {
    return;
  }

  if (!tradeDbInitializationPromise) {
    tradeDbInitializationPromise = initializeCoreSchemas(env)
      .then(() => dbEnsureTradeDomainSchema(env.TRADINGBOT_DB))
      .then(() => {
        isTradeDbInitialized = true;
      })
      .catch((err) => {
        tradeDbInitializationPromise = null;
        throw err;
      });
  }

  await tradeDbInitializationPromise;
}