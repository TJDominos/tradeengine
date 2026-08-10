import type {
  StrategyEvaluationRecord,
  StrategyVersionRecord,
} from './strategyTypes';

export type TabId = 'dashboard' | 'accounts' | 'setup' | 'setups';

export type AuthStatus = {
  setupRequired: boolean;
  authenticated: boolean;
  user?: { username: string; role: string } | null;
};

export type SettingsState = {
  baseTokenAddress: string;
  activeBaseTokenAddress?: string;
  activeQuoteTokenAddress?: string;
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

export type AccountRecord = {
  id: number;
  label: string;
  address: string;
  type: string;
  capabilityBaseMint?: string | null;
  capabilityQuoteMint?: string | null;
  createdAt: number;
  isActive: boolean;
  walletUsdcBalance?: number | null;
  walletSolBalance?: number | null;
  walletActiveTokenMint?: string | null;
  walletActiveTokenBalance?: number | null;
  walletBalanceUpdatedAt?: number | null;
};

export type DerivedAccountPreview = {
  accountIndex: number;
  derivationPath: string;
  address: string;
  alreadyImported: boolean;
};

export type AuditLog = {
  id: number;
  action: string;
  target: string;
  details: string;
  actor: string;
  createdAt: number;
};

export type TradeLog = {
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
  executionTraceJson?: string | null;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type WebhookTransactionLog = {
  id: number;
  tokenContractAddress: string | null;
  tokenSymbol: string | null;
  walletAddress: string | null;
  fromWalletAddress: string | null;
  toWalletAddress: string | null;
  action: 'BUY' | 'SELL' | null;
  usdcAmount: number | null;
  tokenAmount: number | null;
  feeAmountUsd: number | null;
  source: 'webhook' | 'rpc_reconcile';
  eventType: string;
  txSignature: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  errorMessage: string | null;
  createdAt: number;
};

export type RpcEndpoint = {
  id: number;
  network: string;
  url: string;
  isActive: boolean;
  createdAt: number;
};

export type TokenMarketSnapshot = {
  network: string;
  baseTokenAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  volume24h: number | null;
  totalTransactions24h: number | null;
  totalHolders?: number | null;
  outsidersOverOneUsd: number | null;
  dexId: string | null;
  pairAddress: string | null;
  fetchedAt: number;
};

export type TokenHolderAggregate = {
  tokenId: number;
  activeHolderCount: number;
  internalHolderCount: number;
  watchedHolderCount: number;
  outsiderHolderCount: number;
  totalAmountHolding: number;
  internalAmountHolding: number;
  watchedAmountHolding: number;
  lastFullSyncAt: number | null;
  lastDeltaSyncAt: number | null;
  updatedAt: number;
  source: string;
};

export type TokenHolderSyncState = {
  tokenId: number;
  runId: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed';
  source: string;
  nextShardIndex: number;
  processedShardCount: number;
  totalShardCount: number;
  stagedHolderCount: number;
  lastProgramId: string | null;
  lastOwnerPrefix: number | null;
  errorMessage: string | null;
  startedAt: number | null;
  updatedAt: number;
  lastCompletedAt: number | null;
};

export type MarketRefreshStatus = {
  contractAddress: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  requestId: string | null;
  errorMessage: string | null;
  summaryText: string | null;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
};

export type OutsideTokenHolder = {
  address: string;
  label: string | null;
  amountHolding: number;
  source: string;
  ownership: 'internal' | 'outside';
  firstSeenAt: number | null;
  updatedAt: number;
  usdcBalance: number | null;
  solBalance: number | null;
  balanceUpdatedAt: number | null;
};

export type OutsideTokenHolderPage = {
  items: OutsideTokenHolder[];
  page: number;
  pageSize: number;
  totalItems: number;
  latestUpdatedAt: number | null;
  changeToken: string;
  latestChangedAddresses: string[];
  unchanged: boolean;
};

export type StrategyPlanPreviewAllocation = {
  accountId: number;
  label: string;
  walletAddress: string;
  plannedVolumeUsd: number;
  quoteAvailableAmount: number;
  baseTokenAmount: number;
  solBalance: number;
  accountBuyOverAllocated: boolean;
  accountBuyOverAllocationUsd: number;
};

export type StrategyPlanPreviewTask = {
  taskId: string;
  side: 'buy' | 'sell';
  pulse: string | null;
  orderIndex: number;
  totalOrders: number;
  scheduledAt: number;
  totalVolumeUsd: number;
  unallocatedVolumeUsd: number;
  allocations: StrategyPlanPreviewAllocation[];
};

export type StrategyPlanPreviewAccount = {
  accountId: number;
  label: string;
  walletAddress: string;
  quoteAvailableAmount: number;
  baseTokenAmount: number;
  solBalance: number;
  plannedBuyVolumeUsd: number;
  plannedSellVolumeUsd: number;
  buyOverAllocationUsd: number;
  buyRemainingQuoteUsd: number;
  isBuyOverAllocated: boolean;
  pairCompatible: boolean;
  eligibleForBuy: boolean;
  eligibleForSell: boolean;
};

export type StrategyPlanPreview = {
  generatedAt: number;
  pair: {
    baseTokenAddress: string;
    quoteTokenAddress: string;
  };
  macroObjective: 'shakeout' | 'distribution' | 'accumulation';
  accountCyclingEnabled: boolean;
  quoteLabel: string;
  requiredBuyAmount: number;
  availableBuyAmount: number;
  enabledAccountCount: number;
  eligibleAccountCount: number;
  skippedForCapabilityCount: number;
  skippedForSolReserveCount: number;
  sufficientBuyCapacity: boolean;
  tasks: StrategyPlanPreviewTask[];
  accounts: StrategyPlanPreviewAccount[];
};

export type TradableToken = {
  id: number;
  network: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  ammPoolAddress?: string | null;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  quoteTokenSymbol?: string | null;
  quoteTokenName?: string | null;
  quoteTokenDecimals?: number | null;
  isActive: boolean;
};

export type TokenWebhookCheck = {
  ok: boolean;
  checkedAt: number;
  latestSignature: string | null;
  errorMessage: string | null;
};

export type HistoricalSetup = {
  id: number;
  tokenSymbol: string | null;
  baseTokenAddress: string | null;
  timeRangeTarget: string;
  maxTransactions: number;
  maxSlippage: number;
  volumeTarget: number;
  netBuyinTarget: number;
  volatilityTarget: number;
  pullbackTarget: number;
  createdAt: number;
};

export type WalletBalanceToken = {
  mint: string;
  symbol: string;
  network: string;
  amount: string;
  decimals: number | null;
};

export type WalletBalance = {
  address: string;
  sol: string;
  usdc: string;
  tokens: WalletBalanceToken[];
  updatedAt: number;
};

export type EngineState = {
  auth: { username: string; role: string };
  settings: SettingsState;
  internalAccs: AccountRecord[];
  internalAccountSummary: AccountSummary;
  activityLogs: AuditLog[];
  tradeLogs: TradeLog[];
  webhookTransactionLogs: WebhookTransactionLog[];
  tradableTokens: TradableToken[];
  historicalSetups: HistoricalSetup[];
  activeStrategyVersion: StrategyVersionRecord | null;
  strategyVersions: StrategyVersionRecord[];
  strategyEvaluations: StrategyEvaluationRecord[];
  tokenHolderAggregate: TokenHolderAggregate | null;
  tokenHolderSyncState: TokenHolderSyncState | null;
  marketRefreshStatus: MarketRefreshStatus | null;
  outsideTokenHolders: OutsideTokenHolder[];
  rpcEndpoints: RpcEndpoint[];
  marketSnapshot: TokenMarketSnapshot | null;
  marketSnapshotHistory: TokenMarketSnapshot[];
  profitUsdc: number;
  stats: {
    managedAccounts: number;
    tradeExecutionEnabled: boolean;
  };
  system: {
    backend: string;
    databasePath: string;
    databaseConnected: boolean;
  };
};

export type DateRangeState = {
  from: string;
  to: string;
};

export type AccountSummary = {
  total: number;
  activeAccounts?: number;
  activeAssets: number;
  totalSol: number;
  totalUsdc: number;
  trackedWallets: number;
  trackedTokenLines: number;
  totalTrackedTokenAmount?: number;
};

export type DashboardLogTab = 'transaction' | 'activity';

export type DashboardTransactionLog =
  | ({ kind: 'trade' } & TradeLog)
  | ({ kind: 'webhook' } & WebhookTransactionLog);

export type WalletOwnership = 'internal' | 'external' | 'system' | 'untracked';

export type WalletOwnershipMeta = {
  ownership: WalletOwnership;
  accountLabel: string | null;
};

export type {
  StrategyEvaluationRecord,
  StrategyExecutionConfig,
  StrategyFieldCapability,
  StrategyFieldPath,
  StrategyFieldSchema,
  StrategyFieldType,
  StrategyMetadata,
  StrategyParameters,
  StrategyRiskControls,
  StrategySectionId,
  StrategySectionSchema,
  StrategyTargets,
  StrategyTriggerConfig,
  StrategyTriggerSource,
  StrategyType,
  StrategyVersionDocument,
  StrategyVersionRecord,
  StrategyVersionStatus,
} from './strategyTypes';