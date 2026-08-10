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
import type {
  AccountRecord,
  AuditLog,
  ManagedAccountSummaryRecord,
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

function isMissingTableError(err: unknown, tableName: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(`no such table: ${tableName}`)
    || message.includes(`no such table: main.${tableName}`);
}

export interface AvailableAccountRecord extends AccountRecord {
  lastTradedAt: number | null;
  walletBalance: WalletBalanceResponse;
}

export interface ManagedBuyCapacitySummary {
  enabledAccountCount: number;
  eligibleAccountCount: number;
  skippedForCapabilityCount: number;
  skippedForSolReserveCount: number;
  availableQuoteAmount: number;
  quoteMint: string;
}

export type ManagedAccountSort = 'newest' | 'usdc' | 'sol' | 'token';

export interface ManagedAccountPageRecord {
  items: AccountRecord[];
  page: number;
  pageSize: number;
  totalItems: number;
  balances: Record<string, WalletBalanceResponse>;
}

export interface ManagedAccountBalanceRecord extends AccountRecord {
  walletBalance: WalletBalanceResponse;
  quoteAvailableAmount: number;
  baseTokenAmount: number;
  hasSolReserve: boolean;
  pairCompatible: boolean;
}

type ManagedAccountCandidateRow = {
  id: number;
  label: string;
  wallet_address: string;
  type: string;
  capability_base_mint: string | null;
  capability_quote_mint: string | null;
  created_at: number;
  is_active: number;
  last_traded_at: number | null;
  wallet_usdc_balance?: number | null;
  wallet_sol_balance?: number | null;
  wallet_active_token_mint?: string | null;
  wallet_active_token_balance?: number | null;
  wallet_balance_updated_at?: number | null;
};

type AccountSnapshotRow = {
  wallet_usdc_balance?: number | null;
  wallet_sol_balance?: number | null;
  wallet_active_token_mint?: string | null;
  wallet_active_token_balance?: number | null;
  wallet_balance_updated_at?: number | null;
};

function mapAccountRow(
  row: {
    id: number;
    label: string;
    wallet_address: string;
    type: string;
    capability_base_mint?: string | null;
    capability_quote_mint?: string | null;
    created_at: number;
    is_active?: number | null;
  } & AccountSnapshotRow,
): AccountRecord {
  return {
    id: row.id,
    label: row.label,
    address: row.wallet_address,
    type: row.type,
    capabilityBaseMint: row.capability_base_mint ?? null,
    capabilityQuoteMint: row.capability_quote_mint ?? null,
    createdAt: row.created_at,
    isActive: row.is_active !== 0,
    walletUsdcBalance: row.wallet_usdc_balance ?? null,
    walletSolBalance: row.wallet_sol_balance ?? null,
    walletActiveTokenMint: row.wallet_active_token_mint ?? null,
    walletActiveTokenBalance: row.wallet_active_token_balance ?? null,
    walletBalanceUpdatedAt: row.wallet_balance_updated_at ?? null,
  };
}

export function accountCapabilityMatchesMintPair(
  account: Pick<AccountRecord, 'capabilityBaseMint' | 'capabilityQuoteMint'>,
  baseMint: string,
  quoteMint: string,
): boolean {
  const capabilityBaseMint = account.capabilityBaseMint?.trim() ?? '';
  const capabilityQuoteMint = account.capabilityQuoteMint?.trim() ?? '';
  if (!capabilityBaseMint && !capabilityQuoteMint) {
    return true;
  }
  return capabilityBaseMint === baseMint && capabilityQuoteMint === quoteMint;
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
  pair: {
    baseMint: string;
    quoteMint: string;
  },
  walletBalance: WalletBalanceResponse,
): boolean {
  const solBalance = toFiniteNumber(walletBalance.sol) ?? 0;
  if (solBalance < ACCOUNT_MIN_SOL_RESERVE) {
    return false;
  }

  if (action === 'buy') {
    if (pair.quoteMint === SOLANA_USDC_MINT) {
      const usdcBalance = toFiniteNumber(walletBalance.usdc) ?? 0;
      return usdcBalance >= estimatedAmount;
    }
    const quoteBalance = walletBalance.tokens.find(
      (token) => token.mint === pair.quoteMint,
    );
    return (toFiniteNumber(quoteBalance?.amount) ?? 0) > 0;
  }

  const targetBalance = walletBalance.tokens.find(
    (token) => token.mint === pair.baseMint,
  );
  const tokenBalance = toFiniteNumber(targetBalance?.amount) ?? 0;
  return tokenBalance >= estimatedAmount;
}

function hasAnyPairTokenBalance(
  walletBalance: WalletBalanceResponse,
  pair: {
    baseMint: string;
    quoteMint: string;
  },
): boolean {
  const baseBalance = walletBalance.tokens.find((token) => token.mint === pair.baseMint);
  if ((toFiniteNumber(baseBalance?.amount) ?? 0) > 0) {
    return true;
  }
  if (pair.quoteMint === SOLANA_USDC_MINT) {
    return (toFiniteNumber(walletBalance.usdc) ?? 0) > 0;
  }
  const quoteBalance = walletBalance.tokens.find((token) => token.mint === pair.quoteMint);
  return (toFiniteNumber(quoteBalance?.amount) ?? 0) > 0;
}

function readQuoteBalanceAmount(
  walletBalance: WalletBalanceResponse,
  quoteMint: string,
): number {
  if (quoteMint === SOLANA_USDC_MINT) {
    return Math.max(0, toFiniteNumber(walletBalance.usdc) ?? 0);
  }
  const quoteBalance = walletBalance.tokens.find((token) => token.mint === quoteMint);
  return Math.max(0, toFiniteNumber(quoteBalance?.amount) ?? 0);
}

function readBaseTokenAmount(
  walletBalance: WalletBalanceResponse,
  baseMint: string,
): number {
  const baseBalance = walletBalance.tokens.find((token) => token.mint === baseMint);
  return Math.max(0, toFiniteNumber(baseBalance?.amount) ?? 0);
}

async function loadWalletBalancesByAddress(
  accounts: AccountRecord[],
  settings: SettingsState,
  tradableTokens: Awaited<ReturnType<typeof dbListTradableTokens>>,
  rpcUrls: string[],
): Promise<Record<string, WalletBalanceResponse>> {
  if (accounts.length === 0) {
    return {};
  }

  const results = await Promise.allSettled(
    accounts.map(async (account) => ({
      address: account.address,
      balance: await loadWalletBalance(
        account.address,
        settings,
        tradableTokens,
        rpcUrls,
      ),
    })),
  );

  const balances: Record<string, WalletBalanceResponse> = {};
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      continue;
    }
    balances[result.value.address] = result.value.balance;
  }
  return balances;
}

