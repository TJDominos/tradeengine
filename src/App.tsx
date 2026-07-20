import React from 'react';
import {
  AlertTriangle,
  Database,
  LayoutDashboard,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  ScrollText,
  Settings2,
  Shield,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import AdminPanel from './AdminPanel';

type TabId = 'dashboard' | 'accounts' | 'setup' | 'history';

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

const cardClass =
  'rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl';
const inputClass =
  'w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-blue-500';
const buttonClass =
  'inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition';

const tabs: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'accounts', label: 'Accounts', icon: Wallet },
  { id: 'setup', label: 'Trading Setup', icon: Settings2 },
  { id: 'history', label: 'Historical Setups', icon: ScrollText },
];

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
      if (body?.error) {
        error = body.details ? `${body.error}: ${body.details}` : body.error;
      }
    } catch {
      // ignore json parse failures for errors
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
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export default function App() {
  const [auth, setAuth] = React.useState<AuthStatus | null>(null);
  const [engineState, setEngineState] = React.useState<EngineState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [isAdminPanelOpen, setIsAdminPanelOpen] = React.useState(false);
  const [currentTab, setCurrentTab] = React.useState<TabId>('dashboard');

  const [credentials, setCredentials] = React.useState({
    username: '',
    password: '',
  });
  const [bootstrap, setBootstrap] = React.useState({
    username: '',
    password: '',
  });

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
  const [accountForm, setAccountForm] = React.useState({
    label: '',
    address: '',
  });
  const [submitting, setSubmitting] = React.useState<string | null>(null);
  const [walletBalances, setWalletBalances] = React.useState<
    Record<string, WalletBalance>
  >({});
  const [walletBalanceErrors, setWalletBalanceErrors] = React.useState<
    Record<string, string>
  >({});
  const [walletBalancePending, setWalletBalancePending] = React.useState<
    Record<string, boolean>
  >({});

  const loadAuth = React.useCallback(async () => {
    const status = await api<AuthStatus>('/api/auth/status');
    setAuth(status);
    return status;
  }, []);

  const loadState = React.useCallback(async () => {
    const state = await api<EngineState>('/api/state');
    setEngineState(state);
    setSettings(state.settings);
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

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!auth?.authenticated) return;

    let cancelled = false;
    let timer: number | undefined;

    const schedule = async () => {
      try {
        await loadState();
      } catch (err: unknown) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to refresh state',
          );
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(schedule, 15000);
        }
      }
    };

    timer = window.setTimeout(schedule, 15000);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [auth?.authenticated, loadState]);

  const refreshWalletBalances = React.useCallback(async () => {
    if (!engineState) return;

    const accounts = [
      ...engineState.internalAccs,
      ...engineState.outsiderAccs,
    ];
    if (accounts.length === 0) {
      setWalletBalances({});
      setWalletBalanceErrors({});
      setWalletBalancePending({});
      return;
    }

    const loadingState: Record<string, boolean> = {};
    for (const account of accounts) {
      loadingState[account.address] = true;
    }
    setWalletBalancePending(loadingState);

    const results = await Promise.allSettled(
      accounts.map(async (account) => ({
        address: account.address,
        balance: await api<WalletBalance>(
          `/api/wallets/${encodeURIComponent(account.address)}/balance`,
        ),
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
          result.reason instanceof Error
            ? result.reason.message
            : 'Failed to load balance';
      }
    }

    const idleState: Record<string, boolean> = {};
    for (const account of accounts) {
      idleState[account.address] = false;
    }

    setWalletBalances(nextBalances);
    setWalletBalanceErrors(nextErrors);
    setWalletBalancePending(idleState);
  }, [engineState]);

  React.useEffect(() => {
    if (!auth?.authenticated || !engineState) return;
    if (
      currentTab !== 'accounts' &&
      currentTab !== 'dashboard' &&
      !isAdminPanelOpen
    ) {
      return;
    }
    void refreshWalletBalances();
  }, [
    auth?.authenticated,
    currentTab,
    engineState,
    isAdminPanelOpen,
    refreshWalletBalances,
  ]);

  const submitWithFeedback = async (
    name: string,
    action: () => Promise<void>,
  ) => {
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

  const handleSaveSettings = () =>
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
      setNotice('Trading settings saved and snapshotted.');
      await refresh();
    });

  const handleAddTradableToken = () =>
    submitWithFeedback('token', async () => {
      const result = await api<{ token: TradableToken }>('/api/tradable-tokens', {
        method: 'POST',
        body: JSON.stringify(tradableTokenForm),
      });
      setTradableTokenForm({ network: 'solana', contractAddress: '' });
      setSettings((current) =>
        current.contractAddress.trim()
          ? current
          : { ...current, contractAddress: result.token.contractAddress },
      );
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

  const authPanel = () => {
    if (!auth) return null;

    if (auth.setupRequired) {
      return (
        <div className={`${cardClass} mx-auto mt-10 max-w-xl p-8`}>
          <div className="mb-6 flex items-center gap-3 text-white">
            <ShieldCheck className="text-emerald-400" />
            <div>
              <h1 className="text-2xl font-bold">Create the initial admin user</h1>
              <p className="mt-1 text-sm text-slate-400">
                Bootstrap is only available once. Passwords must be at least 12
                characters and are hashed with PBKDF2-SHA256 before storage.
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <input
              className={inputClass}
              placeholder="Admin username"
              value={bootstrap.username}
              onChange={(event) =>
                setBootstrap((current) => ({
                  ...current,
                  username: event.target.value,
                }))
              }
            />
            <input
              className={inputClass}
              type="password"
              placeholder="Strong password (12+ chars, use mixed character types)"
              value={bootstrap.password}
              onChange={(event) =>
                setBootstrap((current) => ({
                  ...current,
                  password: event.target.value,
                }))
              }
            />
            <button
              className={`${buttonClass} w-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60`}
              onClick={handleBootstrap}
              disabled={submitting === 'bootstrap'}
            >
              {submitting === 'bootstrap' ? 'Creating admin…' : 'Create admin account'}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className={`${cardClass} mx-auto mt-10 max-w-xl p-8`}>
        <div className="mb-6 flex items-center gap-3 text-white">
          <Lock className="text-blue-400" />
          <div>
            <h1 className="text-2xl font-bold">Admin login required</h1>
            <p className="mt-1 text-sm text-slate-400">
              The dashboard remains locked until an authenticated session is
              established.
            </p>
          </div>
        </div>
        <div className="space-y-4">
          <input
            className={inputClass}
            placeholder="Username"
            value={credentials.username}
            onChange={(event) =>
              setCredentials((current) => ({
                ...current,
                username: event.target.value,
              }))
            }
          />
          <input
            className={inputClass}
            type="password"
            placeholder="Password"
            value={credentials.password}
            onChange={(event) =>
              setCredentials((current) => ({
                ...current,
                password: event.target.value,
              }))
            }
          />
          <button
            className={`${buttonClass} w-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-60`}
            onClick={handleLogin}
            disabled={submitting === 'login'}
          >
            {submitting === 'login' ? 'Signing in…' : 'Log in'}
          </button>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
        Loading secure admin UI…
      </div>
    );
  }

  if (!auth?.authenticated || !engineState) {
    return (
      <div className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl">
          <header className="mb-8">
            <p className="text-sm uppercase tracking-[0.3em] text-blue-300">
              tradeengine
            </p>
            <h1 className="mt-2 text-4xl font-bold">Worker-backed trading admin</h1>
            <p className="mt-3 max-w-2xl text-slate-400">
              This UI is powered by a Cloudflare Worker with D1. It only unlocks
              after an authenticated session is established.
            </p>
          </header>
          {error && (
            <div className="mb-4 rounded-xl border border-rose-900 bg-rose-950/50 p-4 text-sm text-rose-200">
              {error}
            </div>
          )}
          {notice && (
            <div className="mb-4 rounded-xl border border-emerald-900 bg-emerald-950/50 p-4 text-sm text-emerald-200">
              {notice}
            </div>
          )}
          {authPanel()}
        </div>
      </div>
    );
  }

  const renderDashboard = () => (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Managed Wallets"
          value={String(engineState.stats.managedAccounts)}
          hint="Imported with private key or recovery phrase"
          icon={Shield}
          accent="emerald"
        />
        <MetricCard
          title="Watch Accounts"
          value={String(engineState.stats.watchedAccounts)}
          hint="Public-key monitoring only"
          icon={Wallet}
          accent="blue"
        />
        <MetricCard
          title="Tracked Tokens"
          value={String(engineState.tradableTokens.length)}
          hint="Configured by network and mint address"
          icon={Settings2}
          accent="amber"
        />
        <MetricCard
          title="Saved Snapshots"
          value={String(engineState.historicalSetups.length)}
          hint="Created whenever trading settings are saved"
          icon={ScrollText}
          accent="violet"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className={`${cardClass} p-6`}>
          <div className="mb-4 flex items-center gap-3">
            <Database className="text-blue-400" />
            <h2 className="text-lg font-semibold">Deployability and database binding</h2>
          </div>
          <dl className="space-y-3 text-sm text-slate-300">
            <div>
              <dt className="text-slate-500">Backend</dt>
              <dd className="font-medium text-white">{engineState.system.backend}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Database path</dt>
              <dd className="font-mono text-xs text-blue-300">
                {engineState.system.databasePath}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Connection state</dt>
              <dd className="font-medium text-emerald-300">
                {engineState.system.databaseConnected ? 'Connected' : 'Disconnected'}
              </dd>
            </div>
          </dl>
        </section>

        <section className={`${cardClass} p-6`}>
          <div className="mb-4 flex items-center gap-3">
            <ShieldCheck className="text-emerald-400" />
            <h2 className="text-lg font-semibold">Authorization scope</h2>
          </div>
          <ul className="space-y-2 text-sm text-slate-300">
            <li>• Settings are stored per authenticated admin account.</li>
            <li>• Managed private keys are encrypted at rest and never returned by the API.</li>
            <li>• Wallet balance lookups are restricted to accounts owned by the current admin.</li>
            <li>• Password changes revoke the user’s other active sessions.</li>
          </ul>
        </section>

        <section className={`${cardClass} p-6`}>
          <div className="mb-4 flex items-center gap-3">
            <AlertTriangle className="text-amber-400" />
            <h2 className="text-lg font-semibold">Execution status</h2>
          </div>
          <p className="text-sm text-slate-300">
            Trade execution is still intentionally disabled. This release focuses
            on secure wallet management, balance visibility, tracked token setup,
            and historical configuration snapshots.
          </p>
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
        <section className={`${cardClass} p-6`}>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold">Recent wallet activity</h2>
            <button
              className={`${buttonClass} border border-amber-700 bg-amber-950/40 px-3 py-2 text-amber-300 hover:bg-amber-900/50`}
              onClick={() => setIsAdminPanelOpen(true)}
            >
              <Shield className="mr-2 size-4" /> Open Admin Panel
            </button>
          </div>
          <AccountTable
            title="Managed wallets"
            accounts={engineState.internalAccs.slice(0, 5)}
            emptyText="No managed wallets imported yet."
            balances={walletBalances}
            balanceErrors={walletBalanceErrors}
            balancePending={walletBalancePending}
          />
        </section>

        <section className={`${cardClass} p-6`}>
          <h2 className="mb-4 text-xl font-semibold">Active tracked tokens</h2>
          <p className="mb-4 text-sm text-slate-400">
            Tokens are stored by network and mint address. Their balances are
            shown alongside every imported wallet.
          </p>
          {engineState.tradableTokens.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/50 p-4 text-sm text-slate-400">
              No tokens configured yet. Add one in Trading Setup.
            </div>
          ) : (
            <div className="space-y-3">
              {engineState.tradableTokens.map((token) => (
                <div
                  key={token.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-white">
                        {token.symbol ?? compactAddress(token.contractAddress)}
                      </div>
                      <div className="mt-1 font-mono text-xs text-blue-300">
                        {token.contractAddress}
                      </div>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-1 text-xs ${
                        token.isActive
                          ? 'border-emerald-800 bg-emerald-950/60 text-emerald-300'
                          : 'border-slate-700 bg-slate-900 text-slate-400'
                      }`}
                    >
                      {token.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );

  const renderAccounts = () => (
    <div className="grid gap-6 xl:grid-cols-[1.25fr,0.75fr]">
      <div className="space-y-6">
        <AccountTable
          title="Managed wallets"
          accounts={engineState.internalAccs}
          emptyText="No managed wallets imported yet. Use the Admin Panel to add one from a private key or recovery phrase."
          balances={walletBalances}
          balanceErrors={walletBalanceErrors}
          balancePending={walletBalancePending}
        />
        <AccountTable
          title="Watch-only accounts"
          accounts={engineState.outsiderAccs}
          emptyText="No watch-only accounts imported yet."
          balances={walletBalances}
          balanceErrors={walletBalanceErrors}
          balancePending={walletBalancePending}
        />
      </div>

      <div className="space-y-6">
        <section className={`${cardClass} p-6`}>
          <div className="mb-4 flex items-center gap-3">
            <Shield className="text-amber-400" />
            <h2 className="text-xl font-semibold">Managed wallet operations</h2>
          </div>
          <p className="mb-4 text-sm text-slate-400">
            Use the Admin Panel to import wallets from either a private key or a
            12/24-word recovery phrase, rotate the admin password, and delete
            managed wallets.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              className={`${buttonClass} border border-amber-700 bg-amber-950/40 text-amber-300 hover:bg-amber-900/50`}
              onClick={() => setIsAdminPanelOpen(true)}
            >
              <Shield className="mr-2 size-4" /> Open Admin Panel
            </button>
            <button
              className={`${buttonClass} border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800`}
              onClick={() => void refreshWalletBalances()}
            >
              <RefreshCw className="mr-2 size-4" /> Refresh Balances
            </button>
          </div>
        </section>

        <section className={`${cardClass} p-6`}>
          <div className="mb-4 flex items-center gap-3">
            <Wallet className="text-blue-400" />
            <h2 className="text-xl font-semibold">Import watch-only account</h2>
          </div>
          <div className="space-y-4">
            <input
              className={inputClass}
              placeholder="Label"
              value={accountForm.label}
              onChange={(event) =>
                setAccountForm((current) => ({
                  ...current,
                  label: event.target.value,
                }))
              }
            />
            <input
              className={`${inputClass} font-mono text-xs`}
              placeholder="Solana public key"
              value={accountForm.address}
              onChange={(event) =>
                setAccountForm((current) => ({
                  ...current,
                  address: event.target.value,
                }))
              }
            />
            <button
              className={`${buttonClass} w-full bg-slate-100 text-slate-950 hover:bg-white disabled:opacity-60`}
              onClick={handleImportAccount}
              disabled={submitting === 'account'}
            >
              {submitting === 'account' ? 'Importing…' : 'Import watch-only account'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );

  const renderSetup = () => (
    <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
      <section className={`${cardClass} p-6`}>
        <h2 className="mb-5 text-xl font-semibold">Trading settings</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="mb-2 block text-sm text-slate-400">Primary contract address</label>
            <input
              className={inputClass}
              value={settings.contractAddress}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  contractAddress: event.target.value,
                }))
              }
              placeholder="Optional Solana mint or market address"
            />
          </div>
          <NumberField
            label="Volatility target (%)"
            value={settings.volatilityTarget}
            onChange={(value) =>
              setSettings((current) => ({ ...current, volatilityTarget: value }))
            }
          />
          <NumberField
            label="Pullback target (%)"
            value={settings.pullbackTarget}
            onChange={(value) =>
              setSettings((current) => ({ ...current, pullbackTarget: value }))
            }
          />
          <NumberField
            label="Volume target"
            value={settings.volumeTarget}
            onChange={(value) =>
              setSettings((current) => ({ ...current, volumeTarget: value }))
            }
          />
          <NumberField
            label="Net buy-in target"
            value={settings.netBuyinTarget}
            onChange={(value) =>
              setSettings((current) => ({ ...current, netBuyinTarget: value }))
            }
          />
          <div>
            <label className="mb-2 block text-sm text-slate-400">Time range target</label>
            <select
              className={inputClass}
              value={settings.timeRangeTarget}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  timeRangeTarget: event.target.value,
                }))
              }
            >
              {['1h', '6h', '12h', '24h', '3d', '1w'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <NumberField
            label="Max transactions"
            value={settings.maxTransactions}
            onChange={(value) =>
              setSettings((current) => ({ ...current, maxTransactions: value }))
            }
          />
          <NumberField
            label="Max slippage (%)"
            value={settings.maxSlippage}
            onChange={(value) =>
              setSettings((current) => ({ ...current, maxSlippage: value }))
            }
          />
          <div className="md:col-span-2">
            <label className="mb-2 block text-sm text-slate-400">Strategy notes</label>
            <textarea
              className={`${inputClass} min-h-32`}
              value={settings.strategyNotes}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  strategyNotes: event.target.value,
                }))
              }
            />
          </div>
        </div>
        <button
          className={`${buttonClass} mt-5 w-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-60`}
          onClick={handleSaveSettings}
          disabled={submitting === 'settings'}
        >
          {submitting === 'settings' ? 'Saving…' : 'Save settings'}
        </button>
      </section>

      <div className="space-y-6">
        <section className={`${cardClass} p-6`}>
          <div className="mb-4 flex items-center gap-3">
            <Plus className="text-emerald-400" />
            <h2 className="text-xl font-semibold">Add tracked token</h2>
          </div>
          <p className="mb-4 text-sm text-slate-400">
            Add a token by network and contract address. Once stored, its balance
            appears on the Accounts and Admin views.
          </p>
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm text-slate-400">Network</label>
              <select
                className={inputClass}
                value={tradableTokenForm.network}
                onChange={(event) =>
                  setTradableTokenForm((current) => ({
                    ...current,
                    network: event.target.value,
                  }))
                }
              >
                <option value="solana">solana</option>
              </select>
            </div>
            <div>
              <label className="mb-2 block text-sm text-slate-400">Mint address</label>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={tradableTokenForm.contractAddress}
                onChange={(event) =>
                  setTradableTokenForm((current) => ({
                    ...current,
                    contractAddress: event.target.value,
                  }))
                }
                placeholder="Token mint address"
              />
            </div>
            <button
              className={`${buttonClass} w-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60`}
              onClick={handleAddTradableToken}
              disabled={submitting === 'token'}
            >
              {submitting === 'token' ? 'Adding token…' : 'Add tracked token'}
            </button>
          </div>
        </section>

        <section className={`${cardClass} p-6`}>
          <div className="mb-4 flex items-center gap-3">
            <ShieldCheck className="text-blue-400" />
            <h2 className="text-xl font-semibold">Tracked token list</h2>
          </div>
          {engineState.tradableTokens.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/50 p-4 text-sm text-slate-400">
              No tokens configured yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-slate-300">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                    <th className="pb-2 pr-4">Network</th>
                    <th className="pb-2 pr-4">Token</th>
                    <th className="pb-2 pr-4">Address</th>
                    <th className="pb-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {engineState.tradableTokens.map((token) => (
                    <tr key={token.id} className="border-b border-slate-800/50 align-top">
                      <td className="py-3 pr-4 capitalize">{token.network}</td>
                      <td className="py-3 pr-4 text-white">
                        <div className="font-semibold">
                          {token.symbol ?? compactAddress(token.contractAddress)}
                        </div>
                        <div className="text-xs text-slate-500">
                          {token.name ?? 'Symbol/name pending'}
                        </div>
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-blue-300">
                        {token.contractAddress}
                      </td>
                      <td className="py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-medium ${
                            token.isActive
                              ? 'border border-emerald-800 bg-emerald-950/60 text-emerald-300'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {token.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );

  const renderHistory = () => (
    <div className="grid gap-6 xl:grid-cols-[1fr,1fr]">
      <section className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-slate-800 p-5">
          <h2 className="text-xl font-semibold">Historical setup snapshots</h2>
          <p className="mt-2 text-sm text-slate-400">
            A new snapshot is created every time the trading settings are saved.
          </p>
        </div>
        {engineState.historicalSetups.length === 0 ? (
          <div className="p-5 text-sm text-slate-400">
            No snapshots yet. Save the trading settings once to create the first entry.
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {engineState.historicalSetups.map((setup) => (
              <div key={setup.id} className="space-y-3 p-5 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="font-semibold text-white">
                      {setup.tokenSymbol ?? 'Global setup snapshot'}
                    </div>
                    {setup.contractAddress && (
                      <div className="mt-1 font-mono text-xs text-blue-300">
                        {setup.contractAddress}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">
                    {formatDate(setup.createdAt)}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 text-slate-300">
                  <SetupMetric label="Range" value={setup.timeRangeTarget} />
                  <SetupMetric label="Max tx" value={String(setup.maxTransactions)} />
                  <SetupMetric label="Slippage" value={`${setup.maxSlippage}%`} />
                  <SetupMetric label="Volume" value={String(setup.volumeTarget)} />
                  <SetupMetric label="Net buy-in" value={String(setup.netBuyinTarget)} />
                  <SetupMetric label="Volatility" value={`${setup.volatilityTarget}%`} />
                  <SetupMetric label="Pullback" value={`${setup.pullbackTarget}%`} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-slate-800 p-5">
          <h2 className="text-xl font-semibold">Audit trail</h2>
        </div>
        <div className="max-h-[720px] overflow-auto">
          {engineState.logs.length === 0 ? (
            <div className="p-5 text-sm text-slate-400">No audited actions yet.</div>
          ) : (
            <div className="divide-y divide-slate-800">
              {engineState.logs.map((log) => (
                <div key={log.id} className="space-y-2 p-5 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-blue-300">
                      {log.action}
                    </span>
                    <span className="text-xs text-slate-500">
                      {formatDate(log.createdAt)}
                    </span>
                  </div>
                  <p className="font-medium text-slate-100">{log.target}</p>
                  <p className="text-slate-400">{log.details}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );

  const renderCurrentTab = () => {
    switch (currentTab) {
      case 'accounts':
        return renderAccounts();
      case 'setup':
        return renderSetup();
      case 'history':
        return renderHistory();
      case 'dashboard':
      default:
        return renderDashboard();
    }
  };

  return (
    <>
      <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
        <div className="mx-auto max-w-7xl space-y-6">
          <header
            className={`${cardClass} flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between`}
          >
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-blue-300">tradeengine</p>
              <h1 className="mt-2 text-3xl font-bold">Authenticated Worker admin backend</h1>
              <p className="mt-2 text-sm text-slate-400">
                Wallet management, tracked token configuration, and snapshot
                history now live behind authenticated admin sessions.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="rounded-full border border-emerald-800 bg-emerald-950/60 px-3 py-2 text-emerald-300">
                {engineState.auth.username} · {engineState.auth.role}
              </span>
              <button
                className={`${buttonClass} border border-amber-700 bg-amber-950/40 text-amber-300 hover:bg-amber-900/50`}
                onClick={() => setIsAdminPanelOpen(true)}
              >
                <Shield className="mr-2 size-4" /> Admin
              </button>
              <button
                className={`${buttonClass} border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800`}
                onClick={() => void refresh()}
              >
                <RefreshCw className="mr-2 size-4" /> Refresh
              </button>
              <button
                className={`${buttonClass} border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800`}
                onClick={handleLogout}
              >
                <LogOut className="mr-2 size-4" /> Logout
              </button>
            </div>
          </header>

          {(error || notice) && (
            <div
              className={`rounded-xl border p-4 text-sm ${
                error
                  ? 'border-rose-900 bg-rose-950/50 text-rose-200'
                  : 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              }`}
            >
              {error || notice}
            </div>
          )}

          <div className={`${cardClass} overflow-hidden border border-slate-700`}>
            <div className="flex flex-wrap gap-2 p-3">
                {tabs.map((tab) => (
                  <div key={tab.id}>
                    <TabButton
                      label={tab.label}
                      icon={tab.icon}
                      isActive={currentTab === tab.id}
                      onClick={() => setCurrentTab(tab.id)}
                    />
                  </div>
                ))}
            </div>
          </div>

          {renderCurrentTab()}
        </div>
      </div>
      <AdminPanel
        isOpen={isAdminPanelOpen}
        onClose={() => setIsAdminPanelOpen(false)}
        engineState={engineState}
        walletBalances={walletBalances}
        walletBalanceErrors={walletBalanceErrors}
        walletBalancePending={walletBalancePending}
        onRefresh={async () => {
          await refresh();
          await refreshWalletBalances();
        }}
      />
    </>
  );
}

function TabButton({
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
        isActive
          ? 'bg-slate-700 text-white shadow-sm'
          : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
      }`}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}

function MetricCard({
  title,
  value,
  hint,
  icon: Icon,
  accent,
}: {
  title: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  accent: 'emerald' | 'blue' | 'amber' | 'violet';
}) {
  const accentClass = {
    emerald: 'text-emerald-300 bg-emerald-950/60 border-emerald-800',
    blue: 'text-blue-300 bg-blue-950/60 border-blue-800',
    amber: 'text-amber-300 bg-amber-950/60 border-amber-800',
    violet: 'text-violet-300 bg-violet-950/60 border-violet-800',
  }[accent];

  return (
    <section className={`${cardClass} p-5`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">{title}</p>
          <p className="mt-2 text-3xl font-bold text-white">{value}</p>
        </div>
        <span className={`rounded-xl border p-3 ${accentClass}`}>
          <Icon className="size-5" />
        </span>
      </div>
      <p className="mt-3 text-xs text-slate-500">{hint}</p>
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-sm text-slate-400">{label}</label>
      <input
        className={inputClass}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function AccountTable({
  title,
  accounts,
  emptyText,
  balances,
  balanceErrors,
  balancePending,
}: {
  title: string;
  accounts: AccountRecord[];
  emptyText: string;
  balances: Record<string, WalletBalance>;
  balanceErrors: Record<string, string>;
  balancePending: Record<string, boolean>;
}) {
  return (
    <section className={`${cardClass} overflow-hidden`}>
      <div className="border-b border-slate-800 p-5">
        <h2 className="text-xl font-semibold">{title}</h2>
      </div>
      {accounts.length === 0 ? (
        <div className="p-5 text-sm text-slate-400">{emptyText}</div>
      ) : (
        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-950/60 text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">Label</th>
                <th className="px-5 py-3 font-medium">Address</th>
                <th className="px-5 py-3 font-medium">Balances</th>
                <th className="px-5 py-3 font-medium">Imported</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {accounts.map((account) => (
                <tr key={account.id} className="align-top">
                  <td className="px-5 py-4 font-medium text-slate-100">
                    {account.label}
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-blue-300">
                    <span title={account.address}>{compactAddress(account.address)}</span>
                  </td>
                  <td className="px-5 py-4">
                    <BalanceSummary
                      balance={balances[account.address]}
                      error={balanceErrors[account.address]}
                      loading={balancePending[account.address] ?? false}
                    />
                  </td>
                  <td className="px-5 py-4 text-slate-400">
                    {formatDate(account.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BalanceSummary({
  balance,
  error,
  loading,
}: {
  balance?: WalletBalance;
  error?: string;
  loading: boolean;
}) {
  if (loading) {
    return <p className="text-xs text-slate-500">Loading balances…</p>;
  }
  if (error) {
    return <p className="max-w-xs text-xs text-rose-300">{error}</p>;
  }
  if (!balance) {
    return <p className="text-xs text-slate-500">No balance data yet.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200">
          SOL {balance.sol}
        </span>
        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200">
          USDC {balance.usdc}
        </span>
      </div>
      {balance.tokens.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-slate-300">
          {balance.tokens.map((token) => (
            <span
              key={`${token.network}-${token.mint}`}
              className="rounded-full border border-blue-900 bg-blue-950/40 px-2 py-1"
            >
              {token.symbol} {token.amount}
            </span>
          ))}
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Updated {formatDate(balance.updatedAt)}
      </p>
    </div>
  );
}

function SetupMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 font-semibold text-white">{value}</div>
    </div>
  );
}
