import type {
  SettingsState,
} from './types';
import { SOLANA_USDC_MINT } from '../backend/workerShared';
import type {
  StrategyFieldPath,
  StrategyFieldSchema,
  StrategySectionSchema,
  StrategyVersionDocument,
} from './strategyTypes';

export const STRATEGY_SECTION_SCHEMAS: StrategySectionSchema[] = [
  {
    id: 'basic',
    title: 'Basic',
    description: 'Top-level strategy identity and currently targeted contract.',
  },
  {
    id: 'objective',
    title: 'Macro Objective',
    description: 'Primary campaign mode that drives the hierarchical state machine.',
  },
  {
    id: 'tactics',
    title: 'Tactics',
    description: 'Objective-specific reaction ratios used for tactical, high-priority responses.',
  },
  {
    id: 'parameters',
    title: 'Parameters',
    description: 'Global settings that define the strategy operating window and core limits.',
  },
  {
    id: 'triggers',
    title: 'Triggers',
    description: 'Which event sources can wake the strategy up and how they are throttled.',
  },
  {
    id: 'targets',
    title: 'Targets',
    description: 'Thresholds that decide whether a trigger qualifies for execution.',
  },
  {
    id: 'riskControls',
    title: 'Risk Controls',
    description: 'Hard limits and execution safety switches.',
  },
  {
    id: 'execution',
    title: 'Execution',
    description: 'How the strategy would attempt to route an order when execution is enabled.',
  },
];

