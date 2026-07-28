/// <reference types="@cloudflare/workers-types" />

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from 'micro-ed25519-hdkey';
import nacl from 'tweetnacl';
import { ApiError } from './errors';
export interface Env {
  TRADINGBOT_DB: D1Database;
  ASSETS: Fetcher;
  PRIVATE_KEY_ENCRYPTION_KEY?: string;
  SOLANA_RPC_URL?: string;
  ALCHEMY_WEBHOOK_SIGNING_KEY?: string;
  ALCHEMY_WEBHOOK_SECRET?: string;
}

export const COOKIE_NAME = 'te_session';
export const SESSION_TTL_HOURS = 12;
export const PBKDF2_ITERATIONS = 100_000;
export const DEFAULT_SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOLANA_SPL_TOKEN_PROGRAM_ID =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_TOKEN_2022_PROGRAM_ID =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_HOLDER_SYNC_PROGRAM_IDS = [
  SOLANA_SPL_TOKEN_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
] as const;
export const TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT = 256;
export const TOKEN_HOLDER_SYNC_TOTAL_SHARDS =
  TOKEN_HOLDER_SYNC_PROGRAM_IDS.length * TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT;
export const TOKEN_HOLDER_SYNC_SHARDS_PER_REFRESH = 4;
export const WALLET_BALANCE_CACHE_TTL_MS = 30_000;
export const TOKEN_MARKET_CACHE_TTL_MS = 30_000;
export const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export interface SettingsState {
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
export interface SettingsUpdateRequest {
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
export interface ActiveTokenUpdateRequest {
  contractAddress: string;
}
export interface AccountRecord {
  id: number;
  label: string;
  address: string;
  type: string;
  createdAt: number;
}
export interface AuditLog {
  id: number;
  action: string;
  target: string;
  details: string;
  actor: string;
  createdAt: number;
}
export interface TradableToken {
  id: number;
  network: string;
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  isActive: boolean;
}
export interface TradeLogRecord {
  id: number;
  tokenId: number;
  tokenContractAddress: string | null;
  tokenSymbol: string | null;
  walletAddress: string;
  action: 'BUY' | 'SELL';
  requestedAmount: number;
  executedAmount: number | null;
  executedPrice: number | null;
  txSignature: string | null;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface WebhookTransactionLogRecord {
  id: number;
  tokenContractAddress: string | null;
  tokenSymbol: string | null;
  walletAddress: string | null;
  fromWalletAddress: string | null;
  toWalletAddress: string | null;
  action: 'BUY' | 'SELL' | null;
  usdcAmount: number | null;
  tokenAmount: number | null;
  feeAmountUsd: number | null;
  source: 'webhook' | 'rpc_reconcile';
  eventType: string;
  txSignature: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  errorMessage: string | null;
  createdAt: number;
}
export interface TokenHolderAggregateRecord {
  tokenId: number;
  activeHolderCount: number;
  internalHolderCount: number;
  watchedHolderCount: number;
  outsiderHolderCount: number;
  totalAmountHolding: number;
  internalAmountHolding: number;
  watchedAmountHolding: number;
  lastFullSyncAt: number | null;
  lastDeltaSyncAt: number | null;
  updatedAt: number;
  source: string;
}
export interface OutsideTokenHolderRecord {
  address: string;
  label: string | null;
  amountHolding: number;
  source: string;
  ownership: 'watch' | 'outside';
  updatedAt: number;
}
export type TokenHolderSyncStatus = 'idle' | 'running' | 'completed' | 'failed';
export interface TokenHolderSyncStateRecord {
  tokenId: number;
  runId: string | null;
  status: TokenHolderSyncStatus;
  source: string;
  nextShardIndex: number;
  processedShardCount: number;
  totalShardCount: number;
  stagedHolderCount: number;
  lastProgramId: string | null;
  lastOwnerPrefix: number | null;
  errorMessage: string | null;
  startedAt: number | null;
  updatedAt: number;
  lastCompletedAt: number | null;
}
export interface TokenHolderSyncSummary {
  status: TokenHolderSyncStatus;
  mode: 'rpc_owner_prefix_shards';
  runId: string | null;
  processedShardCount: number;
  totalShardCount: number;
  remainingShardCount: number;
  shardsProcessedThisRun: number;
  stagedHolderCount: number;
  activeHolderCount: number;
  upsertedCount: number;
  zeroedCount: number;
  lastProgramId: string | null;
  lastOwnerPrefix: number | null;
  errorMessage: string | null;
  lastCompletedAt: number | null;
}
export type MarketRefreshStatus = 'idle' | 'running' | 'completed' | 'failed';
export interface MarketRefreshStatusRecord {
  contractAddress: string;
  status: MarketRefreshStatus;
  requestId: string | null;
  errorMessage: string | null;
  summaryText: string | null;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
}
export interface StoredSignalTransactionDetails {
  tokenContractAddress: string | null;
  fromWalletAddress: string | null;
  toWalletAddress: string | null;
  primaryWalletAddress: string | null;
  action: 'BUY' | 'SELL' | null;
  usdcAmount: number | null;
  tokenAmount: number | null;
  feeAmountUsd: number | null;
  source: 'webhook' | 'rpc_reconcile';
  transactionStatus: 'PENDING' | 'CONFIRMED' | 'FAILED';
  detailSource: 'payload' | 'rpc' | 'payload+rpc' | 'unknown';
}
export interface RpcEndpoint {
  id: number;
  network: string;
  url: string;
  isActive: boolean;
  createdAt: number;
}

export interface TokenMarketSnapshot {
  network: string;
  contractAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  volume24h: number | null;
  totalTransactions24h: number | null;
  totalHolders?: number | null;
  outsidersOverOneUsd: number | null;
  dexId: string | null;
  pairAddress: string | null;
  fetchedAt: number;
}

export interface SignalRecord {
  id: number;
  source: string;
  externalId: string;
  eventType: string;
  walletAddress: string | null;
  txSignature: string | null;
  payload: string;
  detailsJson: string | null;
  processed: boolean;
  processedState: number;
  processedAt: number | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: number;
}

export interface SignalCreateRequest {
  source: string;
  externalId: string;
  eventType: string;
  walletAddress: string | null;
  txSignature: string | null;
  payload: string;
  detailsJson?: string | null;
}

export interface AlchemyWebhookPayload {
  webhookId?: unknown;
  id?: unknown;
  createdAt?: unknown;
  type?: unknown;
  event?: unknown;
}

export interface DerivedChainSignal {
  externalId: string;
  eventType: string;
  walletAddress: string | null;
  txSignature: string | null;
  contractAddresses: string[];
  payload: string;
}

export interface HistoricalSetupRecord {
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

export interface WalletBalanceToken {
  mint: string;
  symbol: string;
  network: string;
  amount: string;
  decimals: number | null;
}

export interface WalletBalanceResponse {
  address: string;
  sol: string;
  usdc: string;
  tokens: WalletBalanceToken[];
  updatedAt: number;
}

export interface ManagedWalletImportRequest {
  label: string;
  adminPassword?: string;
  privateKey?: string;
  recoveryPhrase?: string;
  derivationPath?: string;
}

export interface TradableTokenCreateRequest {
  network: string;
  contractAddress: string;
}

export interface RpcEndpointCreateRequest {
  network: string;
  url: string;
}

export interface TradeLogCreateRequest {
  tokenId: number;
  setupId: number | null;
  walletAddress: string;
  action: 'BUY' | 'SELL';
  requestedAmount: number;
  executedAmount?: number | null;
  executedPrice?: number | null;
  txSignature?: string | null;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  errorMessage?: string | null;
}

export interface TrackedTokenDescriptor {
  mint: string;
  symbol: string;
  network: string;
  decimals: number | null;
}

export interface SessionUser {
  id: number;
  username: string;
  role: string;
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export function errorResponse(err: unknown): Response {
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

export async function sha256Hex(value: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function base58Decode(s: string): Uint8Array {
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

export function base58Encode(bytes: Uint8Array): string {
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
  return result + digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('');
}

export function decodeBase64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function readUint64LittleEndian(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(bytes[offset + index] ?? 0) << BigInt(index * 8);
  }
  return value;
}

export function getTokenHolderSyncShardCursor(shardIndex: number): {
  programId: (typeof TOKEN_HOLDER_SYNC_PROGRAM_IDS)[number];
  ownerPrefix: number;
} {
  const normalizedIndex = Math.max(
    0,
    Math.min(shardIndex, TOKEN_HOLDER_SYNC_TOTAL_SHARDS - 1),
  );
  const programCount = TOKEN_HOLDER_SYNC_PROGRAM_IDS.length;
  const ownerPrefix = Math.floor(normalizedIndex / programCount);
  const programIndex = normalizedIndex % programCount;
  return {
    programId:
      TOKEN_HOLDER_SYNC_PROGRAM_IDS[programIndex] ??
      TOKEN_HOLDER_SYNC_PROGRAM_IDS[0],
    ownerPrefix: Math.min(
      TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT - 1,
      ownerPrefix,
    ),
  };
}

export function buildTokenHolderSyncSummary(
  state: TokenHolderSyncStateRecord | null,
  overrides: Partial<TokenHolderSyncSummary> = {},
): TokenHolderSyncSummary {
  const baseSummary: TokenHolderSyncSummary = {
    status: state?.status ?? 'idle',
    mode: 'rpc_owner_prefix_shards',
    runId: state?.runId ?? null,
    processedShardCount: state?.processedShardCount ?? 0,
    totalShardCount: state?.totalShardCount ?? TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
    remainingShardCount: Math.max(
      0,
      (state?.totalShardCount ?? TOKEN_HOLDER_SYNC_TOTAL_SHARDS) -
        (state?.processedShardCount ?? 0),
    ),
    shardsProcessedThisRun: 0,
    stagedHolderCount: state?.stagedHolderCount ?? 0,
    activeHolderCount: state?.stagedHolderCount ?? 0,
    upsertedCount: 0,
    zeroedCount: 0,
    lastProgramId: state?.lastProgramId ?? null,
    lastOwnerPrefix: state?.lastOwnerPrefix ?? null,
    errorMessage: state?.errorMessage ?? null,
    lastCompletedAt: state?.lastCompletedAt ?? null,
  };
  const merged = {
    ...baseSummary,
    ...overrides,
  };
  return {
    ...merged,
    remainingShardCount: Math.max(
      0,
      merged.totalShardCount - merged.processedShardCount,
    ),
  };
}

export function isSolanaRpcRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return normalized.includes('429') || normalized.includes('too many requests');
}

export async function hashPassword(password: string): Promise<string> {
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

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, , iterStr, saltHex, expectedHash] = parts;
  const iterations = parseInt(iterStr, 10);
  const salt = new Uint8Array(
    (saltHex.match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16)),
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
  let diff = 0;
  for (let index = 0; index < computedHash.length; index += 1) {
    diff |= computedHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return diff === 0;
}

export function parseEncryptionKey(keyStr: string): Uint8Array {
  const trimmed = keyStr.trim();
  try {
    const raw = atob(trimmed);
    if (raw.length === 32) {
      return new Uint8Array([...raw].map((char) => char.charCodeAt(0)));
    }
  } catch {
    // not valid base64
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return new Uint8Array(
      (trimmed.match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16)),
    );
  }
  throw new ApiError(
    503,
    'PRIVATE_KEY_ENCRYPTION_KEY must be base64 or hex and decode to exactly 32 bytes',
  );
}

export async function encryptPrivateKey(
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
  payload.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

export async function decryptPrivateKey(
  encryptedB64: string,
  keyStr: string,
): Promise<Uint8Array> {
  const keyBytes = parseEncryptionKey(keyStr);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
    'decrypt',
  ]);
  const payload = Uint8Array.from(atob(encryptedB64), (char) => char.charCodeAt(0));
  const iv = payload.slice(0, 12);
  const ciphertext = payload.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(decrypted);
}

export function normalizeWhitespace(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).join(' ');
}

export function normalizePrivateKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (!trimmed) throw new ApiError(400, 'Private key is required');
  let decoded: Uint8Array;
  if (trimmed.startsWith('[')) {
    let values: number[];
    try {
      values = JSON.parse(trimmed) as number[];
    } catch {
      throw new ApiError(400, 'Private key JSON array could not be parsed');
    }
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'number')) {
      throw new ApiError(400, 'Private key JSON array could not be parsed');
    }
    decoded = new Uint8Array(values);
  } else {
    try {
      decoded = base58Decode(trimmed);
    } catch {
      throw new ApiError(
        400,
        'Private key must be a base58 string or JSON array',
      );
    }
  }

  if (decoded.length === 32) {
    return nacl.sign.keyPair.fromSeed(decoded).secretKey;
  }
  if (decoded.length === 64) {
    return decoded;
  }
  throw new ApiError(
    400,
    'Private key must decode to a 32-byte seed or 64-byte Solana keypair',
  );
}

