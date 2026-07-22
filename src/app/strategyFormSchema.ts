import type {
  SettingsState,
} from './types';
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
    description: 'Managed by the tracked token registry. Changing the active token updates this automatically.',
    fieldType: 'text',
    capability: 'supported',
    editable: false,
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
    id: 'maxTransactions',
    path: 'parameters.maxTransactions',
    section: 'parameters',
    label: 'Max Transactions',
    description: 'Upper bound for accepted aggregate transactions within the chosen time range.',
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
    id: 'dryRun',
    path: 'riskControls.dryRun',
    section: 'riskControls',
    label: 'Dry Run',
    description: 'When enabled, the strategy can qualify and log decisions but must not place real trades.',
    fieldType: 'boolean',
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
    description: 'Currently the runtime still remains dry-run / backend-gated even when enabled here.',
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
];

export function createStrategyDraftFromSettings(
  settings: SettingsState,
): StrategyVersionDocument {
  return {
    schemaVersion: 1,
    engineVersion: '1.0.0',
    strategyType: 'solana-auto-trade',
    parameters: {
      contractAddress: settings.contractAddress,
      timeRangeTarget: settings.timeRangeTarget,
      maxTransactions: settings.maxTransactions,
      maxSlippageBps: Math.round(settings.maxSlippage * 100),
      notes: settings.strategyNotes,
    },
    triggers: {
      sources: ['alchemy_notify', 'manual_refresh'],
      eventTypes: ['*'],
      cooldownMs: 30_000,
      idempotencyWindowMs: 300_000,
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
      dryRun: true,
      requireCompleteMetrics: true,
    },
    execution: {
      enabled: false,
      route: 'jupiter',
      commitment: 'confirmed',
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
  const [sectionKey, fieldKey] = path.split('.') as [keyof StrategyVersionDocument, string];
  const currentSection = document[sectionKey] as unknown as Record<string, unknown>;
  const nextSection = {
    ...currentSection,
    [fieldKey]: value,
  };
  return {
    ...document,
    [sectionKey]: nextSection,
  };
}

export function getStrategyFieldsForSection(sectionId: StrategySectionSchema['id']) {
  return STRATEGY_FIELD_SCHEMAS.filter((field) => field.section === sectionId);
}