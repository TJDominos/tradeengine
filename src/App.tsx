import React from 'react';
import { Lock, LogOut, RefreshCw, ShieldCheck, Wallet, KeyRound, Database, AlertTriangle } from 'lucide-react';

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

type EngineState = {
  auth: { username: string; role: string };
  settings: SettingsState;
  internalAccs: AccountRecord[];
  outsiderAccs: AccountRecord[];
  logs: AuditLog[];
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

const cardClass = 'rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl';
const inputClass = 'w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-blue-500';
const buttonClass = 'inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition';

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
      const body = await response.json();
      if (body?.error) error = body.error;
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

export default function App() {
  const [auth, setAuth] = React.useState<AuthStatus | null>(null);
  const [engineState, setEngineState] = React.useState<EngineState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>('');
  const [notice, setNotice] = React.useState<string>('');

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

  const [privateKeyForm, setPrivateKeyForm] = React.useState({ label: '', privateKey: '' });
  const [accountForm, setAccountForm] = React.useState({ label: '', address: '' });
  const [submitting, setSubmitting] = React.useState<string | null>(null);

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
    } catch (err: any) {
      setError(err.message || 'Failed to load application state');
    } finally {
      setLoading(false);
    }
  }, [loadAuth, loadState]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!auth?.authenticated) return;
    const timer = window.setInterval(() => {
      loadState().catch((err: any) => setError(err.message || 'Failed to refresh state'));
    }, 15000);
    return () => window.clearInterval(timer);
  }, [auth?.authenticated, loadState]);

  const submitWithFeedback = async (name: string, action: () => Promise<void>) => {
    setSubmitting(name);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err: any) {
      setError(err.message || 'Request failed');
    } finally {
      setSubmitting(null);
    }
  };

  const handleBootstrap = () => submitWithFeedback('bootstrap', async () => {
    await api('/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify(bootstrap),
    });
    setBootstrap({ username: '', password: '' });
    setNotice('Initial admin user created. You are now logged in.');
    await refresh();
  });

  const handleLogin = () => submitWithFeedback('login', async () => {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    setCredentials({ username: '', password: '' });
    setNotice('Login successful.');
    await refresh();
  });

  const handleLogout = () => submitWithFeedback('logout', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setEngineState(null);
    setNotice('Logged out.');
    await refresh();
  });

  const handleSaveSettings = () => submitWithFeedback('settings', async () => {
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
    setNotice('Trading settings saved.');
    await refresh();
  });

  const handleImportPrivateKey = () => submitWithFeedback('private-key', async () => {
    await api('/api/private-keys/import', {
      method: 'POST',
      body: JSON.stringify(privateKeyForm),
    });
    setPrivateKeyForm({ label: '', privateKey: '' });
    setNotice('Managed private key imported securely.');
    await refresh();
  });

  const handleImportAccount = () => submitWithFeedback('account', async () => {
    await api('/api/accounts/import', {
      method: 'POST',
      body: JSON.stringify(accountForm),
    });
    setAccountForm({ label: '', address: '' });
    setNotice('Watch-only account imported.');
    await refresh();
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
              <p className="mt-1 text-sm text-slate-400">Bootstrap is only available once. Passwords are hashed with Argon2 before storage.</p>
            </div>
          </div>
          <div className="space-y-4">
            <input className={inputClass} placeholder="Admin username" value={bootstrap.username} onChange={(e) => setBootstrap((current) => ({ ...current, username: e.target.value }))} />
            <input className={inputClass} type="password" placeholder="Strong password (12+ chars)" value={bootstrap.password} onChange={(e) => setBootstrap((current) => ({ ...current, password: e.target.value }))} />
            <button className={`${buttonClass} w-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60`} onClick={handleBootstrap} disabled={submitting === 'bootstrap'}>
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
            <p className="mt-1 text-sm text-slate-400">The dashboard remains locked until an authenticated session is established.</p>
          </div>
        </div>
        <div className="space-y-4">
          <input className={inputClass} placeholder="Username" value={credentials.username} onChange={(e) => setCredentials((current) => ({ ...current, username: e.target.value }))} />
          <input className={inputClass} type="password" placeholder="Password" value={credentials.password} onChange={(e) => setCredentials((current) => ({ ...current, password: e.target.value }))} />
          <button className={`${buttonClass} w-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-60`} onClick={handleLogin} disabled={submitting === 'login'}>
            {submitting === 'login' ? 'Signing in…' : 'Log in'}
          </button>
        </div>
      </div>
    );
  };

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">Loading secure admin UI…</div>;
  }

  if (!auth?.authenticated || !engineState) {
    return (
      <div className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto max-w-5xl">
          <header className="mb-8">
            <p className="text-sm uppercase tracking-[0.3em] text-blue-300">tradeengine</p>
            <h1 className="mt-2 text-4xl font-bold">Rust-backed trading admin</h1>
            <p className="mt-3 max-w-2xl text-slate-400">Node backend routes have been removed. This UI only unlocks after a real Rust session is established.</p>
          </header>
          {error && <div className="mb-4 rounded-xl border border-rose-900 bg-rose-950/50 p-4 text-sm text-rose-200">{error}</div>}
          {notice && <div className="mb-4 rounded-xl border border-emerald-900 bg-emerald-950/50 p-4 text-sm text-emerald-200">{notice}</div>}
          {authPanel()}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className={`${cardClass} flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between`}>
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-blue-300">tradeengine</p>
            <h1 className="mt-2 text-3xl font-bold">Authenticated Rust admin backend</h1>
            <p className="mt-2 text-sm text-slate-400">Only authenticated sessions can configure the system, import private keys, or import accounts.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="rounded-full border border-emerald-800 bg-emerald-950/60 px-3 py-2 text-emerald-300">{engineState.auth.username} · {engineState.auth.role}</span>
            <button className={`${buttonClass} border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800`} onClick={() => refresh()}>
              <RefreshCw size={16} className="mr-2" /> Refresh
            </button>
            <button className={`${buttonClass} border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800`} onClick={handleLogout}>
              <LogOut size={16} className="mr-2" /> Logout
            </button>
          </div>
        </header>

        {(error || notice) && (
          <div className={`rounded-xl border p-4 text-sm ${error ? 'border-rose-900 bg-rose-950/50 text-rose-200' : 'border-emerald-900 bg-emerald-950/50 text-emerald-200'}`}>
            {error || notice}
          </div>
        )}

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
                <dd className="font-mono text-xs text-blue-300">{engineState.system.databasePath}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Connection state</dt>
                <dd className="font-medium text-emerald-300">{engineState.system.databaseConnected ? 'Connected' : 'Disconnected'}</dd>
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
              <li>• Imported watch accounts are scoped to the current admin account.</li>
              <li>• Managed private keys are encrypted at rest and never returned by the API.</li>
              <li>• Sensitive endpoints return 401/403 instead of permissive fallbacks.</li>
            </ul>
          </section>

          <section className={`${cardClass} p-6`}>
            <div className="mb-4 flex items-center gap-3">
              <AlertTriangle className="text-amber-400" />
              <h2 className="text-lg font-semibold">Execution status</h2>
            </div>
            <p className="text-sm text-slate-300">Trade execution is disabled in this PR. The backend returns a clear 501 until a reviewed execution engine exists.</p>
          </section>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className={`${cardClass} p-6`}>
            <h2 className="mb-5 text-xl font-semibold">Trading settings</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="mb-2 block text-sm text-slate-400">Contract address</label>
                <input className={inputClass} value={settings.contractAddress} onChange={(e) => setSettings((current) => ({ ...current, contractAddress: e.target.value }))} placeholder="Optional Solana program or market address" />
              </div>
              <NumberField label="Volatility target (%)" value={settings.volatilityTarget} onChange={(value) => setSettings((current) => ({ ...current, volatilityTarget: value }))} />
              <NumberField label="Pullback target (%)" value={settings.pullbackTarget} onChange={(value) => setSettings((current) => ({ ...current, pullbackTarget: value }))} />
              <NumberField label="Volume target" value={settings.volumeTarget} onChange={(value) => setSettings((current) => ({ ...current, volumeTarget: value }))} />
              <NumberField label="Net buy-in target" value={settings.netBuyinTarget} onChange={(value) => setSettings((current) => ({ ...current, netBuyinTarget: value }))} />
              <div>
                <label className="mb-2 block text-sm text-slate-400">Time range target</label>
                <select className={inputClass} value={settings.timeRangeTarget} onChange={(e) => setSettings((current) => ({ ...current, timeRangeTarget: e.target.value }))}>
                  {['1h', '6h', '12h', '24h', '3d', '1w'].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <NumberField label="Max transactions" value={settings.maxTransactions} onChange={(value) => setSettings((current) => ({ ...current, maxTransactions: value }))} />
              <NumberField label="Max slippage (%)" value={settings.maxSlippage} onChange={(value) => setSettings((current) => ({ ...current, maxSlippage: value }))} />
              <div className="md:col-span-2">
                <label className="mb-2 block text-sm text-slate-400">Strategy notes</label>
                <textarea className={`${inputClass} min-h-32`} value={settings.strategyNotes} onChange={(e) => setSettings((current) => ({ ...current, strategyNotes: e.target.value }))} />
              </div>
            </div>
            <button className={`${buttonClass} mt-5 w-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-60`} onClick={handleSaveSettings} disabled={submitting === 'settings'}>
              {submitting === 'settings' ? 'Saving…' : 'Save settings'}
            </button>
          </section>

          <section className="space-y-6">
            <div className={`${cardClass} p-6`}>
              <div className="mb-4 flex items-center gap-3">
                <KeyRound className="text-emerald-400" />
                <h2 className="text-xl font-semibold">Import managed private key</h2>
              </div>
              <p className="mb-4 text-sm text-slate-400">Authentication is required before this section is usable. Imported private keys are encrypted server-side and only their derived public addresses are shown.</p>
              <div className="space-y-4">
                <input className={inputClass} placeholder="Label" value={privateKeyForm.label} onChange={(e) => setPrivateKeyForm((current) => ({ ...current, label: e.target.value }))} />
                <textarea className={`${inputClass} min-h-28 font-mono text-xs`} placeholder="Paste a Solana base58 private key or 64-byte JSON array" value={privateKeyForm.privateKey} onChange={(e) => setPrivateKeyForm((current) => ({ ...current, privateKey: e.target.value }))} />
                <button className={`${buttonClass} w-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60`} onClick={handleImportPrivateKey} disabled={submitting === 'private-key'}>
                  {submitting === 'private-key' ? 'Importing…' : 'Import private key'}
                </button>
              </div>
            </div>

            <div className={`${cardClass} p-6`}>
              <div className="mb-4 flex items-center gap-3">
                <Wallet className="text-blue-400" />
                <h2 className="text-xl font-semibold">Import watch-only account</h2>
              </div>
              <div className="space-y-4">
                <input className={inputClass} placeholder="Label" value={accountForm.label} onChange={(e) => setAccountForm((current) => ({ ...current, label: e.target.value }))} />
                <input className={`${inputClass} font-mono text-xs`} placeholder="Solana public key" value={accountForm.address} onChange={(e) => setAccountForm((current) => ({ ...current, address: e.target.value }))} />
                <button className={`${buttonClass} w-full bg-slate-100 text-slate-950 hover:bg-white disabled:opacity-60`} onClick={handleImportAccount} disabled={submitting === 'account'}>
                  {submitting === 'account' ? 'Importing…' : 'Import account'}
                </button>
              </div>
            </div>
          </section>
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          <AccountTable title="Managed accounts" accounts={engineState.internalAccs} emptyText="No managed keys imported yet." />
          <AccountTable title="Watch-only accounts" accounts={engineState.outsiderAccs} emptyText="No watch accounts imported yet." />
          <section className={`${cardClass} overflow-hidden`}>
            <div className="border-b border-slate-800 p-5">
              <h2 className="text-xl font-semibold">Audit trail</h2>
            </div>
            <div className="max-h-[480px] overflow-auto">
              {engineState.logs.length === 0 ? (
                <div className="p-5 text-sm text-slate-400">No audited actions yet.</div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {engineState.logs.map((log) => (
                    <div key={log.id} className="space-y-2 p-5 text-sm">
                      <div className="flex items-center justify-between gap-4">
                        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-blue-300">{log.action}</span>
                        <span className="text-xs text-slate-500">{formatDate(log.createdAt)}</span>
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
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div>
      <label className="mb-2 block text-sm text-slate-400">{label}</label>
      <input className={inputClass} type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function AccountTable({ title, accounts, emptyText }: { title: string; accounts: AccountRecord[]; emptyText: string }) {
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
                <th className="px-5 py-3 font-medium">Imported</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td className="px-5 py-3 font-medium text-slate-100">{account.label}</td>
                  <td className="px-5 py-3 font-mono text-xs text-blue-300">{account.address}</td>
                  <td className="px-5 py-3 text-slate-400">{formatDate(account.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
