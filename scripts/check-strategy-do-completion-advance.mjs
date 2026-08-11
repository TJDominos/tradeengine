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
const persistDir = mkdtempSync(path.join(tmpdir(), 'tradeengine-do-complete-'));
const contractAddress = 'So11111111111111111111111111111111111111112';
const walletAddress = contractAddress;

let port = 0;
let inspectorPort = 0;
let baseUrl = '';
let workerProcess;

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

async function stopWorkerProcess(childProcess) {
  if (!childProcess) {
    return;
  }

  const waitForExit = async (timeoutMs) => {
    if (childProcess.exitCode != null || childProcess.signalCode != null) {
      return;
    }
    try {
      await Promise.race([once(childProcess, 'exit'), wait(timeoutMs)]);
    } catch {
      // ignore
    }
  };

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(childProcess.pid), '/t', '/f'], {
        stdio: 'ignore',
      });
    } catch {
      // ignore
    }
  } else if (childProcess.pid != null) {
    try {
      process.kill(-childProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  await waitForExit(5000);

  if (childProcess.exitCode == null && childProcess.signalCode == null) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(childProcess.pid), '/t', '/f'], {
          stdio: 'ignore',
        });
      } catch {
        // ignore
      }
    } else if (childProcess.pid != null) {
      try {
        process.kill(-childProcess.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }

    await waitForExit(2000);
  }

  childProcess.stdout?.destroy();
  childProcess.stderr?.destroy();
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

async function simulateActiveStrategy(authHeaders, body) {
  const { payload } = await requestJson('/api/debug/strategy/current/simulate', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
  });
  return payload;
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
      requireCompleteMetrics: false,
    },
    execution: {
      enabled: true,
      route: 'jupiter',
      commitment: 'confirmed',
      timeJitterRatio: 0,
      volumeJitterRatio: 0,
      macroObjective: 'distribution',
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
    `INSERT INTO tradable_tokens (
      network, contract_address, base_token_address,
       symbol, name, decimals, is_active, created_at
     ) VALUES (
      'solana', ${toSqlString(contractAddress)}, ${toSqlString(contractAddress)},
       'SOL', 'Wrapped SOL', 9, 1, strftime('%s','now')
     )`,
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
      detached: process.platform !== 'win32',
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
    body: JSON.stringify({ username: 'ci-admin-complete', password: 'ci-password-123' }),
  });
  const sessionCookie = bootstrap.response.headers.get('set-cookie');
  assert.ok(sessionCookie, 'bootstrap should set a session cookie');

  const authHeaders = { Cookie: sessionCookie };

  runWranglerJson([
    'execute',
    'tradingbot',
    '--local',
    '--persist-to',
    persistDir,
    '--command',
    `INSERT INTO accounts (
       user_id, type, label, wallet_address, created_at, is_active,
       capability_base_mint, capability_quote_mint,
       wallet_usdc_balance, wallet_sol_balance,
       wallet_active_token_mint, wallet_active_token_balance, wallet_balance_updated_at
     ) SELECT id, 'managed', 'CI Managed', ${toSqlString(walletAddress)}, strftime('%s','now'), 1,
              ${toSqlString(contractAddress)}, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              1000, 1, ${toSqlString(contractAddress)}, 1000, strftime('%s','now') * 1000
       FROM users WHERE username = 'ci-admin-complete';
     INSERT INTO token_market_snapshots (
       token_id, network, contract_address, base_token_address, price_usd, fetched_at
     ) SELECT id, network, ${toSqlString(contractAddress)}, ${toSqlString(contractAddress)}, 1, strftime('%s','now') * 1000
       FROM tradable_tokens WHERE base_token_address = ${toSqlString(contractAddress)}`,
  ]);

  const firstActivation = await requestJson('/api/strategy/active', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(buildStrategyDocument('ci-do-complete-1', 2)),
  });
  const firstQueueVersionId = firstActivation.payload.queuedStrategy?.versionId;
  assert.ok(firstQueueVersionId, 'first strategy should be queued');

  await simulateActiveStrategy(authHeaders, {
    action: 'hold',
    clearPendingTasks: true,
  });

  const secondActivation = await requestJson('/api/strategy/active', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(buildStrategyDocument('ci-do-complete-2', 9)),
  });
  const secondQueueVersionId = secondActivation.payload.queuedStrategy?.versionId;
  assert.ok(secondQueueVersionId, 'second strategy should be queued');

  const activeFirst = await waitFor(
    async () => {
      const { payload } = await requestJson('/api/strategy/current', {
        method: 'GET',
        headers: authHeaders,
      });
      if (payload.active?.versionId === firstQueueVersionId) {
        return payload;
      }
      return null;
    },
    {
      timeoutMs: 20000,
      intervalMs: 500,
      timeoutMessage: 'Timed out waiting for the first queued strategy to become active',
    },
  );

  assert.equal(activeFirst.active.versionId, firstQueueVersionId);

  const completionTrigger = await requestJson('/api/webhook', {
    method: 'POST',
    body: JSON.stringify({
      type: 'whale_buy',
      amount: 40,
      contractAddress,
      txHash: `ci-complete-${Date.now()}`,
      wallet_address: walletAddress,
      is_loss_cut: false,
    }),
  });
  assert.equal(completionTrigger.payload.forwarded, true);

  await simulateActiveStrategy(authHeaders, {
    action: 'complete',
    executedVolumeUsd: 1,
    actualNetInflowUsd: 1,
    clearPendingTasks: true,
  });

  const completionSnapshot = await waitFor(
    async () => {
      const { payload } = await requestJson('/api/strategy/current', {
        method: 'GET',
        headers: authHeaders,
      });
      const completedEntry = payload.history?.find((entry) => entry.versionId === firstQueueVersionId);
      if (completedEntry?.status === 'completed' && payload.active?.versionId === secondQueueVersionId) {
        return payload;
      }
      return null;
    },
    {
      timeoutMs: 30000,
      intervalMs: 500,
      timeoutMessage: 'Timed out waiting for DO completion to promote the next pending strategy',
    },
  );

  const completedEntry = completionSnapshot.history.find((entry) => entry.versionId === firstQueueVersionId);
  assert.equal(completedEntry?.status, 'completed');
  assert.equal(completionSnapshot.active.versionId, secondQueueVersionId);
  assert.ok(
    (completedEntry?.report?.actualTotalVolume ?? 0) > 0,
    'completed strategy should persist a non-zero execution report volume',
  );

  console.log('Strategy DO completion/advance check passed. Completed runs auto-promote the next pending strategy.');
} finally {
  if (workerProcess) {
    await stopWorkerProcess(workerProcess);
  }
  rmSync(persistDir, { recursive: true, force: true });
}