import { ApiError } from '../errors';
import {
  DEFAULT_STRATEGY_TYPE,
  PRIMARY_STRATEGY_NAME,
} from '../strategy/config';
import { normalizeStrategyDocument } from '../strategy/migrations';
import {
  buildStrategyDocumentFromSettings,
  runStrategyRuntime,
} from '../strategy/runtime';
import { StrategyStatus } from '../strategy/types';
import type {
  ExecutionReport,
  StrategyExecutionConfig,
  StrategyDefinitionRecord,
  StrategyMarketSnapshot,
  StrategyRecord,
  StrategyRecordConfig,
  StrategyRuntimeResult,
  StrategySettingsInput,
  StrategyTriggerEvent,
  StrategyVersionDocument,
  StrategyVersionRecord,
} from '../strategy/types';
import { nowTs } from '../time';
import { dbResolveTradableTokenId } from '../tokenStore';
import {
  normalizePubkey,
  parseJsonText,
  sha256Hex,
} from '../workerCore';
import type {
  Env,
  SettingsUpdateRequest,
  TokenMarketSnapshot,
} from '../workerShared';

const DEFAULT_SERIAL_STRATEGY_BASE_VOLUME_USD = 300;
const DEFAULT_SERIAL_STRATEGY_DISTRIBUTION_CHUNK_COUNT = 3;
const DEFAULT_SERIAL_STRATEGY_DISTRIBUTION_DELAY_JITTER_MS = 2_000;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createStrategyRecordVersionId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `strategy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseTimeRangeTargetToDurationMs(timeRangeTarget: string): number {
  switch (timeRangeTarget) {
    case '1h':
      return 60 * 60 * 1000;
    case '6h':
      return 6 * 60 * 60 * 1000;
    case '12h':
      return 12 * 60 * 60 * 1000;
    case '3d':
      return 3 * 24 * 60 * 60 * 1000;
    case '1w':
      return 7 * 24 * 60 * 60 * 1000;
    case '24h':
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function buildQueuedExecutionConfig(
  execution: StrategyExecutionConfig,
): StrategyExecutionConfig {
  return {
    ...execution,
    tactics: {
      ...execution.tactics,
    },
  };
}

function isStrategyFinished(status: StrategyStatus): boolean {
  return (
    status === 'completed' ||
    status === 'aborted' ||
    status === 'failed'
  );
}

function normalizeStoredTimestamp(value: unknown): number {
  if (typeof value === 'number') {
    return value >= 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return normalizeStoredTimestamp(numeric);
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : nowTs();
  }
  return nowTs();
}

function mapStrategyStatus(value: string): StrategyStatus {
  switch (value) {
    case StrategyStatus.Pending:
      return StrategyStatus.Pending;
    case StrategyStatus.Running:
      return StrategyStatus.Running;
    case StrategyStatus.Completed:
      return StrategyStatus.Completed;
    case StrategyStatus.Aborted:
      return StrategyStatus.Aborted;
    case StrategyStatus.Paused:
      return StrategyStatus.Paused;
    case StrategyStatus.Failed:
    default:
      return StrategyStatus.Failed;
  }
}

function mapStrategyRow(row: {
  version_id: string;
  status: string;
  config: string;
  report: string | null;
  created_at: string | number;
  updated_at: string | number;
}): StrategyRecord {
  const config = parseJsonText<StrategyRecordConfig>(row.config);
  const report = row.report ? parseJsonText<ExecutionReport>(row.report) : undefined;
  const createdAt = normalizeStoredTimestamp(row.created_at);
  const updatedAt = normalizeStoredTimestamp(row.updated_at);
  const status = mapStrategyStatus(row.status);
  return {
    versionId: row.version_id,
    status,
    config,
    report,
    createdAt,
    updatedAt,
    startedAt:
      report?.startTime ??
      (status === StrategyStatus.Running || isStrategyFinished(status)
        ? updatedAt
        : null),
    finishedAt: report?.endTime ?? (isStrategyFinished(status) ? updatedAt : null),
  };
}

async function dbGetStrategyRows(
  env: Env,
  query: string,
  bindings: Array<string | number | null> = [],
): Promise<StrategyRecord[]> {
  const prepared = env.TRADINGBOT_DB.prepare(query).bind(...bindings);
  const result = await prepared.all<{
    version_id: string;
    status: string;
    config: string;
    report: string | null;
    created_at: string | number;
    updated_at: string | number;
  }>();
  return result.results.map(mapStrategyRow);
}

function deriveQueuePaused(records: StrategyRecord[]): boolean {
  const hasRunning = records.some((record) => record.status === StrategyStatus.Running);
  if (hasRunning) {
    return false;
  }
  const pending = records.filter((record) => record.status === StrategyStatus.Pending);
  if (pending.length === 0) {
    return false;
  }
  const latestFinal = records
    .filter((record) => isStrategyFinished(record.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  return latestFinal?.status === StrategyStatus.Aborted;
}

function isManualStrategyVersionDocument(
  document: StrategyVersionDocument,
): boolean {
  return document.metadata.origin === 'manual';
}

export function buildStrategyRecordConfigFromVersion(
  version: StrategyVersionRecord,
  userId: number,
): StrategyRecordConfig {
  const document = normalizeStrategyDocument(version.document);
  return {
    userId,
    strategyVersionId: version.id,
    strategyVersionNo: version.versionNo,
    strategyType: version.strategyType,
    document,
    baseTokenAddress: document.parameters.baseTokenAddress,
    quoteTokenAddress: document.parameters.quoteTokenAddress,
    macroObjective: document.execution.macroObjective,
    tactics: {
      ...document.execution.tactics,
    },
    execution: buildQueuedExecutionConfig(document.execution),
    baseOrderCount: Math.max(
      1,
      Math.min(12, Math.max(3, document.riskControls.maxConcurrentOrders * 3)),
    ),
    baseTotalVolumeUsd:
      document.riskControls.maxPositionUsd ??
      (document.targets.volumeUsdMin > 0
        ? document.targets.volumeUsdMin
        : DEFAULT_SERIAL_STRATEGY_BASE_VOLUME_USD),
    baseDurationMs: parseTimeRangeTargetToDurationMs(
      document.parameters.timeRangeTarget,
    ),
    distributionChunkCount: DEFAULT_SERIAL_STRATEGY_DISTRIBUTION_CHUNK_COUNT,
    distributionChunkDelayJitterMs:
      DEFAULT_SERIAL_STRATEGY_DISTRIBUTION_DELAY_JITTER_MS,
  };
}

export async function addStrategy(
  env: Env,
  versionId: string,
  config: StrategyRecordConfig,
): Promise<StrategyRecord> {
  await env.TRADINGBOT_DB
    .prepare(
      `INSERT INTO strategies (
         version_id,
         status,
         config,
         report,
         created_at,
         updated_at
       ) VALUES (?1, ?2, ?3, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(versionId, StrategyStatus.Pending, JSON.stringify(config))
    .run();

  const created = await getStrategyRecordByVersionId(env, versionId);
  if (!created) {
    throw new ApiError(500, `Failed to load created strategy ${versionId}`);
  }
  return created;
}

