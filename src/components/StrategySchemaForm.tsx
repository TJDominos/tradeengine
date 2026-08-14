import React from 'react';
import { Controller, useForm } from 'react-hook-form';

import type { StrategyPlanPreview } from '../app/types';
import { api } from '../app/utils';
import type {
  StrategyMacroObjective,
  StrategyVersionDocument,
  TradableToken,
} from '../app/strategyTypes';

type StrategySchemaFormProps = {
  draft: StrategyVersionDocument;
  onChange: (updater: (current: StrategyVersionDocument) => StrategyVersionDocument) => void;
  onSubmit: (reviewedPlan: StrategyPlanPreview) => void;
  isSubmitting: boolean;
  activeStrategyVersionNo: number | null;
  activeStrategyStatus: string | null;
  tradableTokens: TradableToken[];
};

const macroObjectiveOptions: Array<{
  label: string;
  value: StrategyMacroObjective;
  description: string;
}> = [
  {
    label: 'Shakeout',
    value: 'shakeout',
    description: 'Lean into aggressive sell pressure to flush weak hands out of the market.',
  },
  {
    label: 'Distribution',
    value: 'distribution',
    description: 'Exit gradually into strength without fully overwhelming outside buyers.',
  },
  {
    label: 'Accumulation',
    value: 'accumulation',
    description: 'Absorb sell pressure and build position over a longer operating window.',
  },
];

const timeRangeLabels: Record<string, string> = {
  '1h': '1 hour',
  '6h': '6 hours',
  '12h': '12 hours',
  '24h': '24 hours',
  '3d': '3 days',
  '1w': '1 week',
};

const tacticConfig: Record<
  StrategyMacroObjective,
  { field: 'dumpRatio' | 'followSellRatio' | 'absorbRatio'; label: string; helper: string }
> = {
  shakeout: {
    field: 'dumpRatio',
    label: 'Dump Ratio',
    helper: 'Multiplier for selling harder than observed outside buy pressure.',
  },
  distribution: {
    field: 'followSellRatio',
    label: 'Follow Sell Ratio',
    helper: 'Multiplier for distributing into demand without a full counter dump.',
  },
  accumulation: {
    field: 'absorbRatio',
    label: 'Absorb Ratio',
    helper: 'Multiplier for immediately buying into observed outside sell pressure.',
  },
};

function parseBlankableNumber(value: string): number | null {
  if (value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableNumber(value: string): number | null {
  return parseBlankableNumber(value);
}

function formatNumberInputValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '';
  }
  return String(value);
}

const ORDER_AMOUNT_STEP_USD = 0.01;

function formatCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '$0';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatPriceCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '$0.00';
  }
  if (value === 0) {
    return '$0.00';
  }
  if (Math.abs(value) < 0.01) {
    return `$${value.toFixed(6)}`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatPercentFromBps(value: number | null | undefined): string {
  const percent = (Number(value) || 0) / 100;
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 2)}%`;
}

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '0';
  }
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPlannerTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return 'Unavailable';
  }
  return new Date(value).toLocaleTimeString();
}

function humanizeList(values: string[]): string {
  if (values.length === 0) {
    return 'None configured';
  }
  if (values.length === 1 && values[0] === '*') {
    return 'All supported events';
  }
  return values.join(', ');
}

function titleCase(value: string | null): string {
  if (!value) {
    return 'Unknown';
  }
  return value
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function contractPreview(contractAddress: string): string {
  if (contractAddress.length <= 18) {
    return contractAddress || 'No token selected';
  }
  return `${contractAddress.slice(0, 8)}...${contractAddress.slice(-8)}`;
}

function registryPairLabel(token: TradableToken): string {
  const baseLabel = token.symbol ?? token.name ?? contractPreview(token.baseTokenAddress);
  const quoteLabel =
    token.quoteTokenSymbol ?? token.quoteTokenName ?? contractPreview(token.quoteTokenAddress);
  return `${baseLabel} / ${quoteLabel}`;
}

function registryPairValue(token: TradableToken): string {
  return `${token.baseTokenAddress}::${token.quoteTokenAddress}`;
}

function FormCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-800/80 p-6 shadow-lg shadow-slate-950/20">
      <div className="mb-5">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <p className="mt-1 text-sm text-slate-400">{description}</p>
      </div>
      {children}
    </section>
  );
}

function FieldShell({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</span>
      {children}
      {helper ? <p className="text-xs leading-relaxed text-slate-500">{helper}</p> : null}
    </label>
  );
}

function PriceSlopeChart({ review }: { review: StrategyPlanPreview['volatilityReview'] }) {
  const points = review.points.filter((point) => point.priceUsd != null);
  if (!review.available || points.length < 2) {
    return null;
  }

  const width = 360;
  const height = 150;
  const paddingX = 18;
  const paddingY = 16;
  const chartHeight = 96;
  const bottomY = paddingY + chartHeight;
  const prices = points.map((point) => point.priceUsd ?? 0);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = Math.max(0.000001, maxPrice - minPrice);
  const maxAbsFlow = Math.max(1, ...points.map((point) => Math.abs(point.netFlowUsd)));
  const elapsedValues = points.map((point, index) => point.elapsedMs ?? index);
  const maxElapsed = Math.max(1, ...elapsedValues);
  const xForPoint = (point: (typeof points)[number], index: number) => {
    const elapsed = point.elapsedMs ?? index;
    return paddingX + (elapsed / maxElapsed) * (width - paddingX * 2);
  };
  const yForPrice = (priceUsd: number) => paddingY + ((maxPrice - priceUsd) / priceRange) * chartHeight;
  const pricePath = points
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L';
      return `${command} ${xForPoint(point, index).toFixed(2)} ${yForPrice(point.priceUsd ?? 0).toFixed(2)}`;
    })
    .join(' ');
  const firstActionPoint = points.find((point) => point.side !== 'start');
  const lastPoint = points[points.length - 1];
  const minimumSlopePct = Math.min(
    ...points
      .map((point) => point.slopePctPerHour ?? point.slopePct)
      .filter((value): value is number => value != null),
  );
  const maxDrawdownPct = review.maxDrawdownPct ?? 0;

  const startPrice = review.startPriceUsd;
  const lowPrice = review.projectedLowPriceUsd;
  const highPrice = review.projectedHighPriceUsd;

  const lowChangePct =
    startPrice != null && startPrice > 0 && lowPrice != null
      ? ((lowPrice - startPrice) / startPrice) * 100
      : null;
  const highChangePct =
    startPrice != null && startPrice > 0 && highPrice != null
      ? ((highPrice - startPrice) / startPrice) * 100
      : null;

  return (
    <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Price Slope Chart</p>
          <p className="mt-1 text-xs text-slate-400">
            Net flow {formatCurrency(Math.abs(lastPoint?.cumulativeNetFlowUsd ?? 0))} {((lastPoint?.cumulativeNetFlowUsd ?? 0) >= 0) ? 'buy' : 'sell'} pressure
          </p>
        </div>
        <div className="text-right text-xs text-slate-400">
          <p>{maxDrawdownPct.toFixed(2)}% Start -&gt; Low</p>
          <p className="mt-1">{minimumSlopePct.toFixed(2)}%/h steepest slope</p>
          <p className="mt-1">First action: {titleCase(firstActionPoint?.side ?? 'start')}</p>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Projected price slope chart" className="mt-3 h-40 w-full overflow-visible">
        <line x1={paddingX} y1={bottomY} x2={width - paddingX} y2={bottomY} stroke="rgb(51 65 85)" strokeWidth="1" />
        <path d={pricePath} fill="none" stroke="rgb(96 165 250)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((point, index) => {
          const x = xForPoint(point, index);
          const priceY = yForPrice(point.priceUsd ?? 0);
          const barHeight = Math.max(3, Math.min(24, (Math.abs(point.netFlowUsd) / maxAbsFlow) * 24));
          const isSell = point.side === 'sell';
          const isBuy = point.side === 'buy';
          return (
            <g key={`${point.index}-${point.side}-${index}`}>
              {isSell || isBuy ? (
                <line
                  x1={x}
                  y1={bottomY + (isSell ? 0 : 2)}
                  x2={x}
                  y2={bottomY + (isSell ? barHeight : -barHeight)}
                  stroke={isSell ? 'rgb(251 113 133)' : 'rgb(52 211 153)'}
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              ) : null}
              <circle cx={x} cy={priceY} r={index === 0 ? 3 : 2.5} fill={isSell ? 'rgb(251 113 133)' : isBuy ? 'rgb(52 211 153)' : 'rgb(148 163 184)'} />
            </g>
          );
        })}
      </svg>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-400">
        <div>
          <p className="text-slate-500">Start</p>
          <p className="mt-1 font-medium text-slate-200">{formatPriceCurrency(startPrice)}</p>
        </div>
        <div>
          <p className="text-slate-500">Low</p>
          <p className="mt-1 font-medium text-rose-200">{formatPriceCurrency(lowPrice)}</p>
          {lowChangePct != null ? (
            <p className="mt-0.5 text-[11px] text-rose-300">
              {lowChangePct >= 0 ? '+' : ''}{lowChangePct.toFixed(2)}% from start
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-slate-500">High</p>
          <p className="mt-1 font-medium text-emerald-200">{formatPriceCurrency(highPrice)}</p>
          {highChangePct != null ? (
            <p className="mt-0.5 text-[11px] text-emerald-300">
              {highChangePct >= 0 ? '+' : ''}{highChangePct.toFixed(2)}% from start
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function textInputClassName(readOnly = false): string {
  return [
    'w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none transition',
    'placeholder:text-slate-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30',
    readOnly ? 'cursor-not-allowed text-slate-400' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export default function StrategySchemaForm({
  draft,
  onChange,
  onSubmit,
  isSubmitting,
  activeStrategyVersionNo,
  activeStrategyStatus,
  tradableTokens,
}: StrategySchemaFormProps) {
  const { control, register, watch, handleSubmit, reset, getValues, setValue, formState } = useForm<StrategyVersionDocument>({
    defaultValues: draft,
    mode: 'onChange',
  });

  const formData = watch();
  const objective = formData.execution?.macroObjective ?? 'accumulation';
  const activeTactic = tacticConfig[objective];
  const draftSignature = React.useMemo(() => JSON.stringify(draft), [draft]);
  const planPreviewSignature = React.useMemo(() => JSON.stringify(formData), [formData]);
  const previewDocument = React.useMemo(
    () => formData as StrategyVersionDocument,
    [planPreviewSignature],
  );
  const contractOptions = React.useMemo(() => {
    const options = tradableTokens
      .filter((token) => token.network === 'solana' && token.isActive)
      .map((token) => ({
        value: registryPairValue(token),
        label: registryPairLabel(token),
      }));

    const currentContractAddress =
      (draft.parameters.contractAddress ?? draft.parameters.baseTokenAddress ?? '').trim();
    const currentQuoteTokenAddress =
      draft.parameters.quoteTokenAddress?.trim() ?? '';
    const currentPairValue =
      currentContractAddress && currentQuoteTokenAddress
        ? `${currentContractAddress}::${currentQuoteTokenAddress}`
        : currentContractAddress;
    if (
      currentPairValue &&
      !options.some((option) => option.value === currentPairValue)
    ) {
      options.unshift({
        value: currentPairValue,
        label: `${contractPreview(currentContractAddress)} (removed from registry)`,
      });
    }

    return options;
  }, [draft.parameters.contractAddress, draft.parameters.quoteTokenAddress, tradableTokens]);

  const selectedPairValue = React.useMemo(() => {
    const baseTokenAddress = formData.parameters?.contractAddress?.trim();
    const quoteTokenAddress = formData.parameters?.quoteTokenAddress?.trim();
    if (baseTokenAddress && quoteTokenAddress) {
      return `${baseTokenAddress}::${quoteTokenAddress}`;
    }
    return baseTokenAddress ?? '';
  }, [formData.parameters?.contractAddress, formData.parameters?.quoteTokenAddress]);

  const selectedRegistryToken = React.useMemo(
    () =>
      tradableTokens.find(
        (token) =>
          token.network === 'solana' &&
          token.isActive &&
          registryPairValue(token) === selectedPairValue,
      ) ?? null,
    [selectedPairValue, tradableTokens],
  );
  const [planPreview, setPlanPreview] = React.useState<StrategyPlanPreview | null>(null);
  const [planPreviewLoading, setPlanPreviewLoading] = React.useState(false);
  const [planPreviewError, setPlanPreviewError] = React.useState('');
  const previewRequestIdRef = React.useRef(0);

  const loadPlanPreview = React.useCallback(async (previewDocument: StrategyVersionDocument) => {
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setPlanPreviewLoading(true);
    try {
      const preview = await api<StrategyPlanPreview>('/api/strategy/plan-preview', {
        method: 'POST',
        body: JSON.stringify(previewDocument),
      });
      if (previewRequestIdRef.current !== requestId) {
        return;
      }
      setPlanPreview(preview);
      setPlanPreviewError('');
    } catch (err: unknown) {
      if (previewRequestIdRef.current !== requestId) {
        return;
      }
      setPlanPreviewError(
        err instanceof Error ? err.message : 'Failed to generate planner preview',
      );
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setPlanPreviewLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    const currentSignature = JSON.stringify(getValues());
    if (currentSignature !== draftSignature) {
      reset(draft);
    }
  }, [draft, draftSignature, getValues, reset]);

  React.useEffect(() => {
    if (!formState.isDirty) {
      return;
    }
    onChange(() => formData as StrategyVersionDocument);
  }, [formData, formState.isDirty, onChange]);

  React.useEffect(() => {
    if (!selectedRegistryToken) {
      return;
    }
    if (
      formData.parameters?.baseTokenAddress === selectedRegistryToken.baseTokenAddress &&
      formData.parameters?.quoteTokenAddress === selectedRegistryToken.quoteTokenAddress
    ) {
      return;
    }
    reset({
      ...formData,
      parameters: {
        ...formData.parameters,
        contractAddress: selectedRegistryToken.baseTokenAddress,
        baseTokenAddress: selectedRegistryToken.baseTokenAddress,
        quoteTokenAddress: selectedRegistryToken.quoteTokenAddress,
        ammPoolAddress:
          selectedRegistryToken.ammPoolAddress ??
          formData.parameters?.ammPoolAddress ??
          '',
      },
    });
  }, [formData, reset, selectedRegistryToken]);

  React.useEffect(() => {
    previewRequestIdRef.current += 1;
    setPlanPreview(null);
    const baseTokenAddress = formData.parameters?.baseTokenAddress?.trim() ?? '';
    const quoteTokenAddress = formData.parameters?.quoteTokenAddress?.trim() ?? '';
    if (!baseTokenAddress || !quoteTokenAddress) {
      setPlanPreview(null);
      setPlanPreviewError('Select a base/quote pair to generate a planner preview.');
      setPlanPreviewLoading(false);
      return;
    }

    const timerId = window.setTimeout(() => {
      void loadPlanPreview(previewDocument);
    }, 500);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [loadPlanPreview, planPreviewSignature, previewDocument]);

  const summaryItems = [
    {
      label: 'Mode',
      value:
        objective === 'shakeout'
          ? 'Aggressive Shakeout'
          : objective === 'distribution'
            ? 'Measured Distribution'
            : 'Patient Accumulation',
    },
    {
      label: 'Target Volume',
      value: formatCurrency(formData.targets?.volumeUsdMin),
    },
    {
      label: 'Operating Window',
      value: timeRangeLabels[formData.parameters?.timeRangeTarget ?? '24h'] ?? formData.parameters?.timeRangeTarget ?? '24 hours',
    },
    {
      label: 'Min Planned Trades',
      value: formatNumber(formData.parameters?.minTransactions),
    },
    {
      label: 'Max Transactions',
      value: formatNumber(formData.parameters?.maxTransactions),
    },
    {
      label: 'Trigger Floor',
      value: formatCurrency(formData.triggers?.triggerThresholdUsd),
    },
    {
      label: activeTactic.label,
      value: `${formatNumber(formData.execution?.tactics?.[activeTactic.field])}x`,
    },
  ];

  return (
    <form
      onSubmit={handleSubmit(() => {
        if (planPreview?.isExecutable) {
          onSubmit(planPreview);
        }
      })}
      className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(360px,0.95fr)_minmax(0,1.65fr)]"
    >
      <div className="space-y-6 lg:col-start-1 lg:row-start-1">
        <FormCard
          title="Macro Objective"
          description="Choose the campaign behavior that drives the hierarchical state machine, then set the token context and operator notes."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FieldShell label="Macro Objective" helper={macroObjectiveOptions.find((option) => option.value === objective)?.description}>
              <Controller
                control={control}
                name="execution.macroObjective"
                render={({ field }) => (
                  <select {...field} className={textInputClassName()}>
                    {macroObjectiveOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              />
            </FieldShell>

            <FieldShell label="Execution Enabled" helper="Keep disabled while tuning drafts; the backend still enforces its own execution guardrails.">
              <Controller
                control={control}
                name="execution.enabled"
                render={({ field }) => (
                  <button
                    type="button"
                    onClick={() => field.onChange(!field.value)}
                    className={`flex h-[52px] w-full items-center justify-between rounded-xl border px-4 text-sm font-medium transition ${field.value ? 'border-blue-500 bg-blue-500/15 text-blue-200' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'}`}
                  >
                    <span>{field.value ? 'Enabled' : 'Disabled'}</span>
                    <span className={`h-2.5 w-2.5 rounded-full ${field.value ? 'bg-blue-400' : 'bg-slate-500'}`} />
                  </button>
                )}
              />
            </FieldShell>

            <FieldShell label="Trading Pair" helper="Select a tracked trading pair from the registry. Base and quote mints are inherited from the selected pair.">
              <Controller
                control={control}
                name="parameters.contractAddress"
                render={({ field }) => (
                  <select
                    value={selectedPairValue}
                    onChange={(event) => {
                      const nextPairValue = event.target.value;
                      const nextToken = tradableTokens.find(
                        (token) => registryPairValue(token) === nextPairValue,
                      );
                      field.onChange(nextToken?.baseTokenAddress ?? '');
                    }}
                    className={textInputClassName()}
                    disabled={contractOptions.length === 0}
                  >
                    <option value="">No token selected</option>
                    {contractOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              />
            </FieldShell>

            <FieldShell label="Base Token Mint" helper="Inherited from the selected registry pair.">
              <input
                value={formData.parameters?.baseTokenAddress ?? ''}
                readOnly
                className={textInputClassName(true)}
                placeholder="Base token mint address"
              />
            </FieldShell>

            <FieldShell label="Quote Token Mint" helper="Inherited from the selected registry pair.">
              <input
                value={formData.parameters?.quoteTokenAddress ?? ''}
                readOnly
                className={textInputClassName(true)}
                placeholder="Quote token mint address"
              />
            </FieldShell>

            <FieldShell label="Main AMM Pool Address" helper="Managed on the tracked pair registry. The live runtime uses the registry value and falls back to legacy strategy data only for older versions.">
              <input
                value={selectedRegistryToken?.ammPoolAddress ?? formData.parameters?.ammPoolAddress ?? ''}
                readOnly
                className={textInputClassName(true)}
                placeholder="Configure on the tracked pair registry"
              />
            </FieldShell>

            <FieldShell label="Strategy Notes" helper="Keep a short operator note so published versions are easier to identify later.">
              <textarea
                {...register('parameters.notes')}
                rows={5}
                className={textInputClassName()}
                placeholder="Explain the intent of this setup..."
              />
            </FieldShell>
          </div>
        </FormCard>

        <FormCard
          title="Base Settings"
          description="Tune the operating window, target opportunity size, and qualification thresholds that feed the runtime."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FieldShell label="Operating Window" helper="Used as the human-facing campaign duration and the base reference for backend scheduling.">
              <Controller
                control={control}
                name="parameters.timeRangeTarget"
                render={({ field }) => (
                  <select {...field} className={textInputClassName()}>
                    {Object.entries(timeRangeLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              />
            </FieldShell>

            <FieldShell label="Target Volume (USD)" helper="Minimum aggregate volume needed before the setup qualifies for execution.">
              <Controller
                control={control}
                name="targets.volumeUsdMin"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Min Planned Trades" helper="Planner floor for generated base trades. Use this to force volume to be spread across more transactions instead of a small number of large orders.">
              <Controller
                control={control}
                name="parameters.minTransactions"
                render={({ field }) => (
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => {
                      const parsed = parseBlankableNumber(event.target.value);
                      field.onChange(parsed == null ? null : Math.max(1, Math.floor(parsed)));
                    }}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Max Transactions" helper="Upper bound for accepted aggregate market transaction count in the selected operating window. This market threshold does not cap the planner floor from Min Planned Trades.">
              <Controller
                control={control}
                name="parameters.maxTransactions"
                render={({ field }) => (
                  <input
                    type="number"
                    step="1"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => {
                      const parsed = parseBlankableNumber(event.target.value);
                      field.onChange(parsed == null ? null : Math.max(1, Math.floor(parsed)));
                    }}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Min Order Amount (USD)" helper="Every base-plan order is sized to this floor when the configured campaign volume permits it.">
              <Controller
                control={control}
                name="parameters.minOrderUsd"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => {
                      const parsed = parseBlankableNumber(event.target.value);
                      const minOrderUsd = parsed == null
                        ? null
                        : Math.max(ORDER_AMOUNT_STEP_USD, parsed);
                      field.onChange(minOrderUsd);
                      if (
                        minOrderUsd != null &&
                        (formData.parameters.maxOrderUsd ?? 0) <= minOrderUsd
                      ) {
                        setValue(
                          'parameters.maxOrderUsd',
                          Number((minOrderUsd + ORDER_AMOUNT_STEP_USD).toFixed(2)),
                          { shouldDirty: true },
                        );
                      }
                    }}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Max Order Amount (USD)" helper="Must be larger than Min Order Amount. The planner increases the order count when needed so no executable order exceeds this amount.">
              <Controller
                control={control}
                name="parameters.maxOrderUsd"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    min={Math.max(
                      ORDER_AMOUNT_STEP_USD,
                      (formData.parameters.minOrderUsd ?? 0) + ORDER_AMOUNT_STEP_USD,
                    )}
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => {
                      const parsed = parseBlankableNumber(event.target.value);
                      field.onChange(parsed);
                    }}
                    onBlur={(event) => {
                      field.onBlur();
                      const parsed = parseBlankableNumber(event.target.value);
                      if (parsed == null) {
                        return;
                      }
                      field.onChange(Math.max(
                        (formData.parameters.minOrderUsd ?? 0) + ORDER_AMOUNT_STEP_USD,
                        parsed,
                      ));
                    }}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Max Slippage (%)" helper="Stored internally as basis points, edited here as a percentage.">
              <Controller
                control={control}
                name="parameters.maxSlippageBps"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={field.value == null ? '' : ((field.value ?? 0) / 100).toString()}
                    onChange={(event) => {
                      const parsed = parseBlankableNumber(event.target.value);
                      field.onChange(parsed == null ? null : Math.round(parsed * 100));
                    }}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="External Trigger Floor (USD)" helper="Ignore outside activity smaller than this notional value.">
              <Controller
                control={control}
                name="triggers.triggerThresholdUsd"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Net Buy-In Target (USD)" helper="Optional qualification target for future signal enrichment.">
              <Controller
                control={control}
                name="targets.netBuyinUsdMin"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Volatility Target (%)" helper="Raises curve aggression for shakeout previews and remains the optional volatility target shown in the curve review.">
              <Controller
                control={control}
                name="targets.volatilityPctMin"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Pullback Target (%)" helper="For shakeout, deeper pullback targets increase front-loaded sell pressure and delay buyback recovery.">
              <Controller
                control={control}
                name="targets.pullbackPctMax"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>
          </div>
        </FormCard>

        <FormCard
          title="Tactics & Guardrails"
          description="Show only the tactic that belongs to the selected macro objective, then shape throttle and safety behavior around it."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FieldShell label={activeTactic.label} helper={activeTactic.helper}>
              <Controller
                control={control}
                name={`execution.tactics.${activeTactic.field}`}
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => {
                      const parsed = parseBlankableNumber(event.target.value);
                      field.onChange(parsed == null ? null : Math.max(0, parsed));
                    }}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Cooldown (ms)" helper="Minimum delay before the strategy reacts again to a fresh trigger.">
              <Controller
                control={control}
                name="triggers.cooldownMs"
                render={({ field }) => (
                  <input
                    type="number"
                    step="1"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Idempotency Window (ms)" helper="How long duplicate trigger identifiers are treated as the same event.">
              <Controller
                control={control}
                name="triggers.idempotencyWindowMs"
                render={({ field }) => (
                  <input
                    type="number"
                    step="1"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Max Concurrent Orders" helper="Execution safety cap used by backend planning when live routing is enabled.">
              <Controller
                control={control}
                name="riskControls.maxConcurrentOrders"
                render={({ field }) => (
                  <input
                    type="number"
                    step="1"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Time Jitter Ratio" helper="Randomizes delay distribution across scheduled TWAP slices.">
              <Controller
                control={control}
                name="execution.timeJitterRatio"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Volume Jitter Ratio" helper="Randomizes per-slice notional while preserving total campaign volume.">
              <Controller
                control={control}
                name="execution.volumeJitterRatio"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseBlankableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Account Dispersion Strength" helper="Note: higher values push later slices away from accounts that already have more planned volume. Use 0 to keep weights near-even, 0.5 for the current default, and larger values for more aggressive spreading.">
              <Controller
                control={control}
                name="execution.accountDispersionStrength"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="3"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => {
                      const parsed = parseBlankableNumber(event.target.value);
                      field.onChange(parsed == null ? null : Math.max(0, Math.min(3, parsed)));
                    }}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Max Position (USD)" helper="Optional hard ceiling for future position sizing logic.">
              <Controller
                control={control}
                name="riskControls.maxPositionUsd"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseNullableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Max Daily Loss (USD)" helper="Optional kill-switch threshold for future daily loss enforcement.">
              <Controller
                control={control}
                name="riskControls.maxDailyLossUsd"
                render={({ field }) => (
                  <input
                    type="number"
                    step="0.01"
                    value={formatNumberInputValue(field.value)}
                    onChange={(event) => field.onChange(parseNullableNumber(event.target.value))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Trigger Sources" helper="Comma-separated source list. Current runtime supports manual_refresh and alchemy_notify.">
              <Controller
                control={control}
                name="triggers.sources"
                render={({ field }) => (
                  <input
                    type="text"
                    value={field.value.join(', ')}
                    onChange={(event) =>
                      field.onChange(
                        event.target.value
                          .split(',')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      )
                    }
                    className={textInputClassName()}
                    placeholder="alchemy_notify, manual_refresh"
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Trigger Event Types" helper="Use * to accept all supported event types from the selected trigger sources.">
              <Controller
                control={control}
                name="triggers.eventTypes"
                render={({ field }) => (
                  <input
                    type="text"
                    value={field.value.join(', ')}
                    onChange={(event) =>
                      field.onChange(
                        event.target.value
                          .split(',')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      )
                    }
                    className={textInputClassName()}
                    placeholder="*"
                  />
                )}
              />
            </FieldShell>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
            <Controller
              control={control}
              name="riskControls.requireCompleteMetrics"
              render={({ field }) => (
                <button
                  type="button"
                  onClick={() => field.onChange(!field.value)}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm transition ${field.value ? 'border-blue-500 bg-blue-500/10 text-blue-200' : 'border-slate-700 bg-slate-900 text-slate-300'}`}
                >
                  <span>Require Complete Metrics</span>
                  <span>{field.value ? 'On' : 'Off'}</span>
                </button>
              )}
            />

            <Controller
              control={control}
              name="execution.accountCyclingEnabled"
              render={({ field }) => (
                <button
                  type="button"
                  onClick={() => field.onChange(!field.value)}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm transition ${field.value ? 'border-blue-500 bg-blue-500/10 text-blue-200' : 'border-slate-700 bg-slate-900 text-slate-300'}`}
                >
                  <span>Account Cycling</span>
                  <span>{field.value ? 'On' : 'Off'}</span>
                </button>
              )}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-400">
            <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1">Route: {formData.execution?.route}</span>
            <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1">Commitment: {formData.execution?.commitment}</span>
          </div>
        </FormCard>
      </div>

      <div className="lg:col-start-2 lg:row-start-1">
        <div className="sticky top-6 rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-2xl shadow-slate-950/30">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-xl font-bold text-white">Strategy Summary</h3>
              <p className="mt-1 text-sm text-slate-400">Live overview generated from the current draft values.</p>
            </div>
            <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-300">
              {titleCase(activeStrategyStatus)}
            </span>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Published Version</p>
            <p className="mt-2 text-2xl font-semibold text-white">
              {activeStrategyVersionNo != null ? `v${activeStrategyVersionNo}` : 'Draft only'}
            </p>
            <p className="mt-2 text-sm text-slate-400">Contract: {contractPreview(formData.parameters?.contractAddress ?? '')}</p>
          </div>

          <div className="mt-6 space-y-3">
            {summaryItems.map((item) => (
              <div key={item.label} className="flex items-start justify-between gap-3 rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3">
                <span className="text-sm text-slate-400">{item.label}</span>
                <span className="text-right text-sm font-medium text-slate-100">{item.value}</span>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Trigger Policy</p>
            <p className="mt-2 text-sm text-slate-200">Sources: {humanizeList(formData.triggers?.sources ?? [])}</p>
            <p className="mt-1 text-sm text-slate-200">Events: {humanizeList(formData.triggers?.eventTypes ?? [])}</p>
            <p className="mt-1 text-sm text-slate-200">Cooldown: {formatNumber(formData.triggers?.cooldownMs)} ms</p>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Guardrails</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${formData.execution?.enabled ? 'bg-blue-500/15 text-blue-200' : 'bg-slate-700 text-slate-300'}`}>
                Execution {formData.execution?.enabled ? 'On' : 'Off'}
              </span>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${formData.riskControls?.requireCompleteMetrics ? 'bg-blue-500/15 text-blue-200' : 'bg-slate-700 text-slate-300'}`}>
                Complete Metrics {formData.riskControls?.requireCompleteMetrics ? 'Required' : 'Optional'}
              </span>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${formData.execution?.accountCyclingEnabled ? 'bg-blue-500/15 text-blue-200' : 'bg-slate-700 text-slate-300'}`}>
                Account Cycling {formData.execution?.accountCyclingEnabled ? 'On' : 'Off'}
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-300">Max concurrency: {formatNumber(formData.riskControls?.maxConcurrentOrders)}</p>
            <p className="mt-1 text-sm text-slate-300">Max slippage: {formatPercentFromBps(formData.parameters?.maxSlippageBps)}</p>
            <p className="mt-1 text-sm text-slate-300">Account dispersion: {formatNumberInputValue(formData.execution?.accountDispersionStrength ?? 0.5) || '0'}</p>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Planner Preview</p>
                <p className="mt-1 text-sm text-slate-400">Generated from the current draft and current enabled account balances.</p>
              </div>
              <button
                type="button"
                onClick={() => void loadPlanPreview(previewDocument)}
                disabled={planPreviewLoading}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {planPreviewLoading ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>

            {planPreviewError ? (
              <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {planPreviewError}
              </div>
            ) : null}

            {planPreviewLoading && !planPreview ? (
              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-3 text-sm text-slate-300">
                Generating planner preview...
              </div>
            ) : null}

            {planPreview ? (
              <>
                <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-sm text-slate-200">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Projected Price Curve</p>
                  {planPreview.volatilityReview.available ? (
                    <>
                      <p className="mt-2 text-lg font-semibold">
                        {planPreview.volatilityReview.projectedVolatilityPct?.toFixed(2)}% projected
                        {planPreview.volatilityReview.targetVolatilityPct != null
                          ? ` / ${planPreview.volatilityReview.targetVolatilityPct.toFixed(2)}% optional target`
                          : ''}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        Estimated range {formatPriceCurrency(planPreview.volatilityReview.projectedLowPriceUsd)}–{formatPriceCurrency(planPreview.volatilityReview.projectedHighPriceUsd)} from {formatPriceCurrency(planPreview.volatilityReview.startPriceUsd)}, using {formatCurrency(planPreview.volatilityReview.liquidityUsd)} snapshot liquidity. This estimate does not block execution.
                      </p>
                      <PriceSlopeChart review={planPreview.volatilityReview} />
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-slate-400">
                      Projection unavailable until both market price and liquidity are present. The optional volatility target does not block execution.
                    </p>
                  )}
                </div>

                <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${planPreview.isExecutable ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100' : 'border-rose-500/20 bg-rose-500/10 text-rose-100'}`}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] opacity-80">
                    {planPreview.isExecutable ? 'Executable Plan' : 'Plan Cannot Execute'}
                  </p>
                  <p className="mt-2 font-semibold">
                    {planPreview.plannedTaskCount}/{planPreview.requestedTaskCount} required tasks allocated
                  </p>
                  {!planPreview.isExecutable ? (
                    <p className="mt-1 text-xs opacity-80">
                      {formatCurrency(planPreview.unallocatedVolumeUsd)} remains unallocated. Adjust account balances, minimum order size, or transaction count before deployment.
                    </p>
                  ) : null}
                </div>

                <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${planPreview.sufficientBuyCapacity ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100' : 'border-rose-500/20 bg-rose-500/10 text-rose-100'}`}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] opacity-80">Initial Buy Capacity</p>
                  <p className="mt-2 text-lg font-semibold">
                    {formatCurrency(planPreview.availableBuyAmount)} / {formatCurrency(planPreview.requiredBuyAmount)} {planPreview.quoteLabel}
                  </p>
                  <p className="mt-1 text-xs opacity-80">
                    {planPreview.eligibleTradingAccountCount} account(s) hold at least one pair asset; {planPreview.eligibleAccountCount} can fund an initial minimum buy. Capability skipped {planPreview.skippedForCapabilityCount}, no pair assets {planPreview.skippedForNoPairAssetCount}, low-SOL warning {planPreview.skippedForSolReserveCount}
                  </p>
                </div>

                <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-sm text-slate-200">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Plan Snapshot</p>
                  <p className="mt-2">Pair: {contractPreview(planPreview.pair.baseTokenAddress)} / {contractPreview(planPreview.pair.quoteTokenAddress)}</p>
                  <p className="mt-1">Objective: {titleCase(planPreview.macroObjective)}</p>
                  <p className="mt-1">Account cycling: {planPreview.accountCyclingEnabled ? 'Enabled' : 'Disabled'}</p>
                  <p className="mt-1">Generated: {formatPlannerTime(planPreview.generatedAt)}</p>
                </div>

                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Planned Tasks</p>
                  <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
                    {planPreview.tasks.length > 0 ? (
                      planPreview.tasks.map((task) => (
                        <div key={task.taskId} className="rounded-xl border border-slate-700 bg-slate-800/70 px-3 py-3 text-sm text-slate-200">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium text-white">{task.side.toUpperCase()} {formatCurrency(task.totalVolumeUsd)}</p>
                              <p className="mt-1 text-xs text-slate-400">Pulse {task.pulse ?? 'base'} · Order {task.orderIndex}/{task.totalOrders}</p>
                            </div>
                            <p className="text-xs text-slate-400">{formatPlannerTime(task.scheduledAt)}</p>
                          </div>
                          <div className="mt-3 space-y-2 border-t border-slate-700 pt-3">
                            {task.allocations.length > 0 ? (
                              task.allocations.map((allocation) => {
                                const currentBalance = task.side === 'buy'
                                  ? `${formatNumber(allocation.quoteAvailableAmount)} ${planPreview.quoteLabel}`
                                  : `${formatNumber(allocation.baseTokenAmount)} base`;

                                return (
                                  <div key={allocation.accountId} className="rounded-lg bg-slate-900/70 px-3 py-2">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="truncate font-medium text-slate-100">{allocation.label}</p>
                                        <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{contractPreview(allocation.walletAddress)}</p>
                                      </div>
                                      <p className="shrink-0 font-semibold text-white">
                                        {task.side === 'buy' ? 'Buy' : 'Sell'} {formatCurrency(allocation.plannedVolumeUsd)}
                                      </p>
                                    </div>
                                    <p className="mt-1 text-xs text-slate-400">Current balance: {currentBalance}</p>
                                    {allocation.accountBuyOverAllocated ? (
                                      <p className="mt-1 text-xs text-amber-300">
                                        Buy exceeds available balance by {formatCurrency(allocation.accountBuyOverAllocationUsd)}.
                                      </p>
                                    ) : null}
                                  </div>
                                );
                              })
                            ) : (
                              <p className="text-xs text-slate-500">No account allocation for this task.</p>
                            )}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-700 px-3 py-3 text-sm text-slate-500">
                        No executable planned tasks for this preview.
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={isSubmitting || planPreviewLoading || !planPreview?.isExecutable}
            className="mt-6 w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Deploying...' : 'Deploy Reviewed Plan'}
          </button>
        </div>
      </div>
    </form>
  );
}