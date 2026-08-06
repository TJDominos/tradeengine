import { ApiError } from './errors';
import { dbListTradableTokens, dbResolveSolanaRpcUrls } from './tokenStore';
import { nowTs, normalizeTimestampMs } from './time';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  extractStoredSignalContractAddresses,
  generateToken,
  hashPassword,
  loadWalletBalance,
  mergeStoredSignalTransactionDetails,
  normalizePrivateKey,
  normalizePubkey,
  parseStoredSignalTransactionDetails,
  sha256Hex,
  solanaPubkeyFromKeypairBytes,
  toFiniteNumber,
  validateContractAddress,
  validateLabel,
  validatePassword,
  validateUsername,
  verifyPassword,
} from './workerCore';
import { dbEnsureSchema, dbEnsureTradeDomainSchema } from './workerSchema';
import type {
  AccountRecord,
  AuditLog,
  SessionUser,
  SettingsState,
  SettingsUpdateRequest,
  StoredSignalTransactionDetails,
  TradeLogRecord,
  WebhookTransactionLogRecord,
  WalletBalanceResponse,
} from './workerShared';
import { SOLANA_USDC_MINT } from './workerShared';

const ACCOUNT_TRADE_COOLDOWN_MS = 45_000;
const ACCOUNT_MIN_SOL_RESERVE = 0.01;

export interface AvailableAccountRecord extends AccountRecord {
  isActive: boolean;
  lastTradedAt: number | null;
  walletBalance: WalletBalanceResponse;
}

function compareLeastRecentlyUsed(
  left: { lastTradedAt: number | null; createdAt: number; id: number },
  right: { lastTradedAt: number | null; createdAt: number; id: number },
): number {
  if (left.lastTradedAt == null && right.lastTradedAt != null) {
    return -1;
  }
  if (left.lastTradedAt != null && right.lastTradedAt == null) {
    return 1;
  }
  if (left.lastTradedAt != null && right.lastTradedAt != null && left.lastTradedAt !== right.lastTradedAt) {
    return left.lastTradedAt - right.lastTradedAt;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id - right.id;
}

function hasSufficientBalance(
  action: 'buy' | 'sell',
  estimatedAmount: number,
  contractAddress: string,
  walletBalance: WalletBalanceResponse,
): boolean {
  const solBalance = toFiniteNumber(walletBalance.sol) ?? 0;
  if (solBalance < ACCOUNT_MIN_SOL_RESERVE) {
    return false;
  }

  if (action === 'buy') {
    const usdcBalance = toFiniteNumber(walletBalance.usdc) ?? 0;
    return usdcBalance >= estimatedAmount;
  }

  const targetBalance = walletBalance.tokens.find(
    (token) => token.mint === contractAddress,
  );
  const tokenBalance = toFiniteNumber(targetBalance?.amount) ?? 0;
  return tokenBalance >= estimatedAmount;
}

export async function dbSetupRequired(db: D1Database): Promise<boolean> {
  await dbEnsureSchema(db);
  const result = await db
    .prepare('SELECT COUNT(*) AS cnt FROM users')
    .first<{ cnt: number }>();
  return (result?.cnt ?? 0) === 0;
}

export async function dbCreateUser(
  db: D1Database,
  username: string,
  password: string,
): Promise<SessionUser> {
  validateUsername(username);
  validatePassword(password);
  const passwordHash = await hashPassword(password);
  const createdAt = nowTs();
  try {
    await db
      .prepare(
        'INSERT INTO users (username, password_hash, role, created_at) VALUES (?1, ?2, ?3, ?4)',
      )
      .bind(username.trim(), passwordHash, 'admin', createdAt)
      .run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      throw new ApiError(409, 'Username already exists');
    }
    throw err;
  }
  const user = await db
    .prepare(
      'SELECT id, username, role FROM users WHERE username = ?1',
    )
    .bind(username.trim())
    .first<SessionUser>();
  if (!user) throw new ApiError(500, 'Failed to create user');
  return user;
}

export async function dbAuthenticateUser(
  db: D1Database,
  username: string,
  password: string,
): Promise<SessionUser> {
  const row = await db
    .prepare(
      'SELECT id, username, password_hash, role FROM users WHERE username = ?1',
    )
    .bind(username.trim())
    .first<{ id: number; username: string; password_hash: string; role: string }>();
  if (!row) throw new ApiError(401, 'Invalid username or password');
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) throw new ApiError(401, 'Invalid username or password');
  return { id: row.id, username: row.username, role: row.role };
}

