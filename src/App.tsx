import React, { useEffect } from 'react';
import {
  Activity,
  Archive,
  CheckSquare,
  Clock,
  Code,
  FileText,
  Key,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react';

import AppHeader from './components/AppHeader';
import PageTabs from './components/PageTabs';
import AccountsPage from './pages/AccountsPage';
import DashboardPage from './pages/DashboardPage';
import HistoricalSetupsPage from './pages/HistoricalSetupsPage';
import TradingSetupPage from './pages/TradingSetupPage';

type TabId = 'dashboard' | 'accounts' | 'setup' | 'setups';

type AuthStatus = {
  setupRequired: boolean;
  authenticated: boolean;
  user?: { username: string; role: string } | null;
};

type SettingsState = {
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
};

type AccountRecord = {
  id: number;
  label: string;
  address: string;
  type: string;
  createdAt: number;
};

type AuditLog = {
  id: number;
  action: string;
  target: string;
  details: string;
  actor: string;
  createdAt: number;
};

type TradeLog = {
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
};

type WebhookTransactionLog = {
  id: number;
  tokenContractAddress: string | null;
  tokenSymbol: string | null;
  walletAddress: string | null;
  eventType: string;
  txSignature: string | null;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  errorMessage: string | null;
  createdAt: number;
};

type RpcEndpoint = {
  id: number;
  network: string;
  url: string;
  createdAt: number;
};

type TokenMarketSnapshot = {
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
};

type TradableToken = {
  id: number;
  network: string;
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  isActive: boolean;
};

type HistoricalSetup = {
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
};

type WalletBalanceToken = {
  mint: string;
  symbol: string;
  network: string;
  amount: string;
  decimals: number | null;
};

type WalletBalance = {
  address: string;
  sol: string;
  usdc: string;
  tokens: WalletBalanceToken[];
  updatedAt: number;
};

type EngineState = {
  auth: { username: string; role: string };
  settings: SettingsState;
  internalAccs: AccountRecord[];
  outsiderAccs: AccountRecord[];
  activityLogs: AuditLog[];
  tradeLogs: TradeLog[];
  webhookTransactionLogs: WebhookTransactionLog[];
  tradableTokens: TradableToken[];
  historicalSetups: HistoricalSetup[];
  rpcEndpoints: RpcEndpoint[];
  marketSnapshot: TokenMarketSnapshot | null;
  marketSnapshotHistory: TokenMarketSnapshot[];
  profitUsdc: number;
  stats: {
    managedAccounts: number;
    watchedAccounts: number;
    tradeExecutionEnabled: boolean;
  };
  system: {
    backend: string;
    databasePath: string;
    databaseConnected: boolean;
  };
};

type DateRangeState = {
  from: string;
  to: string;
};

type AccountSummary = {
  total: number;
  activeAssets: number;
  totalSol: number;
  totalUsdc: number;
  trackedWallets: number;
  trackedTokenLines: number;
};

type DashboardLogTab = 'transaction' | 'activity';

type DashboardTransactionLog =
  | ({ kind: 'trade' } & TradeLog)
  | ({ kind: 'webhook' } & WebhookTransactionLog);

type WalletOwnership = 'internal' | 'external' | 'system' | 'untracked';

type WalletOwnershipMeta = {
  ownership: WalletOwnership;
  accountLabel: string | null;
};

const CONTRACT_ADDRESS = '';
const ITEMS_PER_PAGE = 20;
const DASHBOARD_AUTO_REFRESH_INTERVAL_MS = 10_000;
const workerAlgorithmTemplate = `// Cloudflare Worker trade execution sketch
// This editor is stored locally in the browser for planning only.

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const payload = await request.json();
    console.log('Received event batch', payload.length ?? 1);

    // Real trade execution remains disabled in the current backend.
    return new Response('OK', { status: 200 });
  },
};
`;

const formatUSD = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);

const formatNum = (value: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);

const formatLivePrice = (value: number | null | undefined) => {
  if (value == null) return 'Unavailable';
  const maximumFractionDigits = value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value);
};

function formatOptionalUsd(value: number | null | undefined): string {
  return value == null ? 'Unavailable' : formatUSD(value);
}