export async function getNextPendingStrategy(
  env: Env,
): Promise<StrategyRecord | null> {
  const records = await dbGetStrategyRows(
    env,
    `SELECT version_id, status, config, report, created_at, updated_at
     FROM strategies
     WHERE status = ?1
     ORDER BY datetime(created_at) ASC, id ASC
     LIMIT 1`,
    [StrategyStatus.Pending],
  );
  return records[0] ?? null;
}

export async function getActiveStrategy(
  env: Env,
): Promise<StrategyRecord | null> {
  const running = await dbGetStrategyRows(
    env,
    `SELECT version_id, status, config, report, created_at, updated_at
     FROM strategies
     WHERE status = ?1
     ORDER BY datetime(updated_at) DESC, id DESC`,
    [StrategyStatus.Running],
  );
  if (running.length > 1) {
    throw new ApiError(
      500,
      'Strict serial queue invariant violated: more than one strategy is running',
    );
  }
  return running[0] ?? null;
}

export async function updateStrategyStatus(
  env: Env,
  versionId: string,
  newStatus: StrategyStatus,
  report?: ExecutionReport,
): Promise<StrategyRecord | null> {
  const record = await getStrategyRecordByVersionId(env, versionId);
  if (!record) {
    return null;
  }

  if (newStatus === StrategyStatus.Running) {
    const active = await getActiveStrategy(env);
    if (active && active.versionId === versionId) {
      return active;
    }
    if (active) {
      throw new ApiError(
        409,
        `Cannot start strategy ${versionId} while ${active.versionId} is still running`,
      );
    }
  }

  await env.TRADINGBOT_DB
    .prepare(
      `UPDATE strategies
       SET status = ?2,
           report = CASE
             WHEN ?3 IS NULL THEN report
             ELSE ?3
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE version_id = ?1`,
    )
    .bind(
      versionId,
      newStatus,
      report ? JSON.stringify(report) : null,
    )
    .run();

  return getStrategyRecordByVersionId(env, versionId);
}

