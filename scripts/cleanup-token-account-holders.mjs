import { spawnSync } from 'node:child_process';
import process from 'node:process';

import bs58 from 'bs58';

const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const DEFAULT_DATABASE = 'tradingbot';
const RPC_BATCH_SIZE = 100;
const SQL_DELETE_BATCH_SIZE = 200;

function normalizeRpcUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.hostname.toLowerCase().includes('helius-rpc.com')) {
    if (!parsed.searchParams.get('api-key')) {
      const pathSegments = parsed.pathname
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean);
      const legacyApiKey = pathSegments[0] ?? '';
      if (legacyApiKey) {
        parsed.pathname = '/';
        parsed.searchParams.set('api-key', legacyApiKey);
      }
    }
  }
  return parsed.toString();
}

function printUsage() {
  console.log(`Usage:
  npm run cleanup:token-account-holders -- --token-id <id> [--remote|--local] [--persist-to <dir>] [--rpc-url <url>] [--dry-run] [--purge-deltas] [--yes]

Examples:
  npm run cleanup:token-account-holders -- --token-id 7 --remote --rpc-url https://your-solana-rpc.example --dry-run
  npm run cleanup:token-account-holders -- --token-id 7 --remote --rpc-url https://your-solana-rpc.example --yes
  npm run cleanup:token-account-holders -- --token-id 7 --local --persist-to /tmp/tradeengine-debug-route3 --rpc-url http://127.0.0.1:8899 --yes

Notes:
  - The script deletes token-account rows from token_holder_addresses for the selected token_id.
  - It also clears token_holder_aggregates, token_holder_sync_stage, and token_holder_sync_states for that token_id so the next refresh can rebuild from owner addresses.
  - Use --purge-deltas to also delete token_holder_transaction_deltas rows that still reference those token-account addresses.
`);
}

