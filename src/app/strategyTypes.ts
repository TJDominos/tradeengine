export type StrategyType = 'solana-auto-trade';

export type StrategyVersionStatus =
  | 'draft'
  | 'published'
  | 'active'
  | 'retired';

export type StrategyTriggerSource =
  | 'alchemy_notify'
  | 'manual_refresh'
  | 'manual_trade'
  | 'dashboard_refresh'
  | 'unknown';

export type StrategyEvaluationStatus = 'accepted' | 'blocked' | 'error';

export type StrategyFieldCapability = 'supported' | 'partial' | 'planned';

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

export interface StrategyEvaluationRecord {
  id: number;
  userId: number;
  strategyVersionId: number;
  strategyVersionNo: number;
  source: string;
  eventType: string;
  externalId: string | null;
  contractAddress: string;
  walletAddress: string | null;
  txSignature: string | null;
  status: StrategyEvaluationStatus;
  shouldExecute: boolean;
  dryRun: boolean;
  summary: Record<string, unknown>;
  createdAt: number;
}

export type StrategySectionId =
  | 'basic'
  | 'parameters'
  | 'triggers'
  | 'targets'
  | 'riskControls'
  | 'execution';

export type StrategyFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'boolean'
  | 'string-array';

export type StrategyFieldPath =
  | 'parameters.contractAddress'
  | 'parameters.timeRangeTarget'
  | 'parameters.maxTransactions'
  | 'parameters.maxSlippageBps'
  | 'parameters.notes'
  | 'triggers.sources'
  | 'triggers.eventTypes'
  | 'triggers.cooldownMs'
  | 'triggers.idempotencyWindowMs'
  | 'targets.volumeUsdMin'
  | 'targets.netBuyinUsdMin'
  | 'targets.volatilityPctMin'
  | 'targets.pullbackPctMax'
  | 'riskControls.maxPositionUsd'
  | 'riskControls.maxDailyLossUsd'
  | 'riskControls.maxConcurrentOrders'
  | 'riskControls.dryRun'
  | 'riskControls.requireCompleteMetrics'
  | 'execution.enabled'
  | 'execution.route'
  | 'execution.commitment';

export interface StrategyFieldSchema {
  id: string;
  path: StrategyFieldPath;
  section: StrategySectionId;
  label: string;
  description?: string;
  fieldType: StrategyFieldType;
  capability: StrategyFieldCapability;
  editable: boolean;
  placeholder?: string;
  unitLabel?: string;
  options?: Array<{ label: string; value: string }>;
  parseInput?: (value: string | boolean) => unknown;
  formatValue?: (value: unknown) => string | boolean;
}

export interface StrategySectionSchema {
  id: StrategySectionId;
  title: string;
  description: string;
}