export const STRATEGY_FIELD_SCHEMAS: StrategyFieldSchema[] = [
  {
    id: 'contractAddress',
    path: 'parameters.contractAddress',
    section: 'basic',
    label: 'Target Contract',
    description: 'Selected from the tracked pair registry. Saving the strategy persists the chosen pair as the active market pair.',
    fieldType: 'select',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'notes',
    path: 'parameters.notes',
    section: 'basic',
    label: 'Strategy Notes',
    description: 'Human-readable notes that explain what this version is for.',
    fieldType: 'textarea',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'baseTokenAddress',
    path: 'parameters.baseTokenAddress',
    section: 'basic',
    label: 'Base Token Mint',
    description: 'The token you are accumulating or distributing. For most strategies this should match the target contract mint.',
    fieldType: 'text',
    capability: 'supported',
    editable: true,
    placeholder: 'Base token mint address',
  },
  {
    id: 'quoteTokenAddress',
    path: 'parameters.quoteTokenAddress',
    section: 'basic',
    label: 'Quote Token Mint',
    description: 'The token used to price and fund the pair, such as USDC.',
    fieldType: 'text',
    capability: 'supported',
    editable: true,
    placeholder: 'Quote token mint address',
  },
  {
    id: 'timeRangeTarget',
    path: 'parameters.timeRangeTarget',
    section: 'parameters',
    label: 'Time Range Target',
    description: 'Currently only 24h aggregate metrics are available for live qualification.',
    fieldType: 'select',
    capability: 'partial',
    editable: true,
    options: [
      { label: '1 Hour', value: '1h' },
      { label: '6 Hours', value: '6h' },
      { label: '12 Hours', value: '12h' },
      { label: '24 Hours', value: '24h' },
      { label: '3 Days', value: '3d' },
      { label: '1 Week', value: '1w' },
    ],
  },
  {
    id: 'minTransactions',
    path: 'parameters.minTransactions',
    section: 'parameters',
    label: 'Min Planned Trades',
    description: 'Lower bound for planner-generated base trades across the current strategy objective.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'maxTransactions',
    path: 'parameters.maxTransactions',
    section: 'parameters',
    label: 'Max Transactions',
    description: 'Upper bound for accepted aggregate market transactions within the chosen time range, and the planner cap for generated base trades.',
    fieldType: 'number',
    capability: 'partial',
    editable: true,
  },
  {
    id: 'maxSlippageBps',
    path: 'parameters.maxSlippageBps',
    section: 'parameters',
    label: 'Max Slippage (%)',
    description: 'Stored internally as basis points.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
    unitLabel: '%',
    parseInput: (value) => Math.round((Number(value) || 0) * 100),
    formatValue: (value) => String((Number(value) || 0) / 100),
  },
  {
    id: 'macroObjective',
    path: 'execution.macroObjective',
    section: 'objective',
    label: 'Macro Objective',
    description: 'Select the dominant campaign behavior the bot should optimize for.',
    fieldType: 'select',
    capability: 'supported',
    editable: true,
    options: [
      { label: 'Shakeout', value: 'shakeout' },
      { label: 'Distribution', value: 'distribution' },
      { label: 'Accumulation', value: 'accumulation' },
    ],
  },
  {
    id: 'dumpRatio',
    path: 'execution.tactics.dumpRatio',
    section: 'tactics',
    label: 'Dump Ratio',
    description: 'Shakeout multiplier for selling harder than the observed external buy.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
    unitLabel: 'x',
    parseInput: (value) => Math.max(0, Number(value) || 0),
  },
  {
    id: 'followSellRatio',
    path: 'execution.tactics.followSellRatio',
    section: 'tactics',
    label: 'Follow Sell Ratio',
    description: 'Distribution multiplier for selling into external buy pressure without fully overwhelming it.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
    unitLabel: 'x',
    parseInput: (value) => Math.max(0, Number(value) || 0),
  },
  {
    id: 'absorbRatio',
    path: 'execution.tactics.absorbRatio',
    section: 'tactics',
    label: 'Absorb Ratio',
    description: 'Accumulation multiplier for instantly absorbing external sell pressure.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
    unitLabel: 'x',
    parseInput: (value) => Math.max(0, Number(value) || 0),
  },
  {
    id: 'triggerSources',
    path: 'triggers.sources',
    section: 'triggers',
    label: 'Trigger Sources',
    description: 'Comma-separated event source list. Current runtime supports manual_refresh and alchemy_notify.',
    fieldType: 'string-array',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'triggerEventTypes',
    path: 'triggers.eventTypes',
    section: 'triggers',
    label: 'Trigger Event Types',
    description: 'Comma-separated event types. Use * to accept all supported events from the selected sources.',
    fieldType: 'string-array',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'cooldownMs',
    path: 'triggers.cooldownMs',
    section: 'triggers',
    label: 'Cooldown (ms)',
    description: 'Minimum delay before the same strategy can react again to new triggers.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'idempotencyWindowMs',
    path: 'triggers.idempotencyWindowMs',
    section: 'triggers',
    label: 'Idempotency Window (ms)',
    description: 'How long duplicate trigger ids should be considered the same event.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'triggerThresholdUsd',
    path: 'triggers.triggerThresholdUsd',
    section: 'triggers',
    label: 'External Trigger Threshold (USD)',
    description: 'Ignore external trades below this USD threshold.',
    fieldType: 'number',
    capability: 'partial',
    editable: true,
    unitLabel: 'USD',
  },
  {
    id: 'volumeUsdMin',
    path: 'targets.volumeUsdMin',
    section: 'targets',
    label: 'Volume Target (USDC)',
    description: 'Uses the current 24h aggregate volume from the market snapshot.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'netBuyinUsdMin',
    path: 'targets.netBuyinUsdMin',
    section: 'targets',
    label: 'Net Buyin Target (USDC)',
    description: 'Planned field. The current runtime does not yet derive net buyin from live data.',
    fieldType: 'number',
    capability: 'partial',
    editable: true,
  },
  {
    id: 'volatilityPctMin',
    path: 'targets.volatilityPctMin',
    section: 'targets',
    label: 'Volatility Target (%)',
    description: 'Planned field. The current runtime does not yet derive volatility from live data.',
    fieldType: 'number',
    capability: 'partial',
    editable: true,
    unitLabel: '%',
  },
  {
    id: 'pullbackPctMax',
    path: 'targets.pullbackPctMax',
    section: 'targets',
    label: 'Outsider Pull Back (%)',
    description: 'Planned field. The current runtime does not yet derive pullback from live data.',
    fieldType: 'number',
    capability: 'partial',
    editable: true,
    unitLabel: '%',
  },
  {
    id: 'maxPositionUsd',
    path: 'riskControls.maxPositionUsd',
    section: 'riskControls',
    label: 'Max Position (USDC)',
    description: 'Reserved for future execution sizing rules.',
    fieldType: 'number',
    capability: 'planned',
    editable: true,
  },
  {
    id: 'maxDailyLossUsd',
    path: 'riskControls.maxDailyLossUsd',
    section: 'riskControls',
    label: 'Max Daily Loss (USDC)',
    description: 'Reserved for future execution sizing rules.',
    fieldType: 'number',
    capability: 'planned',
    editable: true,
  },
  {
    id: 'maxConcurrentOrders',
    path: 'riskControls.maxConcurrentOrders',
    section: 'riskControls',
    label: 'Max Concurrent Orders',
    description: 'Execution safety cap that will apply once live automated order routing is enabled.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'requireCompleteMetrics',
    path: 'riskControls.requireCompleteMetrics',
    section: 'riskControls',
    label: 'Require Complete Metrics',
    description: 'Block execution when the runtime cannot fully evaluate configured targets.',
    fieldType: 'boolean',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'executionEnabled',
    path: 'execution.enabled',
    section: 'execution',
    label: 'Execution Enabled',
    description: 'Enables live execution planning when the strategy qualifies.',
    fieldType: 'boolean',
    capability: 'partial',
    editable: true,
  },
  {
    id: 'executionRoute',
    path: 'execution.route',
    section: 'execution',
    label: 'Execution Route',
    description: 'Current backend supports Jupiter routing only.',
    fieldType: 'select',
    capability: 'supported',
    editable: false,
    options: [{ label: 'Jupiter', value: 'jupiter' }],
  },
  {
    id: 'executionCommitment',
    path: 'execution.commitment',
    section: 'execution',
    label: 'Commitment',
    description: 'Current backend supports confirmed commitment only.',
    fieldType: 'select',
    capability: 'supported',
    editable: false,
    options: [{ label: 'confirmed', value: 'confirmed' }],
  },
  {
    id: 'timeJitterRatio',
    path: 'execution.timeJitterRatio',
    section: 'execution',
    label: 'Time Jitter Ratio',
    description: 'Randomizes delay between TWAP slices using a bounded uniform ratio.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'volumeJitterRatio',
    path: 'execution.volumeJitterRatio',
    section: 'execution',
    label: 'Volume Jitter Ratio',
    description: 'Randomizes per-slice TWAP notional while preserving total planned volume.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'accountCyclingEnabled',
    path: 'execution.accountCyclingEnabled',
    section: 'execution',
    label: 'Account Cycling',
    description: 'Rotate planned orders across eligible accounts instead of spreading every slice across the whole pool.',
    fieldType: 'boolean',
    capability: 'supported',
    editable: true,
  },
  {
    id: 'accountDispersionStrength',
    path: 'execution.accountDispersionStrength',
    section: 'execution',
    label: 'Account Dispersion Strength',
    description: 'Higher values reduce the weight of accounts that have already accumulated more planned volume.',
    fieldType: 'number',
    capability: 'supported',
    editable: true,
  },
];