export function normalizeRecoveryPhrase(raw: string): string {
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

export function deriveSolanaKeypairFromRecoveryPhrase(
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

export function solanaPubkeyFromKeypairBytes(keypairBytes: Uint8Array): string {
  if (keypairBytes.length < 64) {
    throw new ApiError(400, 'Solana keypair must contain 64 bytes');
  }
  return base58Encode(keypairBytes.slice(32, 64));
}

export function normalizePubkey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, 'A Solana address is required');
  }
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(trimmed);
  } catch {
    throw new ApiError(400, 'Solana addresses must use base58 encoding');
  }
  if (decoded.length !== 32) {
    throw new ApiError(400, 'Solana addresses must decode to 32 bytes');
  }
  return trimmed;
}

export function validateContractAddress(value: string): void {
  normalizePubkey(value);
}

export function normalizeRpcUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, 'RPC URL is required');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError(400, 'RPC URL must be valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'RPC URL must use http or https');
  }
  return url.toString();
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map((entry) => entry.trim()).filter(Boolean)) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function tryNormalizeSolanaPubkey(value: unknown): string | null {
  const text = readNonEmptyString(value);
  if (!text) {
    return null;
  }
  try {
    return normalizePubkey(text);
  } catch {
    return null;
  }
}

export function uniqueSolanaPubkeys(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const pubkey = tryNormalizeSolanaPubkey(value);
    if (!pubkey || seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    result.push(pubkey);
  }
  return result;
}