export async function dbVerifyUserPassword(
  db: D1Database,
  userId: number,
  password: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ password_hash: string }>();
  if (!row) {
    throw new ApiError(401, 'User not found');
  }
  return verifyPassword(password, row.password_hash);
}

export async function dbCreateSession(
  db: D1Database,
  userId: number,
  ttlHours: number,
): Promise<string> {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const createdAt = nowTs();
  const expiresAt = createdAt + ttlHours * 3600;
  const sessionId = `sess-${tokenHash}`;
  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(sessionId, userId, tokenHash, expiresAt, createdAt)
    .run();
  return token;
}

export async function dbGetUserBySessionToken(
  db: D1Database,
  token: string,
): Promise<SessionUser | null> {
  const tokenHash = await sha256Hex(token);
  const now = nowTs();
  // Prune expired sessions
  await db
    .prepare('DELETE FROM sessions WHERE expires_at <= ?1')
    .bind(now)
    .run();
  const user = await db
    .prepare(
      `SELECT users.id, users.username, users.role
       FROM sessions
       INNER JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2`,
    )
    .bind(tokenHash, now)
    .first<SessionUser>();
  return user ?? null;
}

export async function dbDeleteSession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db
    .prepare('DELETE FROM sessions WHERE token_hash = ?1')
    .bind(tokenHash)
    .run();
}

export async function dbDeleteOtherSessions(
  db: D1Database,
  userId: number,
  exceptToken: string | null,
): Promise<void> {
  if (exceptToken) {
    const exceptTokenHash = await sha256Hex(exceptToken);
    await db
      .prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2')
      .bind(userId, exceptTokenHash)
      .run();
    return;
  }
  await db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId).run();
}

export async function dbSaveSettings(
  db: D1Database,
  userId: number,
  update: SettingsUpdateRequest,
): Promise<void> {
  validateContractAddress(update.contractAddress);
  const normalizedContractAddress = update.contractAddress.trim()
    ? normalizePubkey(update.contractAddress)
    : '';
  if (update.volatilityTarget < 0 || update.volatilityTarget > 100) {
    throw new ApiError(400, 'Volatility target must be between 0 and 100');
  }
  if (update.pullbackTarget < 0 || update.pullbackTarget > 100) {
    throw new ApiError(400, 'Pullback target must be between 0 and 100');
  }
  if (update.maxSlippage < 0 || update.maxSlippage > 100) {
    throw new ApiError(400, 'Max slippage must be between 0 and 100');
  }
  if (update.maxTransactions <= 0) {
    throw new ApiError(400, 'Max transactions must be greater than zero');
  }
  const allowedRanges = ['1h', '6h', '12h', '24h', '3d', '1w'];
  if (!allowedRanges.includes(update.timeRangeTarget)) {
    throw new ApiError(400, 'Unsupported time range target');
  }

  const pairs: [string, string][] = [
    ['contractAddress', normalizedContractAddress],
    ['volatilityTarget', String(update.volatilityTarget)],
    ['pullbackTarget', String(update.pullbackTarget)],
    ['volumeTarget', String(update.volumeTarget)],
    ['netBuyinTarget', String(update.netBuyinTarget)],
    ['timeRangeTarget', update.timeRangeTarget],
    ['maxTransactions', String(update.maxTransactions)],
    ['maxSlippage', String(update.maxSlippage)],
    ['strategyNotes', update.strategyNotes.trim()],
  ];

  const stmts = pairs.map(([key, value]) =>
    db
      .prepare(
        'INSERT INTO settings (user_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
      )
      .bind(userId, key, value),
  );
  await db.batch(stmts);
}

export async function dbSaveActiveContractAddress(
  db: D1Database,
  userId: number,
  contractAddress: string,
): Promise<string> {
  validateContractAddress(contractAddress);
  const normalizedContractAddress = contractAddress.trim()
    ? normalizePubkey(contractAddress)
    : '';
  await db
    .prepare(
      'INSERT INTO settings (user_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
    )
    .bind(userId, 'contractAddress', normalizedContractAddress)
    .run();
  return normalizedContractAddress;
}

