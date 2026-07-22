/// <reference types="@cloudflare/workers-types" />

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from 'micro-ed25519-hdkey';
import nacl from 'tweetnacl';

import { ApiError } from './backend/errors';
import {
  buildJupiterSwapTransaction,
  fetchJupiterPriceViaQuote,
  fetchJupiterSwapQuote,
  fetchJupiterTokenMetadata,
  fetchJupiterTokenPrice,
  type JupiterQuoteResponse,
  type JupiterTokenMetadata,
} from './backend/jupiter';
import {
  DEFAULT_STRATEGY_TYPE,
  PRIMARY_STRATEGY_NAME,
} from './backend/strategy/config';
import { normalizeStrategyDocument } from './backend/strategy/migrations';
import {
  buildStrategyDocumentFromSettings,
  runStrategyRuntime,
  summarizeStrategyRuntime,
} from './backend/strategy/runtime';
import {
  buildManualRefreshStrategyTrigger,
  buildWebhookStrategyTrigger,
} from './backend/strategy/triggers';
import type {
  StrategyDefinitionRecord,
  StrategyMarketSnapshot,
  StrategyRuntimeResult,
  StrategySettingsInput,
  StrategyTriggerEvent,
  StrategyVersionDocument,
  StrategyVersionRecord,
} from './backend/strategy/types';
import { nowMs, nowTs, normalizeTimestampMs } from './backend/time';

// ─── environment bindings ────────────────────────────────────────────────────