export async function listStrategyRecords(env: Env): Promise<StrategyRecord[]> {
  return dbGetStrategyRows(
    env,
    `SELECT version_id, status, config, report, created_at, updated_at
     FROM strategies
     ORDER BY datetime(created_at) ASC, id ASC`,
  );
}

export async function getAllStrategies(
  env: Env,
): Promise<{
  active: StrategyRecord[];
  pending: StrategyRecord[];
  history: StrategyRecord[];
  paused: boolean;
}> {
  const records = await listStrategyRecords(env);
  const active = records.filter((record) => record.status === StrategyStatus.Running);
  const pending = records.filter((record) => record.status === StrategyStatus.Pending);
  const history = records.filter(
    (record) =>
      record.status === StrategyStatus.Completed ||
      record.status === StrategyStatus.Aborted ||
      record.status === StrategyStatus.Failed,
  );
  return {
    active,
    pending,
    history,
    paused: deriveQueuePaused(records),
  };
}

export async function getStrategyRecordByVersionId(
  env: Env,
  versionId: string,
): Promise<StrategyRecord | null> {
  const records = await dbGetStrategyRows(
    env,
    `SELECT version_id, status, config, report, created_at, updated_at
     FROM strategies
     WHERE version_id = ?1
     LIMIT 1`,
    [versionId],
  );
  return records[0] ?? null;
}

export async function findStrategyRecordByStrategyVersionId(
  env: Env,
  strategyVersionId: number,
): Promise<StrategyRecord | null> {
  const records = await dbGetStrategyRows(
    env,
    `SELECT version_id, status, config, report, created_at, updated_at
     FROM strategies
     WHERE json_extract(config, '$.strategyVersionId') = ?1
     LIMIT 1`,
    [strategyVersionId],
  );
  return records[0] ?? null;
}

export async function removePendingStrategy(
  env: Env,
  versionId: string,
): Promise<StrategyRecord | null> {
  const record = await getStrategyRecordByVersionId(env, versionId);
  if (!record) {
    return null;
  }
  if (record.status !== StrategyStatus.Pending) {
    throw new ApiError(
      409,
      `Only pending strategies can be removed from the queue (${versionId})`,
    );
  }
  await env.TRADINGBOT_DB
    .prepare('DELETE FROM strategies WHERE version_id = ?1')
    .bind(versionId)
    .run();
  return record;
}

function serializeStrategyVersionContent(
  document: StrategyVersionDocument,
): string {
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    engineVersion: document.engineVersion,
    strategyType: document.strategyType,
    parameters: document.parameters,
    triggers: document.triggers,
    targets: document.targets,
    riskControls: document.riskControls,
    execution: document.execution,
  });
}