export async function dbLoadSettings(
  db: D1Database,
  userId: number,
): Promise<SettingsState> {
  const settings: SettingsState = {
    contractAddress: '',
    volatilityTarget: 4.5,
    pullbackTarget: 2,
    volumeTarget: 0,
    netBuyinTarget: 0,
    timeRangeTarget: '24h',
    maxTransactions: 100,
    maxSlippage: 1,
    strategyNotes:
      'Trading execution is intentionally disabled until a real execution engine is implemented and reviewed.',
    managedKeyCount: 0,
  };

  const managedCount = await db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM accounts WHERE user_id = ?1 AND type = 'managed'",
    )
    .bind(userId)
    .first<{ cnt: number }>();
  settings.managedKeyCount = managedCount?.cnt ?? 0;

  const rows = await db
    .prepare('SELECT key, value FROM settings WHERE user_id = ?1')
    .bind(userId)
    .all<{ key: string; value: string }>();

  for (const row of rows.results) {
    switch (row.key) {
      case 'contractAddress':
        settings.contractAddress = row.value;
        break;
      case 'volatilityTarget':
        settings.volatilityTarget =
          parseFloat(row.value) || settings.volatilityTarget;
        break;
      case 'pullbackTarget':
        settings.pullbackTarget =
          parseFloat(row.value) || settings.pullbackTarget;
        break;
      case 'volumeTarget':
        settings.volumeTarget = parseFloat(row.value) || 0;
        break;
      case 'netBuyinTarget':
        settings.netBuyinTarget = parseFloat(row.value) || 0;
        break;
      case 'timeRangeTarget':
        settings.timeRangeTarget = row.value;
        break;
      case 'maxTransactions':
        settings.maxTransactions =
          parseInt(row.value, 10) || settings.maxTransactions;
        break;
      case 'maxSlippage':
        settings.maxSlippage = parseFloat(row.value) || settings.maxSlippage;
        break;
      case 'strategyNotes':
        settings.strategyNotes = row.value;
        break;
    }
  }
  return settings;
}

export async function dbListAccounts(
  db: D1Database,
  userId: number,
  type: string,
): Promise<AccountRecord[]> {
  const rows = await db
    .prepare(
      'SELECT id, label, wallet_address, type, created_at FROM accounts WHERE user_id = ?1 AND type = ?2 ORDER BY created_at DESC, id DESC',
    )
    .bind(userId, type)
    .all<{
      id: number;
      label: string;
      wallet_address: string;
      type: string;
      created_at: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    label: row.label,
    address: row.wallet_address,
    type: row.type,
    createdAt: row.created_at,
  }));
}

export async function dbListManagedAccountAddresses(
  db: D1Database,
  userId: number,
): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT wallet_address FROM accounts WHERE user_id = ?1 AND type = 'managed' ORDER BY created_at DESC, id DESC",
    )
    .bind(userId)
    .all<{ wallet_address: string }>();
  return rows.results.map((row) => row.wallet_address);
}

export async function dbGetManagedAccountById(
  db: D1Database,
  userId: number,
  accountId: number,
): Promise<AccountRecord> {
  await dbEnsureSchema(db);
  const row = await db
    .prepare(
      `SELECT id, label, wallet_address, type, created_at
       FROM accounts
       WHERE user_id = ?1 AND id = ?2 AND type = 'managed' AND COALESCE(is_active, 1) = 1
       LIMIT 1`,
    )
    .bind(userId, accountId)
    .first<{
      id: number;
      label: string;
      wallet_address: string;
      type: string;
      created_at: number;
    }>();
  if (!row) {
    throw new ApiError(404, `Managed account ${accountId} was not found for the current user`);
  }
  return {
    id: row.id,
    label: row.label,
    address: row.wallet_address,
    type: row.type,
    createdAt: row.created_at,
  };
}

export async function dbLoadManagedKeypairBytesByAccountId(
  db: D1Database,
  userId: number,
  accountId: number,
  encryptionKeyStr: string,
): Promise<Uint8Array> {
  const account = await dbGetManagedAccountById(db, userId, accountId);
  return dbLoadManagedKeypairBytes(db, userId, account.address, encryptionKeyStr);
}

