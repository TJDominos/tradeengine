import assert from 'node:assert/strict';

import {
  deriveAlchemySignalsFromPayload,
  handleWebhookRoutes,
} from '../src/backend/api/webhookHandler';
import type { Env } from '../src/backend/workerShared';

const testContractAddress = 'So11111111111111111111111111111111111111112';
const signingKey = 'ack-regression-signing-key';

function createMockDb(userIds: number[]) {
  return {
    prepare(sql: string) {
      const stmt = {
        bind(..._args: unknown[]) {
          return stmt;
        },
        async all() {
          if (sql.includes('FROM settings')) {
            return {
              results: userIds.map((userId) => ({
                user_id: userId,
                value: testContractAddress,
              })),
            };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes('FROM settings')) {
            return userIds.length > 0
              ? { user_id: userIds[0], value: testContractAddress }
              : null;
          }
          if (sql.includes('FROM signals')) {
            return {
              id: 1,
              source: 'alchemy_notify:ack-regression:user:1',
              external_id: `evt-123:5R1x1111111111111111111111111111111111111111:0:${testContractAddress}`,
              event_type: 'ADDRESS_ACTIVITY:token',
              wallet_address: null,
              tx_signature: '5R1x1111111111111111111111111111111111111111',
              payload: '{}',
              details_json: null,
              processed: 1,
              processed_at: 1,
              error_message: null,
              retry_count: 0,
              created_at: 1,
            };
          }
          return { id: 1 };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;
}

const mockDb = createMockDb([1]);

const env = {
  ALCHEMY_WEBHOOK_SIGNING_KEY: signingKey,
  TRADINGBOT_DB: mockDb,
} as Env;

const backgroundTasks: Promise<unknown>[] = [];
const context = {
  waitUntil(task: Promise<unknown>) {
    backgroundTasks.push(task);
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

const validBody = JSON.stringify({
  webhookId: 'ack-regression',
  id: 'evt-123',
  type: 'ADDRESS_ACTIVITY',
  event: {
    activity: {
      category: 'token',
      hash: '5R1x1111111111111111111111111111111111111111',
      rawContract: { address: testContractAddress },
    },
  },
});

const parsedSignals = deriveAlchemySignalsFromPayload(
  JSON.parse(validBody),
  testContractAddress,
);
assert.equal(parsedSignals.length, 1, 'Single-object activity payloads must produce a signal');
assert.equal(
  parsedSignals[0]?.txSignature,
  '5R1x1111111111111111111111111111111111111111',
  'Single-object activity payloads must preserve the transaction signature',
);

const hmacKey = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(signingKey),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign'],
);
const validSignature = Buffer.from(
  await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(validBody)),
).toString('hex');

// 1. Check valid signature & active token -> HTTP 200
const validResponse = await handleWebhookRoutes(
  new Request(`https://example.com/api/webhooks/alchemy/notify?contractAddress=${testContractAddress}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-alchemy-signature': validSignature,
    },
    body: validBody,
  }),
  env,
  context,
);

assert.ok(validResponse, 'Webhook route should return a response');
assert.equal(validResponse.status, 200, 'Valid webhooks must return HTTP 200');
const validJson = await validResponse.json<{ ok: boolean; routedTargets: number }>();
assert.equal(validJson.ok, true);
assert.deepEqual(validJson, { ok: true, accepted: true });
assert.equal(backgroundTasks.length, 1, 'Valid webhook processing must run in waitUntil');
await Promise.all(backgroundTasks.splice(0));

// 2. Check invalid HMAC signature -> HTTP 401 Error (not 200)
try {
  await handleWebhookRoutes(
    new Request('https://example.com/api/webhooks/alchemy/notify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-alchemy-signature': 'invalid-signature-hex',
      },
      body: validBody,
    }),
    env,
    context,
  );
  assert.fail('Invalid signature should throw ApiError(401)');
} catch (err: unknown) {
  assert.equal((err as { status?: number }).status, 401, 'Invalid signature must yield HTTP 401');
}

// 3. Check invalid JSON body with valid signature -> HTTP 400 Error
const badJsonBody = 'not-a-json';
const badJsonSignature = Buffer.from(
  await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(badJsonBody)),
).toString('hex');

try {
  await handleWebhookRoutes(
    new Request('https://example.com/api/webhooks/alchemy/notify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-alchemy-signature': badJsonSignature,
      },
      body: badJsonBody,
    }),
    env,
    context,
  );
  assert.fail('Invalid JSON body should throw ApiError(400)');
} catch (err: unknown) {
  assert.equal((err as { status?: number }).status, 400, 'Invalid JSON body must yield HTTP 400');
}

// 4. Valid deliveries are acknowledged even when no active target is found later.
const unroutedDb = createMockDb([]);

const unroutedEnv = {
  ...env,
  TRADINGBOT_DB: unroutedDb,
};

const unroutedResponse = await handleWebhookRoutes(
  new Request(`https://example.com/api/webhooks/alchemy/notify?contractAddress=${testContractAddress}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-alchemy-signature': validSignature,
    },
    body: validBody,
  }),
  unroutedEnv,
  context,
);
assert.equal(unroutedResponse?.status, 200);
await Promise.all(backgroundTasks.splice(0));

console.log('Webhook synchronous error and acknowledgement check passed.');

console.log('Streaming webhook acknowledgement regression check passed.');
