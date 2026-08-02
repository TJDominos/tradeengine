import type {
  AccountRecord,
  AccountSummary,
  AuditLog,
  DateRangeState,
  EngineState,
  HistoricalSetup,
  SettingsState,
  TokenMarketSnapshot,
  TradableToken,
  WalletBalance,
  WalletOwnershipMeta,
} from './types';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    let error = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as {
        error?: string;
        details?: string;
      };
      if (body.error) {
        error = body.details ? `${body.error}: ${body.details}` : body.error;
      }
    } catch {
      // ignore
    }
    throw new Error(error);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const formatUSD = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);

export const formatNum = (value: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);

export const formatLivePrice = (value: number | null | undefined) => {
  if (value == null) return 'Unavailable';
  const maximumFractionDigits = value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value);
};

export function formatOptionalUsd(value: number | null | undefined): string {
  return value == null ? 'Unavailable' : formatUSD(value);
}

export function serializeSettings(settings: SettingsState) {
  return {
    contractAddress: settings.contractAddress,
    volatilityTarget: Number(settings.volatilityTarget),
    pullbackTarget: Number(settings.pullbackTarget),
    volumeTarget: Number(settings.volumeTarget),
    netBuyinTarget: Number(settings.netBuyinTarget),
    timeRangeTarget: settings.timeRangeTarget,
    maxTransactions: Number(settings.maxTransactions),
    maxSlippage: Number(settings.maxSlippage),
    strategyNotes: settings.strategyNotes,
  };
}

export function mergeTradableToken(tokens: TradableToken[], nextToken: TradableToken) {
  const existingIndex = tokens.findIndex(
    (token) =>
      token.network === nextToken.network &&
      token.contractAddress === nextToken.contractAddress,
  );
  if (existingIndex === -1) {
    return [...tokens, nextToken];
  }

  return tokens.map((token, index) =>
    index === existingIndex ? nextToken : token,
  );
}

export function normalizeTimestampMs(timestamp: number) {
  return timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

export function formatDate(timestamp: number) {
  return new Date(normalizeTimestampMs(timestamp)).toLocaleString();
}

export function formatWebhookEventLabel(eventType: string) {
  const segments = eventType
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const label = segments[segments.length - 1] ?? eventType;
  return label.replace(/[_-]+/g, ' ').trim().toUpperCase() || 'WEBHOOK';
}

export function buildWalletOwnershipLookup(engineState: EngineState): Map<string, WalletOwnershipMeta> {
  const lookup = new Map<string, WalletOwnershipMeta>();

  for (const account of engineState.internalAccs) {
    lookup.set(account.address, {
      ownership: 'internal',
      accountLabel: account.label,
    });
  }

  return lookup;
}

export function resolveWalletOwnershipMeta(
  walletAddress: string | null | undefined,
  ownershipLookup: Map<string, WalletOwnershipMeta>,
): WalletOwnershipMeta {
  if (!walletAddress || walletAddress === 'system') {
    return { ownership: 'system', accountLabel: null };
  }
  return ownershipLookup.get(walletAddress) ?? {
    ownership: 'untracked',
    accountLabel: null,
  };
}

export function formatDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createDefaultDateRange(): DateRangeState {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    from: formatDateInputValue(start),
    to: formatDateInputValue(end),
  };
}

export function toRangeStartMs(value: string) {
  return new Date(`${value}T00:00:00.000`).getTime();
}

export function toRangeEndMs(value: string) {
  return new Date(`${value}T23:59:59.999`).getTime();
}

export function compactAddress(address: string) {
  if (address.length <= 18) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

export function parseAmount(value?: string): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function walletHasAssets(balance?: WalletBalance): boolean {
  if (!balance) return false;
  if (parseAmount(balance.sol) > 0) return true;
  if (parseAmount(balance.usdc) > 0) return true;
  return balance.tokens.some((token) => parseAmount(token.amount) > 0);
}

export function findWalletTokenAmount(balance: WalletBalance | undefined, mint: string): number {
  if (!balance) return 0;
  const token = balance.tokens.find((entry) => entry.mint === mint);
  return parseAmount(token?.amount);
}

export function summarizeAccounts(
  accounts: AccountRecord[],
  balances: Record<string, WalletBalance>,
): AccountSummary {
  let activeAssets = 0;
  let totalSol = 0;
  let totalUsdc = 0;
  let trackedWallets = 0;
  let trackedTokenLines = 0;

  for (const account of accounts) {
    const balance = balances[account.address];
    if (!balance) continue;
    const hasTracked = balance.tokens.some((token) => parseAmount(token.amount) > 0);
    if (walletHasAssets(balance)) activeAssets += 1;
    totalSol += parseAmount(balance.sol);
    totalUsdc += parseAmount(balance.usdc);
    if (hasTracked) trackedWallets += 1;
    trackedTokenLines += balance.tokens.filter((token) => parseAmount(token.amount) > 0).length;
  }

  return {
    total: accounts.length,
    activeAssets,
    totalSol,
    totalUsdc,
    trackedWallets,
    trackedTokenLines,
  };
}

export function getLogsForSetup(
  historicalSetups: HistoricalSetup[],
  logs: AuditLog[],
  index: number,
): AuditLog[] {
  const current = historicalSetups[index];
  const newerBoundary = index === 0 ? Number.POSITIVE_INFINITY : historicalSetups[index - 1].createdAt;
  return logs
    .filter((log) => log.createdAt >= current.createdAt && log.createdAt < newerBoundary)
    .slice(0, 8);
}

export function loadStoredString(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

export function saveStoredString(key: string, value: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, value);
}