export async function getAvailableAccount(
  db: D1Database,
  userId: number,
  action: 'buy' | 'sell',
  estimatedAmount: number,
  options?: {
    envRpcUrl?: string;
    cooldownMs?: number;
  },
): Promise<AvailableAccountRecord | null> {
  await dbEnsureTradeDomainSchema(db);
  const normalizedEstimatedAmount =
    Number.isFinite(estimatedAmount) && estimatedAmount > 0 ? estimatedAmount : 0;
  if (normalizedEstimatedAmount <= 0) {
    return null;
  }

  const settings = await dbLoadSettings(db, userId);
  const contractAddress = settings.contractAddress.trim()
    ? normalizePubkey(settings.contractAddress)
    : '';
  if (action === 'sell' && (!contractAddress || contractAddress === SOLANA_USDC_MINT)) {
    return null;
  }

  const candidateRows = await db
    .prepare(
      `SELECT
         a.id,
         a.label,
         a.wallet_address,
         a.type,
         a.created_at,
         COALESCE(a.is_active, 1) AS is_active,
         (
           SELECT MAX(COALESCE(tl.updated_at, tl.created_at))
           FROM trade_logs tl
           WHERE tl.wallet_address = a.wallet_address
         ) AS last_traded_at
       FROM accounts a
       WHERE a.user_id = ?1
         AND a.type = 'managed'
         AND COALESCE(a.is_active, 1) = 1`,
    )
    .bind(userId)
    .all<{
      id: number;
      label: string;
      wallet_address: string;
      type: string;
      created_at: number;
      is_active: number;
      last_traded_at: number | null;
    }>();

  const candidates = [...candidateRows.results].sort((left, right) =>
    compareLeastRecentlyUsed(
      {
        id: left.id,
        createdAt: left.created_at,
        lastTradedAt: normalizeTimestampMs(left.last_traded_at),
      },
      {
        id: right.id,
        createdAt: right.created_at,
        lastTradedAt: normalizeTimestampMs(right.last_traded_at),
      },
    ),
  );
  if (candidates.length === 0) {
    return null;
  }

  const tradableTokens = await dbListTradableTokens(db);
  const rpcUrls = await dbResolveSolanaRpcUrls(db, userId, options?.envRpcUrl);
  const cooldownMs = options?.cooldownMs ?? ACCOUNT_TRADE_COOLDOWN_MS;
  const now = Date.now();

  for (const candidate of candidates) {
    const lastTradedAtMs = normalizeTimestampMs(candidate.last_traded_at);
    if (lastTradedAtMs != null && cooldownMs > 0 && now - lastTradedAtMs < cooldownMs) {
      continue;
    }

    const walletBalance = await loadWalletBalance(
      candidate.wallet_address,
      settings,
      tradableTokens,
      rpcUrls,
    );
    if (!hasSufficientBalance(action, normalizedEstimatedAmount, contractAddress, walletBalance)) {
      continue;
    }

    return {
      id: candidate.id,
      label: candidate.label,
      address: candidate.wallet_address,
      type: candidate.type,
      createdAt: candidate.created_at,
      isActive: candidate.is_active !== 0,
      lastTradedAt: lastTradedAtMs,
      walletBalance,
    };
  }

  return null;
}

export async function dbImportWatchAccount(
  db: D1Database,
  userId: number,
  label: string,
  addressInput: string,
): Promise<AccountRecord> {
  validateLabel(label);
  const address = normalizePubkey(addressInput);
  const createdAt = nowTs();
  try {
    await db
      .prepare(
        "INSERT INTO accounts (user_id, type, label, wallet_address, encrypted_private_key, created_at) VALUES (?1, 'watch', ?2, ?3, NULL, ?4)",
      )
      .bind(userId, label.trim(), address, createdAt)
      .run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      throw new ApiError(409, 'Account already imported for this user');
    }
    throw err;
  }
  const row = await db
    .prepare(
      "SELECT id FROM accounts WHERE user_id = ?1 AND type = 'watch' AND wallet_address = ?2",
    )
    .bind(userId, address)
    .first<{ id: number }>();
  return {
    id: row?.id ?? 0,
    label: label.trim(),
    address,
    type: 'watch',
    createdAt,
  };
}

export async function dbImportManagedKey(
  db: D1Database,
  userId: number,
  label: string,
  privateKeyRaw: string,
  encryptionKeyStr: string,
): Promise<AccountRecord> {
  validateLabel(label);
  const keypairBytes = normalizePrivateKey(privateKeyRaw);
  return dbImportManagedKeyBytes(
    db,
    userId,
    label,
    keypairBytes,
    encryptionKeyStr,
  );
}

