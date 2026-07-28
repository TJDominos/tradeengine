import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from 'micro-ed25519-hdkey';
import nacl from 'tweetnacl';

import { ApiError } from './errors';
import type {
  StoredSignalTransactionDetails,
  TokenHolderSyncStateRecord,
  TokenHolderSyncSummary,
  TokenMarketSnapshot,
  TrackedTokenDescriptor,
  WalletBalanceResponse,
} from './workerShared';
import {
  BASE58_ALPHABET,
  COOKIE_NAME,
  DEFAULT_SOLANA_DERIVATION_PATH,
  PBKDF2_ITERATIONS,
  SOLANA_USDC_MINT,
  TOKEN_HOLDER_SYNC_OWNER_PREFIX_COUNT,
  TOKEN_HOLDER_SYNC_PROGRAM_IDS,
  TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
  TOKEN_MARKET_CACHE_TTL_MS,
  WALLET_BALANCE_CACHE_TTL_MS,
} from './workerShared';

const walletBalanceCache = new Map<
  string,
  { expiresAt: number; value: WalletBalanceResponse }
>();

const tokenMarketCache = new Map<
  string,
  { expiresAt: number; value: TokenMarketSnapshot }
>();

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

// ─── misc helpers ─────────────────────────────────────────────────────────────

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

// ─── base58 encode / decode ───────────────────────────────────────────────────

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
  if (bytes.length === 0) {
    return '';
  }
  if ([...bytes].every((byte) => byte === 0)) {
    return '1'.repeat(bytes.length);
  }

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
  const encoded = digits.reverse().map((d) => BASE58_ALPHABET[d]).join('');
  return result + encoded;
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

// ─── password hashing (PBKDF2 via SubtleCrypto) ───────────────────────────────

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

export function parseEncryptionKey(keyStr: string): Uint8Array {
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
  payload.forEach((b) => (binary += String.fromCharCode(b)));
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
  const payload = Uint8Array.from(atob(encryptedB64), (c) => c.charCodeAt(0));
  const iv = payload.slice(0, 12);
  const ciphertext = payload.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(decrypted);
}

export function normalizeWhitespace(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).join(' ');
}

// ─── Solana key helpers ───────────────────────────────────────────────────────

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
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'number')) {
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

/** Extract the base58-encoded public key from a 64-byte Solana keypair. */
export function solanaPubkeyFromKeypairBytes(keypairBytes: Uint8Array): string {
  if (keypairBytes.length !== 64) {
    throw new ApiError(
      400,
      'Private key must decode to a 64-byte Solana keypair',
    );
  }
  // Solana keypair layout: [32-byte seed | 32-byte public key]
  return base58Encode(keypairBytes.slice(32));
}

export function normalizePubkey(value: string): string {
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

export function validateContractAddress(value: string): void {
  if (!value.trim()) return;
  normalizePubkey(value);
}

export function normalizeRpcUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, 'RPC URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(400, 'RPC URL must be a valid http or https URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'RPC URL must use http or https');
  }
  return parsed.toString();
}

export function isHeliusRpcUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase().includes('helius-rpc.com');
  } catch {
    return trimmed.toLowerCase().includes('helius-rpc.com');
  }
}

