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
  logs: AuditLog[];
  tradableTokens: TradableToken[];
  historicalSetups: HistoricalSetup[];
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

const CONTRACT_ADDRESS = '';
const ITEMS_PER_PAGE = 20;
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
  return new Date(timestamp * 1000).toLocaleString();
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

function loadStoredList(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function saveStoredList(key: string, values: string[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(values));
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
            <CheckSquare size={14} className="mr-1.5" /> Difference metrics active
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

function ComboInput({
  value,
  onChange,
  onSave,
  onDelete,
  savedItems,
  placeholder,
  labelText,
  statusText,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onDelete: (item: string) => void;
  savedItems: string[];
  placeholder: string;
  labelText?: string;
  statusText?: string;
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={containerRef}>
      {labelText ? (
        <label className="mb-1.5 flex justify-between text-xs font-medium uppercase tracking-wider text-slate-400">
          {labelText}
          {statusText ? (
            <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] normal-case text-blue-400">
              {statusText}
            </span>
          ) : null}
        </label>
      ) : null}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            placeholder={placeholder}
            className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-slate-300 outline-none focus:border-blue-500"
          />
          {isOpen && savedItems.length > 0 ? (
            <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-slate-700 bg-slate-900 shadow-lg">
              {savedItems.map((item) => (
                <li
                  key={item}
                  className="group flex cursor-pointer items-center justify-between px-3 py-2 text-sm font-mono text-slate-300 hover:bg-slate-800"
                >
                  <span
                    className="flex-1 overflow-hidden text-ellipsis"
                    onClick={() => {
                      onChange(item);
                      setIsOpen(false);
                    }}
                  >
                    {item}
                  </span>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(item);
                    }}
                    className="p-1 text-slate-500 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          onClick={onSave}
          className="cursor-pointer whitespace-nowrap rounded-md border border-blue-500/30 bg-blue-600/20 px-4 text-sm font-medium text-blue-400 hover:bg-blue-600/30"
        >
          Save
        </button>
      </div>
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

  const [activeTab, setActiveTab] = React.useState<TabId>('dashboard');
  const [dateRange, setDateRange] = React.useState<DateRangeState>({ from: '', to: '' });
  const [accountSearchTerm, setAccountSearchTerm] = React.useState('');
  const [internalPage, setInternalPage] = React.useState(1);
  const [outsiderPage, setOutsiderPage] = React.useState(1);
  const [logSearchTerm, setLogSearchTerm] = React.useState('');
  const [logCurrentPage, setLogCurrentPage] = React.useState(1);

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
  const [tradableTokenForm, setTradableTokenForm] = React.useState({ contractAddress: '' });
  const [accountForm, setAccountForm] = React.useState({ label: '', address: '' });

  const [savedContractAddresses, setSavedContractAddresses] = React.useState<string[]>([]);
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

  const hasDateRange = dateRange.from !== '' && dateRange.to !== '';

  useEffect(() => {
    setSavedContractAddresses(loadStoredList('tradeengine.savedContractAddresses'));
    setTradingAlgorithm(loadStoredString('tradeengine.tradingAlgorithm', workerAlgorithmTemplate));
  }, []);

  const loadAuth = React.useCallback(async () => {
    const status = await api<AuthStatus>('/api/auth/status');
    setAuth(status);
    return status;
  }, []);

  const loadState = React.useCallback(async () => {
    const state = await api<EngineState>('/api/state');
    setEngineState(state);
    setSettings(state.settings);
    setLastUpdated(new Date().toLocaleString());
    return state;
  }, []);

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

  useEffect(() => {
    if (!auth?.authenticated) return;
    const interval = window.setInterval(() => {
      void loadState();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [auth?.authenticated, loadState]);

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

  const saveContractAddress = () => {
    const value = settings.contractAddress.trim();
    if (!value) return;
    const next = [value, ...savedContractAddresses.filter((item) => item !== value)].slice(0, 12);
    setSavedContractAddresses(next);
    saveStoredList('tradeengine.savedContractAddresses', next);
    setNotice('Saved contract address shortcut.');
  };

  const deleteSavedContractAddress = (value: string) => {
    const next = savedContractAddresses.filter((item) => item !== value);
    setSavedContractAddresses(next);
    saveStoredList('tradeengine.savedContractAddresses', next);
  };

  const handleBootstrap = () =>
    submitWithFeedback('bootstrap', async () => {
      await api('/api/auth/bootstrap', {
        method: 'POST',
        body: JSON.stringify(bootstrap),
      });
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
      setCredentials({ username: '', password: '' });
      setNotice('Login successful.');
      await refresh();
    });

  const handleLogout = () =>
    submitWithFeedback('logout', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      setEngineState(null);
      setWalletBalances({});
      setNotice('Logged out.');
      await refresh();
    });

  const handleRefresh = () => {
    void refresh();
  };

  const handleStartTrading = () => {
    setNotice('Trade execution is intentionally disabled in the current backend release.');
  };

  const handleSaveConfig = () =>
    submitWithFeedback('settings', async () => {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          contractAddress: settings.contractAddress,
          volatilityTarget: Number(settings.volatilityTarget),
          pullbackTarget: Number(settings.pullbackTarget),
          volumeTarget: Number(settings.volumeTarget),
          netBuyinTarget: Number(settings.netBuyinTarget),
          timeRangeTarget: settings.timeRangeTarget,
          maxTransactions: Number(settings.maxTransactions),
          maxSlippage: Number(settings.maxSlippage),
          strategyNotes: settings.strategyNotes,
        }),
      });
      setNotice('Configuration saved and historical snapshot created.');
      await refresh();
    });

  const handleAddTrackedToken = () =>
    submitWithFeedback('token', async () => {
      await api('/api/tradable-tokens', {
        method: 'POST',
        body: JSON.stringify({
          network: 'solana',
          contractAddress: tradableTokenForm.contractAddress,
        }),
      });
      setTradableTokenForm({ contractAddress: '' });
      setNotice('Tracked token added successfully.');
      await refresh();
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

  const filteredLogs = engineState.logs.filter(
    (log) =>
      log.target.toLowerCase().includes(logSearchTerm.toLowerCase()) ||
      log.action.toLowerCase().includes(logSearchTerm.toLowerCase()) ||
      log.details.toLowerCase().includes(logSearchTerm.toLowerCase()),
  );
  const currentLogs = filteredLogs.slice(
    (logCurrentPage - 1) * ITEMS_PER_PAGE,
    logCurrentPage * ITEMS_PER_PAGE,
  );

  const managedWallets = engineState.internalAccs;

  const renderLogs = () => (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <FileText size={18} /> Live Transaction Log
          <span className="ml-4 flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"></span> LIVE
          </span>
        </h3>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            placeholder="Search logs..."
            value={logSearchTerm}
            onChange={(event) => {
              setLogSearchTerm(event.target.value);
              setLogCurrentPage(1);
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
            {currentLogs.map((log) => (
              <tr key={log.id} className="transition-colors hover:bg-slate-800/50">
                <td className="px-4 py-1.5 text-xs text-slate-400">{formatDate(log.createdAt)}</td>
                <td className="px-4 py-1.5 font-mono text-xs text-slate-500">{compactAddress(log.target)}</td>
                <td className="px-4 py-1.5 text-xs font-bold text-slate-200">{log.action}</td>
                <td className="max-w-[500px] px-4 py-1.5 text-xs text-slate-300">{log.details}</td>
                <td className="px-4 py-1.5 text-center">
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                    <CheckSquare size={10} /> recorded
                  </span>
                </td>
              </tr>
            ))}
            {currentLogs.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-sm text-slate-500">
                  No activity recorded yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination currentPage={logCurrentPage} totalItems={filteredLogs.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setLogCurrentPage} />
    </div>
  );

  const renderDashboard = () => (
    <div className="space-y-6">
      <DateRangePicker dateRange={dateRange} setDateRange={setDateRange} hasDateRange={hasDateRange} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <StatCard title="Contract Address" value={settings.contractAddress || CONTRACT_ADDRESS || 'Not Configured'} isAddress />
        <StatCard title="Managed Wallets" value={String(engineState.stats.managedAccounts)} />
        <StatCard title="Watch Accounts" value={String(engineState.stats.watchedAccounts)} />
        <StatCard title="Tracked Tokens" value={String(engineState.tradableTokens.length)} />
        <StatCard title="Historical Setups" value={String(engineState.historicalSetups.length)} />
        <StatCard title="Database State" value={engineState.system.databaseConnected ? 'Connected' : 'Offline'} subtitle={engineState.system.databasePath} />
        <StatCard title="Primary Time Range" value={settings.timeRangeTarget} />
        <StatCard title="Tracked Contract" value={settings.contractAddress ? compactAddress(settings.contractAddress) : 'None'} copyable />
      </div>

      <div className="mt-8">{renderLogs()}</div>
    </div>
  );

  const renderAccounts = () => (
    <div className="space-y-6">
      <DateRangePicker dateRange={dateRange} setDateRange={setDateRange} hasDateRange={hasDateRange}>
        <div className="flex w-full flex-col gap-1.5 md:w-[400px]">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Global Address Search
          </label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-500" />
            <input
              type="text"
              placeholder="Search by wallet address or label across all accounts..."
              value={accountSearchTerm}
              onChange={(event) => {
                setAccountSearchTerm(event.target.value);
                setInternalPage(1);
                setOutsiderPage(1);
              }}
              className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 pl-9 pr-3 text-sm outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </DateRangePicker>

      <SummaryBlock title="Internal Account Summary" icon={<Wallet size={16} className="text-blue-400" />} data={internalSummary} />
      <SummaryBlock title="Outsider Account Summary" icon={<Users size={16} className="text-amber-400" />} data={outsiderSummary} />

      <AccountsTable
        title="Internal Account List"
        icon={<Wallet size={16} className="text-blue-400" />}
        count={filteredInternal.length}
        rows={internalCurrentSlice}
        typeLabel="Managed"
        typeClass="text-emerald-400"
        balances={walletBalances}
        balanceErrors={walletBalanceErrors}
        balancePending={walletBalancePending}
        emptyText="No internal accounts found."
        actionButton={
          <button
            onClick={() => setIsAdminModalOpen(true)}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm text-white hover:bg-slate-700"
          >
            <Shield size={14} className="text-amber-500" /> Admin
          </button>
        }
      >
        <Pagination currentPage={internalPage} totalItems={filteredInternal.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setInternalPage} />
      </AccountsTable>

      <AccountsTable
        title="Outsider Account List"
        icon={<Users size={16} className="text-amber-400" />}
        count={filteredOutsider.length}
        rows={outsiderCurrentSlice}
        typeLabel="Watch"
        typeClass="text-amber-400"
        balances={walletBalances}
        balanceErrors={walletBalanceErrors}
        balancePending={walletBalancePending}
        emptyText="No outsider accounts found."
        actionButton={
          <button
            onClick={() => void refreshWalletBalances()}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm text-white hover:bg-slate-700"
          >
            <RefreshCw size={14} /> Refresh Balances
          </button>
        }
      >
        <Pagination currentPage={outsiderPage} totalItems={filteredOutsider.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setOutsiderPage} />
      </AccountsTable>
    </div>
  );

  const renderSetup = () => (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div className="h-fit space-y-5 rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm">
        <h3 className="flex items-center gap-2 border-b border-slate-800 pb-4 text-lg font-semibold">
          <Settings size={18} /> Trading Parameters
        </h3>

        <div className="space-y-4">
          <ComboInput
            value={settings.contractAddress}
            onChange={(value) => setSettings((current) => ({ ...current, contractAddress: value }))}
            onSave={saveContractAddress}
            onDelete={deleteSavedContractAddress}
            savedItems={savedContractAddresses}
            placeholder="Primary trading contract address"
            labelText="Trading Contract Address"
            statusText={`${engineState.tradableTokens.length} tracked token(s)`}
          />

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
              Solana RPC Network
            </label>
            <div className="flex h-10 items-center rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm text-blue-400">
              Mainnet RPC Pool Active
            </div>
          </div>

          <SettingInput
            label="Time Range Target"
            sublabel="Target Pre-Condition"
            value={settings.timeRangeTarget}
            onChange={(value) => setSettings((current) => ({ ...current, timeRangeTarget: value }))}
            options={[
              { label: '1 Hour', value: '1h' },
              { label: '6 Hours', value: '6h' },
              { label: '12 Hours', value: '12h' },
              { label: '24 Hours', value: '24h' },
              { label: '3 Days', value: '3d' },
              { label: '1 Week', value: '1w' },
            ]}
          />

          <div className="grid grid-cols-2 gap-4">
            <SettingInput label="Max Transactions" sublabel="Time Range Limit" value={settings.maxTransactions} onChange={(value) => setSettings((current) => ({ ...current, maxTransactions: Number(value) }))} />
            <SettingInput label="Max Slippage" sublabel="Min 0.0001" value={settings.maxSlippage} onChange={(value) => setSettings((current) => ({ ...current, maxSlippage: Number(value) }))} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <SettingInput label="Volume Target (USDC)" value={settings.volumeTarget} onChange={(value) => setSettings((current) => ({ ...current, volumeTarget: Number(value) }))} />
            <SettingInput label="Net Buyin Target" sublabel="Negative = Sell" value={settings.netBuyinTarget} onChange={(value) => setSettings((current) => ({ ...current, netBuyinTarget: Number(value) }))} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <SettingInput label="Volatility Target (%)" value={settings.volatilityTarget} onChange={(value) => setSettings((current) => ({ ...current, volatilityTarget: Number(value) }))} />
            <SettingInput label="Outsider Pull Back (%)" value={settings.pullbackTarget} onChange={(value) => setSettings((current) => ({ ...current, pullbackTarget: Number(value) }))} />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
              Strategy Notes
            </label>
            <textarea
              value={settings.strategyNotes}
              onChange={(event) => setSettings((current) => ({ ...current, strategyNotes: event.target.value }))}
              className="min-h-28 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
              Add Tracked Token (Network + Contract Address)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={tradableTokenForm.contractAddress}
                onChange={(event) => setTradableTokenForm({ contractAddress: event.target.value })}
                placeholder="Token mint address"
                className="h-10 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm outline-none focus:border-blue-500"
              />
              <button
                onClick={handleAddTrackedToken}
                disabled={submitting === 'token'}
                className="flex h-10 items-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <button
            onClick={handleSaveConfig}
            disabled={submitting === 'settings'}
            className="h-11 w-full cursor-pointer rounded-md border border-blue-500 bg-blue-600 font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting === 'settings' ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </div>

      <div className="flex min-h-[500px] flex-col rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm">
        <h3 className="flex items-center gap-2 border-b border-slate-800 pb-4 text-lg font-semibold">
          <Code size={18} /> Trading Algorithm (Cloudflare + Helius)
        </h3>
        <textarea
          className="mt-4 flex-1 resize-none rounded-md border border-slate-700 bg-slate-950 p-4 font-mono text-[13px] leading-relaxed text-emerald-400 outline-none focus:border-blue-500"
          value={tradingAlgorithm}
          onChange={(event) => setTradingAlgorithm(event.target.value)}
          placeholder="// Write your trading algorithm logic here"
        ></textarea>
        <div className="mt-4 flex gap-3 border-t border-slate-800 pt-4">
          <button
            onClick={() => {
              saveStoredString('tradeengine.tradingAlgorithm', tradingAlgorithm);
              setNotice('Algorithm draft saved locally in the browser.');
            }}
            className="h-10 flex-1 cursor-pointer rounded-md bg-emerald-600 font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            Update
          </button>
          <button
            onClick={() => setIsSimulationModalOpen(true)}
            className="h-10 flex-1 cursor-pointer rounded-md border border-slate-700 bg-slate-800 font-medium text-white shadow-sm hover:bg-slate-700"
          >
            Simulation Summary
          </button>
        </div>
      </div>
    </div>
  );

  const renderSetups = () => {
    const setups = engineState.historicalSetups;

    if (setups.length === 0) {
      return (
        <div className="flex flex-col items-center rounded-xl border border-slate-800 bg-slate-900 p-10 text-center text-slate-500 shadow-sm">
          <Archive size={40} className="mb-4 opacity-50" />
          <p className="text-lg font-medium text-slate-400">No Historical Setups Found</p>
          <p className="mx-auto mt-2 max-w-[400px] text-sm">
            Save a configuration from the Trading Setup tab to start tracking historical changes.
          </p>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-4 space-y-6">
        {setups.map((setup, index) => {
          const setupLogs = getLogsForSetup(setups, engineState.logs, index);
          return (
            <div key={setup.id} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-800 bg-slate-800/50 p-4">
                <div>
                  <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-200">
                    <Archive size={16} className="text-emerald-500" />
                    Configuration Setup {index === 0 ? '(Active)' : `(${setups.length - index})`}
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">Deployed {formatDate(setup.createdAt)}</p>
                </div>
                <div className="text-right">
                  <span className="block text-sm font-medium text-slate-300">{setupLogs.length} Events</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-b border-slate-800 bg-slate-900/50 p-5 text-sm md:grid-cols-4">
                <SetupData label="Time Range Condition" value={setup.timeRangeTarget} />
                <SetupData label="Volume Target" value={`${setup.volumeTarget} USDC`} />
                <SetupData label="Net Buyin" value={`${setup.netBuyinTarget} USDC`} />
                <SetupData label="Volatility" value={`${setup.volatilityTarget}%`} />
                <SetupData label="Pullback" value={`${setup.pullbackTarget}%`} />
                <SetupData label="Max Transactions" value={String(setup.maxTransactions)} />
                <SetupData label="Max Slippage" value={`${setup.maxSlippage}%`} />
                <SetupData label="Contract" value={setup.contractAddress ? compactAddress(setup.contractAddress) : 'Global'} />
              </div>

              <div className="p-0">
                {setupLogs.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-sm">
                      <thead>
                        <tr className="h-10 border-b border-slate-800 bg-slate-900 text-xs font-semibold uppercase text-slate-400">
                          <th className="px-4 font-medium" style={{ width: '20%' }}>Time</th>
                          <th className="px-4 font-medium" style={{ width: '20%' }}>Action</th>
                          <th className="px-4 font-medium" style={{ width: '60%' }}>Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {setupLogs.map((log) => (
                          <tr key={log.id} className="transition-colors hover:bg-slate-800/50">
                            <td className="px-4 py-2 font-mono text-xs text-slate-400">{formatDate(log.createdAt)}</td>
                            <td className="px-4 py-2">
                              <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">{log.action}</span>
                            </td>
                            <td className="px-4 py-2 text-xs text-slate-300">{log.target} - {log.details}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-6 text-center text-sm text-slate-500">
                    No audit events fall inside this configuration window yet.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 p-4 font-sans text-slate-200 md:p-6">
      <div className="mb-6 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-white">
            <Activity className="text-blue-500" /> WLT Execution Engine
          </h1>
          <p className="mt-1.5 flex items-center gap-2 text-sm text-slate-400">
            <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 font-mono text-blue-400">
              {settings.contractAddress || CONTRACT_ADDRESS || 'Not Configured'}
            </span>
            <span className="text-slate-700">|</span>
            <Clock size={14} /> Time Updated: {lastUpdated}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleStartTrading}
            className="flex h-10 cursor-pointer items-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            <Activity size={16} /> Start Trading
          </button>
          <button
            onClick={() => setIsAdminModalOpen(true)}
            className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm font-medium text-white shadow-sm hover:bg-slate-700"
          >
            <Shield size={16} className="text-amber-500" /> Admin
          </button>
          <button
            onClick={handleRefresh}
            className="flex h-10 cursor-pointer items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            <RefreshCw size={16} /> Force Sync
          </button>
          <button
            onClick={handleLogout}
            className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm font-medium text-white shadow-sm hover:bg-slate-700"
          >
            <Lock size={16} /> Logout
          </button>
        </div>
      </div>

      {error || notice ? (
        <div className={`mb-6 rounded-xl border p-4 text-sm ${error ? 'border-rose-900 bg-rose-950/50 text-rose-200' : 'border-emerald-900 bg-emerald-950/50 text-emerald-200'}`}>
          {error || notice}
        </div>
      ) : null}

      <div className="mb-6 inline-flex h-10 items-center justify-center self-start rounded-md border border-slate-800 bg-slate-900 p-1 text-slate-400 shadow-sm">
        <TabButton active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} icon={<Activity size={16} />} label="Dashboard" />
        <TabButton active={activeTab === 'accounts'} onClick={() => setActiveTab('accounts')} icon={<Users size={16} />} label="Accounts" />
        <TabButton active={activeTab === 'setup'} onClick={() => setActiveTab('setup')} icon={<Settings size={16} />} label="Trading Setup" />
        <TabButton active={activeTab === 'setups'} onClick={() => setActiveTab('setups')} icon={<Archive size={16} />} label="Historical Setups" />
      </div>

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
