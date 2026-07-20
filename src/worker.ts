/// <reference types="@cloudflare/workers-types" />

// ─── environment bindings ────────────────────────────────────────────────────

export interface Env {
  TRADINGBOT_DB: D1Database;
  ASSETS: Fetcher;
  /** 32-byte key encoded as base64 or hex; required for private-key import */
  PRIVATE_KEY_ENCRYPTION_KEY?: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

const COOKIE_NAME = 'te_session';
const SESSION_TTL_HOURS = 12;
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// ─── types (mirror frontend type shapes) ─────────────────────────────────────

interface SettingsState {
  contractAddress: string;
  volatilityTarget: number;
  pullbackTarget: number;
  volumeTarget: number;
  netBuyinTarget: number;
  timeRangeTarget: string;
  maxTransactions: number;
  maxSlippage: number;
  strategyNotes: string;
  managedKeyCount: number;
}

interface SettingsUpdateRequest {
  contractAddress: string;
  volatilityTarget: number;
  pullbackTarget: number;
  volumeTarget: number;
  netBuyinTarget: number;
  timeRangeTarget: string;
  maxTransactions: number;
  maxSlippage: number;
  strategyNotes: string;
}

interface AccountRecord {
  id: number;
  label: string;
  address: string;
  type: string;
  createdAt: number;
}

interface AuditLog {
  id: number;
  action: string;
  target: string;
  details: string;
  actor: string;
  createdAt: number;
}

interface TradableToken {
  id: number;
  network: string;
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  isActive: boolean;
}

interface SessionUser {
  id: number;
  username: string;
  role: string;
}

// ─── error class ─────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ─── response helpers ─────────────────────────────────────────────────────────

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return jsonResponse({ error: err.message }, err.status);
  }
  console.error('Unexpected error:', err);
  return jsonResponse({ error: 'Internal server error' }, 500);
}

// ─── misc helpers ─────────────────────────────────────────────────────────────

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

async function sha256Hex(value: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ─── base58 encode / decode ───────────────────────────────────────────────────

function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of s) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid base58 character');
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of s) {
    if (char === '1') bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}

function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = '';
  for (const byte of bytes) {
    if (byte === 0) result += '1';
    else break;
  }
  return result + digits.reverse().map((d) => BASE58_ALPHABET[d]).join('');
}

// ─── password hashing (PBKDF2 via SubtleCrypto) ───────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const hashHex = Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const saltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `pbkdf2:sha256:210000:${saltHex}:${hashHex}`;
}

async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, , iterStr, saltHex, expectedHash] = parts;
  const iterations = parseInt(iterStr, 10);
  const salt = new Uint8Array(
    (saltHex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)),
  );
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const computedHash = Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (computedHash.length !== expectedHash.length) return false;
  // Constant-time comparison
  let diff = 0;
  for (let i = 0; i < computedHash.length; i++) {
    diff |= computedHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}

// ─── AES-256-GCM private-key encryption ──────────────────────────────────────

function parseEncryptionKey(keyStr: string): Uint8Array {
  const trimmed = keyStr.trim();
  // Try base64 (44 chars for 32 bytes)
  try {
    const raw = atob(trimmed);
    if (raw.length === 32) {
      return new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
    }
  } catch {
    // not valid base64
  }
  // Try hex (64 hex chars for 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return new Uint8Array(
      (trimmed.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)),
    );
  }
  throw new ApiError(
    503,
    'PRIVATE_KEY_ENCRYPTION_KEY must be base64 or hex and decode to exactly 32 bytes',
  );
}

async function encryptPrivateKey(
  secretBytes: Uint8Array,
  keyStr: string,
): Promise<string> {
  const keyBytes = parseEncryptionKey(keyStr);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    secretBytes,
  );
  const payload = new Uint8Array(12 + ciphertext.byteLength);
  payload.set(iv);
  payload.set(new Uint8Array(ciphertext), 12);
  let binary = '';
  payload.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

// ─── Solana key helpers ───────────────────────────────────────────────────────

function normalizePrivateKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (!trimmed) throw new ApiError(400, 'Private key is required');
  if (trimmed.startsWith('[')) {
    let values: number[];
    try {
      values = JSON.parse(trimmed) as number[];
    } catch {
      throw new ApiError(400, 'Private key JSON array could not be parsed');
    }
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'number')) {
      throw new ApiError(400, 'Private key JSON array could not be parsed');
    }
    return new Uint8Array(values);
  }
  try {
    return base58Decode(trimmed);
  } catch {
    throw new ApiError(
      400,
      'Private key must be a base58 string or JSON array',
    );
  }
}

/** Extract the base58-encoded public key from a 64-byte Solana keypair. */
function solanaPubkeyFromKeypairBytes(keypairBytes: Uint8Array): string {
  if (keypairBytes.length !== 64) {
    throw new ApiError(
      400,
      'Private key must decode to a 64-byte Solana keypair',
    );
  }
  // Solana keypair layout: [32-byte seed | 32-byte public key]
  return base58Encode(keypairBytes.slice(32));
}

function normalizePubkey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ApiError(400, 'Account address is required');
  try {
    const decoded = base58Decode(trimmed);
    if (decoded.length !== 32) throw new Error('wrong length');
    return base58Encode(decoded);
  } catch {
    throw new ApiError(
      400,
      'Account address must be a valid Solana public key',
    );
  }
}

function validateContractAddress(value: string): void {
  if (!value.trim()) return;
  normalizePubkey(value);
}

// ─── input validation ─────────────────────────────────────────────────────────

function validateLabel(label: string): void {
  const t = label.trim();
  if (t.length < 3 || t.length > 80) {
    throw new ApiError(400, 'Label must be between 3 and 80 characters');
  }
}

function validateUsername(username: string): void {
  const t = username.trim();
  if (t.length < 3 || t.length > 64) {
    throw new ApiError(400, 'Username must be between 3 and 64 characters');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(t)) {
    throw new ApiError(
      400,
      "Username may only include letters, numbers, '.', '_' and '-'",
    );
  }
}

function validatePassword(password: string): void {
  if (password.length < 12) {
    throw new ApiError(400, 'Password must be at least 12 characters');
  }
}

// ─── cookie helpers ───────────────────────────────────────────────────────────

function sessionTokenFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}