function buildWalletBalanceFromSnapshot(
  account: AccountRecord,
  activeTokenMint: string,
): WalletBalanceResponse | null {
  const updatedAt = account.walletBalanceUpdatedAt ?? null;
  const hasSnapshot =
    updatedAt != null ||
    account.walletUsdcBalance != null ||
    account.walletSolBalance != null ||
    account.walletActiveTokenBalance != null;
  if (!hasSnapshot) {
    return null;
  }

  const tokens =
    activeTokenMint &&
    account.walletActiveTokenMint === activeTokenMint &&
    account.walletActiveTokenBalance != null
      ? [
          {
            mint: activeTokenMint,
            symbol: 'Tracked',
            network: 'solana',
            amount: String(account.walletActiveTokenBalance),
            decimals: null,
          },
        ]
      : [];

  return {
    address: account.address,
    sol: String(account.walletSolBalance ?? 0),
    usdc: String(account.walletUsdcBalance ?? 0),
    tokens,
    updatedAt: updatedAt ?? 0,
  };
}

function buildWalletBalancesFromSnapshots(
  accounts: AccountRecord[],
  activeTokenMint: string,
): Record<string, WalletBalanceResponse> {
  const balances: Record<string, WalletBalanceResponse> = {};
  for (const account of accounts) {
    const balance = buildWalletBalanceFromSnapshot(account, activeTokenMint);
    if (!balance) {
      continue;
    }
    balances[account.address] = balance;
  }
  return balances;
}

