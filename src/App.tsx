import React, { useEffect } from 'react';
import {
  Activity,
  Archive,
  CheckSquare,
  Clock,
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
import {
  CONTRACT_ADDRESS,
  ITEMS_PER_PAGE,
} from './app/constants';
import { createStrategyDraftFromSettings } from './app/strategyFormSchema';
import type {
  AuthStatus,
  DashboardLogTab,
  DashboardTransactionLog,
  DateRangeState,
  EngineState,
  OutsideTokenHolderPage,
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
  formatUSD,
  mergeTradableToken,
  normalizeTimestampMs,
  parseAmount,
  resolveWalletOwnershipMeta,
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
  const [outsideHolderSort, setOutsideHolderSort] = React.useState<'newest' | 'largest'>('newest');
  const [outsideHolderPage, setOutsideHolderPage] = React.useState<OutsideTokenHolderPage>({
    items: [],
    page: 1,
    pageSize: ITEMS_PER_PAGE,
    totalItems: 0,
  });
  const [outsideHolderPageLoading, setOutsideHolderPageLoading] = React.useState(false);

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
  const [strategyDraft, setStrategyDraft] = React.useState<StrategyVersionDocument | null>(null);
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

  const [loadingMarketSnapshots, setLoadingMarketSnapshots] = React.useState(false);
  
  const settingsDirtyRef = React.useRef(false);
  const strategyDraftDirtyRef = React.useRef(false);
  const activeSubmissionRef = React.useRef<string | null>(null);
  const lastMarketRefreshStatusKeyRef = React.useRef<string | null>(null);
  const lastWalletBalanceRefreshStatusKeyRef = React.useRef<string | null>(null);

  const dateFilterReady = dateRange.from !== '' && dateRange.to !== '';
  const hasDateRange = dateFilterActive && dateFilterReady;
  const marketRefreshRunning = engineState?.marketRefreshStatus?.status === 'running';
  const isRefreshPending = submitting === 'refresh' || marketRefreshRunning;

  useEffect(() => {
    const status = engineState?.marketRefreshStatus;
    if (!status) {
      return;
    }
    const statusKey = `${status.requestId ?? 'none'}:${status.status}:${status.updatedAt}`;
    const previousKey = lastMarketRefreshStatusKeyRef.current;
    if (previousKey === statusKey) {
      return;
    }
    lastMarketRefreshStatusKeyRef.current = statusKey;
    if (!previousKey) {
      return;
    }
    if (status.status === 'completed' && status.summaryText) {
      setError('');
      setNotice(status.summaryText);
      return;
    }
    if (status.status === 'failed' && status.errorMessage) {
      setNotice('');
      setError(`Refresh failed: ${status.errorMessage}`);
    }
  }, [engineState?.marketRefreshStatus]);

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

  const loadOutsideHolderPage = React.useCallback(async () => {
    if (!auth?.authenticated || !settings.contractAddress.trim()) {
      setOutsideHolderPage({
        items: [],
        page: 1,
        pageSize: ITEMS_PER_PAGE,
        totalItems: 0,
      });
      return;
    }

    setOutsideHolderPageLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(outsiderPage),
        pageSize: String(ITEMS_PER_PAGE),
      });
      const trimmedSearch = accountSearchTerm.trim();
      if (trimmedSearch) {
        params.set('search', trimmedSearch);
      }
      params.set('sort', outsideHolderSort);
      const result = await api<OutsideTokenHolderPage>(`/api/token-holders?${params.toString()}`);
      setOutsideHolderPage(result);
    } catch (err: unknown) {
      setOutsideHolderPage({
        items: [],
        page: outsiderPage,
        pageSize: ITEMS_PER_PAGE,
        totalItems: 0,
      });
      setError(err instanceof Error ? err.message : 'Failed to load outside holders');
    } finally {
      setOutsideHolderPageLoading(false);
    }
  }, [accountSearchTerm, auth?.authenticated, outsideHolderSort, outsiderPage, settings.contractAddress]);

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

  const refreshWalletBalances = React.useCallback(async (addresses?: string[]) => {
    if (!auth?.authenticated) return;

    const targetAddresses = Array.from(
      new Set(
        (addresses ?? (
          engineState
            ? engineState.internalAccs.map((account) => account.address)
            : []
        )).filter(Boolean),
      ),
    );

    if (targetAddresses.length === 0) {
      if (!addresses) {
        setWalletBalances({});
        setWalletBalanceErrors({});
        setWalletBalancePending({});
      }
      return;
    }

    setWalletBalancePending((current) => {
      const next = { ...current };
      for (const address of targetAddresses) {
        next[address] = true;
      }
      return next;
    });

    const results = await Promise.allSettled(
      targetAddresses.map(async (address) => ({
        address,
        balance: await api<WalletBalance>(`/api/wallets/${encodeURIComponent(address)}/balance`),
      })),
    );

    setWalletBalances((current) => {
      const next = { ...current };
      for (const result of results) {
        if (result.status === 'fulfilled') {
          next[result.value.address] = result.value.balance;
        }
      }
      return next;
    });

    setWalletBalanceErrors((current) => {
      const next = { ...current };
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const address = targetAddresses[index];
        if (result.status === 'fulfilled') {
          delete next[address];
        } else {
          next[address] =
            result.reason instanceof Error ? result.reason.message : 'Failed to load balance';
        }
      }
      return next;
    });

    setWalletBalancePending((current) => {
      const next = { ...current };
      for (const address of targetAddresses) {
        next[address] = false;
      }
      return next;
    });
  }, [auth?.authenticated, engineState]);

  const refreshInternalWalletBalances = React.useCallback(async () => {
    if (!engineState) {
      return;
    }
    await refreshWalletBalances(
      engineState.internalAccs.map((account) => account.address),
    );
  }, [engineState, refreshWalletBalances]);

  const refreshOutsideWalletBalances = React.useCallback(async () => {
    await refreshWalletBalances(
      outsideHolderPage.items.map((holder) => holder.address),
    );
  }, [outsideHolderPage.items, refreshWalletBalances]);

  useEffect(() => {
    if (!auth?.authenticated || !engineState) return;
    if (activeTab !== 'dashboard' && activeTab !== 'accounts' && !isAdminModalOpen) {
      return;
    }
    void refreshWalletBalances();
  }, [auth?.authenticated, engineState, activeTab, isAdminModalOpen, refreshWalletBalances]);

  useEffect(() => {
    if (!auth?.authenticated || activeTab !== 'accounts' || outsideHolderPage.items.length === 0) {
      return;
    }
    void refreshOutsideWalletBalances();
  }, [auth?.authenticated, activeTab, outsideHolderPage.items, refreshOutsideWalletBalances]);

  useEffect(() => {
    if (!auth?.authenticated) {
      return;
    }
    const status = engineState?.marketRefreshStatus;
    if (!status || status.status !== 'completed') {
      return;
    }
    const statusKey = `${status.requestId ?? 'none'}:${status.status}:${status.updatedAt}`;
    if (lastWalletBalanceRefreshStatusKeyRef.current === statusKey) {
      return;
    }
    lastWalletBalanceRefreshStatusKeyRef.current = statusKey;
    void refreshWalletBalances();
    if (activeTab === 'accounts') {
      void refreshOutsideWalletBalances();
    }
  }, [auth?.authenticated, activeTab, engineState?.marketRefreshStatus, refreshOutsideWalletBalances, refreshWalletBalances]);

  const submitWithFeedback = async (name: string, action: () => Promise<void>) => {
    if (activeSubmissionRef.current) {
      return;
    }
    activeSubmissionRef.current = name;
    setSubmitting(name);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      activeSubmissionRef.current = null;
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

  const loadMarketSnapshotHistory = React.useCallback(async () => {
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
      setError('Invalid date range');
      return;
    }

    setLoadingMarketSnapshots(true);
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
      setError(err instanceof Error ? err.message : 'Failed to load market snapshot history');
    } finally {
      setLoadingMarketSnapshots(false);
    }
  }, [auth?.authenticated, dateRange.from, dateRange.to, settings.contractAddress]);

  const handleRefresh = () =>
    void submitWithFeedback('refresh', async () => {
      if (auth?.authenticated && settings.contractAddress.trim()) {
        setNotice('Refresh started. Fetching market data and syncing token holders...');
        const refreshQuery = hasDateRange
          ? `?startTime=${toRangeStartMs(dateRange.from)}&endTime=${toRangeEndMs(dateRange.to)}`
          : '';
        const result = await api<{
          accepted: boolean;
          status: 'started' | 'running';
          marketSnapshot: TokenMarketSnapshot | null;
          marketRefreshStatus: EngineState['marketRefreshStatus'];
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
        }
        await loadState();
        setNotice(
          result.status === 'running'
            ? 'Refresh is already running. Waiting for the active request to finish.'
            : 'Refresh started. Keep this page open while fetching progresses.',
        );
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
    if (activeTab !== 'accounts') {
      return;
    }
    void loadOutsideHolderPage();
  }, [
    activeTab,
    loadOutsideHolderPage,
    engineState?.tokenHolderSyncState?.updatedAt,
    engineState?.marketRefreshStatus?.updatedAt,
  ]);

  useEffect(() => {
    const requestId = engineState?.marketRefreshStatus?.requestId;
    if (!marketRefreshRunning || !requestId) {
      return;
    }

    const cancelRefresh = () => {
      const payload = JSON.stringify({ requestId });
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/market-snapshot/refresh/cancel', blob);
    };

    window.addEventListener('pagehide', cancelRefresh);
    window.addEventListener('beforeunload', cancelRefresh);
    return () => {
      window.removeEventListener('pagehide', cancelRefresh);
      window.removeEventListener('beforeunload', cancelRefresh);
    };
  }, [engineState?.marketRefreshStatus?.requestId, marketRefreshRunning]);

  useEffect(() => {
    if (!auth?.authenticated || !marketRefreshRunning) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadState().catch((err: unknown) => {
        console.warn('Failed to poll refresh state:', err);
      });
    }, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [auth?.authenticated, loadState, marketRefreshRunning]);

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
  const internalCurrentSlice = filteredInternal.slice(
    (internalPage - 1) * ITEMS_PER_PAGE,
    internalPage * ITEMS_PER_PAGE,
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
  const transactionLogPage = filteredTransactionLogs.length > 0
    ? Math.min(transactionLogCurrentPage, Math.ceil(filteredTransactionLogs.length / ITEMS_PER_PAGE))
    : 1;
  const currentTransactionLogs = filteredTransactionLogs.slice(
    (transactionLogPage - 1) * ITEMS_PER_PAGE,
    transactionLogPage * ITEMS_PER_PAGE,
  );

  const filteredActivityLogs = engineState.activityLogs.filter(
    (log) =>
      isInSelectedRange(log.createdAt) && (
        log.target.toLowerCase().includes(activityLogSearchTerm.toLowerCase()) ||
        log.action.toLowerCase().includes(activityLogSearchTerm.toLowerCase()) ||
        log.details.toLowerCase().includes(activityLogSearchTerm.toLowerCase())
      ),
  );
  const activityLogPage = filteredActivityLogs.length > 0
    ? Math.min(activityLogCurrentPage, Math.ceil(filteredActivityLogs.length / ITEMS_PER_PAGE))
    : 1;
  const currentActivityLogs = filteredActivityLogs.slice(
    (activityLogPage - 1) * ITEMS_PER_PAGE,
    activityLogPage * ITEMS_PER_PAGE,
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
  const holderSyncRunning = engineState.tokenHolderSyncState?.status === 'running';
  const tokenHolderAggregateLoading =
    Boolean(activeTokenContractAddress) &&
    holderSyncRunning &&
    !engineState.tokenHolderAggregate &&
    outsideHolderPage.totalItems === 0;
  const outsideHolderPartial =
    !tokenHolderAggregateLoading &&
    (
      engineState.tokenHolderAggregate?.source === 'rpc_owner_prefix_shards_partial' ||
      (
        !engineState.tokenHolderAggregate &&
        outsideHolderPage.totalItems > 0
      )
    );
  const outsideHolderCount =
    engineState.tokenHolderAggregate?.outsiderHolderCount ??
    (outsideHolderPage.totalItems > 0
      ? outsideHolderPage.totalItems
      : null);
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
      totalTransactionLogsCount={combinedTransactionLogs.length}
      filteredTransactionLogsCount={filteredTransactionLogs.length}
      transactionLogSearchTerm={transactionLogSearchTerm}
      onTransactionLogSearchTermChange={(value) => {
        setTransactionLogSearchTerm(value);
        setTransactionLogCurrentPage(1);
      }}
      transactionLogCurrentPage={transactionLogPage}
      onTransactionLogPageChange={setTransactionLogCurrentPage}
      transactionLogDateFilterActive={hasDateRange}
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
      activityLogCurrentPage={activityLogPage}
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
      outsideHolderRows={outsideHolderPage.items}
      outsideHolderRowsTotal={outsideHolderPage.totalItems}
      outsideHolderSort={outsideHolderSort}
      onOutsideHolderSortChange={(value) => {
        setOutsideHolderSort(value);
        setOutsiderPage(1);
      }}
      outsideHolderCount={outsideHolderCount}
      outsideHolderTotalAmount={outsideHolderTotalAmount}
      outsideHolderSummaryLoading={tokenHolderAggregateLoading}
      outsideHolderListLoading={outsideHolderPageLoading}
      outsideHolderPartial={outsideHolderPartial}
      activeTokenContractAddress={activeTokenContractAddress}
      activeTokenSymbol={activeTokenSymbol}
      walletBalances={walletBalances}
      walletBalanceErrors={walletBalanceErrors}
      walletBalancePending={walletBalancePending}
      internalPage={internalPage}
      outsiderPage={outsiderPage}
      onInternalPageChange={setInternalPage}
      onOutsiderPageChange={setOutsiderPage}
      onOpenAdmin={() => setIsAdminModalOpen(true)}
      onRefreshInternalBalances={() => void refreshInternalWalletBalances()}
      onRefreshOutsideBalances={() => void refreshOutsideWalletBalances()}
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
      activeStrategyVersionNo={engineState.activeStrategyVersion?.versionNo ?? null}
      activeStrategyStatus={engineState.activeStrategyVersion?.status ?? null}
    />
  );

  const renderSetups = () => (
    <HistoricalSetupsPage />
  );

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 p-4 font-sans text-slate-200 md:p-6">
      <AppHeader
        contractAddress={settings.contractAddress || CONTRACT_ADDRESS}
        lastUpdated={lastUpdated}
        isTradingActive={isTradingActive}
        isRefreshing={isRefreshPending}
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
    </div>
  );
}
