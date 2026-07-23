import { Archive, Clock, FileText } from 'lucide-react';
import React from 'react';

import type {
  StrategyEvaluationRecord,
  StrategyVersionRecord,
} from '../app/types';
import { compactAddress, formatDate } from '../app/utils';
import TabButton from '../components/TabButton';

type HistoricalSetupsPageProps = {
  activeStrategyVersion: StrategyVersionRecord | null;
  strategyVersions: StrategyVersionRecord[];
  strategyEvaluations: StrategyEvaluationRecord[];
  onCleanupStrategyVersions: () => void;
  isCleaningStrategyVersions: boolean;
};

export default function HistoricalSetupsPage({
  activeStrategyVersion,
  strategyVersions,
  strategyEvaluations,
  onCleanupStrategyVersions,
  isCleaningStrategyVersions,
}: HistoricalSetupsPageProps) {
  const [activeView, setActiveView] = React.useState<'versions' | 'evaluations'>('versions');

  if (strategyVersions.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-slate-800 bg-slate-900 p-10 text-center text-slate-500 shadow-sm">
        <Archive size={40} className="mb-4 opacity-50" />
        <p className="text-lg font-medium text-slate-400">No Strategy Versions Found</p>
        <p className="mx-auto mt-2 max-w-[400px] text-sm">
          Save and activate a strategy version from the Trading Setup tab to start versioning configuration changes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-slate-800 bg-slate-900 p-1 shadow-sm">
          <TabButton
            active={activeView === 'versions'}
            onClick={() => setActiveView('versions')}
            icon={<Archive size={14} />}
            label="Strategy Versions"
          />
          <TabButton
            active={activeView === 'evaluations'}
            onClick={() => setActiveView('evaluations')}
            icon={<FileText size={14} />}
            label="Strategy Evaluations"
          />
        </div>
        {activeView === 'versions' ? (
          <button
            onClick={onCleanupStrategyVersions}
            disabled={isCleaningStrategyVersions}
            className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-medium uppercase tracking-wider text-rose-300 hover:bg-rose-500/20 disabled:opacity-60"
          >
            {isCleaningStrategyVersions ? 'Clearing...' : 'Clear Automatic Versions'}
          </button>
        ) : null}
      </div>

      {activeView === 'versions' ? (
        <div className="flex flex-col gap-4">
          {strategyVersions.map((version) => {
            const isActive = activeStrategyVersion?.id === version.id;
            const doc = version.document;
            return (
              <div key={version.id} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-800 bg-slate-800/50 p-4">
                  <div>
                    <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-200">
                      <Archive size={16} className="text-emerald-500" />
                      Strategy Version v{version.versionNo}
                      {isActive ? (
                        <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-blue-300">
                          active
                        </span>
                      ) : null}
                    </h3>
                    <p className="mt-1 text-xs text-slate-500">
                      Created {formatDate(version.createdAt)}
                      {version.activatedAt ? ` | Activated ${formatDate(version.activatedAt)}` : ''}
                    </p>
                  </div>
                  <div className="text-right text-xs text-slate-400">
                    <div>Status: {version.status}</div>
                    <div>Schema v{version.schemaVersion}</div>
                    <div>Engine {version.engineVersion}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-b border-slate-800 bg-slate-900/50 p-5 text-sm md:grid-cols-4">
                  <div>
                    <span className="mb-1 block text-xs text-slate-500">Contract</span>
                    <span className="font-medium text-slate-300">{doc.parameters.contractAddress ? compactAddress(doc.parameters.contractAddress) : 'None'}</span>
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-slate-500">Time Range</span>
                    <span className="font-medium text-slate-300">{doc.parameters.timeRangeTarget}</span>
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-slate-500">Max Transactions</span>
                    <span className="font-medium text-slate-300">{doc.parameters.maxTransactions}</span>
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-slate-500">Max Slippage</span>
                    <span className="font-medium text-slate-300">{(doc.parameters.maxSlippageBps / 100).toFixed(2)}%</span>
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-slate-500">Volume Target</span>
                    <span className="font-medium text-slate-300">{doc.targets.volumeUsdMin} USDC</span>
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-slate-500">Net Buyin</span>
                    <span className="font-medium text-slate-300">{doc.targets.netBuyinUsdMin} USDC</span>
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-slate-500">Dry Run</span>
                    <span className="font-medium text-slate-300">{doc.riskControls.dryRun ? 'enabled' : 'disabled'}</span>
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-slate-500">Execution</span>
                    <span className="font-medium text-slate-300">{doc.execution.enabled ? 'enabled' : 'disabled'}</span>
                  </div>
                </div>

                <div className="p-4 text-xs text-slate-300">
                  <div className="mb-2 flex items-center gap-2 text-slate-400">
                    <Clock size={14} /> Trigger Sources
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {doc.triggers.sources.map((source) => (
                      <span key={source} className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-300">
                        {source}
                      </span>
                    ))}
                    {doc.triggers.eventTypes.map((eventType) => (
                      <span key={eventType} className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-blue-300">
                        {eventType}
                      </span>
                    ))}
                  </div>
                  {(version.changeNote || doc.metadata.changeNote) ? (
                    <p className="mt-4 text-slate-400">
                      Change Note: {version.changeNote || doc.metadata.changeNote}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
          <div className="border-b border-slate-800 bg-slate-900/80 p-4">
            <h3 className="text-lg font-semibold text-slate-200">Strategy Evaluations</h3>
            <p className="mt-1 text-xs text-slate-500">
              Every webhook or manual refresh evaluation is recorded here with its decision summary.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-4 py-2 font-medium">Version</th>
                  <th className="px-4 py-2 font-medium">Trigger</th>
                  <th className="px-4 py-2 font-medium">Contract</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Execution</th>
                  <th className="px-4 py-2 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {strategyEvaluations.map((evaluation) => {
                  const reasons = Array.isArray(evaluation.summary.reasons)
                    ? evaluation.summary.reasons.filter((entry): entry is string => typeof entry === 'string')
                    : [];
                  return (
                    <tr key={evaluation.id} className="transition-colors hover:bg-slate-800/50">
                      <td className="px-4 py-2 text-xs text-slate-400">{formatDate(evaluation.createdAt)}</td>
                      <td className="px-4 py-2 text-xs font-semibold text-slate-300">v{evaluation.strategyVersionNo}</td>
                      <td className="px-4 py-2 text-xs text-slate-300">{evaluation.source} / {evaluation.eventType}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">{compactAddress(evaluation.contractAddress)}</td>
                      <td className="px-4 py-2 text-xs text-slate-300">{evaluation.status}</td>
                      <td className="px-4 py-2 text-xs text-slate-300">
                        {evaluation.shouldExecute ? 'execute' : evaluation.dryRun ? 'dry-run' : 'blocked'}
                      </td>
                      <td className="max-w-[480px] px-4 py-2 text-xs text-slate-300">
                        {reasons.length > 0 ? reasons.join(' | ') : 'Qualified without blocking reasons.'}
                      </td>
                    </tr>
                  );
                })}
                {strategyEvaluations.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-sm text-slate-500">
                      No strategy evaluations recorded yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}