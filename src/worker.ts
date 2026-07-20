/// <reference types="@cloudflare/workers-types" />

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from 'micro-ed25519-hdkey';
import nacl from 'tweetnacl';

// ─── environment bindings ────────────────────────────────────────────────────

export interface Env {
  TRADINGBOT_DB: D1Database;
  ASSETS: Fetcher;
  /** 32-byte key encoded as base64 or hex; required for private-key import */
  PRIVATE_KEY_ENCRYPTION_KEY?: string;
  /** Optional Solana RPC URL. Falls back to the public mainnet endpoint. */
  SOLANA_RPC_URL?: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

const COOKIE_NAME = 'te_session';
const SESSION_TTL_HOURS = 12;
const PBKDF2_ITERATIONS = 100_000; // Max supported by Cloudflare Workers
const DEFAULT_SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";
const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET_BALANCE_CACHE_TTL_MS = 30_000;
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const walletBalanceCache = new Map<
  string,
  { expiresAt: number; value: WalletBalanceResponse }
>();

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

interface HistoricalSetupRecord {
  id: number;
  tokenSymbol: string | null;
  contractAddress: string | null;
  timeRangeTarget: string;
  maxTransactions: number;
  maxSlippage: number;
  volumeTarget: number;
  netBuyinTarget: number;
  volatilityTarget: number;
  pullbackTarget: number;
  createdAt: number;
}

interface WalletBalanceToken {
  mint: string;
  symbol: string;
  network: string;
  amount: string;
  decimals: number | null;
}

interface WalletBalanceResponse {
  address: string;
  sol: string;
  usdc: string;
  tokens: WalletBalanceToken[];
  updatedAt: number;
}

interface ManagedWalletImportRequest {
  label: string;
  privateKey?: string;
  recoveryPhrase?: string;
  derivationPath?: string;
}

interface TradableTokenCreateRequest {
  network: string;
  contractAddress: string;
}

interface TrackedTokenDescriptor {
  mint: string;
  symbol: string;
  network: string;
  decimals: number | null;
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
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error('Unexpected error:', errorMsg, err);
  return jsonResponse(
    { error: 'Internal server error', details: errorMsg },
    500,
  );
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
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const hashHex = Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const saltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `pbkdf2:sha256:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
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

function normalizeWhitespace(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).join(' ');
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

function normalizeRecoveryPhrase(raw: string): string {
  const normalized = normalizeWhitespace(raw).toLowerCase();
  if (!normalized) {
    throw new ApiError(400, 'Recovery phrase is required');
  }
  const wordCount = normalized.split(' ').length;
  if (wordCount !== 12 && wordCount !== 24) {
    throw new ApiError(400, 'Recovery phrase must contain 12 or 24 words');
  }
  if (!validateMnemonic(normalized, englishWordlist)) {
    throw new ApiError(400, 'Recovery phrase is not a valid BIP39 mnemonic');
  }
  return normalized;
}

function deriveSolanaKeypairFromRecoveryPhrase(
  recoveryPhraseRaw: string,
  derivationPath = DEFAULT_SOLANA_DERIVATION_PATH,
): Uint8Array {
  const recoveryPhrase = normalizeRecoveryPhrase(recoveryPhraseRaw);
  if (!/^m(\/[0-9]+'?)+$/.test(derivationPath)) {
    throw new ApiError(400, 'Invalid derivation path');
  }
  const seed = mnemonicToSeedSync(recoveryPhrase);
  const derived = HDKey.fromMasterSeed(seed).derive(derivationPath);
  if (!derived.privateKey || derived.privateKey.length !== 32) {
    throw new ApiError(
      400,
      'Could not derive a Solana private key from the recovery phrase',
    );
  }
  return nacl.sign.keyPair.fromSeed(derived.privateKey).secretKey;
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

function formatTokenAmount(rawAmount: bigint, decimals: number): string {
  if (decimals <= 0) return rawAmount.toString();
  const base = 10n ** BigInt(decimals);
  const whole = rawAmount / base;
  const fraction = rawAmount % base;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

function walletBalanceCacheKey(
  address: string,
  trackedTokens: TrackedTokenDescriptor[],
): string {
  const tokenKey = trackedTokens
    .map((token) => `${token.network}:${token.mint}`)
    .sort()
    .join('|');
  return `${address}|${tokenKey}`;
}

function readWalletBalanceCache(
  cacheKey: string,
): WalletBalanceResponse | null {
  const cached = walletBalanceCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    walletBalanceCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function writeWalletBalanceCache(
  cacheKey: string,
  value: WalletBalanceResponse,
): void {
  walletBalanceCache.set(cacheKey, {
    expiresAt: Date.now() + WALLET_BALANCE_CACHE_TTL_MS,
    value,
  });
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

const D1_TRADE_DOMAIN_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tradable_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network TEXT NOT NULL DEFAULT 'solana',
    contract_address TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    decimals INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(network, contract_address)
  )`,
  `CREATE TABLE IF NOT EXISTS historic_setups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_id INTEGER,
    time_range_target TEXT NOT NULL,
    max_transactions INTEGER NOT NULL,
    max_slippage REAL NOT NULL,
    volume_target REAL NOT NULL DEFAULT 0,
    net_buyin_target REAL NOT NULL DEFAULT 0,
    volatility_target REAL NOT NULL DEFAULT 0,
    pullback_target REAL NOT NULL DEFAULT 0,
    contract_address TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id)
  )`,
];

interface CredentialsBody {
  username: string;
  password: string;
}

let schemaInitPromise: Promise<void> | undefined;
let tradeDomainSchemaInitPromise: Promise<void> | undefined;

async function dbEnsureSchema(db: D1Database): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = db
      .batch(D1_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
      .then(() => undefined)
      .catch((err) => {
        schemaInitPromise = undefined;
        throw err;
      });
  }
  await schemaInitPromise;
}