export function formatTokenAmount(rawAmount: bigint, decimals: number): string {
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

export const walletBalanceCache = new Map<
  string,
  { expiresAt: number; value: WalletBalanceResponse }
>();

export function walletBalanceCacheKey(
  address: string,
  trackedTokens: TrackedTokenDescriptor[],
): string {
  const tokenKey = trackedTokens
    .map((token) => `${token.network}:${token.mint}`)
    .sort()
    .join('|');
  return `${address}|${tokenKey}`;
}

export function readWalletBalanceCache(
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

export function writeWalletBalanceCache(
  cacheKey: string,
  value: WalletBalanceResponse,
): void {
  walletBalanceCache.set(cacheKey, {
    expiresAt: Date.now() + WALLET_BALANCE_CACHE_TTL_MS,
    value,
  });
}

export const tokenMarketCache = new Map<
  string,
  { expiresAt: number; value: TokenMarketSnapshot }
>();

export function tokenMarketCacheKey(network: string, contractAddress: string): string {
  return `${network}:${contractAddress}`;
}

export function readTokenMarketCache(
  cacheKey: string,
): TokenMarketSnapshot | null {
  const cached = tokenMarketCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    tokenMarketCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

export function writeTokenMarketCache(
  cacheKey: string,
  value: TokenMarketSnapshot,
): void {
  tokenMarketCache.set(cacheKey, {
    expiresAt: Date.now() + TOKEN_MARKET_CACHE_TTL_MS,
    value,
  });
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function extractStoredSignalContractAddresses(payloadText: string): string[] {
  try {
    const payload = JSON.parse(payloadText) as { contractAddresses?: unknown };
    if (!Array.isArray(payload.contractAddresses)) {
      return [];
    }
    return uniqueSolanaPubkeys(payload.contractAddresses);
  } catch {
    return [];
  }
}

export function parseStoredSignalTransactionDetails(
  rawValue: string | null | undefined,
): StoredSignalTransactionDetails | null {
  if (!rawValue) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredSignalTransactionDetails>;
    return {
      tokenContractAddress: tryNormalizeSolanaPubkey(parsed.tokenContractAddress) ?? null,
      fromWalletAddress: tryNormalizeSolanaPubkey(parsed.fromWalletAddress) ?? null,
      toWalletAddress: tryNormalizeSolanaPubkey(parsed.toWalletAddress) ?? null,
      primaryWalletAddress: tryNormalizeSolanaPubkey(parsed.primaryWalletAddress) ?? null,
      action: parsed.action === 'BUY' || parsed.action === 'SELL' ? parsed.action : null,
      usdcAmount: toFiniteNumber(parsed.usdcAmount),
      tokenAmount: toFiniteNumber(parsed.tokenAmount),
      feeAmountUsd: toFiniteNumber(parsed.feeAmountUsd),
      source: parsed.source === 'rpc_reconcile' ? 'rpc_reconcile' : 'webhook',
      transactionStatus:
        parsed.transactionStatus === 'CONFIRMED' ||
        parsed.transactionStatus === 'FAILED'
          ? parsed.transactionStatus
          : 'PENDING',
      detailSource:
        parsed.detailSource === 'payload' ||
        parsed.detailSource === 'rpc' ||
        parsed.detailSource === 'payload+rpc'
          ? parsed.detailSource
          : 'unknown',
    };
  } catch {
    return null;
  }
}

export function mergeStoredSignalTransactionDetails(
  base: Partial<StoredSignalTransactionDetails> | null | undefined,
  next: Partial<StoredSignalTransactionDetails> | null | undefined,
): StoredSignalTransactionDetails {
  const merged = {
    tokenContractAddress: next?.tokenContractAddress ?? base?.tokenContractAddress ?? null,
    fromWalletAddress: next?.fromWalletAddress ?? base?.fromWalletAddress ?? null,
    toWalletAddress: next?.toWalletAddress ?? base?.toWalletAddress ?? null,
    primaryWalletAddress: next?.primaryWalletAddress ?? base?.primaryWalletAddress ?? null,
    action: next?.action ?? base?.action ?? null,
    usdcAmount: next?.usdcAmount ?? base?.usdcAmount ?? null,
    tokenAmount: next?.tokenAmount ?? base?.tokenAmount ?? null,
    feeAmountUsd: next?.feeAmountUsd ?? base?.feeAmountUsd ?? null,
    source: next?.source ?? base?.source ?? 'webhook',
    transactionStatus: next?.transactionStatus ?? base?.transactionStatus ?? 'PENDING',
    detailSource: next?.detailSource ?? base?.detailSource ?? 'unknown',
  } satisfies StoredSignalTransactionDetails;

  if (base?.detailSource === 'payload' && next?.detailSource === 'rpc') {
    merged.detailSource = 'payload+rpc';
  } else if (base?.detailSource === 'rpc' && next?.detailSource === 'payload') {
    merged.detailSource = 'payload+rpc';
  }

  return merged;
}

export function extractWebhookTransactionDetailsFromPayload(
  payloadText: string,
): Partial<StoredSignalTransactionDetails> {
  try {
    const payload = JSON.parse(payloadText) as AlchemyWebhookPayload;
    const event = isRecord(payload.event) ? payload.event : null;
    if (!event) {
      return {
        source: 'webhook',
        transactionStatus: 'PENDING',
        detailSource: 'payload',
      };
    }

    if (Array.isArray(event.activity)) {
      const activity = event.activity.find((item) => isRecord(item)) as Record<string, unknown> | undefined;
      const rawContract = activity && isRecord(activity.rawContract) ? activity.rawContract : null;
      const log = activity && isRecord(activity.log) ? activity.log : null;
      return {
        tokenContractAddress:
          tryNormalizeSolanaPubkey(rawContract?.address) ??
          tryNormalizeSolanaPubkey(activity?.contractAddress) ??
          tryNormalizeSolanaPubkey(activity?.tokenAddress) ??
          tryNormalizeSolanaPubkey(activity?.mint) ??
          tryNormalizeSolanaPubkey(log?.address) ??
          null,
        fromWalletAddress:
          tryNormalizeSolanaPubkey(activity?.fromAddress) ??
          tryNormalizeSolanaPubkey(isRecord(activity?.from) ? activity?.from.address : null) ??
          null,
        toWalletAddress:
          tryNormalizeSolanaPubkey(activity?.toAddress) ??
          tryNormalizeSolanaPubkey(isRecord(activity?.to) ? activity?.to.address : null) ??
          null,
        primaryWalletAddress:
          tryNormalizeSolanaPubkey(activity?.walletAddress) ??
          tryNormalizeSolanaPubkey(activity?.fromAddress) ??
          tryNormalizeSolanaPubkey(activity?.toAddress) ??
          null,
        action:
          readNonEmptyString(activity?.type)?.toUpperCase() === 'BUY'
            ? 'BUY'
            : readNonEmptyString(activity?.type)?.toUpperCase() === 'SELL'
              ? 'SELL'
              : null,
        usdcAmount: toFiniteNumber(activity?.value),
        tokenAmount: toFiniteNumber(activity?.amount),
        feeAmountUsd: toFiniteNumber(activity?.fee),
        source: 'webhook',
        transactionStatus: 'PENDING',
        detailSource: 'payload',
      };
    }
  } catch {
    // ignore malformed payloads
  }

  return {
    source: 'webhook',
    transactionStatus: 'PENDING',
    detailSource: 'payload',
  };
}