function serializeSettings(settings: SettingsState) {
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

function mergeTradableToken(tokens: TradableToken[], nextToken: TradableToken) {
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

async function api<T>(path: string, options?: RequestInit): Promise<T> {
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

function formatDate(timestamp: number) {
  const normalized = timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(normalized).toLocaleString();
}

function normalizeTimestampMs(timestamp: number) {
  return timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function formatWebhookEventLabel(eventType: string) {
  const segments = eventType
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const label = segments[segments.length - 1] ?? eventType;
  return label.replace(/[_-]+/g, ' ').trim().toUpperCase() || 'WEBHOOK';
}

function buildWalletOwnershipLookup(engineState: EngineState): Map<string, WalletOwnershipMeta> {
  const lookup = new Map<string, WalletOwnershipMeta>();

  for (const account of engineState.outsiderAccs) {
    lookup.set(account.address, {
      ownership: 'external',
      accountLabel: account.label,
    });
  }

  for (const account of engineState.internalAccs) {
    lookup.set(account.address, {
      ownership: 'internal',
      accountLabel: account.label,
    });
  }

  return lookup;
}

function resolveWalletOwnershipMeta(
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

function formatDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createDefaultDateRange(): DateRangeState {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    from: formatDateInputValue(start),
    to: formatDateInputValue(end),
  };
}

function toRangeStartMs(value: string) {
  return new Date(`${value}T00:00:00.000`).getTime();
}

function toRangeEndMs(value: string) {
  return new Date(`${value}T23:59:59.999`).getTime();
}

function compactAddress(address: string) {
  if (address.length <= 18) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function parseAmount(value?: string): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function walletHasAssets(balance?: WalletBalance): boolean {
  if (!balance) return false;
  if (parseAmount(balance.sol) > 0) return true;
  if (parseAmount(balance.usdc) > 0) return true;
  return balance.tokens.some((token) => parseAmount(token.amount) > 0);
}

function findWalletTokenAmount(balance: WalletBalance | undefined, mint: string): number {
  if (!balance) return 0;
  const token = balance.tokens.find((entry) => entry.mint === mint);
  return parseAmount(token?.amount);
}

function summarizeAccounts(
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

function getLogsForSetup(
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

function loadStoredString(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

function saveStoredString(key: string, value: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, value);
}

function DateRangePicker({
  dateRange,
  setDateRange,
  hasDateRange,
  children,
}: {
  dateRange: DateRangeState;
  setDateRange: React.Dispatch<React.SetStateAction<DateRangeState>>;
  hasDateRange: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex w-full flex-wrap items-end gap-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            From Date
          </label>
          <input
            type="date"
            value={dateRange.from}
            className="h-10 w-[160px] cursor-pointer rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
            onChange={(event) =>
              setDateRange((current) => ({ ...current, from: event.target.value }))
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            To Date
          </label>
          <input
            type="date"
            value={dateRange.to}
            className="h-10 w-[160px] cursor-pointer rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
            onChange={(event) =>
              setDateRange((current) => ({ ...current, to: event.target.value }))
            }
          />
        </div>
        {hasDateRange ? (
          <div className="flex h-10 items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-400">
            <CheckSquare size={14} className="mr-1.5" /> Time filter active
          </div>
        ) : null}
      </div>
      {children ? <div className="flex min-w-[300px] flex-1 justify-end">{children}</div> : null}
    </div>
  );
}

function Pagination({
  currentPage,
  totalItems,
  itemsPerPage,
  onPageChange,
}: {
  currentPage: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (totalPages <= 1) return null;

  const first = (currentPage - 1) * itemsPerPage + 1;
  const last = Math.min(currentPage * itemsPerPage, totalItems);

  return (
    <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900/50 p-3 text-sm">
      <span className="text-xs text-slate-500">
        Showing {first} to {last} of {totalItems} entries
      </span>
      <div className="flex gap-1">
        <button
          onClick={() => onPageChange(Math.max(currentPage - 1, 1))}
          disabled={currentPage === 1}
          className="rounded bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Prev
        </button>
        <span className="flex items-center px-3 py-1 text-xs font-medium text-slate-400">
          {currentPage} / {totalPages}
        </span>
        <button
          onClick={() => onPageChange(Math.min(currentPage + 1, totalPages))}
          disabled={currentPage === totalPages}
          className="rounded bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-sm px-4 py-1.5 text-sm font-medium transition-all ${
        active ? 'bg-slate-800 text-slate-100 shadow-sm' : 'hover:bg-slate-800/50 hover:text-slate-300'
      }`}
    >
      <span className="flex items-center gap-2">
        {icon} {label}
      </span>
    </button>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  copyable,
  isAddress,
}: {
  title: string;
  value: string;
  subtitle?: string;
  copyable?: boolean;
  isAddress?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-sm transition-colors hover:border-slate-700">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </p>
      <div className="mt-1 flex items-end justify-between">
        <h2
          className={`font-bold ${
            isAddress
              ? 'break-all font-mono text-[13px] leading-relaxed text-blue-400'
              : copyable
                ? 'cursor-pointer font-mono text-[22px] text-blue-400 hover:text-blue-300'
                : 'text-2xl text-white'
          }`}
        >
          {value}
        </h2>
      </div>
      {subtitle ? <p className="mt-3 text-xs text-slate-500">{subtitle}</p> : null}
    </div>
  );
}

function SettingInput({
  label,
  sublabel,
  value,
  onChange,
  options,
}: {
  label: string;
  sublabel?: string;
  value: string | number;
  onChange: (value: string) => void;
  options?: Array<{ label: string; value: string }>;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
        {label}
        {sublabel ? (
          <span className="ml-1.5 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] normal-case text-slate-500">
            {sublabel}
          </span>
        ) : null}
      </label>
      {options ? (
        <select
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-blue-500"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-blue-500"
        />
      )}
    </div>
  );
}

function SummaryBlock({
  title,
  icon,
  data,
}: {
  title: string;
  icon: React.ReactNode;
  data: AccountSummary;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
      <h3 className="flex items-center gap-2 border-b border-slate-800 pb-2 font-semibold text-slate-200">
        {icon} {title}
      </h3>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <SummaryMetric label="Tracked wallets" value={`${data.trackedWallets} / ${data.total}`} />
        <SummaryMetric label="Active assets" value={String(data.activeAssets)} />
        <SummaryMetric label="Total SOL" value={formatNum(data.totalSol)} />
        <SummaryMetric label="Total USDC" value={formatUSD(data.totalUsdc)} />
        <SummaryMetric label="Token lines" value={String(data.trackedTokenLines)} />
        <SummaryMetric label="Wallets total" value={String(data.total)} />
      </div>
    </div>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}

function BalanceBadges({ balance }: { balance?: WalletBalance }) {
  if (!balance) {
    return <span className="text-xs text-slate-500">Loading...</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] text-slate-300">
        USDC {balance.usdc}
      </span>
      <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] text-slate-300">
        SOL {balance.sol}
      </span>
      {balance.tokens.slice(0, 2).map((token) => (
        <span
          key={`${token.network}-${token.mint}`}
          className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300"
        >
          {token.symbol} {token.amount}
        </span>
      ))}
    </div>
  );
}

function SetupData({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="mb-1 block text-xs text-slate-500">{label}</span>
      <span className="font-medium text-slate-300">{value}</span>
    </div>
  );
}

function SimulationCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'emerald' | 'rose';
}) {
  const accentClass =
    accent === 'emerald'
      ? 'text-emerald-400'
      : accent === 'rose'
        ? 'text-rose-400'
        : 'text-white';
  return (
    <div className="rounded border border-slate-700/50 bg-slate-800/50 p-4">
      <p className="text-[10px] font-bold uppercase text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-medium ${accentClass}`}>{value}</p>
    </div>
  );
}

function SimulationRow({
  left,
  center,
  right,
}: {
  left: string;
  center: string;
  right: string;
}) {
  return (
    <div className="flex items-center justify-between rounded border border-slate-800 bg-slate-950 p-2">
      <span className="text-slate-500">{left}</span>
      <span className="text-blue-400">{center}</span>
      <span className="hidden text-slate-300 sm:inline">{right}</span>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = React.useState<AuthStatus | null>(null);
  const [engineState, setEngineState] = React.useState<EngineState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [lastUpdated, setLastUpdated] = React.useState('-');
  const [isTradingActive, setIsTradingActive] = React.useState(false);

  const [activeTab, setActiveTab] = React.useState<TabId>('dashboard');
  const [dateRange, setDateRange] = React.useState<DateRangeState>(() => createDefaultDateRange());
  const [accountSearchTerm, setAccountSearchTerm] = React.useState('');
  const [internalPage, setInternalPage] = React.useState(1);
  const [outsiderPage, setOutsiderPage] = React.useState(1);
  const [dashboardLogTab, setDashboardLogTab] = React.useState<DashboardLogTab>('transaction');
  const [transactionLogSearchTerm, setTransactionLogSearchTerm] = React.useState('');
  const [activityLogSearchTerm, setActivityLogSearchTerm] = React.useState('');
  const [transactionLogCurrentPage, setTransactionLogCurrentPage] = React.useState(1);
  const [activityLogCurrentPage, setActivityLogCurrentPage] = React.useState(1);

  const [credentials, setCredentials] = React.useState({ username: '', password: '' });
  const [bootstrap, setBootstrap] = React.useState({ username: '', password: '' });

  const [settings, setSettings] = React.useState<SettingsState>({
    contractAddress: '',
    volatilityTarget: 4.5,
    pullbackTarget: 2,
    volumeTarget: 0,
    netBuyinTarget: 0,
    timeRangeTarget: '24h',
    maxTransactions: 100,
    maxSlippage: 1,
    strategyNotes: '',
    managedKeyCount: 0,
  });
  const [tradableTokenForm, setTradableTokenForm] = React.useState({
    network: 'solana',
    contractAddress: '',
  });
  const [rpcEndpointForm, setRpcEndpointForm] = React.useState({ url: '' });
  const [accountForm, setAccountForm] = React.useState({ label: '', address: '' });

  const [tradingAlgorithm, setTradingAlgorithm] = React.useState(workerAlgorithmTemplate);
  const [submitting, setSubmitting] = React.useState<string | null>(null);

  const [walletBalances, setWalletBalances] = React.useState<Record<string, WalletBalance>>({});
  const [walletBalanceErrors, setWalletBalanceErrors] = React.useState<Record<string, string>>({});
  const [walletBalancePending, setWalletBalancePending] = React.useState<Record<string, boolean>>({});

  const [isAdminModalOpen, setIsAdminModalOpen] = React.useState(false);
  const [adminTab, setAdminTab] = React.useState<'password' | 'import' | 'list'>('password');
  const [adminPasswordForm, setAdminPasswordForm] = React.useState({ old: '', new1: '', new2: '' });
  const [adminImportForm, setAdminImportForm] = React.useState({
    key: '',
    password: '',
    recoveryPhrase: Array(24).fill(''),
    isRecovery: false,
    wordCount: 12,
  });
  const [adminMsg, setAdminMsg] = React.useState({ type: '', text: '' });

  const [isSimulationModalOpen, setIsSimulationModalOpen] = React.useState(false);
  const [loadingMarketSnapshots, setLoadingMarketSnapshots] = React.useState(false);
  
  const settingsDirtyRef = React.useRef(false);
  // Tracks which token address we last attempted to auto-init, to avoid
  // re-firing every 3-second polling cycle when the snapshot stays null.
  const marketInitAttemptedRef = React.useRef('');
  const dashboardAutoRefreshInFlightRef = React.useRef(false);

  const hasDateRange = dateRange.from !== '' && dateRange.to !== '';

  useEffect(() => {
    setTradingAlgorithm(loadStoredString('tradeengine.tradingAlgorithm', workerAlgorithmTemplate));
  }, []);

  const syncSettingsFromServer = React.useCallback(
    (nextSettings: SettingsState, options?: { preserveDraft?: boolean }) => {
      setSettings((current) => {
        if (options?.preserveDraft && settingsDirtyRef.current) {
          return {
            ...current,
            contractAddress: nextSettings.contractAddress,
            managedKeyCount: nextSettings.managedKeyCount,
          };
        }
        return nextSettings;
      });
    },
    [],
  );

  const updateStrategySettings = React.useCallback(
    (updater: (current: SettingsState) => SettingsState) => {
      settingsDirtyRef.current = true;
      setSettings((current) => updater(current));
    },
    [],
  );

  const loadAuth = React.useCallback(async () => {
    const status = await api<AuthStatus>('/api/auth/status');
    setAuth(status);
    return status;
  }, []);

  const loadState = React.useCallback(async () => {
    const state = await api<EngineState>('/api/state');
    setEngineState(state);
    syncSettingsFromServer(state.settings, { preserveDraft: true });
    setLastUpdated(new Date().toLocaleString());
    return state;
  }, [syncSettingsFromServer]);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const status = await loadAuth();
      if (status.authenticated) {
        await loadState();
      } else {
        setEngineState(null);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load application state');
    } finally {
      setLoading(false);
    }
  }, [loadAuth, loadState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshWalletBalances = React.useCallback(async () => {
    if (!engineState) return;
    const accounts = [...engineState.internalAccs, ...engineState.outsiderAccs];
    if (accounts.length === 0) {
      setWalletBalances({});
      setWalletBalanceErrors({});
      setWalletBalancePending({});
      return;
    }

    const pending: Record<string, boolean> = {};
    for (const account of accounts) pending[account.address] = true;
    setWalletBalancePending(pending);

    const results = await Promise.allSettled(
      accounts.map(async (account) => ({
        address: account.address,
        balance: await api<WalletBalance>(`/api/wallets/${encodeURIComponent(account.address)}/balance`),
      })),
    );

    const nextBalances: Record<string, WalletBalance> = {};
    const nextErrors: Record<string, string> = {};
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const account = accounts[index];
      if (result.status === 'fulfilled') {
        nextBalances[account.address] = result.value.balance;
      } else {
        nextErrors[account.address] =
          result.reason instanceof Error ? result.reason.message : 'Failed to load balance';
      }
    }

    const idle: Record<string, boolean> = {};
    for (const account of accounts) idle[account.address] = false;
    setWalletBalances(nextBalances);
    setWalletBalanceErrors(nextErrors);
    setWalletBalancePending(idle);
  }, [engineState]);

  useEffect(() => {
    if (!auth?.authenticated || !engineState) return;
    if (activeTab !== 'dashboard' && activeTab !== 'accounts' && !isAdminModalOpen) {
      return;
    }
    void refreshWalletBalances();
  }, [auth?.authenticated, engineState, activeTab, isAdminModalOpen, refreshWalletBalances]);

  // Auto-initialize market data when dashboard loads with active token
  useEffect(() => {
    if (!auth?.authenticated || !engineState || activeTab !== 'dashboard') return;
    const addr = settings.contractAddress.trim();
    if (!addr) return;
    if (engineState.marketSnapshot) return; // Already loaded
    if (marketInitAttemptedRef.current === addr) return; // Already tried for this address

    marketInitAttemptedRef.current = addr;
    const initializeMarketData = async () => {
      try {
        const result = await api<{ marketSnapshot: TokenMarketSnapshot | null }>(
          '/api/market-snapshot/refresh',
          { method: 'POST' },
        );
        if (result.marketSnapshot) {
          setEngineState((current) =>
            current
              ? {
                  ...current,
                  marketSnapshot: result.marketSnapshot,
                }
              : current,
          );
        }
      } catch {
        // Silently fail — user can click Refresh manually
      }
    };
    void initializeMarketData();
  }, [auth?.authenticated, activeTab, settings.contractAddress, engineState]);

  const submitWithFeedback = async (name: string, action: () => Promise<void>) => {
    setSubmitting(name);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSubmitting(null);
    }
  };

  const handleBootstrap = () =>
    submitWithFeedback('bootstrap', async () => {
      await api('/api/auth/bootstrap', {
        method: 'POST',
        body: JSON.stringify(bootstrap),
      });
      settingsDirtyRef.current = false;
      setBootstrap({ username: '', password: '' });
      setNotice('Initial admin user created. You are now logged in.');
      await refresh();
    });

  const handleLogin = () =>
    submitWithFeedback('login', async () => {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      settingsDirtyRef.current = false;
      setCredentials({ username: '', password: '' });
      setNotice('Login successful.');
      await refresh();
    });

  const handleLogout = () =>
    submitWithFeedback('logout', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      settingsDirtyRef.current = false;
      setEngineState(null);
      setWalletBalances({});
      setNotice('Logged out.');
      await refresh();
    });

  const loadMarketSnapshotHistory = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!auth?.authenticated || !settings.contractAddress.trim()) {
      return;
    }
    if (!dateRange.from || !dateRange.to) {
      setEngineState((current) =>
        current
          ? {
              ...current,
              marketSnapshotHistory: [],
            }
          : current,
      );
      return;
    }

    const startTime = toRangeStartMs(dateRange.from);
    const endTime = toRangeEndMs(dateRange.to);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
      if (!options?.silent) {
        setError('Invalid date range');
      }
      return;
    }

    if (!options?.silent) {
      setLoadingMarketSnapshots(true);
    }
    try {
      const result = await api<{ snapshots: TokenMarketSnapshot[] }>(
        `/api/market-snapshots?startTime=${startTime}&endTime=${endTime}&limit=500`,
      );

      setEngineState((current) =>
        current
          ? {
              ...current,
              marketSnapshotHistory: Array.isArray(result.snapshots) ? result.snapshots : [],
            }
          : current,
      );
    } catch (err: unknown) {
      if (!options?.silent) {
        setError(err instanceof Error ? err.message : 'Failed to load market snapshot history');
      } else {
        console.warn('Dashboard snapshot history auto-refresh failed:', err);
      }
    } finally {
      if (!options?.silent) {
        setLoadingMarketSnapshots(false);
      }
    }
  }, [auth?.authenticated, dateRange.from, dateRange.to, settings.contractAddress]);

  const handleRefresh = () =>
    void submitWithFeedback('refresh', async () => {
      if (auth?.authenticated && settings.contractAddress.trim()) {
        const result = await api<{ marketSnapshot: TokenMarketSnapshot | null }>(
          '/api/market-snapshot/refresh',
          { method: 'POST' },
        );
        if (result.marketSnapshot) {
          // Allow auto-init to retry if user manually refreshes
          marketInitAttemptedRef.current = '';
          setEngineState((current) =>
            current
              ? {
                  ...current,
                  marketSnapshot: result.marketSnapshot,
                }
              : current,
          );
          await loadMarketSnapshotHistory();
          setNotice(
            result.marketSnapshot.priceUsd != null
              ? 'Market data refreshed.'
              : 'Token metadata loaded. Price data not yet available in Jupiter.',
          );
        } else {
          setNotice(
            'No data found for this token in Jupiter. The contract address may be incorrect or the token is not yet indexed.',
          );
        }
      } else {
        setNotice('No active trading token. Select a token first to refresh market data.');
      }
    });

  useEffect(() => {
    if (!auth?.authenticated || activeTab !== 'dashboard') return;
    if (!settings.contractAddress.trim() || !hasDateRange) return;
    void loadMarketSnapshotHistory();
  }, [
    activeTab,
    auth?.authenticated,
    hasDateRange,
    loadMarketSnapshotHistory,
    settings.contractAddress,
  ]);

  useEffect(() => {
    if (!auth?.authenticated || activeTab !== 'dashboard') return;

    let disposed = false;

    const pollDashboard = async () => {
      if (dashboardAutoRefreshInFlightRef.current) {
        return;
      }
      dashboardAutoRefreshInFlightRef.current = true;
      try {
        await loadState();
        if (!disposed && settings.contractAddress.trim() && hasDateRange) {
          await loadMarketSnapshotHistory({ silent: true });
        }
      } catch (err: unknown) {
        if (!disposed) {
          console.warn('Dashboard auto-refresh failed:', err);
        }
      } finally {
        dashboardAutoRefreshInFlightRef.current = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void pollDashboard();
    }, DASHBOARD_AUTO_REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeTab,
    auth?.authenticated,
    hasDateRange,
    loadMarketSnapshotHistory,
    loadState,
    settings.contractAddress,
  ]);

  const handleStartTrading = () => {
    setIsTradingActive((current) => {
      const next = !current;
      setNotice(
        next
          ? 'Trading status switched to active. Automated execution is still backend-gated.'
          : 'Trading status switched back to idle.',
      );
      return next;
    });
  };

  const handleSaveConfig = () =>
    submitWithFeedback('settings', async () => {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify(serializeSettings(settings)),
      });
      settingsDirtyRef.current = false;
      setNotice('Strategy configuration saved. The active tracked token stays unchanged.');
      await refresh();
    });

  const handleUseToken = (contractAddress: string) =>
    submitWithFeedback('use-token', async () => {
      const result = await api<{ contractAddress: string; marketSnapshot: TokenMarketSnapshot | null }>(
        '/api/settings/active-token',
        { method: 'POST', body: JSON.stringify({ contractAddress }) },
      );
      const activated = result.contractAddress || contractAddress;
      setSettings((current) => ({ ...current, contractAddress: activated }));
      if (result.marketSnapshot) {
        setEngineState((current) =>
          current ? { ...current, marketSnapshot: result.marketSnapshot } : current,
        );
      }
      setNotice(result.marketSnapshot ? 'Token activated with live market data.' : 'Token activated.');
    });

  const handleAddRpcEndpoint = () =>
    submitWithFeedback('rpc', async () => {
      await api('/api/rpc-endpoints', {
        method: 'POST',
        body: JSON.stringify({
          network: 'solana',
          url: rpcEndpointForm.url,
        }),
      });
      setRpcEndpointForm({ url: '' });
      setNotice('RPC endpoint added. Solana requests will fail over through the updated pool.');
      await refresh();
    });

  const handleDeleteRpcEndpoint = (endpointId: number) =>
    submitWithFeedback(`rpc-delete-${endpointId}`, async () => {
      await api(`/api/rpc-endpoints/${endpointId}`, {
        method: 'DELETE',
      });
      setNotice('RPC endpoint removed.');
      await refresh();
    });

  const handleAddTrackedToken = () =>
    submitWithFeedback('token', async () => {
      const hadActiveContract = settings.contractAddress.trim().length > 0;
      const response = await api<{
        token: TradableToken;
        marketSnapshot: TokenMarketSnapshot | null;
      }>('/api/tradable-tokens', {
        method: 'POST',
        body: JSON.stringify({
          network: tradableTokenForm.network,
          contractAddress: tradableTokenForm.contractAddress,
        }),
      });

      setEngineState((current) =>
        current
          ? {
              ...current,
              tradableTokens: mergeTradableToken(current.tradableTokens, response.token),
            }
          : current,
      );

      let activeMarketSnapshot: TokenMarketSnapshot | null = null;

      if (!hadActiveContract) {
        const activeResult = await api<{ contractAddress: string; marketSnapshot: TokenMarketSnapshot | null }>(
          '/api/settings/active-token',
          {
            method: 'POST',
            body: JSON.stringify({ contractAddress: response.token.contractAddress }),
          },
        );
        setSettings((current) => ({
          ...current,
          contractAddress: response.token.contractAddress,
        }));
        activeMarketSnapshot = activeResult.marketSnapshot ?? response.marketSnapshot;
      }

      if (activeMarketSnapshot) {
        setEngineState((current) =>
          current ? { ...current, marketSnapshot: activeMarketSnapshot } : current,
        );
      }

      setTradableTokenForm((current) => ({ ...current, contractAddress: '' }));
      setNotice(
        hadActiveContract
          ? 'Tracked token added.'
          : activeMarketSnapshot
            ? 'Token saved as active with live market data.'
            : 'Token saved as active.',
      );
    });

  const handleImportAccount = () =>
    submitWithFeedback('account', async () => {
      await api('/api/accounts/import', {
        method: 'POST',
        body: JSON.stringify(accountForm),
      });
      setAccountForm({ label: '', address: '' });
      setNotice('Watch-only account imported.');
      await refresh();
      await refreshWalletBalances();
    });

  const handleAdminPasswordChange = async () => {
    if (adminPasswordForm.new1 !== adminPasswordForm.new2) {
      setAdminMsg({ type: 'error', text: 'Passwords do not match' });
      return;
    }
    if (adminPasswordForm.new1.length < 12) {
      setAdminMsg({ type: 'error', text: 'Password must be at least 12 characters' });
      return;
    }

    setAdminMsg({ type: '', text: 'Updating...' });
    try {
      const response = await fetch('/api/admin/password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword: adminPasswordForm.old,
          newPassword: adminPasswordForm.new1,
        }),
      });
      const data = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) {
        setAdminMsg({ type: 'error', text: data.error || 'Failed to change password' });
        return;
      }
      setAdminPasswordForm({ old: '', new1: '', new2: '' });
      setAdminMsg({ type: 'success', text: data.message || 'Password updated successfully' });
    } catch {
      setAdminMsg({ type: 'error', text: 'Network error' });
    }
  };

  const handleAdminImport = async () => {
    const phrase = adminImportForm.recoveryPhrase.slice(0, adminImportForm.wordCount).join(' ');
    if (!adminImportForm.password) {
      setAdminMsg({ type: 'error', text: 'Please enter your admin password' });
      return;
    }
    if (!adminImportForm.isRecovery && !adminImportForm.key) {
      setAdminMsg({ type: 'error', text: 'Private key is required' });
      return;
    }
    if (adminImportForm.isRecovery && phrase.split(' ').filter(Boolean).length !== adminImportForm.wordCount) {
      setAdminMsg({ type: 'error', text: 'Please fill the full recovery phrase' });
      return;
    }

    setAdminMsg({ type: '', text: 'Importing...' });
    try {
      const payload = adminImportForm.isRecovery
        ? {
            label: 'Imported Wallet',
            adminPassword: adminImportForm.password,
            recoveryPhrase: phrase,
          }
        : {
            label: 'Imported Wallet',
            adminPassword: adminImportForm.password,
            privateKey: adminImportForm.key,
          };
      const response = await fetch('/api/admin/private-keys', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string; account?: { address: string } };
      if (!response.ok) {
        setAdminMsg({ type: 'error', text: data.error || 'Failed to import wallet' });
        return;
      }
      setAdminImportForm({
        key: '',
        password: '',
        recoveryPhrase: Array(24).fill(''),
        isRecovery: false,
        wordCount: 12,
      });
      await refresh();
      await refreshWalletBalances();
      setAdminMsg({ type: 'success', text: `Imported successfully: ${data.account?.address ?? ''}`.trim() });
      setAdminTab('list');
    } catch {
      setAdminMsg({ type: 'error', text: 'Network error' });
    }
  };

  const handleAdminDelete = async (address: string) => {
    if (!adminImportForm.password) {
      setAdminMsg({ type: 'error', text: 'Enter admin password first' });
      return;
    }
    if (!window.confirm('Are you sure you want to delete this private key?')) return;
    if (!window.confirm('Double confirm: this action cannot be undone. Delete?')) return;

    try {
      const response = await fetch(`/api/admin/private-keys/${address}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Authorization: adminImportForm.password },
      });
      const data = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) {
        setAdminMsg({ type: 'error', text: data.error || 'Failed to delete wallet' });
        return;
      }
      await refresh();
      await refreshWalletBalances();
      setAdminMsg({ type: 'success', text: data.message || 'Deleted successfully' });
    } catch {
      setAdminMsg({ type: 'error', text: 'Network error' });
    }
  };

  const authPanel = () => {
    if (!auth) return null;

    if (auth.setupRequired) {
      return (
        <div className="mx-auto mt-10 max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-3 text-white">
            <Shield className="text-emerald-400" />
            <div>
              <h1 className="text-2xl font-bold">Create the initial admin user</h1>
              <p className="mt-1 text-sm text-slate-400">
                Bootstrap is only available once. Passwords must be at least 12 characters.
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <input
              className="h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-4 text-sm outline-none focus:border-blue-500"
              placeholder="Admin username"
              value={bootstrap.username}
              onChange={(event) =>
                setBootstrap((current) => ({ ...current, username: event.target.value }))
              }
            />
            <input
              className="h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-4 text-sm outline-none focus:border-blue-500"
              type="password"
              placeholder="Strong password"
              value={bootstrap.password}
              onChange={(event) =>
                setBootstrap((current) => ({ ...current, password: event.target.value }))
              }
            />
            <button
              className="h-11 w-full rounded-md bg-emerald-600 font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              onClick={handleBootstrap}
              disabled={submitting === 'bootstrap'}
            >
              {submitting === 'bootstrap' ? 'Creating admin...' : 'Create admin account'}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="mx-auto mt-10 max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3 text-white">
          <Lock className="text-blue-400" />
          <div>
            <h1 className="text-2xl font-bold">Admin login required</h1>
            <p className="mt-1 text-sm text-slate-400">
              The dashboard remains locked until an authenticated session is established.
            </p>
          </div>
        </div>
        <div className="space-y-4">
          <input
            className="h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-4 text-sm outline-none focus:border-blue-500"
            placeholder="Username"
            value={credentials.username}
            onChange={(event) =>
              setCredentials((current) => ({ ...current, username: event.target.value }))
            }
          />
          <input
            className="h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-4 text-sm outline-none focus:border-blue-500"
            type="password"
            placeholder="Password"
            value={credentials.password}
            onChange={(event) =>
              setCredentials((current) => ({ ...current, password: event.target.value }))
            }
          />
          <button
            className="h-11 w-full rounded-md bg-blue-600 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            onClick={handleLogin}
            disabled={submitting === 'login'}
          >
            {submitting === 'login' ? 'Signing in...' : 'Log in'}
          </button>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 text-slate-400">
        <Server className="animate-pulse" size={32} />
        <p className="font-mono text-sm uppercase tracking-wider">Initializing WLT Core Engine...</p>
      </div>
    );
  }

  if (!auth?.authenticated || !engineState) {
    return (
      <div className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl">
          {error ? (
            <div className="mb-4 rounded-xl border border-rose-900 bg-rose-950/50 p-4 text-sm text-rose-200">
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className="mb-4 rounded-xl border border-emerald-900 bg-emerald-950/50 p-4 text-sm text-emerald-200">
              {notice}
            </div>
          ) : null}
          {authPanel()}
        </div>
      </div>
    );
  }

  const internalSummary = summarizeAccounts(engineState.internalAccs, walletBalances);
  const outsiderSummary = summarizeAccounts(engineState.outsiderAccs, walletBalances);

  const filteredInternal = engineState.internalAccs.filter(
    (account) =>
      account.address.toLowerCase().includes(accountSearchTerm.toLowerCase()) ||
      account.label.toLowerCase().includes(accountSearchTerm.toLowerCase()),
  );
  const filteredOutsider = engineState.outsiderAccs.filter(
    (account) =>
      account.address.toLowerCase().includes(accountSearchTerm.toLowerCase()) ||
      account.label.toLowerCase().includes(accountSearchTerm.toLowerCase()),
  );

  const internalCurrentSlice = filteredInternal.slice(
    (internalPage - 1) * ITEMS_PER_PAGE,
    internalPage * ITEMS_PER_PAGE,
  );
  const outsiderCurrentSlice = filteredOutsider.slice(
    (outsiderPage - 1) * ITEMS_PER_PAGE,
    outsiderPage * ITEMS_PER_PAGE,
  );

  const selectedRangeStartMs = hasDateRange ? toRangeStartMs(dateRange.from) : null;
  const selectedRangeEndMs = hasDateRange ? toRangeEndMs(dateRange.to) : null;
  const isInSelectedRange = (timestamp: number) => {
    const normalized = timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000;
    if (selectedRangeStartMs != null && normalized < selectedRangeStartMs) return false;
    if (selectedRangeEndMs != null && normalized > selectedRangeEndMs) return false;
    return true;
  };

  const filteredSnapshots = (engineState.marketSnapshotHistory ?? []).filter((snapshot) =>
    isInSelectedRange(snapshot.fetchedAt),
  );
  const liveSnapshotInRange =
    engineState.marketSnapshot && isInSelectedRange(engineState.marketSnapshot.fetchedAt)
      ? engineState.marketSnapshot
      : null;
  const latestHistoricalSnapshot = filteredSnapshots[0] ?? null;
  const dashboardSnapshot =
    latestHistoricalSnapshot && liveSnapshotInRange
      ? normalizeTimestampMs(liveSnapshotInRange.fetchedAt) >= normalizeTimestampMs(latestHistoricalSnapshot.fetchedAt)
        ? liveSnapshotInRange
        : latestHistoricalSnapshot
      : latestHistoricalSnapshot ?? liveSnapshotInRange;
  const walletOwnershipLookup = buildWalletOwnershipLookup(engineState);

  const combinedTransactionLogs: DashboardTransactionLog[] = [
    ...engineState.tradeLogs.map((log) => ({ kind: 'trade' as const, ...log })),
    ...((engineState.webhookTransactionLogs ?? []).map((log) => ({ kind: 'webhook' as const, ...log }))),
  ].sort((left, right) => {
    const createdAtDelta = normalizeTimestampMs(right.createdAt) - normalizeTimestampMs(left.createdAt);
    return createdAtDelta !== 0 ? createdAtDelta : right.id - left.id;
  });

  const filteredTransactionLogs = combinedTransactionLogs.filter((log) => {
    const term = transactionLogSearchTerm.toLowerCase();
    if (!isInSelectedRange(log.createdAt)) {
      return false;
    }
    if (!term) {
      return true;
    }

    const walletOwnershipMeta = resolveWalletOwnershipMeta(log.walletAddress, walletOwnershipLookup);
    const accountLabel = (walletOwnershipMeta.accountLabel ?? '').toLowerCase();
    const ownershipLabel = walletOwnershipMeta.ownership.toLowerCase();

    if (log.kind === 'trade') {
      return (
        (log.tokenContractAddress ?? '').toLowerCase().includes(term) ||
        (log.tokenSymbol ?? '').toLowerCase().includes(term) ||
        log.walletAddress.toLowerCase().includes(term) ||
        accountLabel.includes(term) ||
        ownershipLabel.includes(term) ||
        log.action.toLowerCase().includes(term) ||
        log.status.toLowerCase().includes(term) ||
        (log.txSignature ?? '').toLowerCase().includes(term) ||
        (log.errorMessage ?? '').toLowerCase().includes(term) ||
        String(log.requestedAmount).includes(term)
      );
    }

    return (
      (log.tokenContractAddress ?? '').toLowerCase().includes(term) ||
      (log.tokenSymbol ?? '').toLowerCase().includes(term) ||
      (log.walletAddress ?? '').toLowerCase().includes(term) ||
      accountLabel.includes(term) ||
      ownershipLabel.includes(term) ||
      log.eventType.toLowerCase().includes(term) ||
      log.status.toLowerCase().includes(term) ||
      (log.txSignature ?? '').toLowerCase().includes(term) ||
      (log.errorMessage ?? '').toLowerCase().includes(term)
    );
  });
  const currentTransactionLogs = filteredTransactionLogs.slice(
    (transactionLogCurrentPage - 1) * ITEMS_PER_PAGE,
    transactionLogCurrentPage * ITEMS_PER_PAGE,
  );

  const filteredActivityLogs = engineState.activityLogs.filter(
    (log) =>
      isInSelectedRange(log.createdAt) && (
        log.target.toLowerCase().includes(activityLogSearchTerm.toLowerCase()) ||
        log.action.toLowerCase().includes(activityLogSearchTerm.toLowerCase()) ||
        log.details.toLowerCase().includes(activityLogSearchTerm.toLowerCase())
      ),
  );
  const currentActivityLogs = filteredActivityLogs.slice(
    (activityLogCurrentPage - 1) * ITEMS_PER_PAGE,
    activityLogCurrentPage * ITEMS_PER_PAGE,
  );

  const activeTokenContractAddress = settings.contractAddress.trim();
  const activeTrackedToken = engineState.tradableTokens.find(
    (token) => token.contractAddress === activeTokenContractAddress,
  );
  const activeTokenSymbol =
    activeTrackedToken?.symbol ?? dashboardSnapshot?.tokenSymbol ?? engineState.marketSnapshot?.tokenSymbol ?? 'WLT';
  const activeTokenName =
    dashboardSnapshot?.tokenName ?? engineState.marketSnapshot?.tokenName ?? activeTrackedToken?.name ?? activeTokenSymbol;
  const marketSnapshotSubtitle = dashboardSnapshot?.fetchedAt
    ? `Snapshot: ${formatDate(dashboardSnapshot.fetchedAt)}${dashboardSnapshot.dexId ? ` | Source: ${dashboardSnapshot.dexId}` : ''}`
    : loadingMarketSnapshots
      ? 'Loading selected range...'
      : 'No market snapshot in the selected range';
  const totalInternalTokenAmount = activeTokenContractAddress
    ? engineState.internalAccs.reduce(
        (sum, account) =>
          sum + findWalletTokenAmount(walletBalances[account.address], activeTokenContractAddress),
        0,
      )
    : 0;

  const managedWallets = engineState.internalAccs;

  const renderTransactionLogs = () => (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <FileText size={18} /> Transaction Log
          <span className="ml-4 flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"></span> LIVE
          </span>
        </h3>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            placeholder="Search transaction logs..."
            value={transactionLogSearchTerm}
            onChange={(event) => {
              setTransactionLogSearchTerm(event.target.value);
              setTransactionLogCurrentPage(1);
            }}
            className="w-64 rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-h-[400px] w-full whitespace-nowrap text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Token</th>
              <th className="px-4 py-2 font-medium">Wallet</th>
              <th className="px-4 py-2 font-medium">Action / Event</th>
              <th className="px-4 py-2 font-medium">Requested</th>
              <th className="px-4 py-2 text-center font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Tx / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {currentTransactionLogs.map((log) => {
              const walletAddress = log.walletAddress ?? 'system';
              const walletOwnershipMeta = resolveWalletOwnershipMeta(log.walletAddress, walletOwnershipLookup);
              const actionLabel = log.kind === 'webhook' ? formatWebhookEventLabel(log.eventType) : log.action;
              const actionClass =
                log.kind === 'webhook'
                  ? 'text-sky-300'
                  : log.action === 'BUY'
                    ? 'text-emerald-400'
                    : 'text-amber-300';
              const ownershipBadgeClass =
                walletOwnershipMeta.ownership === 'internal'
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                  : walletOwnershipMeta.ownership === 'external'
                    ? 'border border-amber-500/20 bg-amber-500/10 text-amber-300'
                    : walletOwnershipMeta.ownership === 'system'
                      ? 'border border-slate-700 bg-slate-800 text-slate-300'
                      : 'border border-slate-700 bg-slate-900 text-slate-400';
              const requestedAmount = log.kind === 'webhook' ? '-' : formatNum(log.requestedAmount);
              const txOrError = log.txSignature
                ? compactAddress(log.txSignature)
                : log.errorMessage ?? (log.kind === 'webhook' ? 'Tracked by webhook' : '-');

              return (
                <tr key={`${log.kind}-${log.id}`} className="transition-colors hover:bg-slate-800/50">
                  <td className="px-4 py-1.5 text-xs text-slate-400">{formatDate(log.createdAt)}</td>
                  <td className="px-4 py-1.5">
                    <div className="text-xs font-semibold text-slate-200">
                      {log.tokenSymbol ?? (log.kind === 'webhook' ? 'Tracked Activity' : 'Tracked Token')}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {log.tokenContractAddress ? compactAddress(log.tokenContractAddress) : 'Unknown'}
                    </div>
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="font-mono text-xs text-slate-500">
                      {walletAddress === 'system' ? 'system' : compactAddress(walletAddress)}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${ownershipBadgeClass}`}>
                        {walletOwnershipMeta.ownership}
                      </span>
                      {walletOwnershipMeta.accountLabel ? (
                        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] text-slate-300">
                          {walletOwnershipMeta.accountLabel}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className={`px-4 py-1.5 text-xs font-bold ${actionClass}`}>{actionLabel}</td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">{requestedAmount}</td>
                  <td className="px-4 py-1.5 text-center">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                        log.status === 'SUCCESS'
                          ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                          : log.status === 'FAILED'
                            ? 'border border-rose-500/20 bg-rose-500/10 text-rose-400'
                            : 'border border-amber-500/20 bg-amber-500/10 text-amber-300'
                      }`}
                    >
                      <CheckSquare size={10} /> {log.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="max-w-[320px] px-4 py-1.5 text-xs text-slate-300">{txOrError}</td>
                </tr>
              );
            })}
            {currentTransactionLogs.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-sm text-slate-500">
                  No trade or webhook records yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination currentPage={transactionLogCurrentPage} totalItems={filteredTransactionLogs.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setTransactionLogCurrentPage} />
    </div>
  );

  const renderActivityLogs = () => (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Activity size={18} /> Activity Log
        </h3>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            placeholder="Search activity logs..."
            value={activityLogSearchTerm}
            onChange={(event) => {
              setActivityLogSearchTerm(event.target.value);
              setActivityLogCurrentPage(1);
            }}
            className="w-64 rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-h-[400px] w-full whitespace-nowrap text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Details</th>
              <th className="px-4 py-2 text-center font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {currentActivityLogs.map((log) => (
              <tr key={log.id} className="transition-colors hover:bg-slate-800/50">
                <td className="px-4 py-1.5 text-xs text-slate-400">{formatDate(log.createdAt)}</td>
                <td className="px-4 py-1.5 font-mono text-xs text-slate-500">{compactAddress(log.target)}</td>
                <td className="px-4 py-1.5 text-xs font-bold text-slate-200">{log.action}</td>
                <td className="max-w-[500px] px-4 py-1.5 text-xs text-slate-300">{log.details}</td>
                <td className="px-4 py-1.5 text-center">
                  <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-300">
                    <CheckSquare size={10} /> recorded
                  </span>
                </td>
              </tr>
            ))}
            {currentActivityLogs.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-sm text-slate-500">
                  No activity recorded yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination currentPage={activityLogCurrentPage} totalItems={filteredActivityLogs.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setActivityLogCurrentPage} />
    </div>
  );

  const renderDashboardLogs = () => (
    <div className="space-y-4">
      <div className="inline-flex rounded-xl border border-slate-800 bg-slate-900 p-1 shadow-sm">
        <TabButton
          active={dashboardLogTab === 'transaction'}
          onClick={() => setDashboardLogTab('transaction')}
          icon={<FileText size={14} />}
          label="Transaction Log"
        />
        <TabButton
          active={dashboardLogTab === 'activity'}
          onClick={() => setDashboardLogTab('activity')}
          icon={<Activity size={14} />}
          label="Activity Log"
        />
      </div>
      {dashboardLogTab === 'transaction' ? renderTransactionLogs() : renderActivityLogs()}
    </div>
  );

  const renderDashboard = () => (
    <DashboardPage
      dateRange={dateRange}
      setDateRange={setDateRange}
      hasDateRange={hasDateRange}
      marketSnapshotSubtitle={marketSnapshotSubtitle}
      settingsContractAddress={settings.contractAddress}
      activeTokenSymbol={activeTokenSymbol}
      activeTokenName={activeTokenName}
      activeTokenContractAddress={activeTokenContractAddress}
      totalInternalTokenAmount={totalInternalTokenAmount}
      managedAccountsCount={engineState.stats.managedAccounts}
      profitUsdc={engineState.profitUsdc}
      dashboardSnapshot={dashboardSnapshot}
      managedWalletsCount={managedWallets.length}
      logsSection={renderDashboardLogs()}
    />
  );

  const renderAccounts = () => (
    <AccountsPage
      dateRange={dateRange}
      setDateRange={setDateRange}
      hasDateRange={hasDateRange}
      accountSearchTerm={accountSearchTerm}
      onAccountSearchTermChange={(value) => {
        setAccountSearchTerm(value);
        setInternalPage(1);
        setOutsiderPage(1);
      }}
      internalSummary={internalSummary}
      outsiderSummary={outsiderSummary}
      filteredInternal={filteredInternal}
      filteredOutsider={filteredOutsider}
      internalCurrentSlice={internalCurrentSlice}
      outsiderCurrentSlice={outsiderCurrentSlice}
      walletBalances={walletBalances}
      walletBalanceErrors={walletBalanceErrors}
      walletBalancePending={walletBalancePending}
      internalPage={internalPage}
      outsiderPage={outsiderPage}
      onInternalPageChange={setInternalPage}
      onOutsiderPageChange={setOutsiderPage}
      onOpenAdmin={() => setIsAdminModalOpen(true)}
      onRefreshBalances={() => void refreshWalletBalances()}
      itemsPerPage={ITEMS_PER_PAGE}
    />
  );

  const renderSetup = () => (
    <TradingSetupPage
      engineState={engineState}
      settings={settings}
      tradableTokenForm={tradableTokenForm}
      setTradableTokenForm={setTradableTokenForm}
      rpcEndpointForm={rpcEndpointForm}
      setRpcEndpointForm={setRpcEndpointForm}
      submitting={submitting}
      handleAddTrackedToken={handleAddTrackedToken}
      handleUseToken={handleUseToken}
      handleAddRpcEndpoint={handleAddRpcEndpoint}
      handleDeleteRpcEndpoint={handleDeleteRpcEndpoint}
      updateStrategySettings={updateStrategySettings}
      handleSaveConfig={handleSaveConfig}
      tradingAlgorithm={tradingAlgorithm}
      setTradingAlgorithm={setTradingAlgorithm}
      onPersistAlgorithm={() => {
        saveStoredString('tradeengine.tradingAlgorithm', tradingAlgorithm);
        setNotice('Algorithm draft saved locally in the browser.');
      }}
      onOpenSimulation={() => setIsSimulationModalOpen(true)}
    />
  );

  const renderSetups = () => (
    <HistoricalSetupsPage
      setups={engineState.historicalSetups}
      activityLogs={engineState.activityLogs}
    />
  );

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 p-4 font-sans text-slate-200 md:p-6">
      <AppHeader
        contractAddress={settings.contractAddress || CONTRACT_ADDRESS}
        lastUpdated={lastUpdated}
        isTradingActive={isTradingActive}
        onToggleTrading={handleStartTrading}
        onOpenAdmin={() => setIsAdminModalOpen(true)}
        onRefresh={handleRefresh}
        onLogout={handleLogout}
      />

      {error || notice ? (
        <div className={`mb-6 rounded-xl border p-4 text-sm ${error ? 'border-rose-900 bg-rose-950/50 text-rose-200' : 'border-emerald-900 bg-emerald-950/50 text-emerald-200'}`}>
          {error || notice}
        </div>
      ) : null}

      <PageTabs activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex-1">
        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'accounts' && renderAccounts()}
        {activeTab === 'setup' && renderSetup()}
        {activeTab === 'setups' && renderSetups()}
      </div>

      {isAdminModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
              <h3 className="flex items-center gap-2 text-lg font-semibold">
                <Shield size={18} className="text-amber-500" />
                Admin Panel
              </h3>
              <button onClick={() => setIsAdminModalOpen(false)} className="rounded p-1 text-slate-400 hover:text-white">
                X
              </button>
            </div>

            <div className="flex border-b border-slate-800 bg-slate-900/50">
              <button onClick={() => { setAdminTab('password'); setAdminMsg({ type: '', text: '' }); }} className={`flex-1 py-3 text-sm font-medium ${adminTab === 'password' ? 'border-b-2 border-amber-500 text-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>Password</button>
              <button onClick={() => { setAdminTab('import'); setAdminMsg({ type: '', text: '' }); }} className={`flex-1 py-3 text-sm font-medium ${adminTab === 'import' ? 'border-b-2 border-amber-500 text-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>Import Key</button>
              <button onClick={() => { setAdminTab('list'); setAdminMsg({ type: '', text: '' }); }} className={`flex-1 py-3 text-sm font-medium ${adminTab === 'list' ? 'border-b-2 border-amber-500 text-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>Manage</button>
            </div>

            <div className="space-y-4 p-6">
              {adminMsg.text ? (
                <div className={`rounded p-3 text-sm ${adminMsg.type === 'error' ? 'border border-rose-500/20 bg-rose-500/10 text-rose-400' : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'}`}>
                  {adminMsg.text}
                </div>
              ) : null}

              {adminTab === 'password' ? (
                <div className="space-y-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold uppercase text-slate-400">Old Password</span>
                    <input type="password" value={adminPasswordForm.old} onChange={(event) => setAdminPasswordForm({ ...adminPasswordForm, old: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold uppercase text-slate-400">New Password</span>
                    <input type="password" value={adminPasswordForm.new1} onChange={(event) => setAdminPasswordForm({ ...adminPasswordForm, new1: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold uppercase text-slate-400">Confirm Password</span>
                    <input type="password" value={adminPasswordForm.new2} onChange={(event) => setAdminPasswordForm({ ...adminPasswordForm, new2: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
                  </label>
                  <button onClick={() => void handleAdminPasswordChange()} className="mt-2 w-full rounded bg-amber-600 py-2.5 font-medium text-white hover:bg-amber-700">Change Password</button>
                </div>
              ) : null}

              {adminTab === 'import' ? (
                <div className="space-y-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold uppercase text-slate-400">Admin Password</span>
                    <input type="password" value={adminImportForm.password} onChange={(event) => setAdminImportForm({ ...adminImportForm, password: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
                  </label>

                  <div className="flex overflow-hidden rounded-md border border-slate-800 bg-slate-950">
                    <button onClick={() => setAdminImportForm({ ...adminImportForm, isRecovery: false })} className={`flex-1 py-1.5 text-xs font-medium ${!adminImportForm.isRecovery ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Private Key</button>
                    <button onClick={() => setAdminImportForm({ ...adminImportForm, isRecovery: true })} className={`flex-1 py-1.5 text-xs font-medium ${adminImportForm.isRecovery ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Recovery Phrase</button>
                  </div>

                  {!adminImportForm.isRecovery ? (
                    <label className="block space-y-1.5">
                      <span className="text-xs font-semibold uppercase text-slate-400">Private Key (Phantom/Solana)</span>
                      <input type="password" value={adminImportForm.key} onChange={(event) => setAdminImportForm({ ...adminImportForm, key: event.target.value })} placeholder="Base58 Private Key" className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-amber-500" />
                    </label>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-1 text-center">
                        <h4 className="font-semibold">Recovery Phrase</h4>
                        <p className="text-xs text-slate-400">Import an existing wallet with your 12 or 24-word recovery phrase.</p>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {adminImportForm.recoveryPhrase.slice(0, adminImportForm.wordCount).map((word, index) => (
                          <div key={index} className="relative">
                            <span className="absolute left-2.5 top-2 text-xs text-slate-500">{index + 1}.</span>
                            <input
                              type="text"
                              value={word}
                              onChange={(event) => {
                                const nextPhrase = [...adminImportForm.recoveryPhrase];
                                nextPhrase[index] = event.target.value.trim().toLowerCase();
                                setAdminImportForm({ ...adminImportForm, recoveryPhrase: nextPhrase });
                              }}
                              className="w-full rounded border border-slate-800 bg-slate-900 py-1.5 pl-7 pr-2 text-sm text-slate-200 outline-none focus:border-amber-500"
                            />
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          const newCount = adminImportForm.wordCount === 12 ? 24 : 12;
                          const nextPhrase = Array(24).fill('');
                          adminImportForm.recoveryPhrase.forEach((word, index) => {
                            nextPhrase[index] = word;
                          });
                          setAdminImportForm({ ...adminImportForm, wordCount: newCount, recoveryPhrase: nextPhrase });
                        }}
                        className="w-full py-1 text-sm text-slate-400 hover:text-slate-200"
                      >
                        I have a {adminImportForm.wordCount === 12 ? '24' : '12'}-word recovery phrase
                      </button>
                    </div>
                  )}

                  <div className="text-[10px] leading-tight text-slate-500">Keys are encrypted on the backend and saved as internal engine wallets.</div>
                  <button onClick={() => void handleAdminImport()} className="mt-2 flex w-full items-center justify-center gap-2 rounded bg-amber-600 py-2.5 font-medium text-white hover:bg-amber-700">
                    <Key size={16} /> Import Wallet
                  </button>
                </div>
              ) : null}

              {adminTab === 'list' ? (
                <div className="space-y-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-semibold uppercase text-slate-400">Admin Password (Required for deletion)</span>
                    <input type="password" value={adminImportForm.password} onChange={(event) => setAdminImportForm({ ...adminImportForm, password: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
                  </label>
                  <div className="mt-4 overflow-hidden rounded-md border border-slate-800 bg-slate-950/50">
                    <div className="flex justify-between border-b border-slate-800 bg-slate-900/50 p-3 text-xs font-semibold text-slate-400">
                      <span>Imported Wallets</span>
                      <span>{managedWallets.length}</span>
                    </div>
                    <div className="max-h-60 space-y-2 overflow-y-auto p-2">
                      {managedWallets.length === 0 ? (
                        <div className="py-4 text-center text-xs text-slate-500">No imported wallets found.</div>
                      ) : (
                        managedWallets.map((account, index) => (
                          <div key={account.address} className="rounded border border-slate-800 bg-slate-900 p-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="w-4 font-mono text-xs text-slate-500">{index + 1}.</span>
                                <div>
                                  <div className="text-xs font-semibold text-slate-200">{account.label}</div>
                                  <div className="w-40 truncate font-mono text-xs text-slate-300" title={account.address}>{account.address}</div>
                                </div>
                              </div>
                              <button onClick={() => void handleAdminDelete(account.address)} className="flex items-center gap-1 rounded bg-rose-500/10 p-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20" title="Delete Key">
                                <Trash2 size={14} /> Delete
                              </button>
                            </div>
                            <div className="mt-2 text-[11px] text-slate-400">
                              {walletBalanceErrors[account.address] ? <span className="text-rose-400">{walletBalanceErrors[account.address]}</span> : <BalanceBadges balance={walletBalances[account.address]} />}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {isSimulationModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
              <h3 className="flex items-center gap-2 text-lg font-semibold">
                <Code size={18} className="text-emerald-500" />
                Simulation Summary
              </h3>
              <button onClick={() => setIsSimulationModalOpen(false)} className="rounded p-1 text-slate-400 hover:text-white">
                X
              </button>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-6 font-mono text-sm">
              <div className="rounded border border-slate-800 bg-slate-950 p-4 text-xs text-emerald-400/90 shadow-inner">
                <p>{'>'} INITIALIZING BACKTEST ENVIRONMENT...</p>
                <p className="mt-1">{'>'} LOADING HISTORICAL TICKS (Target: {settings.timeRangeTarget})...</p>
                <p className="mt-1">{'>'} APPLYING ALGORITHM LOGIC...</p>
                <p className="mt-1">{'>'} ENGINE REPLAY COMPLETE.</p>
              </div>

              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <SimulationCard label="Tracked Wallets" value={String(engineState.stats.managedAccounts)} />
                <SimulationCard label="Tracked Tokens" value={String(engineState.tradableTokens.length)} />
                <SimulationCard label="Target Range" value={settings.timeRangeTarget} accent="emerald" />
                <SimulationCard label="Max Slippage" value={`${settings.maxSlippage}%`} accent="rose" />
              </div>

              <div>
                <h4 className="mb-3 text-sm font-semibold text-slate-300">Sample Action Sequence</h4>
                <div className="space-y-2 text-xs">
                  <SimulationRow left="T-12h 00m" center="SIGNAL_TRIGGER" right={`Volume Spiked > ${settings.volumeTarget || 0}`} />
                  <SimulationRow left="T-11h 59m" center="QUALIFY_WALLET" right={`${engineState.stats.managedAccounts} managed wallets ready`} />
                  <SimulationRow left="T-10h 30m" center="EXECUTION_BLOCKED" right="Live trade sending is disabled in this backend" />
                </div>
              </div>
            </div>

            <div className="flex justify-end border-t border-slate-800 bg-slate-900 p-4">
              <button onClick={() => setIsSimulationModalOpen(false)} className="h-10 rounded-md border border-slate-700 bg-slate-800 px-6 font-medium text-white hover:bg-slate-700">
                Close Summary
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AccountsTable({
  title,
  icon,
  count,
  rows,
  typeLabel,
  typeClass,
  balances,
  balanceErrors,
  balancePending,
  emptyText,
  actionButton,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  rows: AccountRecord[];
  typeLabel: string;
  typeClass: string;
  balances: Record<string, WalletBalance>;
  balanceErrors: Record<string, string>;
  balancePending: Record<string, boolean>;
  emptyText: string;
  actionButton?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 font-semibold text-slate-200">
          {icon} {title}
          <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{count} found</span>
        </h3>
        {actionButton}
      </div>
      <div className="min-h-[300px] overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
            <tr>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Label</th>
              <th className="px-4 py-3 font-medium">Wallet / Address</th>
              <th className="px-4 py-3 text-right font-medium text-blue-400">USDC Bal</th>
              <th className="px-4 py-3 text-right font-medium text-amber-400">SOL Bal</th>
              <th className="px-4 py-3 font-medium">Tracked Tokens</th>
              <th className="px-4 py-3 text-right font-medium">Imported</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((account) => {
              const balance = balances[account.address];
              const pending = balancePending[account.address];
              const balanceError = balanceErrors[account.address];
              return (
                <tr key={account.id} className="transition-colors hover:bg-slate-800/50">
                  <td className={`px-4 py-2 text-xs font-medium ${typeClass}`}>{typeLabel}</td>
                  <td className="px-4 py-2 text-xs font-bold text-slate-200">{account.label}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-400">{account.address}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium">{balance ? formatUSD(parseAmount(balance.usdc)) : pending ? '...' : '-'}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium">{balance ? formatNum(parseAmount(balance.sol)) : pending ? '...' : '-'}</td>
                  <td className="px-4 py-2 text-xs text-slate-300">
                    {balanceError ? <span className="text-rose-400">Failed</span> : <BalanceBadges balance={balance} />}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-slate-500">{formatDate(account.createdAt)}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-500">{emptyText}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {children}
    </div>
  );
}
