import { Activity, CheckSquare, Search } from 'lucide-react';

import type { AuditLog } from '../app/types';
import { compactAddress, formatDate } from '../app/utils';
import Pagination from './Pagination';

type ActivityLogsCardProps = {
  currentActivityLogs: AuditLog[];
  filteredActivityLogsCount: number;
  activityLogSearchTerm: string;
  onActivityLogSearchTermChange: (value: string) => void;
  activityLogCurrentPage: number;
  onActivityLogPageChange: (page: number) => void;
  itemsPerPage: number;
};

export default function ActivityLogsCard({
  currentActivityLogs,
  filteredActivityLogsCount,
  activityLogSearchTerm,
  onActivityLogSearchTermChange,
  activityLogCurrentPage,
  onActivityLogPageChange,
  itemsPerPage,
}: ActivityLogsCardProps) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Activity size={18} /> Activity Log
        </h3>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            placeholder="Search activity logs..."
            value={activityLogSearchTerm}
            onChange={(event) => onActivityLogSearchTermChange(event.target.value)}
            className="w-64 rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Details</th>
              <th className="px-4 py-2 text-center font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {currentActivityLogs.map((log) => (
              <tr key={log.id} className="align-top transition-colors hover:bg-slate-800/50">
                <td className="px-4 py-1.5 text-xs text-slate-400">{formatDate(log.createdAt)}</td>
                <td className="px-4 py-1.5 font-mono text-xs text-slate-500">{compactAddress(log.target)}</td>
                <td className="px-4 py-1.5 text-xs font-bold text-slate-200">{log.action}</td>
                <td className="max-w-[500px] whitespace-pre-wrap break-all px-4 py-1.5 text-xs leading-relaxed text-slate-300">{log.details}</td>
                <td className="px-4 py-1.5 text-center">
                  <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-300">
                    <CheckSquare size={10} /> recorded
                  </span>
                </td>
              </tr>
            ))}
            {currentActivityLogs.length === 0 ? (
              <tr>
                <td colSpan={5} className="h-[400px] py-8 align-top text-center text-sm text-slate-500">
                  No activity recorded yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination currentPage={activityLogCurrentPage} totalItems={filteredActivityLogsCount} itemsPerPage={itemsPerPage} onPageChange={onActivityLogPageChange} />
    </div>
  );
}