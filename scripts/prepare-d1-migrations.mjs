import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const location = process.argv.includes('--remote') ? '--remote' : '--local';
const persistToIndex = process.argv.indexOf('--persist-to');
const persistenceArgs = persistToIndex >= 0 && process.argv[persistToIndex + 1]
  ? ['--persist-to', process.argv[persistToIndex + 1]]
  : [];
const database = 'tradingbot';
const baselineThrough = '0013_trade_log_chain_time.sql';
const requiredColumns = {
  users: ['id', 'username', 'password_hash', 'role', 'created_at'],
  sessions: ['id', 'user_id', 'token_hash', 'expires_at', 'created_at'],
  settings: ['user_id', 'key', 'value'],
  accounts: [
    'id', 'user_id', 'type', 'label', 'wallet_address', 'encrypted_private_key',
    'is_active', 'capability_base_mint', 'capability_quote_mint',
    'wallet_usdc_balance', 'wallet_sol_balance', 'wallet_active_token_mint',
    'wallet_active_token_balance', 'wallet_balance_updated_at', 'created_at',
  ],
  audit_logs: ['id', 'user_id', 'action', 'target', 'details', 'created_at'],
  tradable_tokens: [
    'id', 'network', 'contract_address', 'base_token_address',
    'quote_token_address', 'amm_pool_address', 'symbol', 'name', 'decimals',
    'quote_token_symbol', 'quote_token_name', 'quote_token_decimals',
    'is_active', 'created_at',
  ],
  token_market_snapshots: [
    'id', 'token_id', 'network', 'base_token_address', 'total_holders', 'fetched_at',
  ],
  signals: ['id', 'source', 'external_id', 'payload', 'details_json', 'processed'],
  webhook_transaction_logs: ['id', 'user_id', 'group_key', 'chain_time_ms'],
  positions: ['id', 'wallet_address', 'token_id', 'quantity'],
  trade_logs: [
    'id', 'token_id', 'wallet_address', 'chain_time_ms', 'execution_trace_json',
    'strategy_run_id', 'status',
  ],
  historic_setups: ['id', 'user_id', 'base_token_address'],
  strategy_definitions: ['id', 'user_id', 'strategy_type'],
  strategy_versions: ['id', 'strategy_id', 'version_no'],
  strategy_evaluations: ['id', 'strategy_version_id', 'base_token_address'],
  strategies: ['id', 'version_id', 'status', 'config', 'report'],
  token_holder_addresses: [
    'id', 'token_id', 'wallet_address', 'amount_holding', 'wallet_usdc_balance',
    'wallet_sol_balance', 'wallet_balance_updated_at', 'source',
  ],
  token_holder_transaction_deltas: ['id', 'token_id', 'tx_signature'],
  token_holder_aggregates: ['token_id', 'active_holder_count', 'updated_at'],
  token_holder_sync_states: ['token_id', 'run_id', 'status', 'updated_at'],
  token_holder_sync_stage: ['token_id', 'run_id', 'shard_index', 'wallet_address'],
  rpc_endpoints: ['id', 'user_id', 'network', 'url', 'is_active'],
  market_refresh_states: ['user_id', 'contract_address', 'status', 'updated_at'],
};

function executeJson(sql) {
  const output = execFileSync(
    'npx',
    [
      'wrangler', 'd1', 'execute', database, location,
      ...persistenceArgs,
      '--command', sql, '--json',
    ],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.some((entry) => entry.success !== true)) {
    throw new Error('Wrangler returned an unsuccessful D1 response');
  }
  return parsed;
}

const tableState = executeJson(
  `SELECT
     SUM(CASE WHEN name = 'd1_migrations' THEN 1 ELSE 0 END) AS migration_table_count,
     SUM(CASE WHEN name = 'users' THEN 1 ELSE 0 END) AS users_table_count
   FROM sqlite_master
   WHERE type = 'table' AND name IN ('d1_migrations', 'users');`,
);
const hasMigrationTable = Number(
  tableState[0]?.results?.[0]?.migration_table_count ?? 0,
) > 0;
const hasSchema = Number(tableState[0]?.results?.[0]?.users_table_count ?? 0) > 0;
if (!hasMigrationTable) {
  console.log('D1 is empty; migrations will create the schema and migration history.');
  process.exit(0);
}
const migrationState = executeJson('SELECT COUNT(*) AS migration_count FROM d1_migrations');
const migrationCount = Number(migrationState[0]?.results?.[0]?.migration_count ?? 0);

if (migrationCount > 0 || !hasSchema) {
  console.log(migrationCount > 0
    ? `D1 migration history already contains ${migrationCount} record(s).`
    : 'D1 is empty; migrations will create the schema.');
  process.exit(0);
}

const schemaQuery = Object.keys(requiredColumns)
  .map((table) =>
    `SELECT '${table}' AS table_name, name AS column_name FROM pragma_table_info('${table}')`,
  )
  .join(' UNION ALL ');
const schemaResult = executeJson(schemaQuery);
const actualColumns = new Set(
  (schemaResult[0]?.results ?? []).map(
    (column) => `${column.table_name}.${column.column_name}`,
  ),
);
const missing = Object.entries(requiredColumns).flatMap(([table, columns]) =>
  columns
    .map((column) => `${table}.${column}`)
    .filter((qualifiedColumn) => !actualColumns.has(qualifiedColumn)),
);
if (missing.length > 0) {
  throw new Error(
    `Refusing to baseline an incomplete runtime-created schema. Missing: ${missing.join(', ')}`,
  );
}

const migrationNames = readdirSync(resolve(import.meta.dirname, '..', 'migrations'))
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort()
  .filter((name) => name <= baselineThrough);
const values = migrationNames
  .map((name, index) => `(${index + 1}, '${name.replaceAll("'", "''")}')`)
  .join(', ');
executeJson(`INSERT INTO d1_migrations (id, name) VALUES ${values}`);
console.log(
  `Validated the existing schema and baselined ${migrationNames.length} migration(s) through ${baselineThrough}.`,
);