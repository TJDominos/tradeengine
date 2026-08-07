import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const persistDir = mkdtempSync(path.join(tmpdir(), 'tradeengine-d1-queue-'));
const migrationsDir = path.join(repoRoot, 'migrations');

function runWrangler(args) {
  const normalizedArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === '--command') {
      normalizedArgs.push(`--command=${args[index + 1] ?? ''}`);
      index += 1;
      continue;
    }
    normalizedArgs.push(current);
  }

  return execFileSync('npx', ['wrangler', 'd1', ...normalizedArgs], {
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

function unwrapResults(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Unexpected wrangler JSON result payload');
  }
  return payload[0]?.results ?? [];
}

try {
  const migrationFiles = readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  for (const migrationFile of migrationFiles) {
    const migrationSql = readFileSync(
      path.join(migrationsDir, migrationFile),
      'utf8',
    );
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

  const seed = Date.now();
  const pendingVersionId = `recovery-pending-${seed}`;
  const abortedVersionId = `recovery-aborted-${seed}`;

  const pendingConfig = {
    userId: 777,
    strategyVersionId: 501,
    strategyVersionNo: 12,
    strategyType: 'solana-auto-trade',
    document: {
      parameters: {
        contractAddress: 'So11111111111111111111111111111111111111112',
      },
    },
    contractAddress: 'So11111111111111111111111111111111111111112',
    macroObjective: 'shakeout',
    tactics: {
      dumpRatio: 1.2,
      followSellRatio: 0.8,
      absorbRatio: 1,
    },
    execution: {
      enabled: true,
      route: 'jupiter',
      commitment: 'confirmed',
      timeJitterRatio: 0.15,
      volumeJitterRatio: 0.15,
      macroObjective: 'shakeout',
      tactics: {
        dumpRatio: 1.2,
        followSellRatio: 0.8,
        absorbRatio: 1,
      },
    },
    baseOrderCount: 6,
    baseTotalVolumeUsd: 1200,
    baseDurationMs: 3600000,
    distributionChunkCount: 3,
    distributionChunkDelayJitterMs: 2000,
  };

  const abortedConfig = {
    ...pendingConfig,
    strategyVersionId: 502,
    strategyVersionNo: 13,
    macroObjective: 'distribution',
  };

  const abortedReport = {
    actualTotalVolume: 480,
    actualNetInflow: -120,
    tacticsTriggeredCount: 2,
    pnl: -120,
    startTime: seed,
    endTime: seed + 180000,
    abortReason: 'recovery-test',
  };

  runWranglerJson([
    'execute',
    'tradingbot',
    '--local',
    '--persist-to',
    persistDir,
    '--command',
    `INSERT INTO strategies (version_id, status, config, report) VALUES (${toSqlString(pendingVersionId)}, 'pending', ${toSqlString(JSON.stringify(pendingConfig))}, NULL);` +
      `INSERT INTO strategies (version_id, status, config, report) VALUES (${toSqlString(abortedVersionId)}, 'aborted', ${toSqlString(JSON.stringify(abortedConfig))}, ${toSqlString(JSON.stringify(abortedReport))});`,
  ]);

  const rows = unwrapResults(
    runWranglerJson([
      'execute',
      'tradingbot',
      '--local',
      '--persist-to',
      persistDir,
      '--command',
      `SELECT version_id, status, config, report FROM strategies WHERE version_id IN (${toSqlString(pendingVersionId)}, ${toSqlString(abortedVersionId)}) ORDER BY version_id ASC`,
    ]),
  );

  assert.equal(rows.length, 2, 'expected both persisted strategy rows to survive a fresh CLI process');

  const pendingRow = rows.find((row) => row.version_id === pendingVersionId);
  assert.ok(pendingRow, 'pending strategy row should be readable after restart');
  assert.equal(pendingRow.status, 'pending');
  assert.equal(JSON.parse(pendingRow.config).macroObjective, 'shakeout');

  const abortedRow = rows.find((row) => row.version_id === abortedVersionId);
  assert.ok(abortedRow, 'aborted strategy row should be readable after restart');
  assert.equal(abortedRow.status, 'aborted');
  assert.equal(JSON.parse(abortedRow.report).abortReason, 'recovery-test');

  const groupedCounts = unwrapResults(
    runWranglerJson([
      'execute',
      'tradingbot',
      '--local',
      '--persist-to',
      persistDir,
      '--command',
      'SELECT status, COUNT(*) AS count FROM strategies GROUP BY status ORDER BY status ASC',
    ]),
  );

  const pendingCount = groupedCounts.find((row) => row.status === 'pending');
  const abortedCount = groupedCounts.find((row) => row.status === 'aborted');
  assert.equal(Number(pendingCount?.count ?? 0), 1);
  assert.equal(Number(abortedCount?.count ?? 0), 1);

  console.log('Strategy queue recovery check passed. Persisted strategy rows survive fresh D1 reads.');
} finally {
  rmSync(persistDir, { recursive: true, force: true });
}