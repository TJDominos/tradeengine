export type StrategyType = 'solana-auto-trade';

export type StrategyVersionStatus =
  | 'draft'
  | 'published'
  | 'active'
  | 'retired';

export type StrategyEvaluationStatus = 'accepted' | 'blocked' | 'error';

export type StrategyTriggerSource =
  | 'alchemy_notify'
  | 'manual_refresh'
  | 'manual_trade'
  | 'dashboard_refresh'
  | 'unknown';

export interface StrategySettingsInput {
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

export interface StrategyParameters {
  contractAddress: string;
  timeRangeTarget: string;
  maxTransactions: number;
  maxSlippageBps: number;
  notes: string;
}

export interface StrategyTriggerConfig {
  sources: StrategyTriggerSource[];
  eventTypes: string[];
  cooldownMs: number;
  idempotencyWindowMs: number;
}

export interface StrategyTargets {
  volumeUsdMin: number;
  netBuyinUsdMin: number;
  volatilityPctMin: number;
  pullbackPctMax: number;
}

export interface StrategyRiskControls {
  maxPositionUsd: number | null;
  maxDailyLossUsd: number | null;
  maxConcurrentOrders: number;
  dryRun: boolean;
  requireCompleteMetrics: boolean;
}

export interface StrategyExecutionConfig {
  enabled: boolean;
  route: 'jupiter';
  commitment: 'confirmed';
}

export interface StrategyMetadata {
  author: string | null;
  changeNote: string;
  origin: 'settings-sync' | 'manual' | 'migration';
  legacySettingsSnapshot: Record<string, unknown>;
}

export interface StrategyVersionDocument {
  schemaVersion: number;
  engineVersion: string;
  strategyType: StrategyType;
  parameters: StrategyParameters;
  triggers: StrategyTriggerConfig;
  targets: StrategyTargets;
  riskControls: StrategyRiskControls;
  execution: StrategyExecutionConfig;
  metadata: StrategyMetadata;
}

export interface StrategyTriggerEvent {
  source: StrategyTriggerSource;
  eventType: string;
  externalId: string | null;
  contractAddress: string;
  walletAddress: string | null;
  txSignature: string | null;
  triggeredAt: number;
  payloadJson: string | null;
}

export interface StrategyMarketSnapshot {
  contractAddress: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  volume24h: number | null;
  totalTransactions24h: number | null;
  outsidersOverOneUsd: number | null;
  fetchedAt: number;
}

export interface StrategyEvaluationMetric {
  name: string;
  required: boolean;
  available: boolean;
  value: number | string | null;
  threshold: number | string | null;
  comparator: 'gte' | 'lte' | 'eq' | null;
  satisfied: boolean | null;
  note?: string;
}

export interface StrategyEvaluationInput {
  strategy: StrategyVersionDocument;
  trigger: StrategyTriggerEvent;
  marketSnapshot: StrategyMarketSnapshot | null;
  evaluatedAt: number;
}

export interface StrategyEvaluationResult {
  status: StrategyEvaluationStatus;
  qualified: boolean;
  shouldExecute: boolean;
  dryRun: boolean;
  reasons: string[];
  metrics: StrategyEvaluationMetric[];
  triggerAccepted: boolean;
  contractMatched: boolean;
  snapshotPresent: boolean;
  snapshotFresh: boolean;
}

export interface StrategyRuntimeResult {
  strategy: StrategyVersionDocument;
  evaluation: StrategyEvaluationResult;
  summary: Record<string, unknown>;
}

export interface StrategyDefinitionRecord {
  id: number;
  userId: number;
  name: string;
  strategyType: StrategyType;
  currentVersionId: number | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface StrategyVersionRecord {
  id: number;
  strategyId: number;
  versionNo: number;
  schemaVersion: number;
  engineVersion: string;
  strategyType: StrategyType;
  status: StrategyVersionStatus;
  checksum: string;
  changeNote: string | null;
  createdAt: number;
  activatedAt: number | null;
  document: StrategyVersionDocument;
}

export interface StrategyEvaluationPersistedRecord {
  id: number;
  userId: number;
  strategyVersionId: number;
  source: StrategyTriggerSource;
  eventType: string;
  externalId: string | null;
  contractAddress: string;
  walletAddress: string | null;
  txSignature: string | null;
  status: StrategyEvaluationStatus;
  shouldExecute: boolean;
  dryRun: boolean;
  summaryJson: string;
  createdAt: number;
}