async function dbEnsureTradeDomainSchema(db: D1Database): Promise<void> {
  await dbEnsureSchema(db);
  if (!tradeDomainSchemaInitPromise) {
    tradeDomainSchemaInitPromise = db
      .batch(
        D1_TRADE_DOMAIN_SCHEMA_STATEMENTS.map((statement) =>
          db.prepare(statement),
        ),
      )
      .then(() => undefined)
      .catch((err) => {
        tradeDomainSchemaInitPromise = undefined;
        throw err;
      });
  }
  await tradeDomainSchemaInitPromise;
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

function parseManagedWalletImportRequest(
  body: unknown,
): ManagedWalletImportRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(
      400,
      'Wallet label and either a private key or recovery phrase are required',
    );
  }
  const { label, privateKey, recoveryPhrase, derivationPath } = body as {
    label?: unknown;
    privateKey?: unknown;
    recoveryPhrase?: unknown;
    derivationPath?: unknown;
  };
  if (typeof label !== 'string') {
    throw new ApiError(400, 'Wallet label is required');
  }
  const hasPrivateKey =
    typeof privateKey === 'string' && privateKey.trim().length > 0;
  const hasRecoveryPhrase =
    typeof recoveryPhrase === 'string' && recoveryPhrase.trim().length > 0;
  if (hasPrivateKey === hasRecoveryPhrase) {
    throw new ApiError(
      400,
      'Provide exactly one of privateKey or recoveryPhrase',
    );
  }
  if (derivationPath != null && typeof derivationPath !== 'string') {
    throw new ApiError(400, 'Derivation path must be a string');
  }
  return {
    label,
    privateKey: hasPrivateKey ? (privateKey as string) : undefined,
    recoveryPhrase: hasRecoveryPhrase ? (recoveryPhrase as string) : undefined,
    derivationPath: typeof derivationPath === 'string' ? derivationPath : undefined,
  };
}

function parseTradableTokenCreateRequest(
  body: unknown,
): TradableTokenCreateRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Network and contract address are required');
  }
  const { network, contractAddress } = body as {
    network?: unknown;
    contractAddress?: unknown;
  };
  if (typeof network !== 'string' || typeof contractAddress !== 'string') {
    throw new ApiError(400, 'Network and contract address are required');
  }
  return { network, contractAddress };
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