export async function dbImportManagedKeyBytes(
  db: D1Database,
  userId: number,
  label: string,
  keypairBytes: Uint8Array,
  encryptionKeyStr: string,
): Promise<AccountRecord> {
  validateLabel(label);
  const address = solanaPubkeyFromKeypairBytes(keypairBytes);
  const encryptedKey = await encryptPrivateKey(keypairBytes, encryptionKeyStr);
  const createdAt = nowTs();
  try {
    await db
      .prepare(
        "INSERT INTO accounts (user_id, type, label, wallet_address, encrypted_private_key, created_at) VALUES (?1, 'managed', ?2, ?3, ?4, ?5)",
      )
      .bind(userId, label.trim(), address, encryptedKey, createdAt)
      .run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      throw new ApiError(409, 'Managed account already imported for this user');
    }
    throw err;
  }
  const row = await db
    .prepare(
      "SELECT id FROM accounts WHERE user_id = ?1 AND type = 'managed' AND wallet_address = ?2",
    )
    .bind(userId, address)
    .first<{ id: number }>();
  return {
    id: row?.id ?? 0,
    label: label.trim(),
    address,
    type: 'managed',
    createdAt,
  };
}

export async function dbLoadManagedKeypairBytes(
  db: D1Database,
  userId: number,
  walletAddress: string,
  encryptionKeyStr: string,
): Promise<Uint8Array> {
  const normalizedAddress = normalizePubkey(walletAddress);
  const row = await db
    .prepare(
      `SELECT type, encrypted_private_key
       FROM accounts
       WHERE user_id = ?1 AND wallet_address = ?2
       ORDER BY CASE WHEN type = 'managed' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .bind(userId, normalizedAddress)
    .first<{
      type: string;
      encrypted_private_key: string | null;
    }>();
  if (!row) {
    throw new ApiError(
      404,
      `Wallet ${normalizedAddress} is not imported for the current user`,
    );
  }
  if (row.type !== 'managed') {
    throw new ApiError(
      400,
      `Wallet ${normalizedAddress} is imported as watch-only. Import its private key in Admin before using it as a signing wallet`,
    );
  }
  if (!row.encrypted_private_key) {
    throw new ApiError(
      500,
      `Managed wallet ${normalizedAddress} is missing encrypted key material`,
    );
  }
  return decryptPrivateKey(row.encrypted_private_key, encryptionKeyStr);
}

export async function dbAddAuditLog(
  db: D1Database,
  userId: number,
  action: string,
  target: string,
  details: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_logs (user_id, action, target, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(userId, action, target, details, nowTs())
    .run();
}

export async function dbListAuditLogs(
  db: D1Database,
  userId: number,
  username: string,
): Promise<AuditLog[]> {
  const rows = await db
    .prepare(
      'SELECT id, action, target, details, created_at FROM audit_logs WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 50',
    )
    .bind(userId)
    .all<{
      id: number;
      action: string;
      target: string;
      details: string;
      created_at: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    action: row.action,
    target: row.target,
    details: row.details,
    actor: username,
    createdAt: row.created_at,
  }));
}

export async function dbListTradeLogs(db: D1Database): Promise<TradeLogRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `SELECT
         tl.id,
         tl.token_id,
         tl.wallet_address,
         tl.action,
         tl.requested_amount,
         tl.executed_amount,
         tl.executed_price,
         tl.tx_signature,
         tl.status,
         tl.error_message,
         tl.created_at,
         tl.updated_at,
         tt.contract_address,
         tt.symbol
       FROM trade_logs tl
       LEFT JOIN tradable_tokens tt ON tt.id = tl.token_id
       ORDER BY tl.created_at DESC, tl.id DESC
       LIMIT 50`,
    )
    .all<{
      id: number;
      token_id: number;
      wallet_address: string;
      action: 'BUY' | 'SELL';
      requested_amount: number;
      executed_amount: number | null;
      executed_price: number | null;
      tx_signature: string | null;
      status: 'PENDING' | 'SUCCESS' | 'FAILED';
      error_message: string | null;
      created_at: number;
      updated_at: number;
      contract_address: string | null;
      symbol: string | null;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    tokenId: row.token_id,
    tokenContractAddress: row.contract_address,
    tokenSymbol: row.symbol,
    walletAddress: row.wallet_address,
    action: row.action,
    requestedAmount: row.requested_amount,
    executedAmount: row.executed_amount,
    executedPrice: row.executed_price,
    txSignature: row.tx_signature,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function dbListWebhookTransactionLogs(
  db: D1Database,
  userId: number,
): Promise<WebhookTransactionLogRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const [rows, tokens] = await Promise.all([
    db
      .prepare(
        `SELECT
           id,
           event_type,
           wallet_address,
           tx_signature,
           payload,
           details_json,
           processed,
           error_message,
           created_at
         FROM signals
         WHERE source LIKE ?1
         ORDER BY created_at DESC, id DESC
         LIMIT 200`,
      )
      .bind(`%:user:${userId}`)
      .all<{
        id: number;
        event_type: string;
        wallet_address: string | null;
        tx_signature: string | null;
        payload: string;
        details_json: string | null;
        processed: number;
        error_message: string | null;
        created_at: number;
      }>(),
    db
      .prepare(
        'SELECT contract_address, symbol FROM tradable_tokens WHERE network = ?1',
      )
      .bind('solana')
      .all<{
        contract_address: string;
        symbol: string | null;
      }>(),
  ]);

  const symbolByContract = new Map<string, string | null>();
  for (const token of tokens.results) {
    symbolByContract.set(normalizePubkey(token.contract_address), token.symbol);
  }

  const grouped = new Map<string, typeof rows.results>();
  const orderedKeys: string[] = [];

  for (const row of rows.results) {
    const key = row.tx_signature?.trim() || `signal:${row.id}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, [row]);
      orderedKeys.push(key);
    } else {
      existing.push(row);
    }
  }

  return orderedKeys.slice(0, 50).map((key) => {
    const group = grouped.get(key) ?? [];
    const firstRow = group[0];
    const mergedDetails = mergeStoredSignalTransactionDetails(
      ...group.map((row) => parseStoredSignalTransactionDetails(row.details_json)),
      {
        tokenContractAddress:
          group
            .flatMap((row) => extractStoredSignalContractAddresses(row.payload))
            .find((address) => address !== SOLANA_USDC_MINT) ??
          group.flatMap((row) => extractStoredSignalContractAddresses(row.payload))[0] ??
          null,
      },
    );
    const tokenContractAddress = mergedDetails.tokenContractAddress;
    const hasFailed = group.some(
      (row) => !!row.error_message || mergedDetails.transactionStatus === 'FAILED',
    );
    const hasPending = group.some(
      (row) => !row.error_message && row.processed !== 1,
    );
    const status: WebhookTransactionLogRecord['status'] = hasFailed
      ? 'FAILED'
      : hasPending || mergedDetails.transactionStatus === 'PENDING'
        ? 'PENDING'
        : 'CONFIRMED';

    return {
      id: firstRow.id,
      tokenContractAddress,
      tokenSymbol: tokenContractAddress
        ? (symbolByContract.get(tokenContractAddress) ?? null)
        : null,
      walletAddress: mergedDetails.primaryWalletAddress ?? firstRow.wallet_address,
      fromWalletAddress: mergedDetails.fromWalletAddress,
      toWalletAddress: mergedDetails.toWalletAddress,
      action: mergedDetails.action,
      usdcAmount: mergedDetails.usdcAmount,
      tokenAmount: mergedDetails.tokenAmount,
      feeAmountUsd: mergedDetails.feeAmountUsd,
      source: mergedDetails.source,
      eventType: firstRow.event_type,
      txSignature: firstRow.tx_signature,
      status,
      errorMessage: firstRow.error_message,
      createdAt: firstRow.created_at,
    };
  });
}