export interface Env {
  TRADINGBOT_DB: D1Database;
  ASSETS: Fetcher;
  /** 32-byte key encoded as base64 or hex; required for private-key import */
  PRIVATE_KEY_ENCRYPTION_KEY?: string;
  /** Optional Solana RPC URL. Falls back to the public mainnet endpoint. */
  SOLANA_RPC_URL?: string;
  /** Alchemy webhook signing key used to verify X-Alchemy-Signature. */
  ALCHEMY_WEBHOOK_SIGNING_KEY?: string;
  /** Backward-compatible alias for the Alchemy webhook signing key. */
  ALCHEMY_WEBHOOK_SECRET?: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

const COOKIE_NAME = 'te_session';
const SESSION_TTL_HOURS = 12;
const PBKDF2_ITERATIONS = 100_000; // Max supported by Cloudflare Workers
const DEFAULT_SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_SPL_TOKEN_PROGRAM_ID =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOLANA_TOKEN_2022_PROGRAM_ID =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WALLET_BALANCE_CACHE_TTL_MS = 30_000;
const TOKEN_MARKET_CACHE_TTL_MS = 30_000;
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const walletBalanceCache = new Map<
  string,
  { expiresAt: number; value: WalletBalanceResponse }
>();

const tokenMarketCache = new Map<
  string,
  { expiresAt: number; value: TokenMarketSnapshot }
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

interface ActiveTokenUpdateRequest {
  contractAddress: string;
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

interface TradeLogRecord {
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

interface WebhookTransactionLogRecord {
  id: number;
  tokenContractAddress: string | null;
  tokenSymbol: string | null;
  walletAddress: string | null;
  fromWalletAddress: string | null;
  toWalletAddress: string | null;
  action: 'BUY' | 'SELL' | null;
  usdcAmount: number | null;
  tokenAmount: number | null;
  eventType: string;
  txSignature: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  errorMessage: string | null;
  createdAt: number;
}

interface StoredSignalTransactionDetails {
  tokenContractAddress: string | null;
  fromWalletAddress: string | null;
  toWalletAddress: string | null;
  primaryWalletAddress: string | null;
  action: 'BUY' | 'SELL' | null;
  usdcAmount: number | null;
  tokenAmount: number | null;
  transactionStatus: 'PENDING' | 'CONFIRMED' | 'FAILED';
  detailSource: 'payload' | 'rpc' | 'payload+rpc' | 'unknown';
}

interface RpcEndpoint {
  id: number;
  network: string;
  url: string;
  createdAt: number;
}

interface TokenMarketSnapshot {
  network: string;
  contractAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  volume24h: number | null;
  totalTransactions24h: number | null;
  outsidersOverOneUsd: number | null;
  dexId: string | null;
  pairAddress: string | null;
  fetchedAt: number;
}

interface SignalRecord {
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

interface SignalCreateRequest {
  source: string;
  externalId: string;
  eventType: string;
  walletAddress: string | null;
  txSignature: string | null;
  payload: string;
  detailsJson?: string | null;
}

interface AlchemyWebhookPayload {
  webhookId?: unknown;
  id?: unknown;
  createdAt?: unknown;
  type?: unknown;
  event?: unknown;
}

interface DerivedChainSignal {
  externalId: string;
  eventType: string;
  walletAddress: string | null;
  txSignature: string | null;
  contractAddresses: string[];
  payload: string;
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
  adminPassword?: string;
  privateKey?: string;
  recoveryPhrase?: string;
  derivationPath?: string;
}

interface TradableTokenCreateRequest {
  network: string;
  contractAddress: string;
}

interface RpcEndpointCreateRequest {
  network: string;
  url: string;
}

interface TradeLogCreateRequest {
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

async function decryptPrivateKey(
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

function normalizeRpcUrl(value: string): string {
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

function dedupeStrings(values: string[]): string[] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function tryNormalizeSolanaPubkey(value: unknown): string | null {
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

function uniqueSolanaPubkeys(values: unknown[]): string[] {
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

function tokenMarketCacheKey(network: string, contractAddress: string): string {
  return `${network}:${contractAddress}`;
}

function readTokenMarketCache(
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

function writeTokenMarketCache(
  cacheKey: string,
  value: TokenMarketSnapshot,
): void {
  tokenMarketCache.set(cacheKey, {
    expiresAt: Date.now() + TOKEN_MARKET_CACHE_TTL_MS,
    value,
  });
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractStoredSignalContractAddresses(payloadText: string): string[] {
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

  return uniqueSolanaPubkeys([
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

function parseStoredSignalTransactionDetails(
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

function mergeStoredSignalTransactionDetails(
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
    transactionStatus: 'PENDING',
    detailSource: 'unknown',
  };

  for (const details of detailsList) {
    if (!details) continue;
    merged.tokenContractAddress ??= details.tokenContractAddress ?? null;
    merged.fromWalletAddress ??= details.fromWalletAddress ?? null;
    merged.toWalletAddress ??= details.toWalletAddress ?? null;
    merged.primaryWalletAddress ??= details.primaryWalletAddress ?? null;
    merged.action ??= details.action ?? null;
    merged.usdcAmount ??= details.usdcAmount ?? null;
    merged.tokenAmount ??= details.tokenAmount ?? null;

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

function extractWebhookTransactionDetailsFromPayload(
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

  const amountCandidate =
    toFiniteNumber(activity?.amount) ??
    toFiniteNumber(activity?.value) ??
    toFiniteNumber(activity?.tokenAmount) ??
    toFiniteNumber(log?.amount) ??
    toFiniteNumber(log?.value) ??
    toFiniteNumber(log?.tokenAmount);

  const symbolHint = readNonEmptyString(activity?.asset)?.toUpperCase() ?? '';
  const categoryHint = readNonEmptyString(activity?.category)?.toLowerCase() ?? '';
  const action =
    categoryHint.includes('buy')
      ? 'BUY'
      : categoryHint.includes('sell')
        ? 'SELL'
        : null;

  const details: Partial<StoredSignalTransactionDetails> = {
    tokenContractAddress,
    fromWalletAddress,
    toWalletAddress,
    action,
    detailSource: 'payload',
  };

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
  `CREATE TABLE IF NOT EXISTS token_market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    network TEXT NOT NULL DEFAULT 'solana',
    contract_address TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    price_usd REAL,
    liquidity_usd REAL,
    fdv REAL,
    volume_24h REAL,
    total_transactions_24h INTEGER,
    outsiders_over_one_usd INTEGER,
    dex_id TEXT,
    pair_address TEXT,
    fetched_at INTEGER NOT NULL,
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id)
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    wallet_address TEXT,
    tx_signature TEXT,
    payload TEXT NOT NULL,
    details_json TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    processed_at INTEGER,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(source, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    token_id INTEGER NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    avg_cost REAL NOT NULL DEFAULT 0,
    realized_pnl REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(wallet_address, token_id),
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id)
  )`,
  `CREATE TABLE IF NOT EXISTS trade_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    signal_id INTEGER,
    setup_id INTEGER,
    wallet_address TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('BUY', 'SELL')),
    requested_amount REAL NOT NULL,
    executed_amount REAL,
    executed_price REAL,
    tx_signature TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED')),
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(token_id) REFERENCES tradable_tokens(id),
    FOREIGN KEY(setup_id) REFERENCES historic_setups(id)
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
  `CREATE TABLE IF NOT EXISTS strategy_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    strategy_type TEXT NOT NULL,
    current_version_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, strategy_type),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    engine_version TEXT NOT NULL,
    strategy_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    params_json TEXT NOT NULL,
    triggers_json TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    risk_json TEXT NOT NULL,
    execution_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    checksum TEXT NOT NULL,
    change_note TEXT,
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    UNIQUE(strategy_id, version_no),
    FOREIGN KEY(strategy_id) REFERENCES strategy_definitions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    strategy_version_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    external_id TEXT,
    contract_address TEXT NOT NULL,
    wallet_address TEXT,
    tx_signature TEXT,
    status TEXT NOT NULL,
    should_execute INTEGER NOT NULL DEFAULT 0,
    dry_run INTEGER NOT NULL DEFAULT 1,
    summary_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(strategy_version_id) REFERENCES strategy_versions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS rpc_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    network TEXT NOT NULL DEFAULT 'solana',
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, network, url),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address)',
  'CREATE INDEX IF NOT EXISTS idx_signals_processed_created ON signals(processed, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source)',
  'CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_token_fetched ON token_market_snapshots(token_id, fetched_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_contract_fetched ON token_market_snapshots(network, contract_address, fetched_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_trade_logs_token_created ON trade_logs(token_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_trade_logs_wallet_created ON trade_logs(wallet_address, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_strategy_definitions_user_type ON strategy_definitions(user_id, strategy_type)',
  'CREATE INDEX IF NOT EXISTS idx_strategy_versions_strategy_created ON strategy_versions(strategy_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_version_created ON strategy_evaluations(strategy_version_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_user_created ON strategy_evaluations(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_rpc_endpoints_user_network_created ON rpc_endpoints(user_id, network, created_at DESC)',
];

interface CredentialsBody {
  username: string;
  password: string;
}

let schemaInitPromise: Promise<void> | undefined;
let tradeDomainSchemaInitPromise: Promise<void> | undefined;

async function dbEnsureTableColumn(
  db: D1Database,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  const rows = await db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all<{
      name: string;
    }>();
  if (rows.results.some((row) => row.name === columnName)) {
    return;
  }
  await db
    .prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
    .run();
}

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
      .then(async () => {
        await dbEnsureTableColumn(db, 'signals', 'details_json', 'TEXT');
      })
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

function parseJsonText<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
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
  const { label, adminPassword, privateKey, recoveryPhrase, derivationPath } = body as {
    label?: unknown;
    adminPassword?: unknown;
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
  if (adminPassword != null && typeof adminPassword !== 'string') {
    throw new ApiError(400, 'Admin password must be a string');
  }
  return {
    label,
    adminPassword:
      typeof adminPassword === 'string' && adminPassword.trim().length > 0
        ? adminPassword
        : undefined,
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

function parseActiveTokenUpdateRequest(
  body: unknown,
): ActiveTokenUpdateRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Contract address is required');
  }
  const { contractAddress } = body as {
    contractAddress?: unknown;
  };
  if (typeof contractAddress !== 'string') {
    throw new ApiError(400, 'Contract address is required');
  }
  return { contractAddress };
}

function parseRpcEndpointCreateRequest(
  body: unknown,
): RpcEndpointCreateRequest {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'Network and RPC URL are required');
  }
  const { network, url } = body as {
    network?: unknown;
    url?: unknown;
  };
  if (typeof network !== 'string' || typeof url !== 'string') {
    throw new ApiError(400, 'Network and RPC URL are required');
  }
  return { network, url };
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

async function dbVerifyUserPassword(
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

async function dbSaveActiveContractAddress(
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

async function dbListManagedAccountAddresses(
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

async function dbLoadManagedKeypairBytes(
  db: D1Database,
  userId: number,
  walletAddress: string,
  encryptionKeyStr: string,
): Promise<Uint8Array> {
  const normalizedAddress = normalizePubkey(walletAddress);
  const row = await db
    .prepare(
      "SELECT encrypted_private_key FROM accounts WHERE user_id = ?1 AND type = 'managed' AND wallet_address = ?2",
    )
    .bind(userId, normalizedAddress)
    .first<{ encrypted_private_key: string | null }>();
  if (!row?.encrypted_private_key) {
    throw new ApiError(404, `Managed wallet ${normalizedAddress} not found or has no key`);
  }
  return decryptPrivateKey(row.encrypted_private_key, encryptionKeyStr);
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

async function dbListTradeLogs(db: D1Database): Promise<TradeLogRecord[]> {
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

async function dbListWebhookTransactionLogs(
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
      eventType: firstRow.event_type,
      txSignature: firstRow.tx_signature,
      status,
      errorMessage: firstRow.error_message,
      createdAt: firstRow.created_at,
    };
  });
}

async function dbCreateTradeLog(
  db: D1Database,
  input: TradeLogCreateRequest,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  const timestamp = nowTs();
  await db
    .prepare(
      `INSERT INTO trade_logs (
        token_id,
        signal_id,
        setup_id,
        wallet_address,
        action,
        requested_amount,
        executed_amount,
        executed_price,
        tx_signature,
        status,
        error_message,
        created_at,
        updated_at
      ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      input.tokenId,
      input.setupId,
      input.walletAddress,
      input.action,
      input.requestedAmount,
      input.executedAmount ?? null,
      input.executedPrice ?? null,
      input.txSignature ?? null,
      input.status,
      input.errorMessage ?? null,
      timestamp,
      timestamp,
    )
    .run();
}

async function dbListRpcEndpoints(
  db: D1Database,
  userId: number,
  network = 'solana',
): Promise<RpcEndpoint[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      'SELECT id, network, url, created_at FROM rpc_endpoints WHERE user_id = ?1 AND network = ?2 ORDER BY created_at DESC, id DESC',
    )
    .bind(userId, network)
    .all<{
      id: number;
      network: string;
      url: string;
      created_at: number;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    network: row.network,
    url: row.url,
    createdAt: row.created_at,
  }));
}

async function dbResolveSolanaRpcUrls(
  db: D1Database,
  userId: number,
  envRpcUrl?: string,
): Promise<string[]> {
  const endpoints = await dbListRpcEndpoints(db, userId, 'solana');
  return dedupeStrings([
    ...endpoints.map((endpoint) => endpoint.url),
    envRpcUrl ?? '',
  ]);
}

async function dbAddRpcEndpoint(
  db: D1Database,
  userId: number,
  input: RpcEndpointCreateRequest,
): Promise<RpcEndpoint> {
  await dbEnsureTradeDomainSchema(db);
  const network = input.network.trim().toLowerCase();
  if (network !== 'solana') {
    throw new ApiError(400, 'Only the solana network is supported right now');
  }
  const url = normalizeRpcUrl(input.url);
  const createdAt = nowTs();
  try {
    await db
      .prepare(
        'INSERT INTO rpc_endpoints (user_id, network, url, created_at) VALUES (?1, ?2, ?3, ?4)',
      )
      .bind(userId, network, url, createdAt)
      .run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      throw new ApiError(409, 'This RPC endpoint has already been added');
    }
    throw err;
  }
  const row = await db
    .prepare(
      'SELECT id, network, url, created_at FROM rpc_endpoints WHERE user_id = ?1 AND network = ?2 AND url = ?3',
    )
    .bind(userId, network, url)
    .first<{
      id: number;
      network: string;
      url: string;
      created_at: number;
    }>();
  if (!row) throw new ApiError(500, 'Failed to load the saved RPC endpoint');
  return {
    id: row.id,
    network: row.network,
    url: row.url,
    createdAt: row.created_at,
  };
}

async function dbDeleteRpcEndpoint(
  db: D1Database,
  userId: number,
  endpointId: number,
): Promise<RpcEndpoint> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      'SELECT id, network, url, created_at FROM rpc_endpoints WHERE id = ?1 AND user_id = ?2',
    )
    .bind(endpointId, userId)
    .first<{
      id: number;
      network: string;
      url: string;
      created_at: number;
    }>();
  if (!row) {
    throw new ApiError(404, 'RPC endpoint not found');
  }
  await db.prepare('DELETE FROM rpc_endpoints WHERE id = ?1').bind(endpointId).run();
  return {
    id: row.id,
    network: row.network,
    url: row.url,
    createdAt: row.created_at,
  };
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

  // Enrich with Jupiter token metadata (name, symbol, decimals)
  let jupiterName: string | null = null;
  let jupiterSymbol: string | null = null;
  let resolvedDecimals = decimals;
  try {
    const jupiterMeta = await fetchJupiterTokenMetadata(contractAddress);
    if (jupiterMeta) {
      jupiterName = jupiterMeta.name;
      jupiterSymbol = jupiterMeta.symbol;
      if (resolvedDecimals == null && jupiterMeta.decimals != null) {
        resolvedDecimals = jupiterMeta.decimals;
      }
    }
  } catch {
    // non-fatal: token may not be in Jupiter's verified list yet
  }

  await db
    .prepare(
      `INSERT INTO tradable_tokens (
         network,
         contract_address,
         symbol,
         name,
         decimals,
         is_active,
         created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
       ON CONFLICT(network, contract_address) DO UPDATE SET
         is_active = 1,
         symbol = COALESCE(?3, tradable_tokens.symbol),
         name = COALESCE(?4, tradable_tokens.name),
         decimals = COALESCE(?5, tradable_tokens.decimals)`,
    )
    .bind(network, contractAddress, jupiterSymbol, jupiterName, resolvedDecimals, createdAt)
    .run();
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

async function dbUpdateTradableTokenMetadata(
  db: D1Database,
  tokenId: number,
  snapshot: TokenMarketSnapshot,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  await db
    .prepare(
      `UPDATE tradable_tokens
       SET symbol = COALESCE(?2, symbol),
           name = COALESCE(?3, name)
       WHERE id = ?1`,
    )
    .bind(tokenId, snapshot.tokenSymbol, snapshot.tokenName)
    .run();
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

async function dbGetLatestTokenMarketSnapshot(
  db: D1Database,
  tokenId: number,
): Promise<TokenMarketSnapshot | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      `SELECT
         network,
         contract_address,
         token_name,
         token_symbol,
         price_usd,
         liquidity_usd,
         fdv,
         volume_24h,
         total_transactions_24h,
         outsiders_over_one_usd,
         dex_id,
         pair_address,
         fetched_at
       FROM token_market_snapshots
       WHERE token_id = ?1
       ORDER BY CASE
         WHEN fetched_at < 1000000000000 THEN fetched_at * 1000
         ELSE fetched_at
       END DESC, id DESC
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<{
      network: string;
      contract_address: string;
      token_name: string | null;
      token_symbol: string | null;
      price_usd: number | null;
      liquidity_usd: number | null;
      fdv: number | null;
      volume_24h: number | null;
      total_transactions_24h: number | null;
      outsiders_over_one_usd: number | null;
      dex_id: string | null;
      pair_address: string | null;
      fetched_at: number;
    }>();
  if (!row) {
    return null;
  }
  return {
    network: row.network,
    contractAddress: row.contract_address,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    priceUsd: row.price_usd,
    liquidityUsd: row.liquidity_usd,
    fdv: row.fdv,
    volume24h: row.volume_24h,
    totalTransactions24h: row.total_transactions_24h,
    outsidersOverOneUsd: row.outsiders_over_one_usd,
    dexId: row.dex_id,
    pairAddress: row.pair_address,
    fetchedAt: normalizeTimestampMs(row.fetched_at),
  };
}

async function dbInsertTokenMarketSnapshot(
  db: D1Database,
  tokenId: number,
  snapshot: TokenMarketSnapshot,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  await db
    .prepare(
      `INSERT INTO token_market_snapshots (
        token_id,
        network,
        contract_address,
        token_name,
        token_symbol,
        price_usd,
        liquidity_usd,
        fdv,
        volume_24h,
        total_transactions_24h,
        outsiders_over_one_usd,
        dex_id,
        pair_address,
        fetched_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
    .bind(
      tokenId,
      snapshot.network,
      snapshot.contractAddress,
      snapshot.tokenName,
      snapshot.tokenSymbol,
      snapshot.priceUsd,
      snapshot.liquidityUsd,
      snapshot.fdv,
      snapshot.volume24h,
      snapshot.totalTransactions24h,
      snapshot.outsidersOverOneUsd,
      snapshot.dexId,
      snapshot.pairAddress,
      snapshot.fetchedAt,
    )
    .run();
}

// Query market snapshots within a time range
async function dbGetTokenMarketSnapshotsByTimeRange(
  db: D1Database,
  tokenId: number,
  startTime: number,
  endTime: number,
  limit: number = 100,
): Promise<TokenMarketSnapshot[]> {
  await dbEnsureTradeDomainSchema(db);
  const rows = await db
    .prepare(
      `SELECT
         network,
         contract_address,
         token_name,
         token_symbol,
         price_usd,
         liquidity_usd,
         fdv,
         volume_24h,
         total_transactions_24h,
         outsiders_over_one_usd,
         dex_id,
         pair_address,
         fetched_at
       FROM token_market_snapshots
       WHERE token_id = ?1
         AND CASE
           WHEN fetched_at < 1000000000000 THEN fetched_at * 1000
           ELSE fetched_at
         END >= ?2
         AND CASE
           WHEN fetched_at < 1000000000000 THEN fetched_at * 1000
           ELSE fetched_at
         END <= ?3
       ORDER BY CASE
         WHEN fetched_at < 1000000000000 THEN fetched_at * 1000
         ELSE fetched_at
       END DESC, id DESC
       LIMIT ?4`,
    )
    .bind(tokenId, startTime, endTime, limit)
    .all<{
      network: string;
      contract_address: string;
      token_name: string | null;
      token_symbol: string | null;
      price_usd: number | null;
      liquidity_usd: number | null;
      fdv: number | null;
      volume_24h: number | null;
      total_transactions_24h: number | null;
      outsiders_over_one_usd: number | null;
      dex_id: string | null;
      pair_address: string | null;
      fetched_at: number;
    }>();

  return rows.results.map((row) => ({
    network: row.network,
    contractAddress: row.contract_address,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    priceUsd: row.price_usd,
    liquidityUsd: row.liquidity_usd,
    fdv: row.fdv,
    volume24h: row.volume_24h,
    totalTransactions24h: row.total_transactions_24h,
    outsidersOverOneUsd: row.outsiders_over_one_usd,
    dexId: row.dex_id,
    pairAddress: row.pair_address,
    fetchedAt: normalizeTimestampMs(row.fetched_at),
  }));
}

async function dbCreateSignal(
  db: D1Database,
  input: SignalCreateRequest,
): Promise<{ signal: SignalRecord; inserted: boolean }> {
  await dbEnsureTradeDomainSchema(db);
  const existing = await db
    .prepare(
      `SELECT
         id,
         source,
         external_id,
         event_type,
         wallet_address,
         tx_signature,
         payload,
        details_json,
         processed,
         processed_at,
         error_message,
         retry_count,
         created_at
       FROM signals
       WHERE source = ?1 AND external_id = ?2
       LIMIT 1`,
    )
    .bind(input.source, input.externalId)
    .first<{
      id: number;
      source: string;
      external_id: string;
      event_type: string;
      wallet_address: string | null;
      tx_signature: string | null;
      payload: string;
      details_json: string | null;
      processed: number;
      processed_at: number | null;
      error_message: string | null;
      retry_count: number;
      created_at: number;
    }>();

  if (existing) {
    return {
      inserted: false,
      signal: {
        id: existing.id,
        source: existing.source,
        externalId: existing.external_id,
        eventType: existing.event_type,
        walletAddress: existing.wallet_address,
        txSignature: existing.tx_signature,
        payload: existing.payload,
        detailsJson: existing.details_json,
        processed: existing.processed === 1,
        processedState: existing.processed,
        processedAt: existing.processed_at,
        errorMessage: existing.error_message,
        retryCount: existing.retry_count,
        createdAt: existing.created_at,
      },
    };
  }

  const createdAt = nowTs();
  await db
    .prepare(
      `INSERT INTO signals (
        source,
        external_id,
        event_type,
        wallet_address,
        tx_signature,
        payload,
        details_json,
        processed,
        processed_at,
        error_message,
        retry_count,
        created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 2, NULL, NULL, 0, ?8)`,
    )
    .bind(
      input.source,
      input.externalId,
      input.eventType,
      input.walletAddress,
      input.txSignature,
      input.payload,
      input.detailsJson ?? null,
      createdAt,
    )
    .run();

  return {
    inserted: true,
    signal: {
      id: 0,
      source: input.source,
      externalId: input.externalId,
      eventType: input.eventType,
      walletAddress: input.walletAddress,
      txSignature: input.txSignature,
      payload: input.payload,
      detailsJson: input.detailsJson ?? null,
      processed: false,
      processedState: 2,
      processedAt: null,
      errorMessage: null,
      retryCount: 0,
      createdAt,
    },
  };
}

async function dbClaimSignalProcessing(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<boolean> {
  await dbEnsureTradeDomainSchema(db);
  const result = await db
    .prepare(
      `UPDATE signals
       SET processed = 2,
           processed_at = NULL,
           error_message = NULL
       WHERE source = ?1 AND external_id = ?2 AND processed = 0`,
    )
    .bind(source, externalId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function dbResolvePreferredSignalWalletAddress(
  db: D1Database,
  userId: number,
  candidates: Array<string | null | undefined>,
  fallbackWalletAddress: string | null,
): Promise<string | null> {
  const normalizedCandidates = uniqueSolanaPubkeys(candidates);
  if (normalizedCandidates.length === 0) {
    return fallbackWalletAddress;
  }

  const rows = await db
    .prepare(
      `SELECT wallet_address, type
       FROM accounts
       WHERE user_id = ?1 AND wallet_address IN (?2, ?3)
       ORDER BY CASE type WHEN 'managed' THEN 0 ELSE 1 END, id ASC`,
    )
    .bind(userId, normalizedCandidates[0] ?? '', normalizedCandidates[1] ?? '')
    .all<{
      wallet_address: string;
      type: string;
    }>();
  if (rows.results.length > 0) {
    return rows.results[0].wallet_address;
  }
  return fallbackWalletAddress ?? normalizedCandidates[0] ?? null;
}

async function dbUpdateSignalTransactionDetails(
  db: D1Database,
  source: string,
  externalId: string,
  walletAddress: string | null,
  details: StoredSignalTransactionDetails,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  await db
    .prepare(
      `UPDATE signals
       SET wallet_address = ?3,
           details_json = ?4
       WHERE source = ?1 AND external_id = ?2`,
    )
    .bind(source, externalId, walletAddress, JSON.stringify(details))
    .run();
}

async function fetchSolanaWebhookTransactionDetailsFromRpc(
  rpcUrls: string | string[],
  txSignature: string,
  trackedContractAddress: string,
  payloadDetails: Partial<StoredSignalTransactionDetails>,
): Promise<Partial<StoredSignalTransactionDetails>> {
  try {
    const transaction = await solanaRpc<{
      meta?: {
        err?: unknown;
        preTokenBalances?: Array<{
          owner?: string;
          mint?: string;
          uiTokenAmount?: {
            uiAmountString?: string;
            amount?: string;
            decimals?: number;
          };
        }>;
        postTokenBalances?: Array<{
          owner?: string;
          mint?: string;
          uiTokenAmount?: {
            uiAmountString?: string;
            amount?: string;
            decimals?: number;
          };
        }>;
      };
    }>(rpcUrls, 'getTransaction', [
      txSignature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);

    const deltaByOwner = new Map<string, { tracked: number; usdc: number }>();
    const applyTokenBalances = (
      balances:
        | Array<{
            owner?: string;
            mint?: string;
            uiTokenAmount?: {
              uiAmountString?: string;
              amount?: string;
              decimals?: number;
            };
          }>
        | undefined,
      sign: -1 | 1,
    ) => {
      for (const balance of balances ?? []) {
        const owner = tryNormalizeSolanaPubkey(balance.owner);
        const mint = tryNormalizeSolanaPubkey(balance.mint);
        if (!owner || !mint) {
          continue;
        }
        const uiAmount =
          balance.uiTokenAmount?.uiAmountString != null
            ? Number.parseFloat(balance.uiTokenAmount.uiAmountString)
            : typeof balance.uiTokenAmount?.amount === 'string' && typeof balance.uiTokenAmount?.decimals === 'number'
              ? Number.parseFloat(balance.uiTokenAmount.amount) / 10 ** balance.uiTokenAmount.decimals
              : null;
        if (uiAmount == null || !Number.isFinite(uiAmount)) {
          continue;
        }
        const current = deltaByOwner.get(owner) ?? { tracked: 0, usdc: 0 };
        if (mint === trackedContractAddress) {
          current.tracked += sign * uiAmount;
        }
        if (mint === SOLANA_USDC_MINT) {
          current.usdc += sign * uiAmount;
        }
        deltaByOwner.set(owner, current);
      }
    };

    applyTokenBalances(transaction.meta?.preTokenBalances, -1);
    applyTokenBalances(transaction.meta?.postTokenBalances, 1);

    const candidateWallets = uniqueSolanaPubkeys([
      payloadDetails.primaryWalletAddress,
      payloadDetails.fromWalletAddress,
      payloadDetails.toWalletAddress,
    ]);

    let focusWallet: string | null = null;
    for (const wallet of candidateWallets) {
      const delta = deltaByOwner.get(wallet);
      if (delta && (delta.tracked !== 0 || delta.usdc !== 0)) {
        focusWallet = wallet;
        break;
      }
    }
    if (!focusWallet) {
      const fallbackEntry = [...deltaByOwner.entries()].find(
        ([, delta]) => delta.tracked !== 0 || delta.usdc !== 0,
      );
      focusWallet = fallbackEntry?.[0] ?? null;
    }

    const focusDelta = focusWallet ? deltaByOwner.get(focusWallet) ?? null : null;
    const action =
      focusDelta && focusDelta.tracked > 0 && focusDelta.usdc < 0
        ? 'BUY'
        : focusDelta && focusDelta.tracked < 0 && focusDelta.usdc > 0
          ? 'SELL'
          : null;

    const trackedOwners = [...deltaByOwner.entries()].filter(([, delta]) => delta.tracked !== 0);
    const fromWalletAddress =
      payloadDetails.fromWalletAddress ??
      trackedOwners.find(([, delta]) => delta.tracked < 0)?.[0] ??
      null;
    const toWalletAddress =
      payloadDetails.toWalletAddress ??
      trackedOwners.find(([, delta]) => delta.tracked > 0)?.[0] ??
      null;

    return {
      tokenContractAddress: trackedContractAddress,
      fromWalletAddress,
      toWalletAddress,
      primaryWalletAddress: focusWallet,
      action,
      usdcAmount: focusDelta && focusDelta.usdc !== 0 ? Math.abs(focusDelta.usdc) : null,
      tokenAmount: focusDelta && focusDelta.tracked !== 0 ? Math.abs(focusDelta.tracked) : null,
      transactionStatus: transaction.meta?.err ? 'FAILED' : 'CONFIRMED',
      detailSource: 'rpc',
    };
  } catch (err: unknown) {
    console.warn(`Failed to enrich webhook transaction ${txSignature} from RPC:`, err);
    return {
      tokenContractAddress: trackedContractAddress,
      transactionStatus: 'PENDING',
      detailSource: 'unknown',
    };
  }
}

async function dbMarkSignalProcessed(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  await db
    .prepare(
      `UPDATE signals
       SET processed = 1,
           processed_at = ?3,
           error_message = NULL
       WHERE source = ?1 AND external_id = ?2`,
    )
    .bind(source, externalId, nowTs())
    .run();
}

async function dbMarkSignalFailed(
  db: D1Database,
  source: string,
  externalId: string,
  errorMessage: string,
): Promise<void> {
  await dbEnsureTradeDomainSchema(db);
  await db
    .prepare(
      `UPDATE signals
       SET processed = 0,
           processed_at = NULL,
           error_message = ?3,
           retry_count = retry_count + 1
       WHERE source = ?1 AND external_id = ?2`,
    )
    .bind(source, externalId, errorMessage)
    .run();
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

async function dbGetLatestHistoricalSetupId(
  db: D1Database,
  userId: number,
): Promise<number | null> {
  await dbEnsureTradeDomainSchema(db);
  const row = await db
    .prepare(
      'SELECT id FROM historic_setups WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .bind(userId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function dbComputeManagedProfitUsdc(
  db: D1Database,
  userId: number,
  contractAddress: string,
  currentPriceUsd: number | null,
): Promise<number> {
  await dbEnsureTradeDomainSchema(db);
  const tokenId = await dbResolveTradableTokenId(db, contractAddress);
  if (!tokenId) {
    return 0;
  }

  const rows = await db
    .prepare(
      `SELECT p.quantity, p.avg_cost, p.realized_pnl
       FROM positions p
       INNER JOIN accounts a ON a.wallet_address = p.wallet_address
       WHERE a.user_id = ?1 AND a.type = 'managed' AND p.token_id = ?2`,
    )
    .bind(userId, tokenId)
    .all<{
      quantity: number;
      avg_cost: number;
      realized_pnl: number;
    }>();

  let profitUsdc = 0;
  for (const row of rows.results) {
    profitUsdc += row.realized_pnl ?? 0;
    if (currentPriceUsd != null) {
      profitUsdc += (currentPriceUsd - (row.avg_cost ?? 0)) * (row.quantity ?? 0);
    }
  }
  return profitUsdc;
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

function mapTokenMarketSnapshotToStrategySnapshot(
  snapshot: TokenMarketSnapshot | null,
): StrategyMarketSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return {
    contractAddress: snapshot.contractAddress,
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
  dry_run: number;
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
    dryRun: row.dry_run === 1,
    summary: parseJsonText<Record<string, unknown>>(row.summary_json),
    createdAt: row.created_at,
  };
}

async function dbGetOrCreatePrimaryStrategyDefinition(
  db: D1Database,
  userId: number,
): Promise<StrategyDefinitionRecord> {
  await dbEnsureTradeDomainSchema(db);
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
  await dbEnsureTradeDomainSchema(db);
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

async function dbGetActiveStrategyVersion(
  db: D1Database,
  userId: number,
): Promise<StrategyVersionRecord | null> {
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  if (definition.currentVersionId == null) {
    return null;
  }
  return dbGetStrategyVersionById(db, definition.currentVersionId);
}

function mapStrategyDocumentToSettingsUpdate(
  document: StrategyVersionDocument,
): SettingsUpdateRequest {
  return {
    contractAddress: document.parameters.contractAddress,
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

async function dbSaveActiveStrategyVersionDocument(
  db: D1Database,
  userId: number,
  documentInput: StrategyVersionDocument,
  options?: {
    changeNote?: string;
  },
): Promise<{ version: StrategyVersionRecord; created: boolean }> {
  await dbEnsureTradeDomainSchema(db);
  const definition = await dbGetOrCreatePrimaryStrategyDefinition(db, userId);
  const document = normalizeStrategyDocument(documentInput);
  const checksum = await sha256Hex(JSON.stringify(document));
  const currentVersion = definition.currentVersionId
    ? await dbGetStrategyVersionById(db, definition.currentVersionId)
    : null;

  if (currentVersion && currentVersion.checksum === checksum) {
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

async function dbListStrategyVersions(
  db: D1Database,
  userId: number,
  limit = 25,
): Promise<StrategyVersionRecord[]> {
  await dbEnsureTradeDomainSchema(db);
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
       ORDER BY version_no DESC, id DESC
       LIMIT ?2`,
    )
    .bind(definition.id, limit)
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
  return rows.results.map(mapStrategyVersionRow);
}

async function dbListStrategyEvaluations(
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
  dryRun: boolean;
  summary: Record<string, unknown>;
  createdAt: number;
}>> {
  await dbEnsureTradeDomainSchema(db);
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
         se.dry_run,
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
      dry_run: number;
      summary_json: string;
      created_at: number;
    }>();
  return rows.results.map(mapStrategyEvaluationRow);
}

async function dbSyncActiveStrategyVersionFromSettings(
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
  await dbEnsureTradeDomainSchema(db);
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
         dry_run,
         summary_json,
         created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
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
      runtime.evaluation.dryRun ? 1 : 0,
      JSON.stringify(runtime.summary),
      createdAt,
    )
    .run();
}

async function runAndPersistStrategyEvaluation(
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
): Promise<{ version: StrategyVersionRecord; runtime: StrategyRuntimeResult }> {
  const { version } = await dbSyncActiveStrategyVersionFromSettings(
    db,
    userId,
    settings,
    options,
  );
  const runtime = runStrategyRuntime({
    strategyDocument: version.document,
    trigger,
    marketSnapshot: mapTokenMarketSnapshotToStrategySnapshot(marketSnapshot),
  });
  await dbCreateStrategyEvaluation(db, userId, version.id, trigger, runtime);
  return { version, runtime };
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

// ─── Jupiter token API ────────────────────────────────────────────────────────

// ─── Solana transaction signing ───────────────────────────────────────────────

/**
 * Parse a compact-u16 integer from a byte array at a given offset.
 * Returns [value, number of bytes consumed].
 */
function readCompactU16(bytes: Uint8Array, offset: number): [number, number] {
  let val = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < bytes.length) {
    const byte = bytes[offset + bytesRead];
    bytesRead += 1;
    val |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [val, bytesRead];
}

/**
 * Sign a Solana (legacy or v0) serialized transaction with the given 64-byte
 * Solana keypair. The first signature slot is replaced with the real signature.
 * The keypair must be the primary signer (index 0).
 */
function signSolanaTransaction(txBytes: Uint8Array, signerKeypair: Uint8Array): Uint8Array {
  const [sigCount, sigCountLen] = readCompactU16(txBytes, 0);
  if (sigCount === 0) throw new Error('Transaction has no signature slots');
  const messageOffset = sigCountLen + sigCount * 64;
  const messageBytes = txBytes.slice(messageOffset);
  // nacl.sign.detached takes the 64-byte secretKey
  const signature = nacl.sign.detached(messageBytes, signerKeypair);
  const signed = new Uint8Array(txBytes);
  // Replace the first 64-byte signature slot
  signed.set(signature, sigCountLen);
  return signed;
}

async function sendSolanaTransaction(
  rpcUrls: string | string[],
  signedTxBytes: Uint8Array,
): Promise<string> {
  let binary = '';
  signedTxBytes.forEach((b) => (binary += String.fromCharCode(b)));
  const base64Tx = btoa(binary);
  const signature = await solanaRpc<string>(rpcUrls, 'sendTransaction', [
    base64Tx,
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  return signature;
}


async function fetchSolanaOutsiderHolderCountOverOneUsd(
  rpcUrls: string | string[],
  mint: string,
  managedAccountAddresses: string[],
  priceUsd: number | null,
): Promise<number | null> {
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return null;
  }

  const filters = [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }];
  const managedSet = new Set(
    managedAccountAddresses.map((address) => normalizePubkey(address)),
  );
  const programResults = await Promise.allSettled(
    [SOLANA_SPL_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID].map((programId) =>
      solanaRpc<
        Array<{
          account: {
            data: {
              parsed?: {
                info?: {
                  owner?: string;
                  tokenAmount?: {
                    amount?: string;
                    decimals?: number;
                  };
                };
              };
            };
          };
        }>
      >(rpcUrls, 'getProgramAccounts', [
        programId,
        { filters, encoding: 'jsonParsed' },
      ]),
    ),
  );

  let decimals: number | null = null;
  let successfulQueryCount = 0;
  const holderBalances = new Map<string, bigint>();

  for (const programResult of programResults) {
    if (programResult.status !== 'fulfilled') {
      continue;
    }
    successfulQueryCount += 1;
    for (const account of programResult.value) {
      const owner = account.account.data.parsed?.info?.owner;
      const tokenAmount = account.account.data.parsed?.info?.tokenAmount;
      if (!owner || !tokenAmount?.amount) {
        continue;
      }

      const normalizedOwner = normalizePubkey(owner);
      if (managedSet.has(normalizedOwner)) {
        continue;
      }

      holderBalances.set(
        normalizedOwner,
        (holderBalances.get(normalizedOwner) ?? 0n) + BigInt(tokenAmount.amount),
      );
      if (typeof tokenAmount.decimals === 'number') {
        decimals = tokenAmount.decimals;
      }
    }
  }

  if (successfulQueryCount === 0) {
    const rejectedResult = programResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    throw rejectedResult?.reason instanceof Error
      ? rejectedResult.reason
      : new ApiError(502, 'Failed to load token holder accounts from Solana RPC');
  }

  if (decimals == null) {
    decimals = await fetchSolanaMintDecimals(rpcUrls, mint);
  }
  if (decimals == null) {
    return null;
  }

  let outsiderCount = 0;
  for (const rawAmount of holderBalances.values()) {
    const tokenAmount = Number.parseFloat(formatTokenAmount(rawAmount, decimals));
    if (Number.isFinite(tokenAmount) && tokenAmount * priceUsd > 1) {
      outsiderCount += 1;
    }
  }

  return outsiderCount;
}

async function syncTokenMarketSnapshotForUser(
  db: D1Database,
  userId: number,
  network: string,
  contractAddress: string,
  rpcUrls: string | string[],
  options?: {
    force?: boolean;
    managedAccountAddresses?: string[];
    fallbackToStoredOnError?: boolean;
  },
): Promise<TokenMarketSnapshot | null> {
  const normalizedNetwork = network.trim().toLowerCase();
  if (normalizedNetwork !== 'solana') {
    return null;
  }

  const normalizedAddress = normalizePubkey(contractAddress);
  const cacheKey = tokenMarketCacheKey(normalizedNetwork, normalizedAddress);
  const tokenId = await dbResolveTradableTokenId(db, normalizedAddress);
  const latestStoredSnapshot = tokenId
    ? await dbGetLatestTokenMarketSnapshot(db, tokenId)
    : null;

  if (!options?.force) {
    const cachedSnapshot = readTokenMarketCache(cacheKey);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    const latestSnapshotAgeMs = latestStoredSnapshot
      ? nowMs() - latestStoredSnapshot.fetchedAt
      : null;
    if (
      latestStoredSnapshot &&
      latestSnapshotAgeMs != null &&
      latestSnapshotAgeMs <= TOKEN_MARKET_CACHE_TTL_MS
    ) {
      writeTokenMarketCache(cacheKey, latestStoredSnapshot);
      return latestStoredSnapshot;
    }
  }

  // Look up stored decimals for the quote-based price fallback
  const storedDecimals: number | null = tokenId
    ? ((await db
        .prepare('SELECT decimals FROM tradable_tokens WHERE id = ?1')
        .bind(tokenId)
        .first<{ decimals: number | null }>())?.decimals ?? null)
    : null;

  // Fetch metadata from Jupiter lite API (includes price, FDV, liquidity, holders)
  let liveSnapshot: TokenMarketSnapshot | null = null;
  let jupiterMeta: JupiterTokenMetadata | null = null;
  try {
    jupiterMeta = await fetchJupiterTokenMetadata(normalizedAddress);

    // Resolve decimals: DB → Jupiter metadata → Solana RPC (fallback)
    let resolvedDecimals = storedDecimals ?? jupiterMeta?.decimals ?? null;
    if (resolvedDecimals == null) {
      try {
        resolvedDecimals = await fetchSolanaMintDecimals(rpcUrls, normalizedAddress);
      } catch {
        // Non-fatal — quote-based price will be skipped
      }
    }

    // Use price from lite-api metadata, fall back to quote-derived price
    let jupiterPrice = jupiterMeta?.usdPrice ?? null;
    if (jupiterPrice == null && resolvedDecimals != null) {
      jupiterPrice = await fetchJupiterPriceViaQuote(normalizedAddress, resolvedDecimals);
    }

    // Build a snapshot from any available data — even if price is null
    if (jupiterPrice != null || jupiterMeta != null) {
      liveSnapshot = {
        network: normalizedNetwork,
        contractAddress: normalizedAddress,
        tokenName: jupiterMeta?.name ?? latestStoredSnapshot?.tokenName ?? null,
        tokenSymbol: jupiterMeta?.symbol ?? latestStoredSnapshot?.tokenSymbol ?? null,
        priceUsd: jupiterPrice,
        liquidityUsd: jupiterMeta?.liquidityUsd ?? null,
        fdv: jupiterMeta?.fdv ?? null,
        volume24h: jupiterMeta?.volume24h ?? null,
        totalTransactions24h: jupiterMeta?.totalTransactions24h ?? null,
        outsidersOverOneUsd: null,
        dexId: jupiterMeta?.dexId ?? null,
        pairAddress: jupiterMeta?.pairAddress ?? null,
        fetchedAt: nowMs(),
      };
    }
  } catch (err: unknown) {
    console.warn(`Jupiter market fetch failed for ${normalizedAddress}:`, err);
  }

  if (!liveSnapshot) {
    if ((options?.fallbackToStoredOnError ?? true) && latestStoredSnapshot) {
      writeTokenMarketCache(cacheKey, latestStoredSnapshot);
      return latestStoredSnapshot;
    }
    return null;
  }

  let outsidersOverOneUsd: number | null = null;
  try {
    const managedAccountAddresses =
      options?.managedAccountAddresses ??
      (await dbListManagedAccountAddresses(db, userId));

    // If Jupiter provides total holders count, calculate outsiders = total - internal
    if (jupiterMeta?.totalHolders != null && jupiterMeta.totalHolders > 0) {
      outsidersOverOneUsd = Math.max(
        0,
        jupiterMeta.totalHolders - managedAccountAddresses.length,
      );
      console.log(`[syncTokenMarketSnapshotForUser] Outsiders from Jupiter: ${jupiterMeta.totalHolders} total - ${managedAccountAddresses.length} managed = ${outsidersOverOneUsd}`);
    } else if (liveSnapshot?.priceUsd != null) {
      // Fallback: use RPC to scan for outsiders with balance > $1 USD
      outsidersOverOneUsd = await fetchSolanaOutsiderHolderCountOverOneUsd(
        rpcUrls,
        normalizedAddress,
        managedAccountAddresses,
        liveSnapshot.priceUsd,
      );
    } else {
      console.log(`[syncTokenMarketSnapshotForUser] Cannot calculate outsiders: no holders count from Jupiter and no price for RPC filtering`);
    }
  } catch (err: unknown) {
    console.warn(
      `Failed to compute outsider holder count for ${normalizedAddress}:`,
      err,
    );
  }

  const snapshot: TokenMarketSnapshot = {
    ...liveSnapshot,
    outsidersOverOneUsd,
  };

  if (tokenId) {
    await Promise.all([
      dbUpdateTradableTokenMetadata(db, tokenId, snapshot),
      dbInsertTokenMarketSnapshot(db, tokenId, snapshot),
    ]);
  }

  writeTokenMarketCache(cacheKey, snapshot);
  return snapshot;
}

async function solanaRpc<T>(
  rpcUrls: string | string[],
  method: string,
  params: unknown[],
): Promise<T> {
  const pool = dedupeStrings(
    (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls]).map((url) => url.trim()),
  );
  let lastErrorMessage = 'Unknown Solana RPC failure';

  for (const rpcUrl of pool) {
    try {
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
    } catch (err: unknown) {
      lastErrorMessage = err instanceof Error ? err.message : String(err);
      console.warn(`Solana RPC attempt failed for ${rpcUrl}: ${lastErrorMessage}`);
    }
  }

  throw new ApiError(
    502,
    `All configured Solana RPC endpoints failed for ${method}. Last error: ${lastErrorMessage}`,
  );
}

async function fetchSolanaMintDecimals(
  rpcUrls: string | string[],
  mint: string,
): Promise<number | null> {
  const result = await solanaRpc<{ value: { decimals: number } }>(
    rpcUrls,
    'getTokenSupply',
    [mint],
  );
  return result.value?.decimals ?? null;
}

async function fetchSolanaTokenBalance(
  rpcUrls: string | string[],
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
  }>(rpcUrls, 'getTokenAccountsByOwner', [owner, { mint: token.mint }, { encoding: 'jsonParsed' }]);

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
  rpcUrls: string | string[],
): Promise<WalletBalanceResponse> {
  const trackedTokens = buildTrackedTokens(settings, tradableTokens);
  const cacheKey = walletBalanceCacheKey(address, trackedTokens);
  const cached = readWalletBalanceCache(cacheKey);
  if (cached) return cached;

  const lamportsResult = await solanaRpc<{ value: number }>(
    rpcUrls,
    'getBalance',
    [address],
  );
  const sol = formatTokenAmount(BigInt(lamportsResult.value), 9);
  const usdc = await fetchSolanaTokenBalance(rpcUrls, address, {
    mint: SOLANA_USDC_MINT,
    symbol: 'USDC',
    network: 'solana',
    decimals: 6,
  });

  const tokenResults = await Promise.allSettled(
    trackedTokens.map(async (token) => {
      const decimals =
        token.decimals ?? (await fetchSolanaMintDecimals(rpcUrls, token.mint));
      return fetchSolanaTokenBalance(rpcUrls, address, {
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

async function dbListUserIdsByActiveContractAddress(
  db: D1Database,
  contractAddress: string,
): Promise<number[]> {
  await dbEnsureSchema(db);
  const rows = await db
    .prepare(
      `SELECT DISTINCT user_id
       FROM settings
       WHERE key = ?1 AND value = ?2
       ORDER BY user_id ASC`,
    )
    .bind('contractAddress', normalizePubkey(contractAddress))
    .all<{ user_id: number }>();
  return rows.results.map((row) => row.user_id);
}

function resolveAlchemyWebhookSigningKey(env: Env): string {
  const signingKey =
    env.ALCHEMY_WEBHOOK_SIGNING_KEY?.trim() ||
    env.ALCHEMY_WEBHOOK_SECRET?.trim();
  if (!signingKey) {
    throw new ApiError(
      503,
      'ALCHEMY_WEBHOOK_SIGNING_KEY is not configured',
    );
  }
  return signingKey;
}

function parseHexString(value: string): Uint8Array {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) {
    throw new ApiError(400, 'X-Alchemy-Signature must be a valid hex string');
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

async function assertAlchemyWebhookSignature(
  request: Request,
  env: Env,
  rawBody: string,
): Promise<void> {
  const signature = request.headers.get('X-Alchemy-Signature')?.trim();
  if (!signature) {
    throw new ApiError(401, 'Missing X-Alchemy-Signature header');
  }

  const signingKey = resolveAlchemyWebhookSigningKey(env);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    parseHexString(signature),
    new TextEncoder().encode(rawBody),
  );
  if (!isValid) {
    throw new ApiError(401, 'Alchemy webhook signature is invalid');
  }
}

function deriveAlchemySignalsFromPayload(
  payload: AlchemyWebhookPayload,
  defaultContractAddress: string | null,
): DerivedChainSignal[] {
  const webhookId = readNonEmptyString(payload.webhookId);
  const eventId = readNonEmptyString(payload.id) ?? `alchemy-${nowTs()}`;
  const payloadType = readNonEmptyString(payload.type) ?? 'ALCHEMY_NOTIFY';
  const event = isRecord(payload.event) ? payload.event : null;
  const fallbackContracts = defaultContractAddress ? [defaultContractAddress] : [];

  if (event && Array.isArray(event.activity)) {
    const activitySignals = event.activity.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const rawContract = isRecord(item.rawContract) ? item.rawContract : null;
      const log = isRecord(item.log) ? item.log : null;
      const txSignature =
        readNonEmptyString(item.hash) ??
        readNonEmptyString(log?.transactionHash) ??
        null;
      const contractAddresses = uniqueSolanaPubkeys([
        ...fallbackContracts,
        rawContract?.address,
        item.contractAddress,
        item.tokenAddress,
        item.mint,
        log?.address,
      ]);
      return [
        {
          externalId: `${eventId}:${txSignature ?? index}:${index}`,
          eventType: `${payloadType}:${readNonEmptyString(item.category) ?? 'activity'}`,
          walletAddress:
            tryNormalizeSolanaPubkey(item.fromAddress) ??
            tryNormalizeSolanaPubkey(item.toAddress),
          txSignature,
          contractAddresses,
          payload: JSON.stringify({
            webhookId,
            eventId,
            type: payloadType,
            activity: item,
          }),
        } satisfies DerivedChainSignal,
      ];
    });
    if (activitySignals.length > 0) {
      return activitySignals;
    }
  }

  const data = event && isRecord(event.data) ? event.data : null;
  const block = data && isRecord(data.block) ? data.block : null;
  if (block && Array.isArray(block.logs)) {
    const logSignals = block.logs.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const transaction = isRecord(item.transaction) ? item.transaction : null;
      const from = transaction && isRecord(transaction.from) ? transaction.from : null;
      const to = transaction && isRecord(transaction.to) ? transaction.to : null;
      const account = isRecord(item.account) ? item.account : null;
      const txSignature =
        readNonEmptyString(transaction?.hash) ??
        readNonEmptyString(item.transactionHash) ??
        null;
      const contractAddresses = uniqueSolanaPubkeys([
        ...fallbackContracts,
        account?.address,
        item.address,
        item.contractAddress,
        item.tokenAddress,
        item.mint,
      ]);
      return [
        {
          externalId: `${eventId}:${txSignature ?? index}:${index}`,
          eventType: `${payloadType}:log`,
          walletAddress:
            tryNormalizeSolanaPubkey(from?.address) ??
            tryNormalizeSolanaPubkey(to?.address),
          txSignature,
          contractAddresses,
          payload: JSON.stringify({
            webhookId,
            eventId,
            type: payloadType,
            log: item,
          }),
        } satisfies DerivedChainSignal,
      ];
    });
    if (logSignals.length > 0) {
      return logSignals;
    }
  }

  return [
    {
      externalId: eventId,
      eventType: payloadType,
      walletAddress: null,
      txSignature: null,
      contractAddresses: uniqueSolanaPubkeys([
        ...fallbackContracts,
        event?.contractAddress,
        event?.address,
        event?.tokenAddress,
        event?.mint,
      ]),
      payload: JSON.stringify(payload),
    },
  ];
}

async function processTokenActivitySignal(
  env: Env,
  input: {
    userId: number;
    contractAddress: string;
    source: string;
    externalId: string;
    eventType: string;
    walletAddress: string | null;
    txSignature: string | null;
    payload: string;
    providerLabel: string;
  },
): Promise<boolean> {
  const normalizedContractAddress = normalizePubkey(input.contractAddress);
  const { inserted, signal } = await dbCreateSignal(env.TRADINGBOT_DB, {
    source: input.source,
    externalId: input.externalId,
    eventType: input.eventType,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature,
    payload: input.payload,
    detailsJson: null,
  });

  if (!inserted) {
    if (signal.processed) {
      return false;
    }
    const claimed = await dbClaimSignalProcessing(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
    );
    if (!claimed) {
      return false;
    }
  }

  try {
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      input.userId,
      env.SOLANA_RPC_URL,
    );
    const payloadDetails = extractWebhookTransactionDetailsFromPayload(
      input.payload,
      normalizedContractAddress,
    );
    const rpcDetails = input.txSignature
      ? await fetchSolanaWebhookTransactionDetailsFromRpc(
          rpcUrls,
          input.txSignature,
          normalizedContractAddress,
          payloadDetails,
        )
      : null;
    const mergedDetails = mergeStoredSignalTransactionDetails(
      {
        tokenContractAddress: normalizedContractAddress,
        primaryWalletAddress: input.walletAddress,
        transactionStatus: 'PENDING',
        detailSource: 'unknown',
      },
      payloadDetails,
      rpcDetails,
    );
    const preferredWalletAddress = await dbResolvePreferredSignalWalletAddress(
      env.TRADINGBOT_DB,
      input.userId,
      [
        mergedDetails.primaryWalletAddress,
        mergedDetails.fromWalletAddress,
        mergedDetails.toWalletAddress,
      ],
      input.walletAddress,
    );
    mergedDetails.primaryWalletAddress = preferredWalletAddress;
    await dbUpdateSignalTransactionDetails(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
      preferredWalletAddress,
      mergedDetails,
    );

    let marketSnapshot: TokenMarketSnapshot | null = null;
    try {
      marketSnapshot = await syncTokenMarketSnapshotForUser(
        env.TRADINGBOT_DB,
        input.userId,
        'solana',
        normalizedContractAddress,
        rpcUrls,
        {
          force: true,
        },
      );
    } catch (err: unknown) {
      console.warn(
        `Failed to refresh market snapshot from ${input.providerLabel} event for ${normalizedContractAddress}:`,
        err,
      );
    }

    let strategySummary: string | null = null;
    try {
      const settings = await dbLoadSettings(env.TRADINGBOT_DB, input.userId);
      const strategyResult = await runAndPersistStrategyEvaluation(
        env.TRADINGBOT_DB,
        input.userId,
        settings,
        buildWebhookStrategyTrigger({
          eventType: input.eventType,
          externalId: input.externalId,
          contractAddress: normalizedContractAddress,
          walletAddress: input.walletAddress,
          txSignature: input.txSignature,
          payloadJson: input.payload,
        }),
        marketSnapshot,
        {
          changeNote: `Webhook trigger ${input.eventType}`,
          origin: 'settings-sync',
        },
      );
      strategySummary = `Strategy v${strategyResult.version.versionNo}: ${summarizeStrategyRuntime(strategyResult.runtime)}`;
    } catch (err: unknown) {
      console.warn(
        `Strategy evaluation failed for webhook ${input.eventType} on ${normalizedContractAddress}:`,
        err,
      );
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      input.userId,
      'strategy.triggered',
      input.txSignature ?? input.externalId,
      marketSnapshot
        ? `Received an ${input.providerLabel} ${input.eventType} event for ${normalizedContractAddress}. Recorded a fresh market snapshot and triggered strategy evaluation. ${strategySummary ?? 'Strategy runtime is not yet actionable for automated execution.'}`
        : `Received an ${input.providerLabel} ${input.eventType} event for ${normalizedContractAddress}. Triggered strategy evaluation. ${strategySummary ?? 'Strategy runtime is not yet actionable for automated execution.'}`,
    );
    await dbMarkSignalProcessed(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
    );
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await dbMarkSignalFailed(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
      errorMessage,
    );
    throw err;
  }
}

async function processAlchemyNotifyWebhookPayload(
  env: Env,
  payload: AlchemyWebhookPayload,
  contractFromQuery: string | null,
  derivedSignals: DerivedChainSignal[],
): Promise<{
  received: number;
  routedTargets: number;
  processed: number;
  duplicates: number;
  ignored: number;
}> {
  const webhookId = readNonEmptyString(payload.webhookId) ?? 'shared';
  const targetCache = new Map<string, number[]>();

  let processed = 0;
  let duplicates = 0;
  let ignored = 0;
  let routedTargets = 0;

  for (const signal of derivedSignals) {
    const contractAddresses = signal.contractAddresses.length > 0
      ? signal.contractAddresses
      : contractFromQuery
        ? [contractFromQuery]
        : [];
    if (contractAddresses.length === 0) {
      ignored += 1;
      continue;
    }

    const handledTargets = new Set<string>();
    for (const contractAddress of contractAddresses) {
      let userIds = targetCache.get(contractAddress);
      if (!userIds) {
        userIds = await dbListUserIdsByActiveContractAddress(
          env.TRADINGBOT_DB,
          contractAddress,
        );
        targetCache.set(contractAddress, userIds);
      }

      for (const userId of userIds) {
        const targetKey = `${userId}:${contractAddress}`;
        if (handledTargets.has(targetKey)) {
          continue;
        }
        handledTargets.add(targetKey);
        routedTargets += 1;
        const inserted = await processTokenActivitySignal(env, {
          userId,
          contractAddress,
          source: `alchemy_notify:${webhookId}:user:${userId}`,
          externalId: `${signal.externalId}:${contractAddress}`,
          eventType: signal.eventType,
          walletAddress: signal.walletAddress,
          txSignature: signal.txSignature,
          payload: signal.payload,
          providerLabel: 'Alchemy Notify',
        });
        if (inserted) {
          processed += 1;
        } else {
          duplicates += 1;
        }
      }
    }

    if (handledTargets.size === 0) {
      ignored += 1;
    }
  }

  return {
    received: derivedSignals.length,
    routedTargets,
    processed,
    duplicates,
    ignored,
  };
}

async function handleAlchemyNotifyWebhook(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  await assertAlchemyWebhookSignature(request, env, rawBody);
  const payload = parseJsonText<AlchemyWebhookPayload>(rawBody);
  const contractFromQuery = tryNormalizeSolanaPubkey(
    url.searchParams.get('contractAddress'),
  );
  const derivedSignals = deriveAlchemySignalsFromPayload(
    payload,
    contractFromQuery,
  );

  // Background processing: handle webhook and update market snapshots
  ctx.waitUntil(
    (async () => {
      try {
        const result = await processAlchemyNotifyWebhookPayload(
          env,
          payload,
          contractFromQuery,
          derivedSignals,
        );
        
        // After webhook processing, refresh market snapshots for affected tokens
        if (result.processed > 0 || result.routedTargets > 0) {
          console.log(`[webhook] Processed ${result.processed} signals, updating market snapshots`);
          // Collect unique (userId, contractAddress) pairs for market refresh
          const tokensToRefresh = new Set<string>();
          
          for (const signal of derivedSignals) {
            const contractAddresses = signal.contractAddresses.length > 0
              ? signal.contractAddresses
              : contractFromQuery
                ? [contractFromQuery]
                : [];
            
            for (const contractAddress of contractAddresses) {
              const userIds = await dbListUserIdsByActiveContractAddress(
                env.TRADINGBOT_DB,
                contractAddress,
              );
              for (const userId of userIds) {
                tokensToRefresh.add(`${userId}:${contractAddress}`);
              }
            }
          }
          
          // Refresh market snapshots for affected tokens
          const rpcUrl = env.SOLANA_RPC_URL ?? '';
          for (const pair of tokensToRefresh) {
            const [userIdStr, contractAddress] = pair.split(':');
            const userId = parseInt(userIdStr, 10);
            if (!isNaN(userId)) {
              const rpcUrls = await dbResolveSolanaRpcUrls(
                env.TRADINGBOT_DB,
                userId,
                rpcUrl,
              );
              await syncTokenMarketSnapshotForUser(
                env.TRADINGBOT_DB,
                userId,
                'solana',
                contractAddress,
                rpcUrls,
                { force: true },
              ).catch((err) => {
                console.warn(`Failed to refresh market snapshot for ${contractAddress}:`, err);
              });
            }
          }
        }
      } catch (err) {
        console.error('Alchemy webhook background processing failed:', err);
      }
    })(),
  );

  return jsonResponse({ ok: true, accepted: true }, 200);
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
  const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  let activeStrategyVersion: StrategyVersionRecord | null = null;
  try {
    activeStrategyVersion = (
      await dbSyncActiveStrategyVersionFromSettings(
        env.TRADINGBOT_DB,
        user.id,
        settings,
        {
          author: user.username,
          changeNote: 'Auto-synced strategy version during state load',
          origin: 'migration',
        },
      )
    ).version;
  } catch (err: unknown) {
    console.warn(`Failed to auto-sync active strategy version for user ${user.id}:`, err);
    activeStrategyVersion = await dbGetActiveStrategyVersion(
      env.TRADINGBOT_DB,
      user.id,
    ).catch(() => null);
  }
  let [
    internalAccs,
    outsiderAccs,
    activityLogs,
    tradeLogs,
    webhookTransactionLogs,
    tradableTokens,
    historicalSetups,
    strategyVersions,
    strategyEvaluations,
    rpcEndpoints,
  ] =
    await Promise.all([
      dbListAccounts(env.TRADINGBOT_DB, user.id, 'managed'),
      dbListAccounts(env.TRADINGBOT_DB, user.id, 'watch'),
      dbListAuditLogs(env.TRADINGBOT_DB, user.id, user.username),
      dbListTradeLogs(env.TRADINGBOT_DB),
      dbListWebhookTransactionLogs(env.TRADINGBOT_DB, user.id),
      dbListTradableTokens(env.TRADINGBOT_DB),
      dbListHistoricalSetups(env.TRADINGBOT_DB, user.id),
      dbListStrategyVersions(env.TRADINGBOT_DB, user.id),
      dbListStrategyEvaluations(env.TRADINGBOT_DB, user.id),
      dbListRpcEndpoints(env.TRADINGBOT_DB, user.id),
    ]);

  const rpcUrls = dedupeStrings([
    ...rpcEndpoints.map((endpoint) => endpoint.url),
    env.SOLANA_RPC_URL ?? '',
  ]);

  let marketSnapshot: TokenMarketSnapshot | null = null;
  if (settings.contractAddress.trim()) {
    try {
      marketSnapshot = await syncTokenMarketSnapshotForUser(
        env.TRADINGBOT_DB,
        user.id,
        'solana',
        settings.contractAddress,
        rpcUrls,
        {
          managedAccountAddresses: internalAccs.map((account) => account.address),
        },
      );
      if (marketSnapshot) {
        tradableTokens = await dbListTradableTokens(env.TRADINGBOT_DB);
      }
    } catch (err: unknown) {
      console.warn(
        `Failed to load token market snapshot for ${settings.contractAddress}:`,
        err,
      );
    }
  }

  const profitUsdc = settings.contractAddress.trim()
    ? await dbComputeManagedProfitUsdc(
        env.TRADINGBOT_DB,
        user.id,
        settings.contractAddress,
        marketSnapshot?.priceUsd ?? null,
      )
    : 0;

  return jsonResponse({
    auth: { username: user.username, role: user.role },
    settings,
    internalAccs,
    outsiderAccs,
    logs: activityLogs,
    activityLogs,
    tradeLogs,
    webhookTransactionLogs,
    tradableTokens,
    historicalSetups,
    activeStrategyVersion,
    strategyVersions,
    strategyEvaluations,
    rpcEndpoints,
    marketSnapshot,
    marketSnapshotHistory: [],
    profitUsdc,
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
  const normalizedContractAddress = body.contractAddress.trim()
    ? normalizePubkey(body.contractAddress)
    : '';
  let rpcUrls: string[] | null = null;
  if (normalizedContractAddress) {
    rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );
    const decimals = await fetchSolanaMintDecimals(
      rpcUrls,
      normalizedContractAddress,
    ).catch(() => null);
    await dbCreateTradableToken(
      env.TRADINGBOT_DB,
      { network: 'solana', contractAddress: normalizedContractAddress },
      decimals,
    );
  }
  await dbSaveSettings(env.TRADINGBOT_DB, user.id, {
    ...body,
    contractAddress: normalizedContractAddress,
  });
  const updated = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  await dbCreateHistoricalSetupSnapshot(
    env.TRADINGBOT_DB,
    user.id,
    updated,
  );
  const strategySync = await dbSyncActiveStrategyVersionFromSettings(
    env.TRADINGBOT_DB,
    user.id,
    updated,
    {
      author: user.username,
      changeNote: updated.strategyNotes.trim() || 'Trading settings were updated',
      origin: 'settings-sync',
    },
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'settings.updated',
    'settings',
    strategySync.created
      ? `Trading settings were updated. Strategy version v${strategySync.version.versionNo} was published and activated.`
      : `Trading settings were updated. Strategy version v${strategySync.version.versionNo} remains active.`,
  );

  if (normalizedContractAddress && rpcUrls) {
    try {
      await syncTokenMarketSnapshotForUser(
        env.TRADINGBOT_DB,
        user.id,
        'solana',
        normalizedContractAddress,
        rpcUrls,
      );
    } catch (err: unknown) {
      console.warn(
        `Failed to initialize market snapshot after saving settings for ${normalizedContractAddress}:`,
        err,
      );
    }
  }

  return jsonResponse(updated);
}

// POST /api/settings/active-token
async function handleSaveActiveToken(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = parseActiveTokenUpdateRequest(
    await parseJsonBody<unknown>(request),
  );
  const normalizedContractAddress = await dbSaveActiveContractAddress(
    env.TRADINGBOT_DB,
    user.id,
    body.contractAddress,
  );

  let marketSnapshot: TokenMarketSnapshot | null = null;
  if (normalizedContractAddress) {
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );

    const existingTokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    if (!existingTokenId) {
      try {
        const decimals = await fetchSolanaMintDecimals(
          rpcUrls,
          normalizedContractAddress,
        ).catch(() => null);
        await dbCreateTradableToken(
          env.TRADINGBOT_DB,
          {
            network: 'solana',
            contractAddress: normalizedContractAddress,
          },
          decimals,
        );
      } catch (err: unknown) {
        console.warn(
          `Failed to ensure tracked token metadata for ${normalizedContractAddress}:`,
          err,
        );
      }
    }

    try {
      marketSnapshot = await syncTokenMarketSnapshotForUser(
        env.TRADINGBOT_DB,
        user.id,
        'solana',
        normalizedContractAddress,
        rpcUrls,
      );
    } catch (err: unknown) {
      console.warn(
        `Failed to initialize market snapshot after activating ${normalizedContractAddress}:`,
        err,
      );
    }
  }

  const updatedSettings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  const strategySync = await dbSyncActiveStrategyVersionFromSettings(
    env.TRADINGBOT_DB,
    user.id,
    updatedSettings,
    {
      author: user.username,
      changeNote: normalizedContractAddress
        ? 'Active trading token changed'
        : 'Active trading token cleared',
      origin: 'settings-sync',
    },
  );

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    normalizedContractAddress ? 'token.activated' : 'token.cleared',
    normalizedContractAddress || 'none',
    normalizedContractAddress
      ? marketSnapshot
        ? `Activated the tracked token and initialized market data. Strategy version v${strategySync.version.versionNo} is now active.`
        : `Activated the tracked token. Live market data will load on the next successful refresh. Strategy version v${strategySync.version.versionNo} is now active.`
      : `Cleared the active tracked token. Strategy version v${strategySync.version.versionNo} is now active.`,
  );

  return jsonResponse({
    contractAddress: normalizedContractAddress,
    marketSnapshot,
  });
}

// POST /api/strategy/active
async function handleSaveActiveStrategy(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const currentSettings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  const document = normalizeStrategyDocument(
    await parseJsonBody<unknown>(request),
  );

  const normalizedContractAddress = document.parameters.contractAddress.trim()
    ? normalizePubkey(document.parameters.contractAddress)
    : '';
  const normalizedDocument = normalizeStrategyDocument({
    ...document,
    parameters: {
      ...document.parameters,
      contractAddress: normalizedContractAddress,
    },
  });

  const strategySave = await dbSaveActiveStrategyVersionDocument(
    env.TRADINGBOT_DB,
    user.id,
    normalizedDocument,
    {
      changeNote:
        normalizedDocument.metadata.changeNote ||
        normalizedDocument.parameters.notes ||
        'Strategy document updated',
    },
  );

  const settingsUpdate = mapStrategyDocumentToSettingsUpdate(normalizedDocument);
  await dbSaveSettings(env.TRADINGBOT_DB, user.id, settingsUpdate);
  const updatedSettings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  await dbCreateHistoricalSetupSnapshot(
    env.TRADINGBOT_DB,
    user.id,
    updatedSettings,
  );

  let marketSnapshot: TokenMarketSnapshot | null = null;
  if (normalizedContractAddress) {
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );

    const existingTokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    if (!existingTokenId) {
      try {
        const decimals = await fetchSolanaMintDecimals(
          rpcUrls,
          normalizedContractAddress,
        ).catch(() => null);
        await dbCreateTradableToken(
          env.TRADINGBOT_DB,
          {
            network: 'solana',
            contractAddress: normalizedContractAddress,
          },
          decimals,
        );
      } catch (err: unknown) {
        console.warn(
          `Failed to ensure tracked token metadata for strategy contract ${normalizedContractAddress}:`,
          err,
        );
      }
    }

    try {
      marketSnapshot = await syncTokenMarketSnapshotForUser(
        env.TRADINGBOT_DB,
        user.id,
        'solana',
        normalizedContractAddress,
        rpcUrls,
        {
          force: true,
        },
      );
    } catch (err: unknown) {
      console.warn(
        `Failed to initialize market snapshot after saving strategy for ${normalizedContractAddress}:`,
        err,
      );
    }
  }

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'strategy.version_activated',
    normalizedContractAddress || 'none',
    strategySave.created
      ? `Activated strategy version v${strategySave.version.versionNo}.`
      : `Strategy version v${strategySave.version.versionNo} remains active.`,
  );

  return jsonResponse({
    activeStrategyVersion: strategySave.version,
    settings: updatedSettings,
    marketSnapshot,
  });
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
  if (body.adminPassword) {
    const passwordValid = await dbVerifyUserPassword(
      env.TRADINGBOT_DB,
      user.id,
      body.adminPassword,
    );
    if (!passwordValid) {
      throw new ApiError(401, 'Admin password is incorrect');
    }
  }
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
  const rpcUrls = await dbResolveSolanaRpcUrls(
    env.TRADINGBOT_DB,
    user.id,
    env.SOLANA_RPC_URL,
  );
  const decimals = await fetchSolanaMintDecimals(
    rpcUrls,
    normalizedAddress,
  ).catch(() => null);
  const token = await dbCreateTradableToken(
    env.TRADINGBOT_DB,
    { network: body.network, contractAddress: normalizedAddress },
    decimals,
  );
  let marketSnapshot: TokenMarketSnapshot | null = null;
  try {
    marketSnapshot = await syncTokenMarketSnapshotForUser(
      env.TRADINGBOT_DB,
      user.id,
      body.network,
      normalizedAddress,
      rpcUrls,
      {
        force: true,
      },
    );
  } catch (err: unknown) {
    console.warn(
      `Failed to initialize live market data for ${normalizedAddress}:`,
      err,
    );
  }
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'token.added',
    token.contractAddress,
    marketSnapshot
      ? `Added tradable token on ${token.network} and recorded the initial market snapshot.`
      : `Added tradable token on ${token.network}. Live market initialization will retry on the next refresh.`,
  );
  return jsonResponse({ token, marketSnapshot }, 201);
}

// GET /api/market-snapshots?startTime=xxx&endTime=xxx
async function handleGetMarketSnapshotsByTimeRange(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  const contractAddress = settings.contractAddress.trim();
  
  if (!contractAddress) {
    throw new ApiError(
      400,
      'Set an active trading token before querying market snapshots',
    );
  }

  const startTimeParam = url.searchParams.get('startTime');
  const endTimeParam = url.searchParams.get('endTime');
  const limitParam = url.searchParams.get('limit');

  const now = nowMs();
  let startTime = now - 7 * 24 * 60 * 60 * 1000;
  let endTime = now;
  let limit = 100;

  if (startTimeParam) {
    const parsed = Number.parseInt(startTimeParam, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      startTime = normalizeTimestampMs(parsed);
    }
  }

  if (endTimeParam) {
    const parsed = Number.parseInt(endTimeParam, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      endTime = normalizeTimestampMs(parsed);
    }
  }

  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 500) {
      limit = parsed;
    }
  }

  // Find token by contract address
  const tokenId = await dbResolveTradableTokenId(
    env.TRADINGBOT_DB,
    contractAddress,
  );

  if (!tokenId) {
    throw new ApiError(404, 'Token not found');
  }

  const snapshots = await dbGetTokenMarketSnapshotsByTimeRange(
    env.TRADINGBOT_DB,
    tokenId,
    startTime,
    endTime,
    limit,
  );

  return jsonResponse({ snapshots });
}

// POST /api/market-snapshot/refresh
async function handleForceRefreshMarketSnapshot(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  const contractAddress = settings.contractAddress.trim();
  if (!contractAddress) {
    throw new ApiError(
      400,
      'Set an active trading token before forcing a live market refresh',
    );
  }

  const rpcUrls = await dbResolveSolanaRpcUrls(
    env.TRADINGBOT_DB,
    user.id,
    env.SOLANA_RPC_URL,
  );
  const marketSnapshot = await syncTokenMarketSnapshotForUser(
    env.TRADINGBOT_DB,
    user.id,
    'solana',
    contractAddress,
    rpcUrls,
    {
      force: true,
      fallbackToStoredOnError: false,
    },
  );

  let strategyEvaluationSummary: string | null = null;
  let strategyEvaluationPayload: Record<string, unknown> | null = null;
  try {
    const strategyResult = await runAndPersistStrategyEvaluation(
      env.TRADINGBOT_DB,
      user.id,
      settings,
      buildManualRefreshStrategyTrigger({
        contractAddress,
        externalId: `manual-refresh:${user.id}:${contractAddress}:${nowMs()}`,
      }),
      marketSnapshot,
      {
        author: user.username,
        changeNote: 'Manual market snapshot refresh',
        origin: 'settings-sync',
      },
    );
    strategyEvaluationSummary = `Strategy v${strategyResult.version.versionNo}: ${summarizeStrategyRuntime(strategyResult.runtime)}`;
    strategyEvaluationPayload = {
      versionNo: strategyResult.version.versionNo,
      status: strategyResult.runtime.evaluation.status,
      qualified: strategyResult.runtime.evaluation.qualified,
      shouldExecute: strategyResult.runtime.evaluation.shouldExecute,
      dryRun: strategyResult.runtime.evaluation.dryRun,
      reasons: strategyResult.runtime.evaluation.reasons,
    };
  } catch (err: unknown) {
    console.warn(`Strategy evaluation failed after manual refresh for ${contractAddress}:`, err);
  }

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'market_snapshot.force_refreshed',
    contractAddress,
    strategyEvaluationSummary
      ? `Forced a live market snapshot refresh and stored a new historical record. ${strategyEvaluationSummary}`
      : 'Forced a live market snapshot refresh and stored a new historical record.',
  );

  return jsonResponse({ marketSnapshot, strategyEvaluation: strategyEvaluationPayload });
}

// POST /api/rpc-endpoints
async function handleAddRpcEndpoint(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const body = parseRpcEndpointCreateRequest(
    await parseJsonBody<unknown>(request),
  );
  const endpoint = await dbAddRpcEndpoint(env.TRADINGBOT_DB, user.id, body);
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'rpc.endpoint_added',
    endpoint.url,
    `Added ${endpoint.network} RPC endpoint`,
  );
  return jsonResponse({ endpoint }, 201);
}

// DELETE /api/rpc-endpoints/{id}
async function handleDeleteRpcEndpoint(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const user = await requireAdmin(request, env);
  const idText = url.pathname.split('/').pop();
  const endpointId = Number.parseInt(idText ?? '', 10);
  if (!Number.isInteger(endpointId) || endpointId <= 0) {
    throw new ApiError(400, 'RPC endpoint id is invalid');
  }
  const endpoint = await dbDeleteRpcEndpoint(
    env.TRADINGBOT_DB,
    user.id,
    endpointId,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'rpc.endpoint_deleted',
    endpoint.url,
    `Removed ${endpoint.network} RPC endpoint`,
  );
  return jsonResponse({ success: true });
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
  if (!env.PRIVATE_KEY_ENCRYPTION_KEY) {
    throw new ApiError(503, 'PRIVATE_KEY_ENCRYPTION_KEY is not configured — cannot decrypt signing key');
  }

  const user = await requireAdmin(request, env);
  const body = await request.json<{
    action?: string;
    contractAddress?: string;
    walletAddress?: string;
    /** Amount in USDC for BUY; amount in the base token for SELL */
    requestedAmount?: number;
  }>();

  const action = (body.action ?? '').toUpperCase();
  if (action !== 'BUY' && action !== 'SELL') {
    throw new ApiError(400, 'action must be BUY or SELL');
  }
  if (typeof body.requestedAmount !== 'number' || !Number.isFinite(body.requestedAmount) || body.requestedAmount <= 0) {
    throw new ApiError(400, 'requestedAmount must be a positive number');
  }

  const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
  const targetMint = normalizePubkey(
    typeof body.contractAddress === 'string' && body.contractAddress.trim().length > 0
      ? body.contractAddress
      : settings.contractAddress,
  );
  if (!targetMint) {
    throw new ApiError(400, 'No active trading token configured');
  }

  // Resolve the managed wallet to sign with
  const signerAddress = normalizePubkey(
    typeof body.walletAddress === 'string' && body.walletAddress.trim().length > 0
      ? body.walletAddress
      : '',
  );
  // Find first managed wallet if none specified
  let resolvedSignerAddress = signerAddress;
  if (!resolvedSignerAddress) {
    const managed = await dbListManagedAccountAddresses(env.TRADINGBOT_DB, user.id);
    if (managed.length === 0) {
      throw new ApiError(400, 'No managed wallet imported — import a private key first');
    }
    resolvedSignerAddress = managed[0];
  }

  // Load the managed keypair for signing
  const keypairBytes = await dbLoadManagedKeypairBytes(
    env.TRADINGBOT_DB,
    user.id,
    resolvedSignerAddress,
    env.PRIVATE_KEY_ENCRYPTION_KEY,
  );

  // Resolve token decimals for amount calculation
  const tokenRecord = await env.TRADINGBOT_DB
    .prepare('SELECT decimals FROM tradable_tokens WHERE network = ?1 AND contract_address = ?2')
    .bind('solana', targetMint)
    .first<{ decimals: number | null }>();
  const tokenDecimals = tokenRecord?.decimals ?? 6;

  // Calculate atomic units for the quote
  const USDC_DECIMALS = 6;
  let inputMint: string;
  let outputMint: string;
  let amountAtomicUnits: string;

  if (action === 'BUY') {
    // Spend USDC → receive target token
    inputMint = SOLANA_USDC_MINT;
    outputMint = targetMint;
    amountAtomicUnits = String(Math.round(body.requestedAmount * 10 ** USDC_DECIMALS));
  } else {
    // Spend target token → receive USDC
    inputMint = targetMint;
    outputMint = SOLANA_USDC_MINT;
    amountAtomicUnits = String(Math.round(body.requestedAmount * 10 ** tokenDecimals));
  }

  const slippageBps = Math.round(settings.maxSlippage * 100); // % → bps

  // Resolve the token record for audit
  const tokenId = await dbResolveTradableTokenId(env.TRADINGBOT_DB, targetMint);
  const setupId = await dbGetLatestHistoricalSetupId(env.TRADINGBOT_DB, user.id);

  let tradeLogId: number | null = null;
  if (tokenId) {
    const logRow = await env.TRADINGBOT_DB
      .prepare(
        `INSERT INTO trade_logs (
           token_id, setup_id, wallet_address, action,
           requested_amount, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', ?6, ?6)
         RETURNING id`,
      )
      .bind(tokenId, setupId, resolvedSignerAddress, action, body.requestedAmount, nowTs())
      .first<{ id: number }>();
    tradeLogId = logRow?.id ?? null;
  }

  try {
    // 1. Get swap quote from Jupiter
    const quote = await fetchJupiterSwapQuote(
      inputMint,
      outputMint,
      amountAtomicUnits,
      slippageBps,
    );

    // 2. Build the transaction via Jupiter
    const unsignedTxBytes = await buildJupiterSwapTransaction(quote, resolvedSignerAddress);

    // 3. Sign with the managed keypair
    const signedTxBytes = signSolanaTransaction(unsignedTxBytes, keypairBytes);

    // 4. Broadcast to Solana
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );
    const txSignature = await sendSolanaTransaction(rpcUrls, signedTxBytes);

    // 5. Compute the executed amounts from the quote
    const executedAmountRaw = Number(action === 'BUY' ? quote.outAmount : quote.inAmount);
    const executedDecimals = action === 'BUY' ? tokenDecimals : USDC_DECIMALS;
    const executedAmount = executedAmountRaw / 10 ** executedDecimals;

    // 6. Update trade log with success
    if (tradeLogId != null) {
      await env.TRADINGBOT_DB
        .prepare(
          `UPDATE trade_logs
           SET status = 'PENDING', tx_signature = ?2, executed_amount = ?3, updated_at = ?4
           WHERE id = ?1`,
        )
        .bind(tradeLogId, txSignature, executedAmount, nowTs())
        .run();
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'trade.submitted',
      txSignature,
      `${action} ${body.requestedAmount} (${action === 'BUY' ? 'USDC → ' + targetMint : targetMint + ' → USDC'}) via Jupiter. Tx: ${txSignature}`,
    );

    return jsonResponse({
      txSignature,
      action,
      inputMint,
      outputMint,
      requestedAmount: body.requestedAmount,
      executedAmount,
      slippageBps,
      status: 'PENDING',
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (tradeLogId != null) {
      await env.TRADINGBOT_DB
        .prepare(
          `UPDATE trade_logs SET status = 'FAILED', error_message = ?2, updated_at = ?3 WHERE id = ?1`,
        )
        .bind(tradeLogId, errorMessage, nowTs())
        .run();
    }
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'trade.failed',
      targetMint,
      `${action} trade failed: ${errorMessage}`,
    );
    throw err instanceof ApiError ? err : new ApiError(502, `Trade failed: ${errorMessage}`);
  }
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
  const rpcUrls = await dbResolveSolanaRpcUrls(
    env.TRADINGBOT_DB,
    user.id,
    env.SOLANA_RPC_URL,
  );
  const balance = await loadWalletBalance(
    address,
    settings,
    tradableTokens,
    rpcUrls,
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
  const adminPasswordHeader = request.headers.get('Authorization')?.trim();
  if (adminPasswordHeader) {
    const passwordValid = await dbVerifyUserPassword(
      env.TRADINGBOT_DB,
      user.id,
      adminPasswordHeader,
    );
    if (!passwordValid) {
      throw new ApiError(401, 'Admin password is incorrect');
    }
  }
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
  ctx: ExecutionContext,
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
    if (method === 'POST' && pathname === '/api/webhooks/alchemy/notify')
      return await handleAlchemyNotifyWebhook(request, url, env, ctx);
    if (method === 'POST' && pathname === '/api/settings/active-token')
      return await handleSaveActiveToken(request, env);
    if (method === 'POST' && pathname === '/api/settings')
      return await handleSaveSettings(request, env);
    if (method === 'POST' && pathname === '/api/strategy/active')
      return await handleSaveActiveStrategy(request, env);
    if (method === 'POST' && pathname === '/api/tradable-tokens')
      return await handleAddTradableToken(request, env);
    if (method === 'POST' && pathname === '/api/market-snapshot/refresh')
      return await handleForceRefreshMarketSnapshot(request, env);
    if (method === 'GET' && pathname === '/api/market-snapshots')
      return await handleGetMarketSnapshotsByTimeRange(request, url, env);
    if (method === 'POST' && pathname === '/api/rpc-endpoints')
      return await handleAddRpcEndpoint(request, env);
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
    if (method === 'DELETE' && /^\/api\/rpc-endpoints\/\d+$/.test(pathname))
      return await handleDeleteRpcEndpoint(request, url, env);
    if (method === 'DELETE' && pathname.startsWith('/api/admin/private-keys/'))
      return await handleAdminDeletePrivateKey(request, url, env);
    return jsonResponse({ error: 'Not found' }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── Worker entry point ───────────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env, ctx);
    }

    // Pass all other requests through to the static assets binding
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