export function createStrategyDraftFromSettings(
  settings: SettingsState,
): StrategyVersionDocument {
  const activeBaseTokenAddress = settings.activeBaseTokenAddress ?? settings.baseTokenAddress;
  const activeQuoteTokenAddress = settings.activeQuoteTokenAddress ?? SOLANA_USDC_MINT;
  return {
    schemaVersion: 2,
    engineVersion: '1.0.0',
    strategyType: 'solana-auto-trade',
    parameters: {
      contractAddress: activeBaseTokenAddress,
      baseTokenAddress: activeBaseTokenAddress,
      quoteTokenAddress: activeQuoteTokenAddress,
      ammPoolAddress: '',
      timeRangeTarget: settings.timeRangeTarget,
      minTransactions: 1,
      maxTransactions: settings.maxTransactions,
      minOrderUsd: 1,
      maxOrderUsd: 100,
      maxSlippageBps: Math.round(settings.maxSlippage * 100),
      notes: settings.strategyNotes,
    },
    triggers: {
      sources: ['alchemy_notify', 'manual_refresh'],
      eventTypes: ['*'],
      cooldownMs: 30_000,
      idempotencyWindowMs: 300_000,
      onExternalBuy: 'watch_and_wait',
      onExternalSell: 'pause_strategy',
      triggerThresholdUsd: 0,
    },
    targets: {
      volumeUsdMin: settings.volumeTarget,
      netBuyinUsdMin: settings.netBuyinTarget,
      volatilityPctMin: settings.volatilityTarget,
      pullbackPctMax: settings.pullbackTarget,
    },
    riskControls: {
      maxPositionUsd: null,
      maxDailyLossUsd: null,
      maxConcurrentOrders: 1,
      requireCompleteMetrics: true,
    },
    execution: {
      enabled: true,
      route: 'jupiter',
      commitment: 'confirmed',
      timeJitterRatio: 0.15,
      volumeJitterRatio: 0.15,
      accountCyclingEnabled: true,
      accountDispersionStrength: 0.5,
      macroObjective: 'accumulation',
      tactics: {
        dumpRatio: 1.2,
        followSellRatio: 0.8,
        absorbRatio: 1.0,
      },
    },
    metadata: {
      author: null,
      changeNote: settings.strategyNotes,
      origin: 'settings-sync',
      legacySettingsSnapshot: {},
    },
  };
}

export function readStrategyFieldValue(
  document: StrategyVersionDocument,
  path: StrategyFieldPath,
): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, document);
}

export function updateStrategyFieldValue(
  document: StrategyVersionDocument,
  path: StrategyFieldPath,
  value: unknown,
): StrategyVersionDocument {
  const keys = path.split('.');

  const setNestedValue = (
    current: unknown,
    nestedKeys: string[],
    nextValue: unknown,
  ): unknown => {
    if (nestedKeys.length === 0) {
      return nextValue;
    }
    const [key, ...rest] = nestedKeys;
    const currentRecord =
      current != null && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};
    return {
      ...currentRecord,
      [key]: rest.length === 0
        ? nextValue
        : setNestedValue(currentRecord[key], rest, nextValue),
    };
  };

  return setNestedValue(document, keys, value) as StrategyVersionDocument;
}

export function getStrategyFieldsForSection(sectionId: StrategySectionSchema['id']) {
  return STRATEGY_FIELD_SCHEMAS.filter((field) => field.section === sectionId);
}