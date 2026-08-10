import { Activity, Clock, Lock, RefreshCw, Shield } from 'lucide-react';

type AppHeaderProps = {
  lastUpdated: string;
  isRefreshing: boolean;
  requestLocked: boolean;
  onOpenAdmin: () => void;
  onRefresh: () => void;
  onLogout: () => void;
};

export default function AppHeader({
  lastUpdated,
  isRefreshing,
  requestLocked,
  onOpenAdmin,
  onRefresh,
  onLogout,
}: AppHeaderProps) {
  return (
    <div className="mb-6 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-white">
          <Activity className="text-blue-500" /> Execution Engine
        </h1>
        <p className="mt-1.5 flex items-center gap-2 text-sm text-slate-400">
          <Clock size={14} /> Time Updated: {lastUpdated}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onOpenAdmin}
          className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm font-medium text-white shadow-sm hover:bg-slate-700"
        >
          <Shield size={16} className="text-amber-500" /> Admin
        </button>
        <button
          onClick={onRefresh}
          disabled={isRefreshing || requestLocked}
          className={`flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium text-white shadow-sm ${
            isRefreshing || requestLocked
              ? 'cursor-not-allowed bg-blue-500/70'
              : 'cursor-pointer bg-blue-600 hover:bg-blue-700'
          }`}
        >
          <RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />
          {isRefreshing ? 'Fetching...' : 'Refresh'}
        </button>
        <button
          onClick={onLogout}
          disabled={requestLocked}
          className="flex h-10 items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm font-medium text-white shadow-sm hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Lock size={16} /> Logout
        </button>
      </div>
    </div>
  );
}