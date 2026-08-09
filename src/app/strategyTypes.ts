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

export type StrategyMacroObjective =
  | 'shakeout'
  | 'distribution'
  | 'accumulation';

export interface StrategyExecutionTactics {
  dumpRatio: number;
  followSellRatio: number;
  absorbRatio: number;
}

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

export type StrategyExternalBuyAction =
  | 'reduce_target'
  | 'counter_trade'
  | 'watch_and_wait';

export type StrategyExternalSellAction = 'buy_the_dip' | 'pause_strategy';

export interface StrategyParameters {
  contractAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  ammPoolAddress: string;
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
  onExternalBuy: StrategyExternalBuyAction;
  onExternalSell: StrategyExternalSellAction;
  triggerThresholdUsd: number;
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
  requireCompleteMetrics: boolean;
}

export interface StrategyExecutionConfig {
  enabled: boolean;
  route: 'jupiter';
  commitment: 'confirmed';
  timeJitterRatio: number;
  volumeJitterRatio: number;
  accountCyclingEnabled: boolean;
  accountDispersionStrength: number;
  macroObjective: StrategyMacroObjective;
  tactics: StrategyExecutionTactics;
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
  summary: Record<string, unknown>;
  createdAt: number;
}

export type StrategySectionId =
  | 'basic'
  | 'objective'
  | 'tactics'
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
  | 'parameters.baseTokenAddress'
  | 'parameters.quoteTokenAddress'
  | 'parameters.ammPoolAddress'
  | 'parameters.timeRangeTarget'
  | 'parameters.maxTransactions'
  | 'parameters.maxSlippageBps'
  | 'parameters.notes'
  | 'triggers.sources'
  | 'triggers.eventTypes'
  | 'triggers.cooldownMs'
  | 'triggers.idempotencyWindowMs'
  | 'triggers.onExternalBuy'
  | 'triggers.onExternalSell'
  | 'triggers.triggerThresholdUsd'
  | 'targets.volumeUsdMin'
  | 'targets.netBuyinUsdMin'
  | 'targets.volatilityPctMin'
  | 'targets.pullbackPctMax'
  | 'riskControls.maxPositionUsd'
  | 'riskControls.maxDailyLossUsd'
  | 'riskControls.maxConcurrentOrders'
  | 'riskControls.requireCompleteMetrics'
  | 'execution.enabled'
  | 'execution.route'
  | 'execution.commitment'
  | 'execution.timeJitterRatio'
  | 'execution.volumeJitterRatio'
  | 'execution.accountCyclingEnabled'
  | 'execution.accountDispersionStrength'
  | 'execution.macroObjective'
  | 'execution.tactics.dumpRatio'
  | 'execution.tactics.followSellRatio'
  | 'execution.tactics.absorbRatio';

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