function buildSessionCookie(
  token: string,
  ttlHours: number,
  secure: boolean,
): string {
  const maxAge = ttlHours * 3600;
  return (
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}` +
    (secure ? '; Secure' : '')
  );
}

function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

// ─── D1 database operations ───────────────────────────────────────────────────

const D1_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    encrypted_private_key TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, type, wallet_address),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_accounts_user_type ON accounts(user_id, type)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created_at ON audit_logs(user_id, created_at DESC)',
];

interface CredentialsBody {
  username: string;
  password: string;
}

let schemaInitPromise: Promise<void> | undefined;

async function dbEnsureSchema(db: D1Database): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = db
      .batch(D1_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
      .catch((err) => {
        schemaInitPromise = undefined;
        throw err;
      });
  }
  await schemaInitPromise;
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json<T>();
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON');
  }
}

function parseCredentialsBody(body: unknown): CredentialsBody {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Username and password are required');
  }
  const { username, password } = body as {
    username?: unknown;
    password?: unknown;
  };
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new ApiError(400, 'Username and password are required');
  }
  return { username, password };
}

async function dbSetupRequired(db: D1Database): Promise<boolean> {
  await dbEnsureSchema(db);
  const result = await db
    .prepare('SELECT COUNT(*) AS cnt FROM users')
    .first<{ cnt: number }>();
  return (result?.cnt ?? 0) === 0;
}

async function dbCreateUser(
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

async function dbAuthenticateUser(
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

async function dbCreateSession(
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

async function dbGetUserBySessionToken(
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

async function dbDeleteSession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db
    .prepare('DELETE FROM sessions WHERE token_hash = ?1')
    .bind(tokenHash)
    .run();
}

async function dbSaveSettings(
  db: D1Database,
  userId: number,
  update: SettingsUpdateRequest,
): Promise<void> {
  validateContractAddress(update.contractAddress);
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
    ['contractAddress', update.contractAddress],
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

async function dbLoadSettings(
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

async function dbListAccounts(
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

async function dbImportWatchAccount(
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

async function dbImportManagedKey(
  db: D1Database,
  userId: number,
  label: string,
  privateKeyRaw: string,
  encryptionKeyStr: string,
): Promise<AccountRecord> {
  validateLabel(label);
  const keypairBytes = normalizePrivateKey(privateKeyRaw);
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

async function dbAddAuditLog(
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

async function dbListAuditLogs(
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

async function dbListTradableTokens(db: D1Database): Promise<TradableToken[]> {
  const rows = await db
    .prepare(
      'SELECT id, network, contract_address, symbol, name, decimals, is_active FROM tradable_tokens ORDER BY id ASC',
    )
    .all<{
      id: number;
      network: string;
      contract_address: string;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      is_active: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    network: row.network,
    contractAddress: row.contract_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    isActive: row.is_active === 1,
  }));
}

// ─── auth middleware helpers ──────────────────────────────────────────────────

async function requireUser(request: Request, env: Env): Promise<SessionUser> {
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (!token) throw new ApiError(401, 'Login required');
  const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
  if (!user) throw new ApiError(401, 'Login required');
  return user;
}

async function requireAdmin(request: Request, env: Env): Promise<SessionUser> {
  const user = await requireUser(request, env);
  if (user.role !== 'admin') {
    throw new ApiError(403, 'Admin permissions are required for this action');
  }
  return user;
}

// ─── route handlers ───────────────────────────────────────────────────────────

// GET /api/health
async function handleHealth(_req: Request, env: Env): Promise<Response> {
  // Verify DB connectivity with a lightweight query
  await env.TRADINGBOT_DB.prepare('SELECT 1').first();
  return jsonResponse({
    ok: true,
    backend: 'cloudflare-worker',
    databaseConnected: true,
    databasePath: 'D1:tradingbot',
  });
}

// GET /api/auth/status
async function handleAuthStatus(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (setupRequired) {
    return jsonResponse({ setupRequired: true, authenticated: false, user: null });
  }
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (!token) {
    return jsonResponse({ setupRequired: false, authenticated: false, user: null });
  }
  const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
  return jsonResponse({
    setupRequired: false,
    authenticated: !!user,
    user: user ? { username: user.username, role: user.role } : null,
  });
}

// POST /api/auth/bootstrap
async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (!setupRequired) {
    throw new ApiError(
      403,
      'Bootstrap is disabled because an admin user already exists',
    );
  }
  const body = parseCredentialsBody(await parseJsonBody<unknown>(request));
  const user = await dbCreateUser(
    env.TRADINGBOT_DB,
    body.username,
    body.password,
  );
  const token = await dbCreateSession(
    env.TRADINGBOT_DB,
    user.id,
    SESSION_TTL_HOURS,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'auth.bootstrap',
    user.username,
    'Created initial admin account',
  );
  return jsonResponse(
    { authenticated: true, user: { username: user.username, role: user.role } },
    201,
    { 'Set-Cookie': buildSessionCookie(token, SESSION_TTL_HOURS, isSecure(request)) },
  );
}

// POST /api/auth/login
async function handleLogin(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (setupRequired) {
    throw new ApiError(
      403,
      'Initial admin setup is required before login. Create an admin account first.',
    );
  }
  const body = parseCredentialsBody(await parseJsonBody<unknown>(request));
  const user = await dbAuthenticateUser(
    env.TRADINGBOT_DB,
    body.username,
    body.password,
  );
  const token = await dbCreateSession(
    env.TRADINGBOT_DB,
    user.id,
    SESSION_TTL_HOURS,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'auth.login',
    user.username,
    'Authenticated admin session',
  );
  return jsonResponse(
    { authenticated: true, user: { username: user.username, role: user.role } },
    200,
    { 'Set-Cookie': buildSessionCookie(token, SESSION_TTL_HOURS, isSecure(request)) },
  );
}

// POST /api/auth/logout
async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (token) {
    const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
    await dbDeleteSession(env.TRADINGBOT_DB, token);
    if (user) {
      await dbAddAuditLog(
        env.TRADINGBOT_DB,
        user.id,
        'auth.logout',
        user.username,
        'Ended admin session',
      );
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
  });
}

// GET /api/state
async function handleGetState(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const [settings, internalAccs, outsiderAccs, logs, tradableTokens] =
    await Promise.all([
      dbLoadSettings(env.TRADINGBOT_DB, user.id),
      dbListAccounts(env.TRADINGBOT_DB, user.id, 'managed'),
      dbListAccounts(env.TRADINGBOT_DB, user.id, 'watch'),
      dbListAuditLogs(env.TRADINGBOT_DB, user.id, user.username),
      dbListTradableTokens(env.TRADINGBOT_DB).catch((err: unknown) => {
        // Only swallow "no such table" errors that occur before the migration runs.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('no such table')) return [] as TradableToken[];
        throw err;
      }),
    ]);
  return jsonResponse({
    auth: { username: user.username, role: user.role },
    settings,
    internalAccs,
    outsiderAccs,
    logs,
    tradableTokens,
    stats: {
      managedAccounts: internalAccs.length,
      watchedAccounts: outsiderAccs.length,
      tradeExecutionEnabled: false,
    },
    system: {
      backend: 'cloudflare-worker',
      databasePath: 'D1:tradingbot',
      databaseConnected: true,
    },
  });
}

// POST /api/settings
async function handleSaveSettings(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = await request.json<SettingsUpdateRequest>();
  await dbSaveSettings(env.TRADINGBOT_DB, user.id, body);
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'settings.updated',
    'settings',
    'Trading settings were updated',
  );
  const updated = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  return jsonResponse(updated);
}

// POST /api/private-keys/import
async function handleImportPrivateKey(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.PRIVATE_KEY_ENCRYPTION_KEY) {
    throw new ApiError(
      503,
      'PRIVATE_KEY_ENCRYPTION_KEY is not configured on the server',
    );
  }
  const user = await requireAdmin(request, env);
  const body = await request.json<{ label: string; privateKey: string }>();
  const account = await dbImportManagedKey(
    env.TRADINGBOT_DB,
    user.id,
    body.label,
    body.privateKey,
    env.PRIVATE_KEY_ENCRYPTION_KEY,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'private_key.imported',
    account.address,
    `Imported managed key '${account.label}'. Private key material was encrypted at rest and is never returned by the API.`,
  );
  return jsonResponse({ account }, 201);
}

// POST /api/accounts/import
async function handleImportAccount(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = await request.json<{ label: string; address: string }>();
  const account = await dbImportWatchAccount(
    env.TRADINGBOT_DB,
    user.id,
    body.label,
    body.address,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'account.imported',
    account.address,
    `Imported watch-only account '${account.label}'.`,
  );
  return jsonResponse({ account }, 201);
}

// POST /api/trade
async function handleTrade(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = await request.json<{ symbol?: string; action?: string }>();
  const symbol = body.symbol ?? 'unknown';
  const action = body.action ?? 'unspecified';
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'trade.execution_blocked',
    symbol,
    `Received blocked trade execution request for action '${action}'. Real trade execution is not implemented.`,
  );
  throw new ApiError(
    501,
    'Trade execution is intentionally not implemented in this Worker yet.',
  );
}

// ─── API router ───────────────────────────────────────────────────────────────

async function handleApi(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const { pathname } = url;
  const { method } = request;

  try {
    if (method === 'GET' && pathname === '/api/health')
      return await handleHealth(request, env);
    if (method === 'GET' && pathname === '/api/auth/status')
      return await handleAuthStatus(request, env);
    if (method === 'POST' && pathname === '/api/auth/bootstrap')
      return await handleBootstrap(request, env);
    if (method === 'POST' && pathname === '/api/auth/login')
      return await handleLogin(request, env);
    if (method === 'POST' && pathname === '/api/auth/logout')
      return await handleLogout(request, env);
    if (method === 'GET' && pathname === '/api/state')
      return await handleGetState(request, env);
    if (method === 'POST' && pathname === '/api/settings')
      return await handleSaveSettings(request, env);
    if (method === 'POST' && pathname === '/api/private-keys/import')
      return await handleImportPrivateKey(request, env);
    if (method === 'POST' && pathname === '/api/accounts/import')
      return await handleImportAccount(request, env);
    if (method === 'POST' && pathname === '/api/trade')
      return await handleTrade(request, env);
    return jsonResponse({ error: 'Not found' }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── Worker entry point ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env);
    }

    // Pass all other requests through to the static assets binding
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