export function dedupeStrategyVersionsForDisplay(
  versions: StrategyVersionRecord[],
  activeVersion: StrategyVersionRecord | null,
): {
  versions: StrategyVersionRecord[];
  activeVersion: StrategyVersionRecord | null;
} {
  const uniqueByContent = new Map<string, StrategyVersionRecord>();
  for (const version of [...versions].reverse()) {
    const signature = serializeStrategyVersionContent(version.document);
    if (!uniqueByContent.has(signature)) {
      uniqueByContent.set(signature, version);
    }
  }

  const dedupedVersions = [...uniqueByContent.values()].sort(
    (left, right) => right.versionNo - left.versionNo || right.id - left.id,
  );

  if (!activeVersion) {
    return { versions: dedupedVersions, activeVersion: null };
  }

  const activeSignature = serializeStrategyVersionContent(activeVersion.document);
  return {
    versions: dedupedVersions,
    activeVersion:
      dedupedVersions.find(
        (version) =>
          serializeStrategyVersionContent(version.document) === activeSignature,
      ) ?? activeVersion,
  };
}

function mapTokenMarketSnapshotToStrategySnapshot(
  snapshot: TokenMarketSnapshot | null,
): StrategyMarketSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return {
    contractAddress: snapshot.baseTokenAddress,
    priceUsd: snapshot.priceUsd,
    liquidityUsd: snapshot.liquidityUsd,
    fdv: snapshot.fdv,
    volume24h: snapshot.volume24h,
    totalTransactions24h: snapshot.totalTransactions24h,
    outsidersOverOneUsd: snapshot.outsidersOverOneUsd,
    fetchedAt: snapshot.fetchedAt,
  };
}

function mapStrategyDefinitionRow(row: {
  id: number;
  user_id: number;
  name: string;
  strategy_type: string;
  current_version_id: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}): StrategyDefinitionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    strategyType: row.strategy_type as StrategyDefinitionRecord['strategyType'],
    currentVersionId: row.current_version_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStrategyVersionRow(row: {
  id: number;
  strategy_id: number;
  version_no: number;
  schema_version: number;
  engine_version: string;
  strategy_type: string;
  status: string;
  params_json: string;
  triggers_json: string;
  targets_json: string;
  risk_json: string;
  execution_json: string;
  metadata_json: string;
  checksum: string;
  change_note: string | null;
  created_at: number;
  activated_at: number | null;
}): StrategyVersionRecord {
  const document: StrategyVersionDocument = normalizeStrategyDocument({
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    strategyType: row.strategy_type,
    parameters: parseJsonText(row.params_json),
    triggers: parseJsonText(row.triggers_json),
    targets: parseJsonText(row.targets_json),
    riskControls: parseJsonText(row.risk_json),
    execution: parseJsonText(row.execution_json),
    metadata: parseJsonText(row.metadata_json),
  });

  return {
    id: row.id,
    strategyId: row.strategy_id,
    versionNo: row.version_no,
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    strategyType: row.strategy_type as StrategyVersionRecord['strategyType'],
    status: row.status as StrategyVersionRecord['status'],
    checksum: row.checksum,
    changeNote: row.change_note,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    document,
  };
}

function mapStrategyEvaluationRow(row: {
  id: number;
  user_id: number;
  strategy_version_id: number;
  version_no: number;
  source: string;
  event_type: string;
  external_id: string | null;
  contract_address: string;
  wallet_address: string | null;
  tx_signature: string | null;
  status: string;
  should_execute: number;
  summary_json: string;
  created_at: number;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    strategyVersionId: row.strategy_version_id,
    strategyVersionNo: row.version_no,
    source: row.source,
    eventType: row.event_type,
    externalId: row.external_id,
    contractAddress: row.contract_address,
    walletAddress: row.wallet_address,
    txSignature: row.tx_signature,
    status: row.status,
    shouldExecute: row.should_execute === 1,
    summary: parseJsonText<Record<string, unknown>>(row.summary_json),
    createdAt: row.created_at,
  };
}