export async function listManagedAccountsWithStoredBalances(
  db: D1Database,
  userId: number,
  options?: {
    pair?: {
      baseMint: string;
      quoteMint: string;
    };
  },
): Promise<ManagedAccountBalanceRecord[]> {
  const settings = await dbLoadSettings(db, userId);
  const pair = options?.pair ?? {
    baseMint: settings.baseTokenAddress.trim()
      ? normalizePubkey(settings.baseTokenAddress)
      : '',
    quoteMint: SOLANA_USDC_MINT,
  };
  const accounts = await listActiveManagedAccountCandidates(db, userId);

  return accounts.map((account) => {
    const accountRecord = mapAccountRow(account);
    const walletBalance =
      buildWalletBalanceFromSnapshot(accountRecord, pair.baseMint) ?? {
        address: accountRecord.address,
        sol: '0',
        usdc: '0',
        tokens: [],
        updatedAt: 0,
      };
    return {
      ...accountRecord,
      walletBalance,
      quoteAvailableAmount: readQuoteBalanceAmount(walletBalance, pair.quoteMint),
      baseTokenAmount: pair.baseMint
        ? readBaseTokenAmount(walletBalance, pair.baseMint)
        : 0,
      hasSolReserve: (toFiniteNumber(walletBalance.sol) ?? 0) >= ACCOUNT_MIN_SOL_RESERVE,
      pairCompatible: accountCapabilityMatchesMintPair(accountRecord, pair.baseMint, pair.quoteMint),
    };
  });
}

