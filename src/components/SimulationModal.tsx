import { Code } from 'lucide-react';

import type { SettingsState } from '../app/types';
import SimulationCard from './SimulationCard';
import SimulationRow from './SimulationRow';

type SimulationModalProps = {
  open: boolean;
  onClose: () => void;
  settings: SettingsState;
  managedAccountsCount: number;
  tradableTokensCount: number;
};

export default function SimulationModal({
  open,
  onClose,
  settings,
  managedAccountsCount,
  tradableTokensCount,
}: SimulationModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Code size={18} className="text-emerald-500" />
            Simulation Summary
          </h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-white">
            X
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-6 font-mono text-sm">
          <div className="rounded border border-slate-800 bg-slate-950 p-4 text-xs text-emerald-400/90 shadow-inner">
            <p>{'>'} INITIALIZING BACKTEST ENVIRONMENT...</p>
            <p className="mt-1">{'>'} LOADING HISTORICAL TICKS (Target: {settings.timeRangeTarget})...</p>
            <p className="mt-1">{'>'} APPLYING ALGORITHM LOGIC...</p>
            <p className="mt-1">{'>'} ENGINE REPLAY COMPLETE.</p>
          </div>

          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <SimulationCard label="Tracked Wallets" value={String(managedAccountsCount)} />
            <SimulationCard label="Tracked Tokens" value={String(tradableTokensCount)} />
            <SimulationCard label="Target Range" value={settings.timeRangeTarget} accent="emerald" />
            <SimulationCard label="Max Slippage" value={`${settings.maxSlippage}%`} accent="rose" />
          </div>

          <div>
            <h4 className="mb-3 text-sm font-semibold text-slate-300">Sample Action Sequence</h4>
            <div className="space-y-2 text-xs">
              <SimulationRow left="T-12h 00m" center="SIGNAL_TRIGGER" right={`Volume Spiked > ${settings.volumeTarget || 0}`} />
              <SimulationRow left="T-11h 59m" center="QUALIFY_WALLET" right={`${managedAccountsCount} managed wallets ready`} />
              <SimulationRow left="T-10h 30m" center="EXECUTION_BLOCKED" right="Live trade sending is disabled in this backend" />
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-slate-800 bg-slate-900 p-4">
          <button onClick={onClose} className="h-10 rounded-md border border-slate-700 bg-slate-800 px-6 font-medium text-white hover:bg-slate-700">
            Close Summary
          </button>
        </div>
      </div>
    </div>
  );
}