async function dbDeleteOtherSessions(
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
  return dbImportManagedKeyBytes(
    db,
    userId,
    label,
    keypairBytes,
    encryptionKeyStr,
  );
}

async function dbImportManagedKeyBytes(
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
  await dbEnsureTradeDomainSchema(db);
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

async function dbCreateTradableToken(
  db: D1Database,
  input: TradableTokenCreateRequest,
  decimals: number | null,
): Promise<TradableToken> {
  await dbEnsureTradeDomainSchema(db);
  const network = input.network.trim().toLowerCase();
  if (network !== 'solana') {
    throw new ApiError(400, 'Only the solana network is supported right now');
  }
  const contractAddress = normalizePubkey(input.contractAddress);
  const createdAt = nowTs();
  try {
    await db
      .prepare(
        'INSERT INTO tradable_tokens (network, contract_address, symbol, name, decimals, is_active, created_at) VALUES (?1, ?2, NULL, NULL, ?3, 1, ?4)',
      )
      .bind(network, contractAddress, decimals, createdAt)
      .run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      throw new ApiError(409, 'This token has already been added');
    }
    throw err;
  }
  const row = await db
    .prepare(
      'SELECT id, network, contract_address, symbol, name, decimals, is_active FROM tradable_tokens WHERE network = ?1 AND contract_address = ?2',
    )
    .bind(network, contractAddress)
    .first<{
      id: number;
      network: string;
      contract_address: string;
      symbol: string | null;
      name: string | null;
      decimals: number | null;
      is_active: number;
    }>();
  if (!row) throw new ApiError(500, 'Failed to load the saved token');
  return {
    id: row.id,
    network: row.network,
    contractAddress: row.contract_address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    isActive: row.is_active === 1,
  };
}

