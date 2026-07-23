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
import AdminModal from './components/AdminModal';
import AuthPanel from './components/AuthPanel';
import DashboardLogsSection from './components/DashboardLogsSection';
import PageTabs from './components/PageTabs';
import SimulationModal from './components/SimulationModal';
import {
  CONTRACT_ADDRESS,
  DASHBOARD_AUTO_REFRESH_INTERVAL_MS,
  ITEMS_PER_PAGE,
  workerAlgorithmTemplate,
} from './app/constants';
import { createStrategyDraftFromSettings } from './app/strategyFormSchema';
import type {
  AuthStatus,
  DashboardLogTab,
  DashboardTransactionLog,
  DateRangeState,
  EngineState,
  SettingsState,
  StrategyVersionDocument,
  TabId,
  TokenMarketSnapshot,
  TradableToken,
  WalletBalance,
  WalletOwnershipMeta,
} from './app/types';
import {
  api,
  buildWalletOwnershipLookup,
  createDefaultDateRange,
  findWalletTokenAmount,
  formatDate,
  loadStoredString,
  mergeTradableToken,
  normalizeTimestampMs,
  resolveWalletOwnershipMeta,
  saveStoredString,
  serializeSettings,
  summarizeAccounts,
  toRangeEndMs,
  toRangeStartMs,
} from './app/utils';
import AccountsPage from './pages/AccountsPage';
import DashboardPage from './pages/DashboardPage';
import HistoricalSetupsPage from './pages/HistoricalSetupsPage';
import TradingSetupPage from './pages/TradingSetupPage';

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
  const [dateFilterActive, setDateFilterActive] = React.useState(true);
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
  const [strategyDraft, setStrategyDraft] = React.useState<StrategyVersionDocument | null>(null);

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
  const strategyDraftDirtyRef = React.useRef(false);
  const dashboardAutoRefreshInFlightRef = React.useRef(false);
  const latestMarketSnapshotFetchedAtRef = React.useRef<number | null>(null);
  const loadedMarketSnapshotHistoryAtRef = React.useRef<number | null>(null);

  const dateFilterReady = dateRange.from !== '' && dateRange.to !== '';
  const hasDateRange = dateFilterActive && dateFilterReady;

  useEffect(() => {
    latestMarketSnapshotFetchedAtRef.current = engineState?.marketSnapshot?.fetchedAt ?? null;
  }, [engineState?.marketSnapshot?.fetchedAt]);

  useEffect(() => {
    setTradingAlgorithm(loadStoredString('tradeengine.tradingAlgorithm', workerAlgorithmTemplate));
  }, []);

  const syncSettingsFromServer = React.useCallback(
    (nextSettings: SettingsState) => {
      setSettings(nextSettings);
    },
    [],
  );

  const syncStrategyDraftFromServer = React.useCallback(
    (state: EngineState, options?: { preserveDraft?: boolean }) => {
      const nextDraft = state.activeStrategyVersion?.document ?? createStrategyDraftFromSettings(state.settings);
      setStrategyDraft((current) => {
        if (options?.preserveDraft && strategyDraftDirtyRef.current && current) {
          return current;
        }
        return nextDraft;
      });
    },
    [],
  );

  const updateStrategyDraft = React.useCallback(
    (updater: (current: StrategyVersionDocument) => StrategyVersionDocument) => {
      strategyDraftDirtyRef.current = true;
      setStrategyDraft((current) => (current ? updater(current) : current));
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
    syncSettingsFromServer(state.settings);
    syncStrategyDraftFromServer(state, { preserveDraft: true });
    setLastUpdated(new Date().toLocaleString());
    return state;
  }, [syncSettingsFromServer, syncStrategyDraftFromServer]);

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
      strategyDraftDirtyRef.current = false;
      setEngineState(null);
      setStrategyDraft(null);
      setWalletBalances({});
      setNotice('Logged out.');
      await refresh();
    });

  const loadMarketSnapshotHistory = React.useCallback(async (options?: { silent?: boolean; snapshotFetchedAt?: number | null }) => {
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
      loadedMarketSnapshotHistoryAtRef.current =
        options?.snapshotFetchedAt ?? latestMarketSnapshotFetchedAtRef.current;
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
        const refreshQuery = hasDateRange
          ? `?startTime=${toRangeStartMs(dateRange.from)}&endTime=${toRangeEndMs(dateRange.to)}`
          : '';
        const result = await api<{
          marketSnapshot: TokenMarketSnapshot | null;
          windowCompleteness?: {
            expectedTransactions: number;
            completeTransactionsBefore: number;
            enrichedTransactions: number;
            completeTransactionsAfter: number;
          };
          rpcReconciliation?: {
            scannedSignatures: number;
            insertedSignals: number;
            duplicates: number;
            skippedIrrelevant: number;
          };
          holderSyncSummary?: {
            status: 'idle' | 'running' | 'completed' | 'failed';
            processedShardCount: number;
            totalShardCount: number;
            stagedHolderCount: number;
            activeHolderCount: number;
            errorMessage: string | null;
          };
        }>(
          `/api/market-snapshot/refresh${refreshQuery}`,
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
          await loadState();
          await loadMarketSnapshotHistory({
            snapshotFetchedAt: result.marketSnapshot.fetchedAt,
          });
          const holderSyncMessage = result.holderSyncSummary
            ? result.holderSyncSummary.status === 'completed'
              ? ` Holder sync completed with ${result.holderSyncSummary.activeHolderCount} holders.`
              : result.holderSyncSummary.status === 'failed'
                ? ` Holder sync failed: ${result.holderSyncSummary.errorMessage ?? 'unknown error'}.`
                : result.holderSyncSummary.status === 'running'
                  ? ` Holder sync ${result.holderSyncSummary.processedShardCount}/${result.holderSyncSummary.totalShardCount} shards, staged ${result.holderSyncSummary.stagedHolderCount} holders so far.`
                  : ''
            : '';
          setNotice(
            result.marketSnapshot.priceUsd != null
              ? result.rpcReconciliation || result.windowCompleteness
                ? `Market data refreshed. Window transactions ${result.windowCompleteness?.expectedTransactions ?? 0}, complete before ${result.windowCompleteness?.completeTransactionsBefore ?? 0}, enriched ${result.windowCompleteness?.enrichedTransactions ?? 0}, complete after ${result.windowCompleteness?.completeTransactionsAfter ?? 0}. RPC reconciliation scanned ${result.rpcReconciliation?.scannedSignatures ?? 0} signatures and inserted ${result.rpcReconciliation?.insertedSignals ?? 0} transaction record(s).${holderSyncMessage}`
                : 'Market data refreshed.'
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
        const state = await loadState();
        const snapshotFetchedAt = state.marketSnapshot?.fetchedAt ?? null;
        if (
          !disposed &&
          settings.contractAddress.trim() &&
          hasDateRange &&
          snapshotFetchedAt !== loadedMarketSnapshotHistoryAtRef.current
        ) {
          await loadMarketSnapshotHistory({
            silent: true,
            snapshotFetchedAt,
          });
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
      if (!strategyDraft) {
        throw new Error('Strategy draft is not ready');
      }
      const response = await api<{
        activeStrategyVersion: EngineState['activeStrategyVersion'];
        settings: SettingsState;
        marketSnapshot: TokenMarketSnapshot | null;
      }>('/api/strategy/active', {
        method: 'POST',
        body: JSON.stringify(strategyDraft),
      });
      settingsDirtyRef.current = false;
      strategyDraftDirtyRef.current = false;
      setSettings(response.settings);
      setEngineState((current) =>
        current
          ? {
              ...current,
              activeStrategyVersion: response.activeStrategyVersion,
              marketSnapshot: response.marketSnapshot ?? current.marketSnapshot,
            }
          : current,
      );
      setNotice(
        response.activeStrategyVersion
          ? `Strategy version v${response.activeStrategyVersion.versionNo} saved and activated.`
          : 'Strategy configuration saved.',
      );
      await refresh();
    });

  const handleCleanupStrategyVersions = () =>
    submitWithFeedback('strategy-cleanup', async () => {
      if (
        typeof window !== 'undefined' &&
        !window.confirm(
          'Clear all previous strategy versions and keep only the current active version?',
        )
      ) {
        return;
      }

      const response = await api<{
        deletedVersions: number;
        deletedEvaluations: number;
        activeStrategyVersion: EngineState['activeStrategyVersion'];
      }>('/api/strategy/versions/cleanup', {
        method: 'POST',
      });

      setNotice(
        response.activeStrategyVersion
          ? `Deleted ${response.deletedVersions} automatic strategy version(s) and ${response.deletedEvaluations} evaluation(s). Kept manual v${response.activeStrategyVersion.versionNo} active.`
          : `Deleted ${response.deletedVersions} automatic strategy version(s) and ${response.deletedEvaluations} evaluation(s). No manual strategy version remains active.`,
      );
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
      setNotice(
        result.marketSnapshot
          ? 'Token activated with stored market data.'
          : 'Token activated. Market data refresh now runs only on manual refresh or webhook events.',
      );
      await refresh();
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
            ? 'Token saved as active with stored market data.'
            : 'Token saved as active. Market data refresh now runs only on manual refresh or webhook events.',
      );
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

  const authPanel = () => (
    <AuthPanel
      auth={auth}
      bootstrap={bootstrap}
      setBootstrap={setBootstrap}
      credentials={credentials}
      setCredentials={setCredentials}
      onBootstrap={handleBootstrap}
      onLogin={handleLogin}
      submitting={submitting}
    />
  );

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

  const filteredInternal = engineState.internalAccs.filter(
    (account) =>
      account.address.toLowerCase().includes(accountSearchTerm.toLowerCase()) ||
      account.label.toLowerCase().includes(accountSearchTerm.toLowerCase()),
  );
  const filteredOutsideHolders = engineState.outsideTokenHolders.filter(
    (holder) =>
      holder.address.toLowerCase().includes(accountSearchTerm.toLowerCase()) ||
      (holder.label ?? '').toLowerCase().includes(accountSearchTerm.toLowerCase()),
  );

  const internalCurrentSlice = filteredInternal.slice(
    (internalPage - 1) * ITEMS_PER_PAGE,
    internalPage * ITEMS_PER_PAGE,
  );
  const outsiderCurrentSlice = filteredOutsideHolders.slice(
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

  const rangeTransactionLogs = combinedTransactionLogs.filter((log) =>
    isInSelectedRange(log.createdAt),
  );

  const rangeTransactionVolumeUsd = rangeTransactionLogs.reduce((sum, log) => {
    if (log.kind === 'webhook') {
      return sum + (log.usdcAmount ?? 0);
    }
    if (log.action === 'BUY') {
      return sum + log.requestedAmount;
    }
    if (log.executedAmount != null && log.executedPrice != null) {
      return sum + log.executedAmount * log.executedPrice;
    }
    return sum;
  }, 0);

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
      (log.fromWalletAddress ?? '').toLowerCase().includes(term) ||
      (log.toWalletAddress ?? '').toLowerCase().includes(term) ||
      accountLabel.includes(term) ||
      ownershipLabel.includes(term) ||
      (log.action ?? '').toLowerCase().includes(term) ||
      log.eventType.toLowerCase().includes(term) ||
      log.status.toLowerCase().includes(term) ||
      String(log.usdcAmount ?? '').includes(term) ||
      String(log.tokenAmount ?? '').includes(term) ||
      String(log.feeAmountUsd ?? '').includes(term) ||
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
  const tokenHolderAggregateLoading =
    Boolean(activeTokenContractAddress) && !engineState.tokenHolderAggregate;
  const outsideHolderCount = engineState.tokenHolderAggregate?.outsiderHolderCount ?? null;
  const outsideHolderTotalAmount = engineState.tokenHolderAggregate
    ? Math.max(
        0,
        engineState.tokenHolderAggregate.totalAmountHolding -
          engineState.tokenHolderAggregate.internalAmountHolding,
      )
    : null;

  const renderDashboardLogs = () => (
    <DashboardLogsSection
      dashboardLogTab={dashboardLogTab}
      onDashboardLogTabChange={setDashboardLogTab}
      currentTransactionLogs={currentTransactionLogs}
      filteredTransactionLogsCount={filteredTransactionLogs.length}
      transactionLogSearchTerm={transactionLogSearchTerm}
      onTransactionLogSearchTermChange={(value) => {
        setTransactionLogSearchTerm(value);
        setTransactionLogCurrentPage(1);
      }}
      transactionLogCurrentPage={transactionLogCurrentPage}
      onTransactionLogPageChange={setTransactionLogCurrentPage}
      activeTokenPriceUsd={dashboardSnapshot?.priceUsd ?? engineState.marketSnapshot?.priceUsd ?? null}
      onTransactionAddressClick={(address) => {
        setAccountSearchTerm(address);
        setInternalPage(1);
        setOutsiderPage(1);
        setActiveTab('accounts');
      }}
      walletOwnershipLookup={walletOwnershipLookup}
      currentActivityLogs={currentActivityLogs}
      filteredActivityLogsCount={filteredActivityLogs.length}
      activityLogSearchTerm={activityLogSearchTerm}
      onActivityLogSearchTermChange={(value) => {
        setActivityLogSearchTerm(value);
        setActivityLogCurrentPage(1);
      }}
      activityLogCurrentPage={activityLogCurrentPage}
      onActivityLogPageChange={setActivityLogCurrentPage}
      itemsPerPage={ITEMS_PER_PAGE}
    />
  );

  const renderDashboard = () => (
    <DashboardPage
      dateRange={dateRange}
      setDateRange={setDateRange}
      dateFilterReady={dateFilterReady}
      dateFilterActive={dateFilterActive}
      onDateFilterToggle={() => {
        if (!dateFilterReady) {
          return;
        }
        setDateFilterActive((current) => !current);
      }}
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
      tokenHolderAggregate={engineState.tokenHolderAggregate}
      tokenHolderAggregateLoading={tokenHolderAggregateLoading}
      transactionCount={rangeTransactionLogs.length}
      transactionVolumeUsd={rangeTransactionVolumeUsd}
      logsSection={renderDashboardLogs()}
    />
  );

  const renderAccounts = () => (
    <AccountsPage
      dateRange={dateRange}
      setDateRange={setDateRange}
      dateFilterReady={dateFilterReady}
      dateFilterActive={dateFilterActive}
      onDateFilterToggle={() => {
        if (!dateFilterReady) {
          return;
        }
        setDateFilterActive((current) => !current);
      }}
      hasDateRange={hasDateRange}
      accountSearchTerm={accountSearchTerm}
      onAccountSearchTermChange={(value) => {
        setAccountSearchTerm(value);
        setInternalPage(1);
        setOutsiderPage(1);
      }}
      internalSummary={internalSummary}
      filteredInternal={filteredInternal}
      internalCurrentSlice={internalCurrentSlice}
      outsideHolderRows={outsiderCurrentSlice}
      filteredOutsideHoldersCount={filteredOutsideHolders.length}
      outsideHolderCount={outsideHolderCount}
      outsideHolderTotalAmount={outsideHolderTotalAmount}
      outsideHolderLoading={tokenHolderAggregateLoading}
      activeTokenSymbol={activeTokenSymbol}
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
      strategyDraft={strategyDraft}
      tradableTokenForm={tradableTokenForm}
      setTradableTokenForm={setTradableTokenForm}
      rpcEndpointForm={rpcEndpointForm}
      setRpcEndpointForm={setRpcEndpointForm}
      submitting={submitting}
      handleAddTrackedToken={handleAddTrackedToken}
      handleUseToken={handleUseToken}
      handleAddRpcEndpoint={handleAddRpcEndpoint}
      handleDeleteRpcEndpoint={handleDeleteRpcEndpoint}
      updateStrategyDraft={updateStrategyDraft}
      handleSaveConfig={handleSaveConfig}
      tradingAlgorithm={tradingAlgorithm}
      setTradingAlgorithm={setTradingAlgorithm}
      onPersistAlgorithm={() => {
        saveStoredString('tradeengine.tradingAlgorithm', tradingAlgorithm);
        setNotice('Algorithm draft saved locally in the browser.');
      }}
      onOpenSimulation={() => setIsSimulationModalOpen(true)}
      activeStrategyVersionNo={engineState.activeStrategyVersion?.versionNo ?? null}
      activeStrategyStatus={engineState.activeStrategyVersion?.status ?? null}
    />
  );

  const renderSetups = () => (
    <HistoricalSetupsPage
      activeStrategyVersion={engineState.activeStrategyVersion}
      strategyVersions={engineState.strategyVersions}
      strategyEvaluations={engineState.strategyEvaluations}
      onCleanupStrategyVersions={handleCleanupStrategyVersions}
      isCleaningStrategyVersions={submitting === 'strategy-cleanup'}
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

      <AdminModal
        open={isAdminModalOpen}
        onClose={() => setIsAdminModalOpen(false)}
        adminTab={adminTab}
        setAdminTab={setAdminTab}
        adminMsg={adminMsg}
        setAdminMsg={setAdminMsg}
        adminPasswordForm={adminPasswordForm}
        setAdminPasswordForm={setAdminPasswordForm}
        adminImportForm={adminImportForm}
        setAdminImportForm={setAdminImportForm}
        managedWallets={managedWallets}
        walletBalanceErrors={walletBalanceErrors}
        walletBalances={walletBalances}
        onPasswordChange={() => void handleAdminPasswordChange()}
        onImport={() => void handleAdminImport()}
        onDelete={(address) => void handleAdminDelete(address)}
      />

      <SimulationModal
        open={isSimulationModalOpen}
        onClose={() => setIsSimulationModalOpen(false)}
        settings={settings}
        managedAccountsCount={engineState.stats.managedAccounts}
        tradableTokensCount={engineState.tradableTokens.length}
      />
    </div>
  );
}