export async function dbUpdateManagedAccountWalletBalanceSnapshot(
  db: D1Database,
  userId: number,
  walletAddress: string,
  snapshot: {
    usdcBalance: number;
    solBalance: number;
    activeTokenMint: string | null;
    activeTokenBalance: number | null;
    updatedAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE accounts
       SET wallet_usdc_balance = ?4,
           wallet_sol_balance = ?5,
           wallet_active_token_mint = ?6,
           wallet_active_token_balance = ?7,
           wallet_balance_updated_at = ?8
       WHERE user_id = ?1
         AND type = 'managed'
         AND wallet_address = ?2`,
    )
    .bind(
      userId,
      walletAddress,
      'managed',
      snapshot.usdcBalance,
      snapshot.solBalance,
      snapshot.activeTokenMint,
      snapshot.activeTokenBalance,
      snapshot.updatedAt,
    )
    .run();
}

async function listActiveManagedAccountCandidates(
  db: D1Database,
  userId: number,
): Promise<ManagedAccountCandidateRow[]> {
  const candidateRows = await db
    .prepare(
      `SELECT
         a.id,
         a.label,
         a.wallet_address,
         a.type,
         a.capability_base_mint,
         a.capability_quote_mint,
         a.created_at,
         a.wallet_usdc_balance,
         a.wallet_sol_balance,
         a.wallet_active_token_mint,
         a.wallet_active_token_balance,
         a.wallet_balance_updated_at,
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
    .all<ManagedAccountCandidateRow>();

  return [...candidateRows.results].sort((left, right) =>
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
}

function candidateCapabilityMatchesMintPair(
  candidate: ManagedAccountCandidateRow,
  baseMint: string,
  quoteMint: string,
): boolean {
  return accountCapabilityMatchesMintPair(
    {
      capabilityBaseMint: candidate.capability_base_mint,
      capabilityQuoteMint: candidate.capability_quote_mint,
    },
    baseMint,
    quoteMint,
  );
}

export async function listManagedAccountsWithBalances(
  db: D1Database,
  userId: number,
  options?: {
    envRpcUrl?: string;
    pair?: {
      baseMint: string;
      quoteMint: string;
    };
  },
): Promise<ManagedAccountBalanceRecord[]> {
  const settings = await dbLoadSettings(db, userId);
  const pair = options?.pair ?? {
    baseMint: settings.baseTokenAddress.trim()
      ? normalizePubkey(settings.baseTokenAddress)
      : '',
    quoteMint: SOLANA_USDC_MINT,
  };
  const candidates = await listActiveManagedAccountCandidates(db, userId);
  if (candidates.length === 0) {
    return [];
  }

  const tradableTokens = await dbListTradableTokens(db);
  const rpcUrls = await dbResolveSolanaRpcUrls(db, userId, options?.envRpcUrl);

  return Promise.all(
    candidates.map(async (candidate) => {
      const walletBalance = await loadWalletBalance(
        candidate.wallet_address,
        settings,
        tradableTokens,
        rpcUrls,
      );
      const quoteAvailableAmount = readQuoteBalanceAmount(walletBalance, pair.quoteMint);
      const baseTokenAmount = pair.baseMint
        ? readBaseTokenAmount(walletBalance, pair.baseMint)
        : 0;
      const solBalance = toFiniteNumber(walletBalance.sol) ?? 0;
      return {
        ...mapAccountRow(candidate),
        walletBalance,
        quoteAvailableAmount,
        baseTokenAmount,
        hasSolReserve: solBalance >= ACCOUNT_MIN_SOL_RESERVE,
        pairCompatible: candidateCapabilityMatchesMintPair(
          candidate,
          pair.baseMint,
          pair.quoteMint,
        ),
      };
    }),
  );
}

export async function dbIsSetupRequired(db: D1Database): Promise<boolean> {
  try {
    const result = await db
      .prepare('SELECT COUNT(*) AS cnt FROM users')
      .first<{ cnt: number }>();
    return (result?.cnt ?? 0) === 0;
  } catch (err) {
    if (isMissingTableError(err, 'users')) {
      return true;
    }
    throw err;
  }
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
  try {
    // Prune expired sessions.
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
  } catch (err) {
    if (isMissingTableError(err, 'sessions') || isMissingTableError(err, 'users')) {
      return null;
    }
    throw err;
  }
}

export async function dbDeleteSession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  try {
    await db
      .prepare('DELETE FROM sessions WHERE token_hash = ?1')
      .bind(tokenHash)
      .run();
  } catch (err) {
    if (isMissingTableError(err, 'sessions')) {
      return;
    }
    throw err;
  }
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
  validateContractAddress(update.baseTokenAddress);
  const normalizedContractAddress = update.baseTokenAddress.trim()
    ? normalizePubkey(update.baseTokenAddress)
    : '';
  const normalizedActiveQuoteTokenAddress =
    typeof update.activeQuoteTokenAddress === 'string' && update.activeQuoteTokenAddress.trim().length > 0
      ? normalizePubkey(update.activeQuoteTokenAddress)
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
    ['activeBaseTokenAddress', normalizedContractAddress],
    ['activeQuoteTokenAddress', normalizedActiveQuoteTokenAddress],
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
  quoteTokenAddress?: string,
): Promise<string> {
  validateContractAddress(contractAddress);
  const normalizedContractAddress = contractAddress.trim()
    ? normalizePubkey(contractAddress)
    : '';
  const normalizedQuoteTokenAddress =
    typeof quoteTokenAddress === 'string' && quoteTokenAddress.trim().length > 0
      ? normalizePubkey(quoteTokenAddress)
      : '';
  await db.batch([
    db
      .prepare(
        'INSERT INTO settings (user_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
      )
      .bind(userId, 'contractAddress', normalizedContractAddress),
    db
      .prepare(
        'INSERT INTO settings (user_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
      )
      .bind(userId, 'activeBaseTokenAddress', normalizedContractAddress),
    db
      .prepare(
        'INSERT INTO settings (user_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
      )
      .bind(userId, 'activeQuoteTokenAddress', normalizedQuoteTokenAddress),
  ]);
  return normalizedContractAddress;
}

export async function dbLoadSettings(
  db: D1Database,
  userId: number,
): Promise<SettingsState> {
  const settings: SettingsState = {
    baseTokenAddress: '',
    activeBaseTokenAddress: '',
    activeQuoteTokenAddress: '',
    volatilityTarget: 4.5,
    pullbackTarget: 2,
    volumeTarget: 0,
    netBuyinTarget: 0,
    timeRangeTarget: '24h',
    maxTransactions: 100,
    maxSlippage: 0.1,
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
        settings.baseTokenAddress = row.value;
        break;
      case 'activeBaseTokenAddress':
        settings.activeBaseTokenAddress = row.value;
        break;
      case 'activeQuoteTokenAddress':
        settings.activeQuoteTokenAddress = row.value;
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
  settings.activeBaseTokenAddress =
    settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress;
  return settings;
}

export async function dbListAccounts(
  db: D1Database,
  userId: number,
  type: string,
): Promise<AccountRecord[]> {
  const rows = await db
    .prepare(
      `SELECT id, label, wallet_address, type, capability_base_mint, capability_quote_mint, created_at,
              wallet_usdc_balance, wallet_sol_balance, wallet_active_token_mint, wallet_active_token_balance, wallet_balance_updated_at,
              COALESCE(is_active, 1) AS is_active
       FROM accounts
       WHERE user_id = ?1 AND type = ?2
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId, type)
    .all<{
      id: number;
      label: string;
      wallet_address: string;
      type: string;
      capability_base_mint: string | null;
      capability_quote_mint: string | null;
      created_at: number;
      wallet_usdc_balance: number | null;
      wallet_sol_balance: number | null;
      wallet_active_token_mint: string | null;
      wallet_active_token_balance: number | null;
      wallet_balance_updated_at: number | null;
      is_active: number;
    }>();
  return rows.results.map((row) => mapAccountRow(row));
}

export async function dbListAccountsDirectory(
  db: D1Database,
  userId: number,
  type: string,
): Promise<AccountRecord[]> {
  const rows = await db
    .prepare(
      `SELECT id, label, wallet_address, type, capability_base_mint, capability_quote_mint, created_at,
              COALESCE(is_active, 1) AS is_active
       FROM accounts
       WHERE user_id = ?1 AND type = ?2
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId, type)
    .all<{
      id: number;
      label: string;
      wallet_address: string;
      type: string;
      capability_base_mint: string | null;
      capability_quote_mint: string | null;
      created_at: number;
      is_active: number;
    }>();
  return rows.results.map((row) => mapAccountRow(row));
}

  export async function dbListInternalAccountDirectory(
    db: D1Database,
    userId: number,
  ): Promise<AccountRecord[]> {
    const rows = await db
      .prepare(
        `SELECT id, label, wallet_address, type, capability_base_mint, capability_quote_mint, created_at,
                COALESCE(is_active, 1) AS is_active
         FROM accounts
         WHERE user_id = ?1 AND type = 'managed'
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(userId)
      .all<{
        id: number;
        label: string;
        wallet_address: string;
        type: string;
        capability_base_mint: string | null;
        capability_quote_mint: string | null;
        created_at: number;
        is_active: number;
      }>();
    return rows.results.map((row) => mapAccountRow(row));
  }

export async function dbGetManagedAccountSummary(
  db: D1Database,
  userId: number,
  activeBaseTokenAddress: string,
): Promise<ManagedAccountSummaryRecord> {
  const normalizedActiveBaseTokenAddress = activeBaseTokenAddress.trim();
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN COALESCE(is_active, 1) = 1 THEN 1 ELSE 0 END) AS active_accounts,
         SUM(CASE
           WHEN COALESCE(wallet_sol_balance, 0) > 0
             OR COALESCE(wallet_usdc_balance, 0) > 0
             OR COALESCE(wallet_active_token_balance, 0) > 0
           THEN 1
           ELSE 0
         END) AS active_assets,
         SUM(COALESCE(wallet_sol_balance, 0)) AS total_sol,
         SUM(COALESCE(wallet_usdc_balance, 0)) AS total_usdc,
         SUM(CASE
           WHEN ?2 <> ''
             AND wallet_active_token_mint = ?2
             AND COALESCE(wallet_active_token_balance, 0) > 0
           THEN 1
           ELSE 0
         END) AS tracked_wallets,
         SUM(CASE
           WHEN ?2 <> ''
             AND wallet_active_token_mint = ?2
             AND COALESCE(wallet_active_token_balance, 0) > 0
           THEN 1
           ELSE 0
         END) AS tracked_token_lines,
         SUM(CASE
           WHEN ?2 <> '' AND wallet_active_token_mint = ?2
           THEN COALESCE(wallet_active_token_balance, 0)
           ELSE 0
         END) AS total_tracked_token_amount
       FROM accounts
       WHERE user_id = ?1 AND type = 'managed'`,
    )
    .bind(userId, normalizedActiveBaseTokenAddress)
    .first<{
      total: number;
      active_accounts: number | null;
      active_assets: number | null;
      total_sol: number | null;
      total_usdc: number | null;
      tracked_wallets: number | null;
      tracked_token_lines: number | null;
      total_tracked_token_amount: number | null;
    }>();

  return {
    total: Number(row?.total ?? 0),
    activeAccounts: Number(row?.active_accounts ?? 0),
    activeAssets: Number(row?.active_assets ?? 0),
    totalSol: Number(row?.total_sol ?? 0),
    totalUsdc: Number(row?.total_usdc ?? 0),
    trackedWallets: Number(row?.tracked_wallets ?? 0),
    trackedTokenLines: Number(row?.tracked_token_lines ?? 0),
    totalTrackedTokenAmount: Number(row?.total_tracked_token_amount ?? 0),
  };
}

export async function dbListManagedAccountsPage(
  db: D1Database,
  userId: number,
  options?: {
    page?: number;
    pageSize?: number;
    searchTerm?: string | null;
    sort?: ManagedAccountSort;
    envRpcUrl?: string;
  },
): Promise<ManagedAccountPageRecord> {
  const page = Math.max(1, options?.page ?? 1);
  const pageSize = Math.max(1, options?.pageSize ?? 20);
  const searchTerm = (options?.searchTerm ?? '').trim().toLowerCase();
  const sort: ManagedAccountSort =
    options?.sort === 'usdc' ||
    options?.sort === 'sol' ||
    options?.sort === 'token'
      ? options.sort
      : 'newest';

  const settings = await dbLoadSettings(db, userId);
  const activeBaseTokenAddress =
    settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
  const offset = (page - 1) * pageSize;
  const searchPattern = `%${searchTerm}%`;
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM accounts
       WHERE user_id = ?1
         AND type = 'managed'
         AND (?2 = '' OR LOWER(wallet_address) LIKE ?3 OR LOWER(label) LIKE ?3)`,
    )
    .bind(userId, searchTerm, searchPattern)
    .first<{ total: number }>();
  const rows = await db
    .prepare(
      `SELECT id, label, wallet_address, type, capability_base_mint, capability_quote_mint, created_at,
              wallet_usdc_balance, wallet_sol_balance, wallet_active_token_mint, wallet_active_token_balance, wallet_balance_updated_at,
              COALESCE(is_active, 1) AS is_active
       FROM accounts
       WHERE user_id = ?1
         AND type = 'managed'
         AND (?2 = '' OR LOWER(wallet_address) LIKE ?3 OR LOWER(label) LIKE ?3)
       ORDER BY
         CASE WHEN ?4 = 'usdc' THEN COALESCE(wallet_usdc_balance, 0) END DESC,
         CASE WHEN ?4 = 'sol' THEN COALESCE(wallet_sol_balance, 0) END DESC,
         CASE
           WHEN ?4 = 'token' THEN CASE
             WHEN ?5 <> '' AND wallet_active_token_mint = ?5
             THEN COALESCE(wallet_active_token_balance, 0)
             ELSE 0
           END
         END DESC,
         COALESCE(is_active, 1) DESC,
         created_at DESC,
         id DESC
       LIMIT ?6 OFFSET ?7`,
    )
    .bind(
      userId,
      searchTerm,
      searchPattern,
      sort,
      activeBaseTokenAddress,
      pageSize,
      offset,
    )
    .all<{
      id: number;
      label: string;
      wallet_address: string;
      type: string;
      capability_base_mint: string | null;
      capability_quote_mint: string | null;
      created_at: number;
      wallet_usdc_balance: number | null;
      wallet_sol_balance: number | null;
      wallet_active_token_mint: string | null;
      wallet_active_token_balance: number | null;
      wallet_balance_updated_at: number | null;
      is_active: number;
    }>();
  const items = rows.results.map((row) => mapAccountRow(row));
  const totalItems = Number(countRow?.total ?? 0);

  const balances = buildWalletBalancesFromSnapshots(items, activeBaseTokenAddress);

  return {
    items,
    page,
    pageSize,
    totalItems,
    balances,
  };
}

export async function dbListManagedAccountAddresses(
  db: D1Database,
  userId: number,
  options?: {
    activeOnly?: boolean;
  },
): Promise<string[]> {
  const activeOnlyClause = options?.activeOnly
    ? " AND COALESCE(is_active, 1) = 1"
    : '';
  const rows = await db
    .prepare(
      `SELECT wallet_address
       FROM accounts
       WHERE user_id = ?1 AND type = 'managed'${activeOnlyClause}
       ORDER BY created_at DESC, id DESC`,
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
  const row = await db
    .prepare(
      `SELECT id, label, wallet_address, type, capability_base_mint, capability_quote_mint, created_at,
              wallet_usdc_balance, wallet_sol_balance, wallet_active_token_mint, wallet_active_token_balance, wallet_balance_updated_at,
              COALESCE(is_active, 1) AS is_active
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
      capability_base_mint: string | null;
      capability_quote_mint: string | null;
      created_at: number;
      wallet_usdc_balance: number | null;
      wallet_sol_balance: number | null;
      wallet_active_token_mint: string | null;
      wallet_active_token_balance: number | null;
      wallet_balance_updated_at: number | null;
      is_active: number;
    }>();
  if (!row) {
    throw new ApiError(404, `Managed account ${accountId} was not found for the current user`);
  }
  return mapAccountRow(row);
}

export async function dbGetManagedAccountByAddress(
  db: D1Database,
  userId: number,
  walletAddress: string,
): Promise<AccountRecord> {
  const normalizedAddress = normalizePubkey(walletAddress);
  const row = await db
    .prepare(
      `SELECT id, label, wallet_address, type, capability_base_mint, capability_quote_mint, created_at,
              wallet_usdc_balance, wallet_sol_balance, wallet_active_token_mint, wallet_active_token_balance, wallet_balance_updated_at,
              COALESCE(is_active, 1) AS is_active
       FROM accounts
       WHERE user_id = ?1 AND wallet_address = ?2 AND type = 'managed' AND COALESCE(is_active, 1) = 1
       LIMIT 1`,
    )
    .bind(userId, normalizedAddress)
    .first<{
      id: number;
      label: string;
      wallet_address: string;
      type: string;
      capability_base_mint: string | null;
      capability_quote_mint: string | null;
      created_at: number;
      wallet_usdc_balance: number | null;
      wallet_sol_balance: number | null;
      wallet_active_token_mint: string | null;
      wallet_active_token_balance: number | null;
      wallet_balance_updated_at: number | null;
      is_active: number;
    }>();
  if (!row) {
    throw new ApiError(404, `Managed wallet ${normalizedAddress} was not found for the current user`);
  }
  return mapAccountRow(row);
}

export async function dbSetManagedAccountActiveState(
  db: D1Database,
  userId: number,
  addressInput: string,
  isActive: boolean,
): Promise<AccountRecord> {
  const normalizedAddress = normalizePubkey(addressInput);
  const row = await db
    .prepare(
      `SELECT id, label, wallet_address, type, capability_base_mint, capability_quote_mint, created_at,
              wallet_usdc_balance, wallet_sol_balance, wallet_active_token_mint, wallet_active_token_balance, wallet_balance_updated_at,
              COALESCE(is_active, 1) AS is_active
       FROM accounts
       WHERE user_id = ?1 AND wallet_address = ?2 AND type = 'managed'
       LIMIT 1`,
    )
    .bind(userId, normalizedAddress)
    .first<{
      id: number;
      label: string;
      wallet_address: string;
      type: string;
      capability_base_mint: string | null;
      capability_quote_mint: string | null;
      created_at: number;
      wallet_usdc_balance: number | null;
      wallet_sol_balance: number | null;
      wallet_active_token_mint: string | null;
      wallet_active_token_balance: number | null;
      wallet_balance_updated_at: number | null;
      is_active: number;
    }>();
  if (!row) {
    throw new ApiError(404, `Managed wallet ${normalizedAddress} was not found for the current user`);
  }

  await db
    .prepare('UPDATE accounts SET is_active = ?1 WHERE id = ?2')
    .bind(isActive ? 1 : 0, row.id)
    .run();

  return mapAccountRow({
    ...row,
    is_active: isActive ? 1 : 0,
  });
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
    pair?: {
      baseMint: string;
      quoteMint: string;
    };
  },
): Promise<AvailableAccountRecord | null> {
  const normalizedEstimatedAmount =
    Number.isFinite(estimatedAmount) && estimatedAmount > 0 ? estimatedAmount : 0;
  if (normalizedEstimatedAmount <= 0) {
    return null;
  }

  const settings = await dbLoadSettings(db, userId);
  const pair = options?.pair ?? {
    baseMint: settings.baseTokenAddress.trim()
      ? normalizePubkey(settings.baseTokenAddress)
      : '',
    quoteMint: SOLANA_USDC_MINT,
  };
  if (action === 'sell' && (!pair.baseMint || pair.baseMint === pair.quoteMint)) {
    return null;
  }

  const candidates = await listActiveManagedAccountCandidates(db, userId);
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
    if (!candidateCapabilityMatchesMintPair(candidate, pair.baseMint, pair.quoteMint)) {
      continue;
    }

    const walletBalance = await loadWalletBalance(
      candidate.wallet_address,
      settings,
      tradableTokens,
      rpcUrls,
    );
    if (!hasAnyPairTokenBalance(walletBalance, pair)) {
      continue;
    }
    if (!hasSufficientBalance(action, normalizedEstimatedAmount, pair, walletBalance)) {
      continue;
    }

    return {
      ...mapAccountRow(candidate),
      lastTradedAt: lastTradedAtMs,
      walletBalance,
    };
  }

  return null;
}