async function dbResolveTradableTokenId(
  db: D1Database,
  contractAddress: string,
): Promise<number | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      'SELECT id FROM tradable_tokens WHERE network = ?1 AND contract_address = ?2 LIMIT 1',
    )
    .bind('solana', normalizePubkey(contractAddress))
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function dbCreateHistoricalSetupSnapshot(
  db: D1Database,
  userId: number,
  settings: SettingsState,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  const tokenId = settings.contractAddress.trim()
    ? await dbResolveTradableTokenId(db, settings.contractAddress)
    : null;
  await db
    .prepare(
      `INSERT INTO historic_setups (
        user_id,
        token_id,
        time_range_target,
        max_transactions,
        max_slippage,
        volume_target,
        net_buyin_target,
        volatility_target,
        pullback_target,
        contract_address,
        metadata,
        created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      userId,
      tokenId,
      settings.timeRangeTarget,
      settings.maxTransactions,
      settings.maxSlippage,
      settings.volumeTarget,
      settings.netBuyinTarget,
      settings.volatilityTarget,
      settings.pullbackTarget,
      settings.contractAddress.trim() || null,
      JSON.stringify({ managedKeyCount: settings.managedKeyCount }),
      nowTs(),
    )
    .run();
}

async function dbListHistoricalSetups(
  db: D1Database,
  userId: number,
): Promise<HistoricalSetupRecord[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `SELECT
         hs.id,
         hs.contract_address,
         hs.time_range_target,
         hs.max_transactions,
         hs.max_slippage,
         hs.volume_target,
         hs.net_buyin_target,
         hs.volatility_target,
         hs.pullback_target,
         hs.created_at,
         tt.symbol AS token_symbol
       FROM historic_setups hs
       LEFT JOIN tradable_tokens tt ON tt.id = hs.token_id
       WHERE hs.user_id = ?1
       ORDER BY hs.created_at DESC, hs.id DESC
       LIMIT 20`,
    )
    .bind(userId)
    .all<{
      id: number;
      contract_address: string | null;
      time_range_target: string;
      max_transactions: number;
      max_slippage: number;
      volume_target: number;
      net_buyin_target: number;
      volatility_target: number;
      pullback_target: number;
      created_at: number;
      token_symbol: string | null;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    tokenSymbol: row.token_symbol,
    contractAddress: row.contract_address,
    timeRangeTarget: row.time_range_target,
    maxTransactions: row.max_transactions,
    maxSlippage: row.max_slippage,
    volumeTarget: row.volume_target,
    netBuyinTarget: row.net_buyin_target,
    volatilityTarget: row.volatility_target,
    pullbackTarget: row.pullback_target,
    createdAt: row.created_at,
  }));
}

async function dbUserOwnsAccount(
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

async function solanaRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  if (!response.ok) {
    throw new ApiError(502, `Solana RPC request failed with ${response.status}`);
  }
  const body = await response.json<{
    result?: T;
    error?: { code?: number; message?: string };
  }>();
  if (body.error) {
    throw new ApiError(
      502,
      `Solana RPC error: ${body.error.message ?? 'unknown error'}`,
    );
  }
  if (body.result == null) {
    throw new ApiError(502, 'Solana RPC returned an empty result');
  }
  return body.result;
}

async function fetchSolanaMintDecimals(
  rpcUrl: string,
  mint: string,
): Promise<number | null> {
  const result = await solanaRpc<{ value: { decimals: number } }>(
    rpcUrl,
    'getTokenSupply',
    [mint],
  );
  return result.value?.decimals ?? null;
}

async function fetchSolanaTokenBalance(
  rpcUrl: string,
  owner: string,
  token: TrackedTokenDescriptor,
): Promise<WalletBalanceToken> {
  const result = await solanaRpc<{
    value: Array<{
      account: {
        data: {
          parsed?: {
            info?: {
              tokenAmount?: {
                amount?: string;
                decimals?: number;
              };
            };
          };
        };
      };
    }>;
  }>(rpcUrl, 'getTokenAccountsByOwner', [owner, { mint: token.mint }, { encoding: 'jsonParsed' }]);

  let total = 0n;
  let decimals = token.decimals;
  for (const account of result.value) {
    const tokenAmount =
      account.account.data.parsed?.info?.tokenAmount;
    if (!tokenAmount?.amount) continue;
    total += BigInt(tokenAmount.amount);
    if (typeof tokenAmount.decimals === 'number') {
      decimals = tokenAmount.decimals;
    }
  }

  return {
    mint: token.mint,
    symbol: token.symbol,
    network: token.network,
    amount: formatTokenAmount(total, decimals ?? 0),
    decimals,
  };
}

function buildTrackedTokens(
  settings: SettingsState,
  tradableTokens: TradableToken[],
): TrackedTokenDescriptor[] {
  const tracked = new Map<string, TrackedTokenDescriptor>();

  for (const token of tradableTokens) {
    if (!token.isActive || token.network !== 'solana') continue;
    if (token.contractAddress === SOLANA_USDC_MINT) continue;
    tracked.set(token.contractAddress, {
      mint: token.contractAddress,
      symbol: token.symbol ?? `${token.contractAddress.slice(0, 4)}…${token.contractAddress.slice(-4)}`,
      network: token.network,
      decimals: token.decimals,
    });
  }

  if (
    settings.contractAddress.trim() &&
    settings.contractAddress !== SOLANA_USDC_MINT
  ) {
    const mint = normalizePubkey(settings.contractAddress);
    if (!tracked.has(mint)) {
      tracked.set(mint, {
        mint,
        symbol: 'Configured Token',
        network: 'solana',
        decimals: null,
      });
    }
  }

  return [...tracked.values()];
}

async function loadWalletBalance(
  address: string,
  settings: SettingsState,
  tradableTokens: TradableToken[],
  rpcUrl: string,
): Promise<WalletBalanceResponse> {
  const trackedTokens = buildTrackedTokens(settings, tradableTokens);
  const cacheKey = walletBalanceCacheKey(address, trackedTokens);
  const cached = readWalletBalanceCache(cacheKey);
  if (cached) return cached;

  const lamportsResult = await solanaRpc<{ value: number }>(
    rpcUrl,
    'getBalance',
    [address],
  );
  const sol = formatTokenAmount(BigInt(lamportsResult.value), 9);
  const usdc = await fetchSolanaTokenBalance(rpcUrl, address, {
    mint: SOLANA_USDC_MINT,
    symbol: 'USDC',
    network: 'solana',
    decimals: 6,
  });

  const tokenResults = await Promise.allSettled(
    trackedTokens.map(async (token) => {
      const decimals =
        token.decimals ?? (await fetchSolanaMintDecimals(rpcUrl, token.mint));
      return fetchSolanaTokenBalance(rpcUrl, address, {
        ...token,
        decimals,
      });
    }),
  );

  const tokens = tokenResults
    .filter(
      (result): result is PromiseFulfilledResult<WalletBalanceToken> =>
        result.status === 'fulfilled',
    )
    .map((result) => result.value);

  const response: WalletBalanceResponse = {
    address,
    sol,
    usdc: usdc.amount,
    tokens,
    updatedAt: nowTs(),
  };

  writeWalletBalanceCache(cacheKey, response);
  return response;
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
  const [
    settings,
    internalAccs,
    outsiderAccs,
    logs,
    tradableTokens,
    historicalSetups,
  ] =
    await Promise.all([
      dbLoadSettings(env.TRADINGBOT_DB, user.id),
      dbListAccounts(env.TRADINGBOT_DB, user.id, 'managed'),
      dbListAccounts(env.TRADINGBOT_DB, user.id, 'watch'),
      dbListAuditLogs(env.TRADINGBOT_DB, user.id, user.username),
      dbListTradableTokens(env.TRADINGBOT_DB),
      dbListHistoricalSetups(env.TRADINGBOT_DB, user.id),
    ]);
  return jsonResponse({
    auth: { username: user.username, role: user.role },
    settings,
    internalAccs,
    outsiderAccs,
    logs,
    tradableTokens,
    historicalSetups,
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
  const body = await parseJsonBody<SettingsUpdateRequest>(request);
  await dbSaveSettings(env.TRADINGBOT_DB, user.id, body);
  const updated = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  await dbCreateHistoricalSetupSnapshot(
    env.TRADINGBOT_DB,
    user.id,
    updated,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'settings.updated',
    'settings',
    'Trading settings were updated',
  );
  return jsonResponse(updated);
}

// POST /api/private-keys/import and POST /api/admin/private-keys
async function handleImportManagedWallet(
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
  const body = parseManagedWalletImportRequest(
    await parseJsonBody<unknown>(request),
  );
  const account = body.privateKey
    ? await dbImportManagedKey(
        env.TRADINGBOT_DB,
        user.id,
        body.label,
        body.privateKey,
        env.PRIVATE_KEY_ENCRYPTION_KEY,
      )
    : await dbImportManagedKeyBytes(
        env.TRADINGBOT_DB,
        user.id,
        body.label,
        deriveSolanaKeypairFromRecoveryPhrase(
          body.recoveryPhrase ?? '',
          body.derivationPath,
        ),
        env.PRIVATE_KEY_ENCRYPTION_KEY,
      );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'private_key.imported',
    account.address,
    body.privateKey
      ? `Imported managed key '${account.label}' from a private key. Private key material was encrypted at rest and is never returned by the API.`
      : `Imported managed key '${account.label}' from a recovery phrase using ${body.derivationPath ?? DEFAULT_SOLANA_DERIVATION_PATH}. Derived key material was encrypted at rest and is never returned by the API.`,
  );
  return jsonResponse({ account }, 201);
}

// POST /api/tradable-tokens
async function handleAddTradableToken(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = parseTradableTokenCreateRequest(
    await parseJsonBody<unknown>(request),
  );
  const normalizedAddress = normalizePubkey(body.contractAddress);
  const decimals = await fetchSolanaMintDecimals(
    env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL,
    normalizedAddress,
  );
  const token = await dbCreateTradableToken(
    env.TRADINGBOT_DB,
    { network: body.network, contractAddress: normalizedAddress },
    decimals,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'token.added',
    token.contractAddress,
    `Added tradable token on ${token.network}`,
  );
  return jsonResponse({ token }, 201);
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

// POST /api/admin/password - Change admin password
async function handleAdminChangePassword(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const currentToken = sessionTokenFromCookie(request.headers.get('Cookie'));
  const body = await request.json<{ oldPassword: string; newPassword: string }>();

  if (!body.oldPassword || !body.newPassword) {
    throw new ApiError(400, 'Old and new passwords are required');
  }

  // Verify old password
  const dbUser = await env.TRADINGBOT_DB
    .prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(user.id)
    .first<{ password_hash: string }>();

  if (!dbUser) throw new ApiError(401, 'User not found');

  const oldPasswordValid = await verifyPassword(body.oldPassword, dbUser.password_hash);
  if (!oldPasswordValid) throw new ApiError(401, 'Old password is incorrect');

  validatePassword(body.newPassword);
  const newPasswordHash = await hashPassword(body.newPassword);

  // Update password
  await env.TRADINGBOT_DB
    .prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2')
    .bind(newPasswordHash, user.id)
    .run();
  await dbDeleteOtherSessions(env.TRADINGBOT_DB, user.id, currentToken);

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'admin.password_changed',
    user.username,
    'Admin password was changed',
  );

  return jsonResponse({ success: true, message: 'Password updated successfully' }, 200);
}

// GET /api/wallets/{address}/balance
async function handleGetWalletBalance(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireUser(request, env);
  const addressPath = decodeURIComponent(url.pathname.split('/')[3] ?? '');
  const address = normalizePubkey(addressPath);
  const ownsAccount = await dbUserOwnsAccount(
    env.TRADINGBOT_DB,
    user.id,
    address,
  );
  if (!ownsAccount) {
    throw new ApiError(404, 'Wallet not found for the current user');
  }
  const [settings, tradableTokens] = await Promise.all([
    dbLoadSettings(env.TRADINGBOT_DB, user.id),
    dbListTradableTokens(env.TRADINGBOT_DB),
  ]);
  const balance = await loadWalletBalance(
    address,
    settings,
    tradableTokens,
    env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL,
  );
  return jsonResponse(balance);
}

// DELETE /api/admin/private-keys/{address} - Delete imported private key
async function handleAdminDeletePrivateKey(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const addressPath = url.pathname.split('/').pop();

  if (!addressPath) {
    throw new ApiError(400, 'Wallet address is required');
  }

  // Verify the wallet exists and belongs to this user
  const account = await env.TRADINGBOT_DB
    .prepare(
      "SELECT id, label FROM accounts WHERE user_id = ?1 AND wallet_address = ?2 AND type = 'managed'",
    )
    .bind(user.id, addressPath)
    .first<{ id: number; label: string }>();

  if (!account) {
    throw new ApiError(404, 'Wallet not found or does not belong to this user');
  }

  // Delete the account
  await env.TRADINGBOT_DB
    .prepare('DELETE FROM accounts WHERE id = ?1')
    .bind(account.id)
    .run();

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'admin.private_key_deleted',
    addressPath,
    `Deleted managed key '${account.label}'`,
  );

  return jsonResponse({ success: true, message: 'Wallet deleted successfully' }, 200);
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
    if (method === 'POST' && pathname === '/api/tradable-tokens')
      return await handleAddTradableToken(request, env);
    if (method === 'POST' && pathname === '/api/private-keys/import')
      return await handleImportManagedWallet(request, env);
    if (method === 'POST' && pathname === '/api/admin/private-keys')
      return await handleImportManagedWallet(request, env);
    if (method === 'POST' && pathname === '/api/accounts/import')
      return await handleImportAccount(request, env);
    if (method === 'POST' && pathname === '/api/trade')
      return await handleTrade(request, env);
    if (method === 'POST' && pathname === '/api/admin/password')
      return await handleAdminChangePassword(request, env);
    if (method === 'GET' && /^\/api\/wallets\/[^/]+\/balance$/.test(pathname))
      return await handleGetWalletBalance(request, url, env);
    if (method === 'DELETE' && pathname.startsWith('/api/admin/private-keys/'))
      return await handleAdminDeletePrivateKey(request, url, env);
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
