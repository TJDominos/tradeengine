import { CheckSquare, FileText, Search } from 'lucide-react';

import type { DashboardTransactionLog, WalletOwnershipMeta } from '../app/types';
import {
  compactAddress,
  formatDate,
  formatNum,
  formatWebhookEventLabel,
  resolveWalletOwnershipMeta,
} from '../app/utils';
import Pagination from './Pagination';

type TransactionLogsCardProps = {
  currentTransactionLogs: DashboardTransactionLog[];
  filteredTransactionLogsCount: number;
  transactionLogSearchTerm: string;
  onTransactionLogSearchTermChange: (value: string) => void;
  transactionLogCurrentPage: number;
  onTransactionLogPageChange: (page: number) => void;
  itemsPerPage: number;
  walletOwnershipLookup: Map<string, WalletOwnershipMeta>;
};

export default function TransactionLogsCard({
  currentTransactionLogs,
  filteredTransactionLogsCount,
  transactionLogSearchTerm,
  onTransactionLogSearchTermChange,
  transactionLogCurrentPage,
  onTransactionLogPageChange,
  itemsPerPage,
  walletOwnershipLookup,
}: TransactionLogsCardProps) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <FileText size={18} /> Transaction Log
          <span className="ml-4 flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"></span> LIVE
          </span>
        </h3>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            placeholder="Search transaction logs..."
            value={transactionLogSearchTerm}
            onChange={(event) => onTransactionLogSearchTermChange(event.target.value)}
            className="w-64 rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-h-[400px] w-full whitespace-nowrap text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Token</th>
              <th className="px-4 py-2 font-medium">Wallets</th>
              <th className="px-4 py-2 font-medium">Action / Event</th>
              <th className="px-4 py-2 font-medium">Token Qty</th>
              <th className="px-4 py-2 font-medium">USDC Amount</th>
              <th className="px-4 py-2 text-center font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Tx / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {currentTransactionLogs.map((log) => {
              const walletAddress = log.walletAddress ?? 'system';
              const walletOwnershipMeta = resolveWalletOwnershipMeta(log.walletAddress, walletOwnershipLookup);
              const actionLabel =
                log.kind === 'webhook'
                  ? log.action ?? formatWebhookEventLabel(log.eventType)
                  : log.action;
              const actionClass =
                log.kind === 'webhook'
                  ? log.action === 'BUY'
                    ? 'text-emerald-400'
                    : log.action === 'SELL'
                      ? 'text-amber-300'
                      : 'text-sky-300'
                  : log.action === 'BUY'
                    ? 'text-emerald-400'
                    : 'text-amber-300';
              const ownershipBadgeClass =
                walletOwnershipMeta.ownership === 'internal'
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                  : walletOwnershipMeta.ownership === 'external'
                    ? 'border border-amber-500/20 bg-amber-500/10 text-amber-300'
                    : walletOwnershipMeta.ownership === 'system'
                      ? 'border border-slate-700 bg-slate-800 text-slate-300'
                      : 'border border-slate-700 bg-slate-900 text-slate-400';
              const tokenAmount =
                log.kind === 'webhook'
                  ? log.tokenAmount
                  : log.action === 'BUY'
                    ? log.executedAmount
                    : log.requestedAmount;
              const usdcAmount =
                log.kind === 'webhook'
                  ? log.usdcAmount
                  : log.action === 'BUY'
                    ? log.requestedAmount
                    : log.executedAmount != null && log.executedPrice != null
                      ? log.executedAmount * log.executedPrice
                      : null;
              const txOrError = log.txSignature
                ? compactAddress(log.txSignature)
                : log.errorMessage ?? (log.kind === 'webhook' ? 'Tracked by webhook' : '-');

              return (
                <tr key={`${log.kind}-${log.id}`} className="transition-colors hover:bg-slate-800/50">
                  <td className="px-4 py-1.5 text-xs text-slate-400">{formatDate(log.createdAt)}</td>
                  <td className="px-4 py-1.5">
                    <div className="text-xs font-semibold text-slate-200">
                      {log.tokenSymbol ?? (log.kind === 'webhook' ? 'Tracked Activity' : 'Tracked Token')}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {log.tokenContractAddress ? compactAddress(log.tokenContractAddress) : 'Unknown'}
                    </div>
                  </td>
                  <td className="px-4 py-1.5">
                    {log.kind === 'webhook' ? (
                      <div className="space-y-1 font-mono text-xs text-slate-500">
                        <div>
                          <span className="mr-1 text-slate-600">from</span>
                          {log.fromWalletAddress ? compactAddress(log.fromWalletAddress) : '-'}
                        </div>
                        <div>
                          <span className="mr-1 text-slate-600">to</span>
                          {log.toWalletAddress ? compactAddress(log.toWalletAddress) : '-'}
                        </div>
                      </div>
                    ) : (
                      <div className="font-mono text-xs text-slate-500">
                        {walletAddress === 'system' ? 'system' : compactAddress(walletAddress)}
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${ownershipBadgeClass}`}>
                        {walletOwnershipMeta.ownership}
                      </span>
                      {walletOwnershipMeta.accountLabel ? (
                        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] text-slate-300">
                          {walletOwnershipMeta.accountLabel}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className={`px-4 py-1.5 text-xs font-bold ${actionClass}`}>{actionLabel}</td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">{tokenAmount != null ? formatNum(tokenAmount) : '-'}</td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">{usdcAmount != null ? formatNum(usdcAmount) : '-'}</td>
                  <td className="px-4 py-1.5 text-center">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                        log.status === 'SUCCESS' || log.status === 'CONFIRMED'
                          ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                          : log.status === 'FAILED'
                            ? 'border border-rose-500/20 bg-rose-500/10 text-rose-400'
                            : 'border border-amber-500/20 bg-amber-500/10 text-amber-300'
                      }`}
                    >
                      <CheckSquare size={10} /> {log.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="max-w-[320px] px-4 py-1.5 text-xs text-slate-300">{txOrError}</td>
                </tr>
              );
            })}
            {currentTransactionLogs.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-sm text-slate-500">
                  No trade or webhook records yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination currentPage={transactionLogCurrentPage} totalItems={filteredTransactionLogsCount} itemsPerPage={itemsPerPage} onPageChange={onTransactionLogPageChange} />
    </div>
  );
}