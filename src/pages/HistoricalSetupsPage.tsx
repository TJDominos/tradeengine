import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FileText,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
} from 'lucide-react';
import React from 'react';

import type { StrategyPriceCurveReview } from '../app/types';
import { api, compactAddress, formatDate, formatUSD } from '../app/utils';
import { PriceSlopeChart } from '../components/StrategySchemaForm';

type QueueExecutionReport = {
  actualTotalVolume: number;
  actualNetInflow: number;
  tacticsTriggeredCount: number;
  pnl: number;
  startTime: number;
  endTime: number;
  abortReason?: string;
  tasks?: QueueTask[];
};

type QueueStrategyDocument = {
  parameters: {
    contractAddress: string;
  };
};

type QueueStrategyConfig = {
  strategyVersionId: number | null;
  strategyVersionNo: number | null;
  contractAddress: string;
  macroObjective: 'shakeout' | 'distribution' | 'accumulation';
  baseTotalVolumeUsd: number;
  document: QueueStrategyDocument;
  reviewedPlan?: {
    generatedAt: number;
    volatilityReview?: StrategyPriceCurveReview;
  };
};

type QueueStrategyRecord = {
  runNumber: number;
  versionId: string;
  status: 'pending' | 'running' | 'completed' | 'aborted' | 'failed' | 'paused';
  config: QueueStrategyConfig;
  report?: QueueExecutionReport;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

type QueueEngineMetrics = {
  actualTotalVolume: number;
  actualNetInflow: number;
  tacticsTriggeredCount: number;
  pnl: number;
  startTime?: number | null;
};

type QueueTask = {
  id: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  scheduledAt: number;
  nextExecutionTime: number | null;
  source: 'base' | 'tactic';
  status: 'done' | 'pending' | 'failed' | 'superseded';
  attemptCount: number;
  executedVolumeUsd: number;
  completedAt: number | null;
  lastFailedAt: number | null;
  lastError: string | null;
  supersededAt?: number | null;
  planRevision?: number;
  triggerTxHash?: string | null;
};

type QueueSnapshotResponse = {
  active: QueueStrategyRecord | null;
  pending: QueueStrategyRecord[];
  history: QueueStrategyRecord[];
  paused: boolean;
  queueStatus: 'active' | 'paused' | 'aborted';
  tasks: QueueTask[];
  currentEngineState: string | null;
  currentMetrics: QueueEngineMetrics | null;
};

function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(' ');
}

function strategyVersionLabel(record: QueueStrategyRecord): string {
  const versionLabel = record.config.strategyVersionNo != null
    ? `v${record.config.strategyVersionNo}`
    : record.versionId.slice(0, 8);
  return `Run #${record.runNumber} · ${versionLabel}`;
}

function resolveDisplayStatus(record: QueueStrategyRecord): string {
  if (record.status === 'aborted') {
    return 'Aborted';
  }
  if (record.status === 'failed' && record.report?.abortReason) {
    return 'Aborted';
  }
  return titleCase(record.status);
}

function ProjectedPriceCurveSnapshot({ record }: { record: QueueStrategyRecord }) {
  const review = record.config.reviewedPlan?.volatilityReview;
  const generatedAt = record.config.reviewedPlan?.generatedAt;

  return (
    <div className="mt-5 border-t border-slate-700 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Projected Price Curve</p>
          <p className="mt-1 text-sm text-slate-300">Preview snapshot captured before this run started</p>
        </div>
        {generatedAt ? <p className="text-xs text-slate-500">Previewed {formatDate(generatedAt)}</p> : null}
      </div>
      {review?.available ? (
        <PriceSlopeChart review={review} />
      ) : (
        <div className="mt-3 rounded-xl border border-dashed border-slate-700 bg-slate-900/70 px-4 py-4 text-sm text-slate-500">
          {review
            ? 'The preview did not have enough market price and liquidity data to project a curve.'
            : 'No projected price curve snapshot was recorded for this run.'}
        </div>
      )}
    </div>
  );
}

