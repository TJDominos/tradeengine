import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const migrationsDir = path.join(repoRoot, 'migrations');
const persistDir = mkdtempSync(path.join(tmpdir(), 'tradeengine-do-lifecycle-'));
const contractAddress = 'So11111111111111111111111111111111111111112';
const walletAddress = contractAddress;

let port = 0;
let inspectorPort = 0;
let baseUrl = '';

function normalizeWranglerArgs(args) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === '--command') {
      normalized.push(`--command=${args[index + 1] ?? ''}`);
      index += 1;
      continue;
    }
    normalized.push(current);
  }
  return normalized;
}

function runWrangler(args) {
  return execFileSync('npx', ['wrangler', 'd1', ...normalizeWranglerArgs(args)], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CI: '1',
    },
  });
}

function runWranglerJson(args) {
  return JSON.parse(runWrangler([...args, '--json']));
}

function toSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvailablePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate an ephemeral port');
  }
  const allocatedPort = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return allocatedPort;
}

async function waitFor(predicate, options) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await wait(options.intervalMs);
  }
  throw new Error(options.timeoutMessage);
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    ...options,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Request ${pathname} failed (${response.status}): ${text}`);
  }
  return { response, payload };
}

function buildStrategyDocument(note, volumeUsd) {
  return {
    schemaVersion: 1,
    engineVersion: '1.0.0',
    strategyType: 'solana-auto-trade',
    parameters: {
      contractAddress,
      timeRangeTarget: '1h',
      maxTransactions: 12,
      maxSlippageBps: 100,
      notes: note,
    },
    triggers: {
      sources: ['alchemy_notify', 'manual_refresh'],
      eventTypes: ['*'],
      cooldownMs: 500,
      idempotencyWindowMs: 30000,
      onExternalBuy: 'watch_and_wait',
      onExternalSell: 'pause_strategy',
      triggerThresholdUsd: 0,
    },
    targets: {
      volumeUsdMin: volumeUsd,
      netBuyinUsdMin: 0,
      volatilityPctMin: 0,
      pullbackPctMax: 0,
    },
    riskControls: {
      maxPositionUsd: volumeUsd,
      maxDailyLossUsd: null,
      maxConcurrentOrders: 1,
      dryRun: false,
      requireCompleteMetrics: false,
    },
    execution: {
      enabled: true,
      route: 'jupiter',
      commitment: 'confirmed',
      timeJitterRatio: 0,
      volumeJitterRatio: 0,
      macroObjective: 'shakeout',
      tactics: {
        dumpRatio: 1.2,
        followSellRatio: 0.8,
        absorbRatio: 1,
      },
    },
    metadata: {
      author: 'ci',
      changeNote: note,
      origin: 'manual',
      legacySettingsSnapshot: {},
    },
  };
}

let workerProcess;

try {
  port = await getAvailablePort();
  inspectorPort = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const migrationFiles = readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  for (const migrationFile of migrationFiles) {
    const migrationSql = readFileSync(path.join(migrationsDir, migrationFile), 'utf8');
    runWranglerJson([
      'execute',
      'tradingbot',
      '--local',
      '--persist-to',
      persistDir,
      '--command',
      migrationSql,
    ]);
  }

  runWranglerJson([
    'execute',
    'tradingbot',
    '--local',
    '--persist-to',
    persistDir,
    '--command',
    `INSERT INTO tradable_tokens (network, contract_address, symbol, name, decimals, is_active, created_at)
     VALUES ('solana', ${toSqlString(contractAddress)}, 'SOL', 'Wrapped SOL', 9, 1, strftime('%s','now'))`,
  ]);

  workerProcess = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
      '--local-protocol',
      'http',
      '--persist-to',
      persistDir,
      '--log-level',
      'error',
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let workerLogs = '';
  workerProcess.stdout.on('data', (chunk) => {
    workerLogs += chunk.toString();
  });
  workerProcess.stderr.on('data', (chunk) => {
    workerLogs += chunk.toString();
  });

  await waitFor(
    async () => {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
    {
      timeoutMs: 30000,
      intervalMs: 500,
      timeoutMessage: `Local worker did not become ready. Logs:\n${workerLogs}`,
    },
  );

  const bootstrap = await requestJson('/api/auth/bootstrap', {
    method: 'POST',
    body: JSON.stringify({ username: 'ci-admin', password: 'ci-password-123' }),
  });
  const sessionCookie = bootstrap.response.headers.get('set-cookie');
  assert.ok(sessionCookie, 'bootstrap should set a session cookie');

  const authHeaders = {
    Cookie: sessionCookie,
  };

  const firstActivation = await requestJson('/api/strategy/active', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(buildStrategyDocument('ci-do-lifecycle-1', 12)),
  });
  assert.ok(firstActivation.payload.queuedStrategy?.versionId, 'first activation should enqueue strategy');
  const firstQueueVersionId = firstActivation.payload.queuedStrategy.versionId;

  const secondActivation = await requestJson('/api/strategy/active', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(buildStrategyDocument('ci-do-lifecycle-2', 18)),
  });
  assert.ok(secondActivation.payload.queuedStrategy?.versionId, 'second activation should enqueue strategy');
  const secondQueueVersionId = secondActivation.payload.queuedStrategy.versionId;
  assert.notEqual(firstQueueVersionId, secondQueueVersionId, 'queued strategies should be distinct');

  const runningSnapshot = await waitFor(
    async () => {
      const { payload } = await requestJson('/api/strategy/current', {
        method: 'GET',
        headers: authHeaders,
      });
      if (payload.active?.versionId === firstQueueVersionId && payload.currentMetrics) {
        return payload;
      }
      return null;
    },
    {
      timeoutMs: 30000,
      intervalMs: 500,
      timeoutMessage: 'Timed out waiting for first queued strategy to become active',
    },
  );

  const progressedSnapshot = await waitFor(
    async () => {
      const { payload } = await requestJson('/api/strategy/current', {
        method: 'GET',
        headers: authHeaders,
      });
      if ((payload.currentMetrics?.actualTotalVolume ?? 0) > 0) {
        return payload;
      }
      return null;
    },
    {
      timeoutMs: 30000,
      intervalMs: 500,
      timeoutMessage: 'Timed out waiting for DO alarm loop to produce live metrics',
    },
  );

  assert.ok(
    progressedSnapshot.currentMetrics.actualTotalVolume > 0,
    'DO metrics should reflect executed TWAP volume',
  );

  const webhookResponse = await requestJson('/api/webhook', {
    method: 'POST',
    body: JSON.stringify({
      type: 'whale_buy',
      amount: 25,
      contractAddress,
      txHash: `ci-tx-${Date.now()}`,
      wallet_address: walletAddress,
      is_loss_cut: false,
    }),
  });
  assert.equal(webhookResponse.payload.forwarded, true, 'webhook should forward the event to the active DO');
  assert.equal(webhookResponse.payload.duplicate, false, 'fresh webhook event should not be treated as a duplicate');

  const abortResponse = await requestJson('/api/strategy/abort', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ reason: 'CI lifecycle abort' }),
  });
  assert.equal(abortResponse.payload.report?.abortReason, 'CI lifecycle abort');

  const pausedSnapshot = await waitFor(
    async () => {
      const { payload } = await requestJson('/api/strategy/current', {
        method: 'GET',
        headers: authHeaders,
      });
      const abortedEntry = payload.history?.find((entry) => entry.versionId === firstQueueVersionId);
      if (payload.active == null && payload.paused === true && abortedEntry?.status === 'aborted') {
        return payload;
      }
      return null;
    },
    {
      timeoutMs: 30000,
      intervalMs: 500,
      timeoutMessage: 'Timed out waiting for aborted strategy to move into paused history state',
    },
  );

  assert.ok(
    pausedSnapshot.pending.some((entry) => entry.versionId === secondQueueVersionId),
    'second strategy should remain pending after abort pauses the queue',
  );

  const resumeResponse = await requestJson('/api/strategy/resume', {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(resumeResponse.payload.started, true, 'resume should start the next queued strategy');

  const resumedSnapshot = await waitFor(
    async () => {
      const { payload } = await requestJson('/api/strategy/current', {
        method: 'GET',
        headers: authHeaders,
      });
      if (payload.active?.versionId === secondQueueVersionId && payload.paused === false) {
        return payload;
      }
      return null;
    },
    {
      timeoutMs: 30000,
      intervalMs: 500,
      timeoutMessage: 'Timed out waiting for resumed queue to promote the second strategy',
    },
  );

  assert.equal(resumedSnapshot.active.versionId, secondQueueVersionId);
  console.log('Strategy DO lifecycle check passed. Start, metrics, webhook, abort, and resume all succeeded.');
} finally {
  if (workerProcess) {
    workerProcess.kill('SIGTERM');
    try {
      await Promise.race([
        once(workerProcess, 'exit'),
        wait(5000),
      ]);
    } catch {
      // ignore
    }
    if (!workerProcess.killed) {
      workerProcess.kill('SIGKILL');
    }
  }
  rmSync(persistDir, { recursive: true, force: true });
}