export async function getManagedBuyCapacitySummary(
  db: D1Database,
  userId: number,
  options?: {
    envRpcUrl?: string;
    pair?: {
      baseMint: string;
      quoteMint: string;
    };
  },
): Promise<ManagedBuyCapacitySummary> {
  const settings = await dbLoadSettings(db, userId);
  const pair = options?.pair ?? {
    baseMint: settings.baseTokenAddress.trim()
      ? normalizePubkey(settings.baseTokenAddress)
      : '',
    quoteMint: SOLANA_USDC_MINT,
  };

  const accounts = await listManagedAccountsWithBalances(db, userId, {
    envRpcUrl: options?.envRpcUrl,
    pair,
  });
  if (accounts.length === 0) {
    return {
      enabledAccountCount: 0,
      eligibleAccountCount: 0,
      skippedForCapabilityCount: 0,
      skippedForSolReserveCount: 0,
      availableQuoteAmount: 0,
      quoteMint: pair.quoteMint,
    };
  }

  let eligibleAccountCount = 0;
  let skippedForCapabilityCount = 0;
  let skippedForSolReserveCount = 0;
  let availableQuoteAmount = 0;

  for (const account of accounts) {
    if (!account.pairCompatible) {
      skippedForCapabilityCount += 1;
      continue;
    }

    if (!account.hasSolReserve) {
      skippedForSolReserveCount += 1;
      continue;
    }

    const quoteAmount = account.quoteAvailableAmount;
    if (quoteAmount <= 0) {
      continue;
    }

    eligibleAccountCount += 1;
    availableQuoteAmount += quoteAmount;
  }

  return {
    enabledAccountCount: accounts.length,
    eligibleAccountCount,
    skippedForCapabilityCount,
    skippedForSolReserveCount,
    availableQuoteAmount: Number(availableQuoteAmount.toFixed(6)),
    quoteMint: pair.quoteMint,
  };
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
    isActive: true,
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
    isActive: true,
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
         tl.chain_time_ms,
        tl.execution_trace_json,
         tl.status,
         tl.error_message,
         tl.created_at,
         tl.updated_at,
         tt.base_token_address AS token_contract_address,
         tt.symbol
       FROM trade_logs tl
       LEFT JOIN tradable_tokens tt ON tt.id = tl.token_id
       ORDER BY tl.chain_time_ms DESC, tl.created_at DESC, tl.id DESC
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
      chain_time_ms: number | null;
      execution_trace_json: string | null;
      status: 'PENDING' | 'SUCCESS' | 'FAILED';
      error_message: string | null;
      created_at: number;
      updated_at: number;
      token_contract_address: string | null;
      symbol: string | null;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    tokenId: row.token_id,
    tokenContractAddress: row.token_contract_address,
    tokenSymbol: row.symbol,
    walletAddress: row.wallet_address,
    action: row.action,
    requestedAmount: row.requested_amount,
    executedAmount: row.executed_amount,
    executedPrice: row.executed_price,
    txSignature: row.tx_signature,
    chainTimeMs: row.chain_time_ms,
    executionTraceJson: row.execution_trace_json,
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
  const rows = await db
    .prepare(
      `SELECT
         wtl.id,
         wtl.token_contract_address,
         tt.symbol AS token_symbol,
         wtl.wallet_address,
         wtl.from_wallet_address,
         wtl.to_wallet_address,
         wtl.action,
         wtl.usdc_amount,
         wtl.token_amount,
         wtl.fee_amount_usd,
         wtl.source,
         wtl.event_type,
         wtl.tx_signature,
         wtl.chain_time_ms,
         wtl.status,
         wtl.error_message,
         wtl.created_at
       FROM webhook_transaction_logs wtl
       LEFT JOIN tradable_tokens tt ON tt.id = wtl.token_id
       WHERE wtl.user_id = ?1
       ORDER BY wtl.chain_time_ms DESC, wtl.id DESC
       LIMIT 50`,
    )
    .bind(userId)
    .all<{
      id: number;
      token_contract_address: string | null;
      token_symbol: string | null;
      wallet_address: string | null;
      from_wallet_address: string | null;
      to_wallet_address: string | null;
      action: 'BUY' | 'SELL' | 'TRANSFER' | null;
      usdc_amount: number | null;
      token_amount: number | null;
      fee_amount_usd: number | null;
      source: 'webhook' | 'rpc_reconcile';
      event_type: string;
      tx_signature: string | null;
      chain_time_ms: number | null;
      status: 'PENDING' | 'CONFIRMED' | 'FAILED';
      error_message: string | null;
      created_at: number;
    }>();

  return rows.results.map((row) => ({
    id: row.id,
    tokenContractAddress: row.token_contract_address,
    tokenSymbol: row.token_symbol,
    walletAddress: row.wallet_address,
    fromWalletAddress: row.from_wallet_address,
    toWalletAddress: row.to_wallet_address,
    action: row.action,
    usdcAmount: row.usdc_amount,
    tokenAmount: row.token_amount,
    feeAmountUsd: row.fee_amount_usd,
    source: row.source,
    eventType: row.event_type,
    txSignature: row.tx_signature,
    chainTimeMs: row.chain_time_ms,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }));
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