export default function HistoricalSetupsPage() {
  const [queueState, setQueueState] = React.useState<QueueSnapshotResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [actionKey, setActionKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const [expandedReportId, setExpandedReportId] = React.useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = React.useState<string>('');

  const loadQueueState = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const response = await api<QueueSnapshotResponse>('/api/strategy/current');
      setQueueState(response);
      setError('');
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load strategy queue state');
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    void loadQueueState();
    const intervalId = window.setInterval(() => {
      void loadQueueState({ silent: true });
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [loadQueueState]);

  const runAction = React.useCallback(
    async (key: string, action: () => Promise<void>) => {
      setActionKey(key);
      try {
        await action();
        await loadQueueState({ silent: true });
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Strategy queue action failed');
      } finally {
        setActionKey(null);
      }
    },
    [loadQueueState],
  );

  const active = queueState?.active ?? null;
  const pending = queueState?.pending ?? [];
  const history = queueState?.history ?? [];
  const metrics = queueState?.currentMetrics ?? null;
  const tasks = queueState?.tasks ?? [];
  const upcomingTaskCount = tasks.filter((task) => task.nextExecutionTime != null).length;
  const failedTaskCount = tasks.filter((task) => task.status === 'failed').length;
  const completedTaskCount = tasks.filter((task) => task.status === 'done').length;
  const supersededTaskCount = tasks.filter((task) => task.status === 'superseded').length;
  const orderedTasks = [...tasks].sort((left, right) => {
    const leftNextExecution = left.nextExecutionTime ?? Number.POSITIVE_INFINITY;
    const rightNextExecution = right.nextExecutionTime ?? Number.POSITIVE_INFINITY;
    return leftNextExecution - rightNextExecution || right.scheduledAt - left.scheduledAt;
  });
  const queueStatus = queueState?.queueStatus ?? 'active';
  const targetVolume = active?.config.baseTotalVolumeUsd ?? 0;
  const executedVolume = metrics?.actualTotalVolume ?? 0;
  const progressRatio =
    targetVolume > 0 ? Math.min(100, Math.max(0, (executedVolume / targetVolume) * 100)) : 0;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-700 bg-slate-900/95 p-6 shadow-xl shadow-slate-950/20">
        <div className="flex flex-col gap-3 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-white">Queue Status & Management</h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
              Draft strategies in Trading Setup, then manage their strict serial execution lifecycle from this queue dashboard.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-400">
            {loading ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-300">
                <LoaderCircle size={14} className="animate-spin" /> Loading queue
              </span>
            ) : (
              <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5">
                Last refresh {lastUpdated || 'just now'}
              </span>
            )}
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <div className="mt-6 space-y-6">
          <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Active Strategy</p>
                {active ? (
                  <>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <h3 className="text-2xl font-semibold text-white">{strategyVersionLabel(active)}</h3>
                      <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${queueStatus === 'paused' ? 'border-amber-500/30 bg-amber-500/15 text-amber-300' : 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'}`}>
                        {queueStatus}
                      </span>
                    </div>
                    <p className="mt-3 text-sm text-slate-300">
                      Objective: <span className="font-medium text-white">{titleCase(active.config.macroObjective)}</span>
                    </p>
                    <p className="mt-1 text-sm text-slate-400">
                      Contract: {compactAddress(active.config.document.parameters.contractAddress || active.config.contractAddress)}
                    </p>
                    <p className="mt-1 text-sm text-slate-400">
                      Engine State: {queueState?.currentEngineState ? titleCase(queueState.currentEngineState) : 'Running'}
                    </p>
                  </>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-slate-700 bg-slate-900/70 px-5 py-8 text-center text-slate-400">
                    <Activity size={28} className="mx-auto mb-3 text-slate-600" />
                    <p className="text-lg font-medium text-slate-300">System Idle</p>
                    <p className="mt-2 text-sm text-slate-500">No strategy is currently running. Deploy or resume a pending queue item to begin execution.</p>
                  </div>
                )}
              </div>

              {active ? (
                <div className="flex flex-wrap justify-end gap-2">
                  {queueStatus === 'paused' ? (
                    <button
                      onClick={() => void runAction('resume-current', async () => {
                        await api('/api/strategy/resume', { method: 'POST' });
                      })}
                      disabled={actionKey != null}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Play size={16} />
                      {actionKey === 'resume-current' ? 'Resuming...' : 'Resume'}
                    </button>
                  ) : (
                    <button
                      onClick={() => void runAction('pause-current', async () => {
                        await api('/api/strategy/pause', { method: 'POST' });
                      })}
                      disabled={actionKey != null}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Pause size={16} />
                      {actionKey === 'pause-current' ? 'Pausing...' : 'Pause'}
                    </button>
                  )}
                  <button
                    onClick={() => void runAction('abort-current', async () => {
                      await api('/api/strategy/abort', {
                        method: 'POST',
                        body: JSON.stringify({ reason: 'Manual user abort' }),
                      });
                    })}
                    disabled={actionKey != null}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-rose-500/40 bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <AlertTriangle size={16} />
                    {actionKey === 'abort-current' ? 'Aborting...' : 'Abort'}
                  </button>
                </div>
              ) : null}
            </div>

            {active ? (
              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between text-sm text-slate-400">
                  <span>Executed Volume</span>
                  <span>
                    {formatUSD(executedVolume)} / {formatUSD(targetVolume)}
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-950">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-green-400 to-lime-300 transition-all"
                    style={{ width: `${progressRatio}%` }}
                  />
                </div>
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Net Inflow</p>
                    <p className="mt-2 text-lg font-semibold text-white">{formatUSD(metrics?.actualNetInflow ?? 0)}</p>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">PnL</p>
                    <p className="mt-2 text-lg font-semibold text-white">{formatUSD(metrics?.pnl ?? 0)}</p>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Tactics Triggered</p>
                    <p className="mt-2 text-lg font-semibold text-white">{metrics?.tacticsTriggeredCount ?? 0}</p>
                  </div>
                </div>
                <ProjectedPriceCurveSnapshot record={active} />
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Execution Tasks</p>
                <h3 className="mt-2 text-xl font-semibold text-white">{tasks.length} planned task{tasks.length === 1 ? '' : 's'}</h3>
                <p className="mt-1 text-sm text-slate-400">
                  {upcomingTaskCount} upcoming · {failedTaskCount} failed · {completedTaskCount} completed · {supersededTaskCount} superseded
                </p>
              </div>
              <span className={`text-sm font-medium ${queueStatus === 'aborted' ? 'text-rose-300' : queueStatus === 'paused' ? 'text-amber-300' : 'text-emerald-300'}`}>
                {titleCase(queueStatus)}
              </span>
            </div>

            {tasks.length === 0 ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-700 bg-slate-900/70 px-5 py-6 text-sm text-slate-500">
                No execution tasks are available for this strategy.
              </div>
            ) : (
              <div className="mt-5 overflow-x-auto rounded-xl border border-slate-700">
                <table className="min-w-[900px] w-full text-left text-sm">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Task</th>
                      <th className="px-4 py-3 font-medium">Plan</th>
                      <th className="px-4 py-3 font-medium">Side</th>
                      <th className="px-4 py-3 font-medium">Volume</th>
                      <th className="px-4 py-3 font-medium">Planned</th>
                      <th className="px-4 py-3 font-medium">Next Execution</th>
                      <th className="px-4 py-3 font-medium">Attempts</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900/70">
                    {orderedTasks.map((task) => (
                      <tr key={task.id}>
                        <td className="max-w-52 px-4 py-3">
                          <p className="truncate font-medium text-slate-200" title={task.id}>{task.id}</p>
                          {task.lastError ? <p className="mt-1 line-clamp-2 text-xs text-rose-300" title={task.lastError}>{task.lastError}</p> : null}
                        </td>
                        <td className="px-4 py-3 text-slate-400">
                          <p>Revision {task.planRevision ?? 0}</p>
                          {task.triggerTxHash ? <p className="mt-1 font-mono text-xs" title={task.triggerTxHash}>{compactAddress(task.triggerTxHash)}</p> : null}
                        </td>
                        <td className={`px-4 py-3 font-semibold uppercase ${task.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}`}>{task.side}</td>
                        <td className="px-4 py-3 text-slate-300">{formatUSD(task.amountUsd)}</td>
                        <td className="px-4 py-3 text-slate-400">{formatDate(task.scheduledAt)}</td>
                        <td className="px-4 py-3 text-slate-400">{task.nextExecutionTime ? formatDate(task.nextExecutionTime) : '—'}</td>
                        <td className="px-4 py-3 text-slate-300">{task.attemptCount}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold uppercase ${task.status === 'done' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : task.status === 'failed' ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : task.status === 'superseded' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-slate-600 bg-slate-800 text-slate-300'}`}>
                            {task.status === 'failed' && task.nextExecutionTime != null ? 'retrying' : task.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Pending Queue</p>
                <h3 className="mt-2 text-xl font-semibold text-white">{pending.length} queued strategy{pending.length === 1 ? '' : 'ies'}</h3>
                <p className="mt-1 text-sm text-slate-400">Strict serial execution means only one macro strategy can run at a time.</p>
              </div>

              {queueState?.paused && !active ? (
                <button
                  onClick={() =>
                    void runAction('resume-queue', async () => {
                      await api('/api/strategy/resume', { method: 'POST' });
                    })
                  }
                  disabled={actionKey === 'resume-queue'}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Play size={16} />
                  {actionKey === 'resume-queue' ? 'Resuming...' : 'Resume Queue'}
                </button>
              ) : null}
            </div>

            {pending.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-700 bg-slate-900/70 px-5 py-6 text-sm text-slate-500">
                No pending strategies in the queue.
              </div>
            ) : (
              <div className="mt-5 overflow-hidden rounded-2xl border border-slate-700">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Version</th>
                      <th className="px-4 py-3 font-medium">Objective</th>
                      <th className="px-4 py-3 font-medium">Target Volume</th>
                      <th className="px-4 py-3 font-medium">Queued At</th>
                      <th className="px-4 py-3 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900/70">
                    {pending.map((record) => (
                      <tr key={record.versionId} className="hover:bg-slate-800/50">
                        <td className="px-4 py-3 font-semibold text-white">{strategyVersionLabel(record)}</td>
                        <td className="px-4 py-3 text-slate-300">{titleCase(record.config.macroObjective)}</td>
                        <td className="px-4 py-3 text-slate-300">{formatUSD(record.config.baseTotalVolumeUsd)}</td>
                        <td className="px-4 py-3 text-slate-400">{formatDate(record.createdAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() =>
                              void runAction(`cancel-${record.versionId}`, async () => {
                                await api(`/api/strategy/pending/${encodeURIComponent(record.versionId)}/cancel`, {
                                  method: 'POST',
                                });
                              })
                            }
                            disabled={actionKey === `cancel-${record.versionId}`}
                            className="inline-flex items-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-60"
                          >
                            <Trash2 size={14} /> Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Execution History & Reports</p>
              <h3 className="mt-2 text-xl font-semibold text-white">Completed and aborted strategy runs</h3>
            </div>

            {history.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-700 bg-slate-900/70 px-5 py-6 text-sm text-slate-500">
                No execution history recorded yet.
              </div>
            ) : (
              <div className="mt-5 overflow-hidden rounded-2xl border border-slate-700">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Version</th>
                      <th className="px-4 py-3 font-medium">Objective</th>
                      <th className="px-4 py-3 font-medium">Final Net Inflow</th>
                      <th className="px-4 py-3 font-medium">End Time</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Report</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900/70">
                    {history.map((record) => {
                      const expanded = expandedReportId === record.versionId;
                      const displayStatus = resolveDisplayStatus(record);
                      const isAborted = displayStatus === 'Aborted';
                      return (
                        <React.Fragment key={record.versionId}>
                          <tr className="hover:bg-slate-800/50">
                            <td className="px-4 py-3 font-semibold text-white">{strategyVersionLabel(record)}</td>
                            <td className="px-4 py-3 text-slate-300">{titleCase(record.config.macroObjective)}</td>
                            <td className="px-4 py-3 text-slate-300">{formatUSD(record.report?.actualNetInflow ?? 0)}</td>
                            <td className="px-4 py-3 text-slate-400">{record.report ? formatDate(record.report.endTime) : 'Unavailable'}</td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${isAborted ? 'bg-amber-500/15 text-amber-200' : 'bg-emerald-500/15 text-emerald-200'}`}>
                                {isAborted ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
                                {displayStatus}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                onClick={() => setExpandedReportId(expanded ? null : record.versionId)}
                                className="inline-flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-200 transition hover:bg-blue-500/20"
                              >
                                <FileText size={14} />
                                {expanded ? 'Hide Report' : 'View Report'}
                              </button>
                            </td>
                          </tr>
                          {expanded ? (
                            <tr>
                              <td colSpan={6} className="bg-slate-950/90 px-4 py-4">
                                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
                                  <div className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3">
                                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Actual Volume</p>
                                    <p className="mt-2 text-sm font-semibold text-white">{formatUSD(record.report?.actualTotalVolume ?? 0)}</p>
                                  </div>
                                  <div className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3">
                                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Net Inflow</p>
                                    <p className="mt-2 text-sm font-semibold text-white">{formatUSD(record.report?.actualNetInflow ?? 0)}</p>
                                  </div>
                                  <div className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3">
                                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">PnL</p>
                                    <p className="mt-2 text-sm font-semibold text-white">{formatUSD(record.report?.pnl ?? 0)}</p>
                                  </div>
                                  <div className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3">
                                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Tactical Triggers</p>
                                    <p className="mt-2 text-sm font-semibold text-white">{record.report?.tacticsTriggeredCount ?? 0}</p>
                                  </div>
                                  <div className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3">
                                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Window</p>
                                    <p className="mt-2 text-sm font-semibold text-white">
                                      {record.report ? `${formatDate(record.report.startTime)} → ${formatDate(record.report.endTime)}` : 'Unavailable'}
                                    </p>
                                  </div>
                                </div>
                                {record.report?.abortReason ? (
                                  <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                                    Abort Reason: {record.report.abortReason}
                                  </div>
                                ) : null}
                                <ProjectedPriceCurveSnapshot record={record} />
                                <div className="mt-4">
                                  <div className="flex flex-wrap items-end justify-between gap-3">
                                    <div>
                                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Run Tasks</p>
                                      <p className="mt-1 text-sm text-slate-300">
                                        {record.report?.tasks?.length ?? 0} task{record.report?.tasks?.length === 1 ? '' : 's'} recorded for this run
                                      </p>
                                    </div>
                                  </div>
                                  {record.report?.tasks?.length ? (
                                    <div className="mt-3 overflow-x-auto rounded-xl border border-slate-700">
                                      <table className="min-w-[900px] w-full text-left text-sm">
                                        <thead className="bg-slate-900 text-slate-400">
                                          <tr>
                                            <th className="px-4 py-3 font-medium">Task</th>
                                            <th className="px-4 py-3 font-medium">Plan</th>
                                            <th className="px-4 py-3 font-medium">Side</th>
                                            <th className="px-4 py-3 font-medium">Volume</th>
                                            <th className="px-4 py-3 font-medium">Planned</th>
                                            <th className="px-4 py-3 font-medium">Completed</th>
                                            <th className="px-4 py-3 font-medium">Attempts</th>
                                            <th className="px-4 py-3 font-medium">Status</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-800 bg-slate-900/70">
                                          {record.report.tasks.map((task) => (
                                            <tr key={task.id}>
                                              <td className="max-w-52 px-4 py-3">
                                                <p className="truncate font-medium text-slate-200" title={task.id}>{task.id}</p>
                                                {task.lastError ? <p className="mt-1 line-clamp-2 text-xs text-rose-300" title={task.lastError}>{task.lastError}</p> : null}
                                              </td>
                                              <td className="px-4 py-3 text-slate-400">Revision {task.planRevision ?? 0}</td>
                                              <td className={`px-4 py-3 font-semibold uppercase ${task.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}`}>{task.side}</td>
                                              <td className="px-4 py-3 text-slate-300">{formatUSD(task.amountUsd)}</td>
                                              <td className="px-4 py-3 text-slate-400">{formatDate(task.scheduledAt)}</td>
                                              <td className="px-4 py-3 text-slate-400">{task.completedAt ? formatDate(task.completedAt) : 'Unavailable'}</td>
                                              <td className="px-4 py-3 text-slate-300">{task.attemptCount}</td>
                                              <td className="px-4 py-3 text-slate-300">{titleCase(task.status)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : (
                                    <div className="mt-3 rounded-xl border border-dashed border-slate-700 bg-slate-900/70 px-4 py-4 text-sm text-slate-500">
                                      Task details were not recorded for this run.
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}