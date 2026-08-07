import React from 'react';
import { Controller, useForm } from 'react-hook-form';

import type {
  StrategyMacroObjective,
  StrategyVersionDocument,
} from '../app/strategyTypes';

type StrategySchemaFormProps = {
  draft: StrategyVersionDocument;
  onChange: (updater: (current: StrategyVersionDocument) => StrategyVersionDocument) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  activeStrategyVersionNo: number | null;
  activeStrategyStatus: string | null;
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

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullableNumber(value: string): number | null {
  if (value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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
}: StrategySchemaFormProps) {
  const { control, register, watch, handleSubmit, reset, getValues, formState } = useForm<StrategyVersionDocument>({
    defaultValues: draft,
    mode: 'onChange',
  });

  const formData = watch();
  const objective = formData.execution?.macroObjective ?? 'accumulation';
  const activeTactic = tacticConfig[objective];
  const draftSignature = React.useMemo(() => JSON.stringify(draft), [draft]);

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
      label: 'Max Trades',
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
    <form onSubmit={handleSubmit(() => onSubmit())} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
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

            <FieldShell label="Target Contract" helper="Managed by the tracked token registry. Activating a token updates this value automatically.">
              <input
                {...register('parameters.contractAddress')}
                readOnly
                className={textInputClassName(true)}
                placeholder="No token selected"
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
              <input
                type="number"
                step="0.01"
                {...register('targets.volumeUsdMin', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
              />
            </FieldShell>

            <FieldShell label="Max Trades" helper="Upper bound for accepted aggregate transaction count in the selected operating window.">
              <input
                type="number"
                step="1"
                {...register('parameters.maxTransactions', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
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
                    value={((field.value ?? 0) / 100).toString()}
                    onChange={(event) => field.onChange(Math.round(parseNumber(event.target.value) * 100))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="External Trigger Floor (USD)" helper="Ignore outside activity smaller than this notional value.">
              <input
                type="number"
                step="0.01"
                {...register('triggers.triggerThresholdUsd', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
              />
            </FieldShell>

            <FieldShell label="Net Buy-In Target (USD)" helper="Optional qualification target for future signal enrichment.">
              <input
                type="number"
                step="0.01"
                {...register('targets.netBuyinUsdMin', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
              />
            </FieldShell>

            <FieldShell label="Volatility Target (%)" helper="Optional filter used when full market metrics are available.">
              <input
                type="number"
                step="0.01"
                {...register('targets.volatilityPctMin', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
              />
            </FieldShell>

            <FieldShell label="Pullback Limit (%)" helper="Maximum tolerated outsider pullback before the setup blocks execution.">
              <input
                type="number"
                step="0.01"
                {...register('targets.pullbackPctMax', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
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
                    value={field.value ?? 0}
                    onChange={(event) => field.onChange(Math.max(0, parseNumber(event.target.value)))}
                    className={textInputClassName()}
                  />
                )}
              />
            </FieldShell>

            <FieldShell label="Cooldown (ms)" helper="Minimum delay before the strategy reacts again to a fresh trigger.">
              <input
                type="number"
                step="1"
                {...register('triggers.cooldownMs', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
              />
            </FieldShell>

            <FieldShell label="Idempotency Window (ms)" helper="How long duplicate trigger identifiers are treated as the same event.">
              <input
                type="number"
                step="1"
                {...register('triggers.idempotencyWindowMs', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
              />
            </FieldShell>

            <FieldShell label="Max Concurrent Orders" helper="Execution safety cap used by backend planning when live routing is enabled.">
              <input
                type="number"
                step="1"
                {...register('riskControls.maxConcurrentOrders', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
              />
            </FieldShell>

            <FieldShell label="Time Jitter Ratio" helper="Randomizes delay distribution across scheduled TWAP slices.">
              <input
                type="number"
                step="0.01"
                {...register('execution.timeJitterRatio', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
              />
            </FieldShell>

            <FieldShell label="Volume Jitter Ratio" helper="Randomizes per-slice notional while preserving total campaign volume.">
              <input
                type="number"
                step="0.01"
                {...register('execution.volumeJitterRatio', { setValueAs: (value) => parseNumber(String(value ?? '0')) })}
                className={textInputClassName()}
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
                    value={field.value ?? ''}
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
                    value={field.value ?? ''}
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
              name="riskControls.dryRun"
              render={({ field }) => (
                <button
                  type="button"
                  onClick={() => field.onChange(!field.value)}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm transition ${field.value ? 'border-emerald-500 bg-emerald-500/10 text-emerald-200' : 'border-slate-700 bg-slate-900 text-slate-300'}`}
                >
                  <span>Dry Run</span>
                  <span>{field.value ? 'On' : 'Off'}</span>
                </button>
              )}
            />

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
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-400">
            <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1">Route: {formData.execution?.route}</span>
            <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1">Commitment: {formData.execution?.commitment}</span>
          </div>
        </FormCard>
      </div>

      <div className="lg:col-span-1">
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
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${formData.riskControls?.dryRun ? 'bg-emerald-500/15 text-emerald-200' : 'bg-slate-700 text-slate-300'}`}>
                Dry Run {formData.riskControls?.dryRun ? 'On' : 'Off'}
              </span>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${formData.riskControls?.requireCompleteMetrics ? 'bg-blue-500/15 text-blue-200' : 'bg-slate-700 text-slate-300'}`}>
                Complete Metrics {formData.riskControls?.requireCompleteMetrics ? 'Required' : 'Optional'}
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-300">Max concurrency: {formatNumber(formData.riskControls?.maxConcurrentOrders)}</p>
            <p className="mt-1 text-sm text-slate-300">Max slippage: {formatPercentFromBps(formData.parameters?.maxSlippageBps)}</p>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-6 w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Deploying...' : 'Deploy Strategy'}
          </button>
        </div>
      </div>
    </form>
  );
}