function parseArgs(argv) {
  const options = {
    database: DEFAULT_DATABASE,
    mode: null,
    persistTo: null,
    tokenId: null,
    rpcUrl: process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? '',
    dryRun: false,
    purgeDeltas: false,
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--remote':
        options.mode = 'remote';
        break;
      case '--local':
        options.mode = 'local';
        break;
      case '--persist-to':
        options.persistTo = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--token-id': {
        const rawValue = argv[index + 1] ?? '';
        const parsedValue = Number.parseInt(rawValue, 10);
        options.tokenId = Number.isFinite(parsedValue) ? parsedValue : null;
        index += 1;
        break;
      }
      case '--rpc-url':
        options.rpcUrl = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--database':
        options.database = argv[index + 1] ?? DEFAULT_DATABASE;
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--purge-deltas':
        options.purgeDeltas = true;
        break;
      case '--yes':
      case '-y':
        options.yes = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function ensureValidOptions(options) {
  if (options.help) {
    printUsage();
    process.exit(0);
  }
  if (options.mode !== 'remote' && options.mode !== 'local') {
    throw new Error('Specify exactly one of --remote or --local');
  }
  if (options.mode === 'local' && !options.persistTo) {
    throw new Error('--persist-to is required with --local so the script targets the intended D1 state');
  }
  if (!Number.isInteger(options.tokenId) || options.tokenId <= 0) {
    throw new Error('--token-id must be a positive integer');
  }
  if (!options.rpcUrl || !/^https?:\/\//i.test(options.rpcUrl)) {
    throw new Error('--rpc-url is required and must be an http/https URL');
  }
  options.rpcUrl = normalizeRpcUrl(options.rpcUrl);
  if (!options.dryRun && !options.yes) {
    throw new Error('Refusing to delete data without --yes');
  }
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function runWranglerCommand(options, sql) {
  const args = [
    '--yes',
    'wrangler',
    'd1',
    'execute',
    options.database,
    options.mode === 'remote' ? '--remote' : '--local',
    '--json',
    '--command',
    sql,
  ];
  if (options.mode === 'local' && options.persistTo) {
    args.splice(args.length - 2, 0, '--persist-to', options.persistTo);
  }

  const result = spawnSync('npx', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(stderr || stdout || `wrangler d1 execute failed with exit code ${result.status}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return [];
  }

  return JSON.parse(stdout);
}

function queryRows(options, sql) {
  const response = runWranglerCommand(options, sql);
  return Array.isArray(response) && response[0]?.results ? response[0].results : [];
}

function rpcGetMultipleAccounts(rpcUrl, addresses) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'cleanup-token-account-holders',
    method: 'getMultipleAccounts',
    params: [
      addresses,
      {
        encoding: 'base64',
        dataSlice: { offset: 32, length: 32 },
      },
    ],
  });

  const result = spawnSync(
    'curl',
    [
      '-sS',
      '-H',
      'Content-Type: application/json',
      '--data',
      body,
      rpcUrl,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `curl failed with exit code ${result.status}`);
  }

  const stdout = result.stdout?.trim() ?? '';
  if (!stdout) {
    throw new Error('Solana RPC returned an empty response');
  }

  const payload = JSON.parse(stdout);
  if (payload?.error) {
    throw new Error(`Solana RPC error: ${payload.error.message ?? 'unknown error'}`);
  }

  return Array.isArray(payload?.result?.value) ? payload.result.value : [];
}

function resolveTokenAccountOwners(rpcUrl, addresses) {
  const ownerByTokenAccount = new Map();

  for (const group of chunk(addresses, RPC_BATCH_SIZE)) {
    const accountInfos = rpcGetMultipleAccounts(rpcUrl, group);
    for (let index = 0; index < group.length; index += 1) {
      const accountInfo = accountInfos[index] ?? null;
      if (!accountInfo || !TOKEN_PROGRAM_IDS.has(accountInfo.owner ?? '')) {
        continue;
      }

      const data = Array.isArray(accountInfo.data)
        ? accountInfo.data[0]
        : accountInfo.data;
      if (typeof data !== 'string' || data.length === 0) {
        continue;
      }

      const ownerBytes = Buffer.from(data, 'base64');
      if (ownerBytes.length < 32) {
        continue;
      }

      const tokenAccountAddress = group[index];
      const ownerAddress = bs58.encode(ownerBytes.subarray(0, 32));
      if (ownerAddress && ownerAddress !== tokenAccountAddress) {
        ownerByTokenAccount.set(tokenAccountAddress, ownerAddress);
      }
    }
  }

  return ownerByTokenAccount;
}

function printSampleMappings(ownerByTokenAccount, limit = 10) {
  const entries = [...ownerByTokenAccount.entries()].slice(0, limit);
  if (entries.length === 0) {
    return;
  }

  console.log('Sample token-account to owner mappings:');
  for (const [tokenAccount, ownerAddress] of entries) {
    console.log(`  ${tokenAccount} -> ${ownerAddress}`);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    ensureValidOptions(options);

    const tokenRows = queryRows(
      options,
      `SELECT id, network, base_token_address, quote_token_address, symbol, name
       FROM tradable_tokens
       WHERE id = ${options.tokenId}
       LIMIT 1`,
    );
    if (tokenRows.length === 0) {
      throw new Error(`No tradable_tokens row found for token_id ${options.tokenId}`);
    }

    const tokenRow = tokenRows[0];
    console.log(`Target token_id ${options.tokenId}: ${tokenRow.symbol ?? tokenRow.name ?? tokenRow.base_token_address} (${tokenRow.base_token_address} / ${tokenRow.quote_token_address})`);

    const holderRows = queryRows(
      options,
      `SELECT wallet_address
       FROM token_holder_addresses
       WHERE token_id = ${options.tokenId}`,
    );
    const stageRows = queryRows(
      options,
      `SELECT wallet_address
       FROM token_holder_sync_stage
       WHERE token_id = ${options.tokenId}`,
    );

    const holderAddresses = holderRows.map((row) => row.wallet_address).filter(Boolean);
    const stageAddresses = stageRows.map((row) => row.wallet_address).filter(Boolean);
    const candidateAddresses = [...new Set([...holderAddresses, ...stageAddresses])];

    console.log(`Scanned ${holderAddresses.length} token_holder_addresses row(s) and ${stageAddresses.length} token_holder_sync_stage row(s).`);

    if (candidateAddresses.length === 0) {
      console.log('No holder addresses found for this token_id. Nothing to clean.');
      return;
    }

    const ownerByTokenAccount = await resolveTokenAccountOwners(
      options.rpcUrl,
      candidateAddresses,
    );

    if (ownerByTokenAccount.size === 0) {
      console.log('No token-account holder rows detected. Nothing to delete.');
      return;
    }

    const tokenAccountAddresses = [...ownerByTokenAccount.keys()];
    printSampleMappings(ownerByTokenAccount);
    console.log(`Detected ${tokenAccountAddresses.length} token-account address row(s) for token_id ${options.tokenId}.`);

    const holderAtaCount = holderAddresses.filter((address) => ownerByTokenAccount.has(address)).length;
    const stageAtaCount = stageAddresses.filter((address) => ownerByTokenAccount.has(address)).length;
    console.log(`  token_holder_addresses matches: ${holderAtaCount}`);
    console.log(`  token_holder_sync_stage matches: ${stageAtaCount}`);

    if (options.dryRun) {
      console.log('Dry run only. No rows deleted.');
      return;
    }

    for (const addressBatch of chunk(tokenAccountAddresses, SQL_DELETE_BATCH_SIZE)) {
      const inClause = addressBatch.map(sqlQuote).join(', ');
      runWranglerCommand(
        options,
        `DELETE FROM token_holder_addresses
         WHERE token_id = ${options.tokenId}
           AND wallet_address IN (${inClause});`,
      );

      if (options.purgeDeltas) {
        runWranglerCommand(
          options,
          `DELETE FROM token_holder_transaction_deltas
           WHERE token_id = ${options.tokenId}
             AND (
               wallet_from IN (${inClause})
               OR wallet_to IN (${inClause})
             );`,
        );
      }
    }

    runWranglerCommand(
      options,
      `DELETE FROM token_holder_sync_stage WHERE token_id = ${options.tokenId};
       DELETE FROM token_holder_aggregates WHERE token_id = ${options.tokenId};
       DELETE FROM token_holder_sync_states WHERE token_id = ${options.tokenId};`,
    );

    const remainingHolderRows = queryRows(
      options,
      `SELECT COUNT(*) AS cnt
       FROM token_holder_addresses
       WHERE token_id = ${options.tokenId}`,
    );
    const remainingStageRows = queryRows(
      options,
      `SELECT COUNT(*) AS cnt
       FROM token_holder_sync_stage
       WHERE token_id = ${options.tokenId}`,
    );

    console.log('Cleanup complete.');
    console.log(`  Remaining token_holder_addresses rows: ${remainingHolderRows[0]?.cnt ?? 0}`);
    console.log(`  Remaining token_holder_sync_stage rows: ${remainingStageRows[0]?.cnt ?? 0}`);
    console.log('Next step: trigger a dashboard Refresh for this pair to rebuild holder rows from owner addresses.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();