export function normalizeHeliusRpcUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname.toLowerCase().includes('helius-rpc.com')) {
      return parsed.toString();
    }
    if (!parsed.searchParams.get('api-key')) {
      const legacyKey = parsed.pathname
        .split('/')
        .map((segment) => segment.trim())
        .find((segment) => segment.length > 0);
      if (legacyKey) {
        parsed.pathname = '/';
        parsed.searchParams.set('api-key', legacyKey);
      }
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
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
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function extractStoredSignalContractAddresses(payloadText: string): string[] {
  let payload: unknown;
  try {
    payload = parseJsonText<unknown>(payloadText);
  } catch {
    return [];
  }

  if (!isRecord(payload)) {
    return [];
  }

  const activity = isRecord(payload.activity) ? payload.activity : null;
  const rawContract = activity && isRecord(activity.rawContract)
    ? activity.rawContract
    : null;
  const log = isRecord(payload.log) ? payload.log : null;
  const event = isRecord(payload.event) ? payload.event : null;
  const firstActivity =
    event && Array.isArray(event.activity)
      ? event.activity.find((item): item is Record<string, unknown> => isRecord(item)) ?? null
      : null;
  const firstRawContract = firstActivity && isRecord(firstActivity.rawContract)
    ? firstActivity.rawContract
    : null;
  const data = event && isRecord(event.data) ? event.data : null;
  const block = data && isRecord(data.block) ? data.block : null;
  const firstLog =
    block && Array.isArray(block.logs)
      ? block.logs.find((item): item is Record<string, unknown> => isRecord(item)) ?? null
      : null;
  const explicitContractAddresses = Array.isArray(payload.contractAddresses)
    ? payload.contractAddresses
    : [];

  return uniqueSolanaPubkeys([
    ...explicitContractAddresses,
    rawContract?.address,
    activity?.contractAddress,
    activity?.tokenAddress,
    activity?.mint,
    log?.address,
    log?.contractAddress,
    log?.tokenAddress,
    log?.mint,
    firstRawContract?.address,
    firstActivity?.contractAddress,
    firstActivity?.tokenAddress,
    firstActivity?.mint,
    firstLog?.address,
    firstLog?.contractAddress,
    firstLog?.tokenAddress,
    firstLog?.mint,
    event?.contractAddress,
    event?.address,
    event?.tokenAddress,
    event?.mint,
    payload.contractAddress,
    payload.address,
    payload.tokenAddress,
    payload.mint,
  ]);
}

export function parseStoredSignalTransactionDetails(
  detailsJson: string | null | undefined,
): StoredSignalTransactionDetails | null {
  if (!detailsJson) {
    return null;
  }

  let payload: unknown;
  try {
    payload = parseJsonText<unknown>(detailsJson);
  } catch {
    return null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  const actionText = readNonEmptyString(payload.action)?.toUpperCase();
  const statusText = readNonEmptyString(payload.transactionStatus)?.toUpperCase();
  const detailSourceText = readNonEmptyString(payload.detailSource);

  return {
    tokenContractAddress: tryNormalizeSolanaPubkey(payload.tokenContractAddress),
    fromWalletAddress: tryNormalizeSolanaPubkey(payload.fromWalletAddress),
    toWalletAddress: tryNormalizeSolanaPubkey(payload.toWalletAddress),
    primaryWalletAddress: tryNormalizeSolanaPubkey(payload.primaryWalletAddress),
    action: actionText === 'BUY' || actionText === 'SELL' ? actionText : null,
    usdcAmount: toFiniteNumber(payload.usdcAmount),
    tokenAmount: toFiniteNumber(payload.tokenAmount),
    feeAmountUsd: toFiniteNumber(payload.feeAmountUsd),
    source:
      readNonEmptyString(payload.source) === 'rpc_reconcile'
        ? 'rpc_reconcile'
        : 'webhook',
    transactionStatus:
      statusText === 'CONFIRMED' || statusText === 'FAILED' || statusText === 'PENDING'
        ? statusText
        : 'PENDING',
    detailSource:
      detailSourceText === 'payload' ||
      detailSourceText === 'rpc' ||
      detailSourceText === 'payload+rpc' ||
      detailSourceText === 'unknown'
        ? detailSourceText
        : 'unknown',
  };
}

export function mergeStoredSignalTransactionDetails(
  ...detailsList: Array<Partial<StoredSignalTransactionDetails> | null | undefined>
): StoredSignalTransactionDetails {
  const merged: StoredSignalTransactionDetails = {
    tokenContractAddress: null,
    fromWalletAddress: null,
    toWalletAddress: null,
    primaryWalletAddress: null,
    action: null,
    usdcAmount: null,
    tokenAmount: null,
    feeAmountUsd: null,
    source: 'webhook',
    transactionStatus: 'PENDING',
    detailSource: 'unknown',
  };

  for (const details of detailsList) {
    if (!details) continue;
    const preferDetails =
      details.detailSource === 'rpc' ||
      details.detailSource === 'payload+rpc' ||
      details.source === 'rpc_reconcile';

    merged.tokenContractAddress ??= details.tokenContractAddress ?? null;
    if (preferDetails) {
      if (details.fromWalletAddress) {
        merged.fromWalletAddress = details.fromWalletAddress;
      } else {
        merged.fromWalletAddress ??= null;
      }
      if (details.toWalletAddress) {
        merged.toWalletAddress = details.toWalletAddress;
      } else {
        merged.toWalletAddress ??= null;
      }
      if (details.primaryWalletAddress) {
        merged.primaryWalletAddress = details.primaryWalletAddress;
      } else {
        merged.primaryWalletAddress ??= null;
      }
      if (details.action) {
        merged.action = details.action;
      } else {
        merged.action ??= null;
      }
      if (details.usdcAmount != null) {
        merged.usdcAmount = details.usdcAmount;
      } else {
        merged.usdcAmount ??= null;
      }
      if (details.tokenAmount != null) {
        merged.tokenAmount = details.tokenAmount;
      } else {
        merged.tokenAmount ??= null;
      }
      if (details.feeAmountUsd != null) {
        merged.feeAmountUsd = details.feeAmountUsd;
      } else {
        merged.feeAmountUsd ??= null;
      }
    } else {
      merged.fromWalletAddress ??= details.fromWalletAddress ?? null;
      merged.toWalletAddress ??= details.toWalletAddress ?? null;
      merged.primaryWalletAddress ??= details.primaryWalletAddress ?? null;
      merged.action ??= details.action ?? null;
      merged.usdcAmount ??= details.usdcAmount ?? null;
      merged.tokenAmount ??= details.tokenAmount ?? null;
      merged.feeAmountUsd ??= details.feeAmountUsd ?? null;
    }

    if (details.transactionStatus === 'FAILED') {
      merged.transactionStatus = 'FAILED';
    } else if (
      merged.transactionStatus !== 'FAILED' &&
      details.transactionStatus === 'PENDING'
    ) {
      merged.transactionStatus = 'PENDING';
    } else if (
      merged.transactionStatus === 'PENDING' &&
      details.transactionStatus === 'CONFIRMED'
    ) {
      merged.transactionStatus = 'CONFIRMED';
    }

    if (details.detailSource) {
      merged.detailSource =
        merged.detailSource === 'unknown'
          ? details.detailSource
          : merged.detailSource === details.detailSource
            ? merged.detailSource
            : 'payload+rpc';
    }
  }

  return merged;
}

function deriveWebhookActionFromHints(
  ...hints: Array<string | null | undefined>
): StoredSignalTransactionDetails['action'] {
  for (const hint of hints) {
    const normalizedHint = readNonEmptyString(hint)?.toLowerCase();
    if (!normalizedHint) {
      continue;
    }
    if (normalizedHint.includes('buy')) {
      return 'BUY';
    }
    if (normalizedHint.includes('sell')) {
      return 'SELL';
    }
  }
  return null;
}

export function extractWebhookTransactionDetailsFromPayload(
  payloadText: string,
  trackedContractAddress: string,
): Partial<StoredSignalTransactionDetails> {
  let payload: unknown;
  try {
    payload = parseJsonText<unknown>(payloadText);
  } catch {
    return {};
  }

  if (!isRecord(payload)) {
    return {};
  }

  const activity = isRecord(payload.activity) ? payload.activity : null;
  const log = isRecord(payload.log) ? payload.log : null;
  const transaction = log && isRecord(log.transaction) ? log.transaction : null;
  const from = transaction && isRecord(transaction.from) ? transaction.from : null;
  const to = transaction && isRecord(transaction.to) ? transaction.to : null;
  const rawContract = activity && isRecord(activity.rawContract)
    ? activity.rawContract
    : null;

  const fromWalletAddress =
    tryNormalizeSolanaPubkey(activity?.fromAddress) ??
    tryNormalizeSolanaPubkey(from?.address) ??
    null;
  const toWalletAddress =
    tryNormalizeSolanaPubkey(activity?.toAddress) ??
    tryNormalizeSolanaPubkey(to?.address) ??
    null;

  const activityContractAddress =
    tryNormalizeSolanaPubkey(rawContract?.address) ??
    tryNormalizeSolanaPubkey(activity?.contractAddress) ??
    tryNormalizeSolanaPubkey(activity?.tokenAddress) ??
    tryNormalizeSolanaPubkey(activity?.mint) ??
    null;
  const logContractAddress =
    tryNormalizeSolanaPubkey(log?.contractAddress) ??
    tryNormalizeSolanaPubkey(log?.tokenAddress) ??
    tryNormalizeSolanaPubkey(log?.mint) ??
    tryNormalizeSolanaPubkey(log?.address) ??
    null;
  const tokenContractAddress =
    [activityContractAddress, logContractAddress, trackedContractAddress]
      .find((address) => address != null && address !== SOLANA_USDC_MINT) ??
    trackedContractAddress;
  const isTrackedTokenActivity =
    activityContractAddress === trackedContractAddress ||
    logContractAddress === trackedContractAddress;

  const amountCandidate =
    toFiniteNumber(activity?.amount) ??
    toFiniteNumber(activity?.value) ??
    toFiniteNumber(activity?.tokenAmount) ??
    toFiniteNumber(log?.amount) ??
    toFiniteNumber(log?.value) ??
    toFiniteNumber(log?.tokenAmount);

  const symbolHint = readNonEmptyString(activity?.asset)?.toUpperCase() ?? '';
  const action = isTrackedTokenActivity
    ? deriveWebhookActionFromHints(
        readNonEmptyString(activity?.type),
        readNonEmptyString(activity?.side),
        readNonEmptyString(activity?.category),
        readNonEmptyString(log?.type),
        readNonEmptyString(log?.category),
      )
    : null;
  const primaryWalletAddress =
    tryNormalizeSolanaPubkey(activity?.walletAddress) ??
    fromWalletAddress ??
    toWalletAddress ??
    tryNormalizeSolanaPubkey(log?.walletAddress) ??
    null;

  const details: Partial<StoredSignalTransactionDetails> = {
    tokenContractAddress,
    fromWalletAddress,
    toWalletAddress,
    primaryWalletAddress,
    action,
    detailSource: 'payload',
    source: 'webhook',
  };

  const payloadFee =
    toFiniteNumber(activity?.fee) ??
    toFiniteNumber(activity?.feeUsd) ??
    toFiniteNumber(activity?.feeUSD) ??
    toFiniteNumber(log?.fee) ??
    toFiniteNumber(log?.feeUsd) ??
    toFiniteNumber(log?.feeUSD);
  if (payloadFee != null) {
    details.feeAmountUsd = Math.abs(payloadFee);
  }

  if (amountCandidate != null) {
    if (
      activityContractAddress === SOLANA_USDC_MINT ||
      logContractAddress === SOLANA_USDC_MINT ||
      symbolHint === 'USDC'
    ) {
      details.usdcAmount = Math.abs(amountCandidate);
    } else if (
      tokenContractAddress &&
      (activityContractAddress === tokenContractAddress || logContractAddress === tokenContractAddress)
    ) {
      details.tokenAmount = Math.abs(amountCandidate);
    }
  }

  return details;
}

// ─── input validation ─────────────────────────────────────────────────────────

export function validateLabel(label: string): void {
  const t = label.trim();
  if (t.length < 3 || t.length > 80) {
    throw new ApiError(400, 'Label must be between 3 and 80 characters');
  }
}

export function validateUsername(username: string): void {
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

export function validatePassword(password: string): void {
  if (password.length < 12) {
    throw new ApiError(400, 'Password must be at least 12 characters');
  }
}

// ─── cookie helpers ───────────────────────────────────────────────────────────

export function sessionTokenFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}

export function buildSessionCookie(
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

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}

export function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export function parseJsonText<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON');
  }
}
