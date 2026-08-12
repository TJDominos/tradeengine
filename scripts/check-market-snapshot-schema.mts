import assert from 'node:assert/strict';

import { dbInsertTokenMarketSnapshot } from '../src/backend/tokenStore';
import type { TokenMarketSnapshot } from '../src/backend/workerShared';

const baseTokenAddress = 'So11111111111111111111111111111111111111112';
const snapshot: TokenMarketSnapshot = {
  network: 'solana',
  baseTokenAddress,
  tokenName: 'Wrapped SOL',
  tokenSymbol: 'SOL',
  priceUsd: 150,
  liquidityUsd: 1_000_000,
  fdv: 2_000_000,
  volume24h: 100_000,
  totalTransactions24h: 500,
  totalHolders: 250,
  outsidersOverOneUsd: 200,
  dexId: 'test-dex',
  pairAddress: 'test-pair',
  fetchedAt: 1_700_000_000_000,
};

function createDb(hasLegacyContractAddress: boolean): {
  db: D1Database;
  getInsert: () => { sql: string; bindings: unknown[] };
} {
  let insert: { sql: string; bindings: unknown[] } | undefined;
  const db = {
    prepare(sql: string) {
      if (sql.startsWith('PRAGMA table_info')) {
        return {
          all: async () => ({
            results: [
              { name: 'base_token_address' },
              ...(hasLegacyContractAddress ? [{ name: 'contract_address' }] : []),
            ],
          }),
        };
      }
      return {
        bind(...bindings: unknown[]) {
          insert = { sql, bindings };
          return { run: async () => ({ success: true }) };
        },
      };
    },
  } as unknown as D1Database;
  return {
    db,
    getInsert: () => {
      assert.ok(insert, 'Expected a market snapshot insert');
      return insert;
    },
  };
}

const legacy = createDb(true);
await dbInsertTokenMarketSnapshot(legacy.db, 7, snapshot);
assert.match(legacy.getInsert().sql, /contract_address, base_token_address/);
assert.match(legacy.getInsert().sql, /VALUES \(\?1, \?2, \?3, \?3,/);
assert.equal(legacy.getInsert().bindings[2], baseTokenAddress);

const canonical = createDb(false);
await dbInsertTokenMarketSnapshot(canonical.db, 7, snapshot);
assert.doesNotMatch(canonical.getInsert().sql, /contract_address/);
assert.match(canonical.getInsert().sql, /VALUES \(\?1, \?2, \?3, \?4,/);
assert.equal(canonical.getInsert().bindings[2], baseTokenAddress);

console.log('Market snapshot schema compatibility checks passed.');