async function dbGetOrCreatePrimaryStrategyDefinition(
  db: D1Database,
  userId: number,
): Promise<StrategyDefinitionRecord> {
  const existing = await db
    .prepare(
      `SELECT
         id,
         user_id,
         name,
         strategy_type,
         current_version_id,
         status,
         created_at,
         updated_at
       FROM strategy_definitions
       WHERE user_id = ?1 AND strategy_type = ?2
       LIMIT 1`,
    )
    .bind(userId, DEFAULT_STRATEGY_TYPE)
    .first<{
      id: number;
      user_id: number;
      name: string;
      strategy_type: string;
      current_version_id: number | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>();
  if (existing) {
    return mapStrategyDefinitionRow(existing);
  }

  const createdAt = nowTs();
  await db
    .prepare(
      `INSERT INTO strategy_definitions (
         user_id,
         name,
         strategy_type,
         current_version_id,
         status,
         created_at,
         updated_at
       ) VALUES (?1, ?2, ?3, NULL, 'active', ?4, ?4)`,
    )
    .bind(userId, PRIMARY_STRATEGY_NAME, DEFAULT_STRATEGY_TYPE, createdAt)
    .run();

  const created = await db
    .prepare(
      `SELECT
         id,
         user_id,
         name,
         strategy_type,
         current_version_id,
         status,
         created_at,
         updated_at
       FROM strategy_definitions
       WHERE user_id = ?1 AND strategy_type = ?2
       LIMIT 1`,
    )
    .bind(userId, DEFAULT_STRATEGY_TYPE)
    .first<{
      id: number;
      user_id: number;
      name: string;
      strategy_type: string;
      current_version_id: number | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>();
  if (!created) {
    throw new ApiError(500, 'Failed to create primary strategy definition');
  }
  return mapStrategyDefinitionRow(created);
}

async function dbGetStrategyVersionById(
  db: D1Database,
  versionId: number,
): Promise<StrategyVersionRecord | null> {
  const row = await db
    .prepare(
      `SELECT
         id,
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       FROM strategy_versions
       WHERE id = ?1
       LIMIT 1`,
    )
    .bind(versionId)
    .first<{
      id: number;
      strategy_id: number;
      version_no: number;
      schema_version: number;
      engine_version: string;
      strategy_type: string;
      status: string;
      params_json: string;
      triggers_json: string;
      targets_json: string;
      risk_json: string;
      execution_json: string;
      metadata_json: string;
      checksum: string;
      change_note: string | null;
      created_at: number;
      activated_at: number | null;
    }>();
  return row ? mapStrategyVersionRow(row) : null;
}

export async function dbGetActiveStrategyVersion(
  db: D1Database,
  userId: number,
): Promise<StrategyVersionRecord | null> {
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  if (definition.currentVersionId == null) {
    return null;
  }
  return dbGetStrategyVersionById(db, definition.currentVersionId);
}

export function mapStrategyDocumentToSettingsUpdate(
  document: StrategyVersionDocument,
): SettingsUpdateRequest {
  return {
    baseTokenAddress: document.parameters.baseTokenAddress,
    volatilityTarget: document.targets.volatilityPctMin,
    pullbackTarget: document.targets.pullbackPctMax,
    volumeTarget: document.targets.volumeUsdMin,
    netBuyinTarget: document.targets.netBuyinUsdMin,
    timeRangeTarget: document.parameters.timeRangeTarget,
    maxTransactions: document.parameters.maxTransactions,
    maxSlippage: document.parameters.maxSlippageBps / 100,
    strategyNotes: document.parameters.notes,
  };
}

export async function dbSaveActiveStrategyVersionDocument(
  db: D1Database,
  userId: number,
  documentInput: StrategyVersionDocument,
  options?: {
    changeNote?: string;
  },
): Promise<{ version: StrategyVersionRecord; created: boolean }> {
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  const document = normalizeStrategyDocument(documentInput);
  const checksum = await sha256Hex(serializeStrategyVersionContent(document));
  const currentVersion = definition.currentVersionId
    ? await dbGetStrategyVersionById(db, definition.currentVersionId)
    : null;
  const currentVersionChecksum = currentVersion
    ? await sha256Hex(serializeStrategyVersionContent(currentVersion.document))
    : null;

  if (currentVersion && currentVersionChecksum === checksum) {
    return { version: currentVersion, created: false };
  }

  const nextVersionNo =
    ((await db
      .prepare(
        'SELECT MAX(version_no) AS max_version_no FROM strategy_versions WHERE strategy_id = ?1',
      )
      .bind(definition.id)
      .first<{ max_version_no: number | null }>())?.max_version_no ?? 0) + 1;
  const createdAt = nowTs();

  await db
    .prepare(
      `INSERT INTO strategy_versions (
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
    )
    .bind(
      definition.id,
      nextVersionNo,
      document.schemaVersion,
      document.engineVersion,
      document.strategyType,
      JSON.stringify(document.parameters),
      JSON.stringify(document.triggers),
      JSON.stringify(document.targets),
      JSON.stringify(document.riskControls),
      JSON.stringify(document.execution),
      JSON.stringify(document.metadata),
      checksum,
      options?.changeNote ?? document.metadata.changeNote,
      createdAt,
    )
    .run();

  const inserted = await db
    .prepare(
      `SELECT
         id,
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       FROM strategy_versions
       WHERE strategy_id = ?1 AND version_no = ?2
       LIMIT 1`,
    )
    .bind(definition.id, nextVersionNo)
    .first<{
      id: number;
      strategy_id: number;
      version_no: number;
      schema_version: number;
      engine_version: string;
      strategy_type: string;
      status: string;
      params_json: string;
      triggers_json: string;
      targets_json: string;
      risk_json: string;
      execution_json: string;
      metadata_json: string;
      checksum: string;
      change_note: string | null;
      created_at: number;
      activated_at: number | null;
    }>();
  if (!inserted) {
    throw new ApiError(500, 'Failed to load inserted strategy version');
  }

  if (currentVersion) {
    await db
      .prepare("UPDATE strategy_versions SET status = 'published' WHERE id = ?1")
      .bind(currentVersion.id)
      .run();
  }

  await db
    .prepare(
      'UPDATE strategy_definitions SET current_version_id = ?2, updated_at = ?3 WHERE id = ?1',
    )
    .bind(definition.id, inserted.id, createdAt)
    .run();

  return {
    version: mapStrategyVersionRow(inserted),
    created: true,
  };
}

export async function dbListStrategyVersions(
  db: D1Database,
  userId: number,
  limit = 25,
): Promise<StrategyVersionRecord[]> {
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  const fetchLimit = Math.max(limit * 10, 250);
  const rows = await db
    .prepare(
      `SELECT
         id,
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       FROM strategy_versions
       WHERE strategy_id = ?1
       ORDER BY version_no DESC, id DESC
       LIMIT ?2`,
    )
     .bind(definition.id, fetchLimit)
    .all<{
      id: number;
      strategy_id: number;
      version_no: number;
      schema_version: number;
      engine_version: string;
      strategy_type: string;
      status: string;
      params_json: string;
      triggers_json: string;
      targets_json: string;
      risk_json: string;
      execution_json: string;
      metadata_json: string;
      checksum: string;
      change_note: string | null;
      created_at: number;
      activated_at: number | null;
    }>();
  return rows.results.map(mapStrategyVersionRow).slice(0, fetchLimit);
}

export async function dbDeletePreviousStrategyVersions(
  db: D1Database,
  userId: number,
): Promise<{
  deletedVersions: number;
  deletedEvaluations: number;
  keptVersion: StrategyVersionRecord | null;
}> {
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  const rows = await db
    .prepare(
      `SELECT
         id,
         strategy_id,
         version_no,
         schema_version,
         engine_version,
         strategy_type,
         status,
         params_json,
         triggers_json,
         targets_json,
         risk_json,
         execution_json,
         metadata_json,
         checksum,
         change_note,
         created_at,
         activated_at
       FROM strategy_versions
       WHERE strategy_id = ?1
       ORDER BY version_no DESC, id DESC`,
    )
    .bind(definition.id)
    .all<{
      id: number;
      strategy_id: number;
      version_no: number;
      schema_version: number;
      engine_version: string;
      strategy_type: string;
      status: string;
      params_json: string;
      triggers_json: string;
      targets_json: string;
      risk_json: string;
      execution_json: string;
      metadata_json: string;
      checksum: string;
      change_note: string | null;
      created_at: number;
      activated_at: number | null;
    }>();

  const versions = rows.results.map(mapStrategyVersionRow);
  const manualVersions = versions.filter((version) =>
    isManualStrategyVersionDocument(version.document),
  );
  const deletedVersionsList = versions.filter(
    (version) => !isManualStrategyVersionDocument(version.document),
  );

  if (versions.length === 0) {
    return {
      deletedVersions: 0,
      deletedEvaluations: 0,
      keptVersion: null,
    };
  }

  const keepVersion = manualVersions.find(
    (version) => version.id === definition.currentVersionId,
  ) ?? manualVersions[0] ?? null;

  if (deletedVersionsList.length === 0) {
    const updatedAt = nowTs();
    if (keepVersion) {
      await db.batch(
        manualVersions.map((version) =>
          db
            .prepare(
              `UPDATE strategy_versions
               SET status = ?2,
                   activated_at = CASE
                     WHEN id = ?1 THEN COALESCE(activated_at, ?3)
                     ELSE activated_at
                   END
               WHERE id = ?1`,
            )
            .bind(
              version.id,
              version.id === keepVersion.id ? 'active' : 'published',
              updatedAt,
            ),
        ),
      );
      await db
        .prepare(
          'UPDATE strategy_definitions SET current_version_id = ?2, updated_at = ?3 WHERE id = ?1',
        )
        .bind(definition.id, keepVersion.id, updatedAt)
        .run();
    } else {
      await db
        .prepare(
          'UPDATE strategy_definitions SET current_version_id = NULL, updated_at = ?2 WHERE id = ?1',
        )
        .bind(definition.id, updatedAt)
        .run();
    }
    return {
      deletedVersions: 0,
      deletedEvaluations: 0,
      keptVersion: keepVersion,
    };
  }

  let deletedEvaluations = 0;
  for (const version of deletedVersionsList) {
    deletedEvaluations +=
      (
        await db
          .prepare(
            'SELECT COUNT(*) AS count FROM strategy_evaluations WHERE strategy_version_id = ?1',
          )
          .bind(version.id)
          .first<{ count: number }>()
      )?.count ?? 0;
  }

  if (deletedVersionsList.length > 0) {
    await db.batch(
      deletedVersionsList.map((version) =>
        db
          .prepare('DELETE FROM strategy_versions WHERE id = ?1')
          .bind(version.id),
      ),
    );
  }

  const updatedAt = nowTs();
  if (manualVersions.length > 0 && keepVersion) {
    await db.batch(
      manualVersions.map((version) =>
        db
          .prepare(
            `UPDATE strategy_versions
             SET status = ?2,
                 activated_at = CASE
                   WHEN id = ?1 THEN COALESCE(activated_at, ?3)
                   ELSE activated_at
                 END
             WHERE id = ?1`,
          )
          .bind(
            version.id,
            version.id === keepVersion.id ? 'active' : 'published',
            updatedAt,
          ),
      ),
    );
    await db
      .prepare(
        'UPDATE strategy_definitions SET current_version_id = ?2, updated_at = ?3 WHERE id = ?1',
      )
      .bind(definition.id, keepVersion.id, updatedAt)
      .run();
  } else {
    await db
      .prepare(
        'UPDATE strategy_definitions SET current_version_id = NULL, updated_at = ?2 WHERE id = ?1',
      )
      .bind(definition.id, updatedAt)
      .run();
  }

  return {
    deletedVersions: deletedVersionsList.length,
    deletedEvaluations,
    keptVersion: keepVersion,
  };
}

export async function dbListStrategyEvaluations(
  db: D1Database,
  userId: number,
  limit = 50,
): Promise<Array<{
  id: number;
  userId: number;
  strategyVersionId: number;
  strategyVersionNo: number;
  source: string;
  eventType: string;
  externalId: string | null;
  contractAddress: string;
  walletAddress: string | null;
  txSignature: string | null;
  status: string;
  shouldExecute: boolean;
  summary: Record<string, unknown>;
  createdAt: number;
}>> {
  const rows = await db
    .prepare(
      `SELECT
         se.id,
         se.user_id,
         se.strategy_version_id,
         sv.version_no,
         se.source,
         se.event_type,
         se.external_id,
         se.contract_address,
         se.wallet_address,
         se.tx_signature,
         se.status,
         se.should_execute,
         se.summary_json,
         se.created_at
       FROM strategy_evaluations se
       INNER JOIN strategy_versions sv ON sv.id = se.strategy_version_id
       WHERE se.user_id = ?1
       ORDER BY se.created_at DESC, se.id DESC
       LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<{
      id: number;
      user_id: number;
      strategy_version_id: number;
      version_no: number;
      source: string;
      event_type: string;
      external_id: string | null;
      contract_address: string;
      wallet_address: string | null;
      tx_signature: string | null;
      status: string;
      should_execute: number;
      summary_json: string;
      created_at: number;
    }>();
  return rows.results.map(mapStrategyEvaluationRow);
}

export async function dbSyncActiveStrategyVersionFromSettings(
  db: D1Database,
  userId: number,
  settings: StrategySettingsInput,
  options?: {
    author?: string | null;
    changeNote?: string;
    origin?: 'settings-sync' | 'manual' | 'migration';
  },
): Promise<{ version: StrategyVersionRecord; created: boolean }> {
  const document = buildStrategyDocumentFromSettings(settings, {
    author: options?.author ?? null,
    changeNote: options?.changeNote,
    origin: options?.origin,
  });
  return dbSaveActiveStrategyVersionDocument(db, userId, document, {
    changeNote: options?.changeNote,
  });
}

async function dbCreateStrategyEvaluation(
  db: D1Database,
  userId: number,
  strategyVersionId: number,
  trigger: StrategyTriggerEvent,
  runtime: StrategyRuntimeResult,
): Promise<void> {
  const createdAt = nowTs();
  await db
    .prepare(
      `INSERT INTO strategy_evaluations (
         user_id,
         strategy_version_id,
         source,
         event_type,
         external_id,
         contract_address,
         wallet_address,
         tx_signature,
         status,
         should_execute,
         summary_json,
         created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      userId,
      strategyVersionId,
      trigger.source,
      trigger.eventType,
      trigger.externalId,
      trigger.contractAddress,
      trigger.walletAddress,
      trigger.txSignature,
      runtime.evaluation.status,
      runtime.evaluation.shouldExecute ? 1 : 0,
      JSON.stringify(runtime.summary),
      createdAt,
    )
    .run();
}

export async function runAndPersistStrategyEvaluation(
  db: D1Database,
  userId: number,
  settings: StrategySettingsInput,
  trigger: StrategyTriggerEvent,
  marketSnapshot: TokenMarketSnapshot | null,
  options?: {
    author?: string | null;
    changeNote?: string;
    origin?: 'settings-sync' | 'manual' | 'migration';
  },
): Promise<{ version: StrategyVersionRecord; runtime: StrategyRuntimeResult } | null> {
  void settings;
  void options;
  const version = await dbGetActiveStrategyVersion(db, userId);
  if (!version) {
    return null;
  }
  const runtime = runStrategyRuntime({
    strategyDocument: version.document,
    trigger,
    marketSnapshot: mapTokenMarketSnapshotToStrategySnapshot(marketSnapshot),
  });
  await dbCreateStrategyEvaluation(db, userId, version.id, trigger, runtime);
  return { version, runtime };
}

export async function dbUserOwnsAccount(
  db: D1Database,
  userId: number,
  address: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT id FROM accounts WHERE user_id = ?1 AND wallet_address = ?2 LIMIT 1',
    )
    .bind(userId, address)
    .first<{ id: number }>();
  return !!row;
}
