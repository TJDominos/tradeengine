import { Activity, Clock, Lock, RefreshCw, Shield } from 'lucide-react';

type AppHeaderProps = {
  contractAddress: string;
  lastUpdated: string;
  isTradingActive: boolean;
  onToggleTrading: () => void;
  onOpenAdmin: () => void;
  onRefresh: () => void;
  onLogout: () => void;
};

export default function AppHeader({
  contractAddress,
  lastUpdated,
  isTradingActive,
  onToggleTrading,
  onOpenAdmin,
  onRefresh,
  onLogout,
}: AppHeaderProps) {
  return (
    <div className="mb-6 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-white">
          <Activity className="text-blue-500" /> WLT Execution Engine
        </h1>
        <p className="mt-1.5 flex items-center gap-2 text-sm text-slate-400">
          <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 font-mono text-blue-400">
            {contractAddress || 'Not Configured'}
          </span>
          <span className="text-slate-700">|</span>
          <Clock size={14} /> Time Updated: {lastUpdated}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onToggleTrading}
          className={`flex h-10 cursor-pointer items-center gap-2 rounded-md px-4 text-sm font-medium text-white shadow-sm ${
            isTradingActive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
        >
          <Activity size={16} /> {isTradingActive ? 'Trading' : 'Start Trading'}
        </button>
        <button
          onClick={onOpenAdmin}
          className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm font-medium text-white shadow-sm hover:bg-slate-700"
        >
          <Shield size={16} className="text-amber-500" /> Admin
        </button>
        <button
          onClick={onRefresh}
          className="flex h-10 cursor-pointer items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          <RefreshCw size={16} /> Refresh
        </button>
        <button
          onClick={onLogout}
          className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm font-medium text-white shadow-sm hover:bg-slate-700"
        >
          <Lock size={16} /> Logout
        </button>
      </div>
    </div>
  );
}