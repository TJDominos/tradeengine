import { Archive } from 'lucide-react';

import type { AuditLog, HistoricalSetup } from '../app/types';
import { compactAddress, formatDate, getLogsForSetup } from '../app/utils';
import SetupData from '../components/SetupData';

type HistoricalSetupsPageProps = {
  setups: HistoricalSetup[];
  activityLogs: AuditLog[];
};

export default function HistoricalSetupsPage({ setups, activityLogs }: HistoricalSetupsPageProps) {
  if (setups.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-slate-800 bg-slate-900 p-10 text-center text-slate-500 shadow-sm">
        <Archive size={40} className="mb-4 opacity-50" />
        <p className="text-lg font-medium text-slate-400">No Historical Setups Found</p>
        <p className="mx-auto mt-2 max-w-[400px] text-sm">
          Save a configuration from the Trading Setup tab to start tracking historical changes.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 space-y-6">
      {setups.map((setup, index) => {
        const setupLogs = getLogsForSetup(setups, activityLogs, index);
        return (
          <div key={setup.id} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-800/50 p-4">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-200">
                  <Archive size={16} className="text-emerald-500" />
                  Configuration Setup {index === 0 ? '(Active)' : `(${setups.length - index})`}
                </h3>
                <p className="mt-1 text-xs text-slate-500">Deployed {formatDate(setup.createdAt)}</p>
              </div>
              <div className="text-right">
                <span className="block text-sm font-medium text-slate-300">{setupLogs.length} Events</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 border-b border-slate-800 bg-slate-900/50 p-5 text-sm md:grid-cols-4">
              <SetupData label="Time Range Condition" value={setup.timeRangeTarget} />
              <SetupData label="Volume Target" value={`${setup.volumeTarget} USDC`} />
              <SetupData label="Net Buyin" value={`${setup.netBuyinTarget} USDC`} />
              <SetupData label="Volatility" value={`${setup.volatilityTarget}%`} />
              <SetupData label="Pullback" value={`${setup.pullbackTarget}%`} />
              <SetupData label="Max Transactions" value={String(setup.maxTransactions)} />
              <SetupData label="Max Slippage" value={`${setup.maxSlippage}%`} />
              <SetupData label="Contract" value={setup.contractAddress ? compactAddress(setup.contractAddress) : 'Global'} />
            </div>

            <div className="p-0">
              {setupLogs.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="h-10 border-b border-slate-800 bg-slate-900 text-xs font-semibold uppercase text-slate-400">
                        <th className="px-4 font-medium" style={{ width: '20%' }}>Time</th>
                        <th className="px-4 font-medium" style={{ width: '20%' }}>Action</th>
                        <th className="px-4 font-medium" style={{ width: '60%' }}>Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {setupLogs.map((log) => (
                        <tr key={log.id} className="transition-colors hover:bg-slate-800/50">
                          <td className="px-4 py-2 font-mono text-xs text-slate-400">{formatDate(log.createdAt)}</td>
                          <td className="px-4 py-2">
                            <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">{log.action}</span>
                          </td>
                          <td className="px-4 py-2 text-xs text-slate-300">{log.target} - {log.details}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-6 text-center text-sm text-slate-500">
                  No audit events fall inside this configuration window yet.
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}