import assert from 'node:assert/strict';

import { handleWebhookRoutes } from '../src/backend/api/webhookHandler';
import type { Env } from '../src/backend/workerShared';

const backgroundTasks: Promise<unknown>[] = [];
const signingKey = 'ack-regression-signing-key';
const rawBody = JSON.stringify({ webhookId: 'ack-regression', event: {} });
const hmacKey = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(signingKey),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign'],
);
const signature = Buffer.from(
  await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(rawBody)),
).toString('hex');
const context = {
  waitUntil(task: Promise<unknown>) {
    backgroundTasks.push(task);
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

const response = await handleWebhookRoutes(
  new Request('https://example.com/api/webhooks/alchemy/notify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-alchemy-signature': signature,
    },
    body: rawBody,
  }),
  { ALCHEMY_WEBHOOK_SIGNING_KEY: signingKey } as Env,
  context,
);

assert.ok(response, 'Alchemy webhook route should return a response');
assert.equal(response.status, 200, 'received Alchemy events must be acknowledged with HTTP 200');
assert.deepEqual(await response.json(), { ok: true, accepted: true });
assert.equal(backgroundTasks.length, 1, 'event processing should be scheduled in the background');
await Promise.all(backgroundTasks);

console.log('Webhook acknowledgement regression check passed.');

let closeBody: (() => void) | undefined;
const streamingBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(rawBody));
    closeBody = () => controller.close();
  },
});
const streamingBackgroundTasks: Promise<unknown>[] = [];
const streamingContext = {
  waitUntil(task: Promise<unknown>) {
    streamingBackgroundTasks.push(task);
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;
const streamingResponsePromise = handleWebhookRoutes(
  new Request('https://example.com/api/webhooks/alchemy/notify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-alchemy-signature': signature,
    },
    body: streamingBody,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' }),
  { ALCHEMY_WEBHOOK_SIGNING_KEY: signingKey } as Env,
  streamingContext,
);
const acknowledgementResult = await Promise.race([
  streamingResponsePromise.then(() => 'acknowledged' as const),
  new Promise<'timed-out'>((resolve) => {
    setTimeout(() => resolve('timed-out'), 50);
  }),
]);
closeBody?.();
const streamingResponse = await streamingResponsePromise;

assert.equal(
  acknowledgementResult,
  'acknowledged',
  'Alchemy webhook acknowledgement must not wait for the complete request body',
);
assert.equal(streamingResponse?.status, 200);
await Promise.all(streamingBackgroundTasks);

console.log('Streaming webhook acknowledgement regression check passed.');