export async function dbListRecentSignalsForDebug(
  db: D1Database,
  userId: number,
  limit: number,
): Promise<Array<{
  id: number;
  source: string;
  externalId: string;
  eventType: string;
  walletAddress: string | null;
  txSignature: string | null;
  processed: number;
  errorMessage: string | null;
  createdAt: number;
  contractAddresses: string[];
  details: StoredSignalTransactionDetails | null;
  payloadPreview: string;
}>> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `SELECT
         id,
         source,
         external_id,
         event_type,
         wallet_address,
         tx_signature,
         processed,
         error_message,
         created_at,
         details_json,
         payload
       FROM signals
       WHERE source LIKE ?1
       ORDER BY created_at DESC, id DESC
       LIMIT ?2`,
    )
    .bind(`%:user:${userId}`, limit)
    .all<{
      id: number;
      source: string;
      external_id: string;
      event_type: string;
      wallet_address: string | null;
      tx_signature: string | null;
      processed: number;
      error_message: string | null;
      created_at: number;
      details_json: string | null;
      payload: string;
    }>();

  return rows.results.map((row) => ({
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    eventType: row.event_type,
    walletAddress: row.wallet_address,
    txSignature: row.tx_signature,
    processed: row.processed,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    contractAddresses: extractStoredSignalContractAddresses(row.payload),
    details: parseStoredSignalTransactionDetails(row.details_json),
    payloadPreview: row.payload.slice(0, 2000),
  }));
}

