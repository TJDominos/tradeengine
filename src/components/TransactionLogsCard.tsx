import { CheckSquare, Copy, FileText, RefreshCw, Search } from 'lucide-react';

import type { DashboardTransactionLog, WalletOwnershipMeta } from '../app/types';
import {
  compactAddress,
  formatDate,
  formatUSD,
  formatNum,
  formatWebhookEventLabel,
  resolveWalletOwnershipMeta,
} from '../app/utils';
import Pagination from './Pagination';

type TransactionLogsCardProps = {
  currentTransactionLogs: DashboardTransactionLog[];
  onRefreshTransactionLogs: () => void;
  transactionLogRefreshPending: boolean;
  requestLocked: boolean;
  totalTransactionLogsCount: number;
  filteredTransactionLogsCount: number;
  transactionLogSearchTerm: string;
  onTransactionLogSearchTermChange: (value: string) => void;
  transactionLogCurrentPage: number;
  onTransactionLogPageChange: (page: number) => void;
  transactionLogDateFilterActive: boolean;
  itemsPerPage: number;
  activeTokenPriceUsd: number | null;
  onTransactionAddressClick: (address: string) => void;
  walletOwnershipLookup: Map<string, WalletOwnershipMeta>;
};

export default function TransactionLogsCard({
  currentTransactionLogs,
  onRefreshTransactionLogs,
  transactionLogRefreshPending,
  requestLocked,
  totalTransactionLogsCount,
  filteredTransactionLogsCount,
  transactionLogSearchTerm,
  onTransactionLogSearchTermChange,
  transactionLogCurrentPage,
  onTransactionLogPageChange,
  transactionLogDateFilterActive,
  itemsPerPage,
  activeTokenPriceUsd,
  onTransactionAddressClick,
  walletOwnershipLookup,
}: TransactionLogsCardProps) {
  const hasSearchFilter = transactionLogSearchTerm.trim().length > 0;
  const emptyStateMessage = totalTransactionLogsCount === 0
    ? 'No trade or webhook records yet.'
    : filteredTransactionLogsCount === 0 && hasSearchFilter && transactionLogDateFilterActive
      ? 'No transaction logs match the current search in the selected date range.'
      : filteredTransactionLogsCount === 0 && hasSearchFilter
        ? 'No transaction logs match the current search.'
        : filteredTransactionLogsCount === 0 && transactionLogDateFilterActive
          ? 'No transaction logs fall within the selected date range.'
          : 'No trade or webhook records yet.';

  const handleCopyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Ignore clipboard failures; clicking still navigates to the account search.
    }
  };

  const renderAddress = (address: string | null, label: 'from' | 'to') => {
    if (!address) {
      return <span className="text-slate-600">-</span>;
    }

    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onTransactionAddressClick(address)}
          className="font-mono text-xs text-slate-200 underline decoration-dotted underline-offset-4 transition hover:text-blue-300"
          title={`Search ${label} address in Accounts`}
        >
          {compactAddress(address)}
        </button>
        <button
          type="button"
          onClick={() => void handleCopyText(address)}
          className="rounded border border-slate-700 bg-slate-950 p-1 text-slate-500 transition hover:border-slate-500 hover:text-slate-200"
          title="Copy address"
        >
          <Copy size={10} />
        </button>
      </div>
    );
  };

  const renderOwnershipMeta = (meta: WalletOwnershipMeta, options?: { showSourceLabel?: string }) => (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        meta.ownership === 'internal'
          ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
          : meta.ownership === 'external'
            ? 'border border-amber-500/20 bg-amber-500/10 text-amber-300'
            : meta.ownership === 'system'
              ? 'border border-slate-700 bg-slate-800 text-slate-300'
              : 'border border-slate-700 bg-slate-900 text-slate-400'
      }`}>
        {meta.ownership}
      </span>
      {options?.showSourceLabel ? (
        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-300">
          {options.showSourceLabel}
        </span>
      ) : null}
      {meta.accountLabel ? (
        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[10px] text-slate-300">
          {meta.accountLabel}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <FileText size={18} /> Transaction Log
          <span className="ml-4 flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"></span> LIVE
          </span>
        </h3>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onRefreshTransactionLogs}
            disabled={requestLocked}
            className="flex h-9 items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 text-sm text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={14} className={transactionLogRefreshPending ? 'animate-spin' : ''} />
            {transactionLogRefreshPending ? 'Refreshing...' : 'Refresh RPC Logs'}
          </button>
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
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Token</th>
              <th className="px-4 py-2 font-medium">From</th>
              <th className="px-4 py-2 font-medium">To</th>
              <th className="px-4 py-2 font-medium">Action / Event</th>
              <th className="px-4 py-2 font-medium">Token Qty</th>
              <th className="px-4 py-2 font-medium">USDC Amount</th>
              <th className="px-4 py-2 font-medium">Fee</th>
              <th className="px-4 py-2 text-center font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Tx / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {currentTransactionLogs.map((log) => {
              const displayTime = log.kind === 'webhook'
                ? log.chainTimeMs
                : log.txSignature
                  ? log.chainTimeMs
                  : log.createdAt;
              const walletOwnershipMeta = resolveWalletOwnershipMeta(
                log.walletAddress,
                walletOwnershipLookup,
                'external',
              );
              const webhookFromOwnership =
                log.kind === 'webhook'
                  ? resolveWalletOwnershipMeta(
                      log.fromWalletAddress,
                      walletOwnershipLookup,
                      'external',
                    )
                  : null;
              const webhookToOwnership =
                log.kind === 'webhook'
                  ? resolveWalletOwnershipMeta(
                      log.toWalletAddress,
                      walletOwnershipLookup,
                      'external',
                    )
                  : null;
              const normalizedWebhookAction =
                log.kind === 'webhook'
                  ? log.action ?? (
                      webhookFromOwnership?.ownership === 'internal' && webhookToOwnership?.ownership !== 'internal'
                        ? 'SELL'
                        : webhookToOwnership?.ownership === 'internal' && webhookFromOwnership?.ownership !== 'internal'
                          ? 'BUY'
                          : null
                    )
                  : null;
              const actionLabel =
                log.kind === 'webhook'
                  ? normalizedWebhookAction ?? formatWebhookEventLabel(log.eventType)
                  : log.action;
              const actionClass =
                log.kind === 'webhook'
                  ? normalizedWebhookAction === 'BUY'
                    ? 'text-emerald-400'
                    : normalizedWebhookAction === 'SELL'
                      ? 'text-amber-300'
                      : normalizedWebhookAction === 'TRANSFER'
                        ? 'text-sky-300'
                      : 'text-sky-300'
                  : log.action === 'BUY'
                    ? 'text-emerald-400'
                    : 'text-amber-300';
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
              const estimatedUsdcAmount =
                usdcAmount == null && log.kind === 'webhook' && tokenAmount != null && activeTokenPriceUsd != null
                  ? tokenAmount * activeTokenPriceUsd
                  : null;
              const feeAmount =
                log.kind === 'webhook'
                  ? log.feeAmountUsd
                  : null;
              const sourceLabel =
                log.kind === 'webhook'
                  ? log.source === 'rpc_reconcile'
                    ? 'rpc'
                    : 'webhook'
                  : 'trade';
              const txOrError = log.txSignature
                ? compactAddress(log.txSignature)
                : log.errorMessage ?? (log.kind === 'webhook' ? 'Tracked by webhook' : '-');

              return (
                <tr key={`${log.kind}-${log.id}`} className="transition-colors hover:bg-slate-800/50">
                  <td className="px-4 py-1.5 text-xs text-slate-400">
                    {displayTime != null ? formatDate(displayTime) : 'Pending chain time'}
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="text-xs font-semibold text-slate-200">
                      {log.tokenSymbol ?? (log.kind === 'webhook' ? 'Tracked Activity' : 'Tracked Pair')}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {log.tokenContractAddress ? compactAddress(log.tokenContractAddress) : 'Unknown'}
                    </div>
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="space-y-1 text-slate-500">
                      {renderAddress(log.kind === 'webhook' ? log.fromWalletAddress : log.walletAddress, 'from')}
                      {renderOwnershipMeta(
                        log.kind === 'webhook'
                          ? (webhookFromOwnership ?? walletOwnershipMeta)
                          : walletOwnershipMeta,
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="space-y-1 text-slate-500">
                      {renderAddress(log.kind === 'webhook' ? log.toWalletAddress : null, 'to')}
                      {log.kind === 'webhook'
                        ? renderOwnershipMeta(
                            webhookToOwnership ?? { ownership: 'system', accountLabel: null },
                            { showSourceLabel: sourceLabel },
                          )
                        : renderOwnershipMeta({ ownership: 'system', accountLabel: null }, { showSourceLabel: sourceLabel })}
                    </div>
                  </td>
                  <td className={`px-4 py-1.5 text-xs font-bold ${actionClass}`}>{actionLabel}</td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">{tokenAmount != null ? formatNum(tokenAmount) : '-'}</td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">
                    {usdcAmount != null
                      ? formatUSD(usdcAmount)
                      : estimatedUsdcAmount != null
                        ? `~${formatUSD(estimatedUsdcAmount)}`
                        : '-'}
                  </td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">{feeAmount != null ? formatNum(feeAmount) : '-'}</td>
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
                  <td className="max-w-[320px] px-4 py-1.5 text-xs text-slate-300">
                    {log.txSignature ? (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono" title={log.txSignature}>{txOrError}</span>
                        <button
                          type="button"
                          onClick={() => void handleCopyText(log.txSignature!)}
                          className="rounded border border-slate-700 bg-slate-950 p-1 text-slate-500 transition hover:border-slate-500 hover:text-slate-200"
                          title="Copy transaction signature"
                        >
                          <Copy size={10} />
                        </button>
                      </div>
                    ) : (
                      txOrError
                    )}
                  </td>
                </tr>
              );
            })}
            {currentTransactionLogs.length === 0 ? (
              <tr>
                <td colSpan={10} className="h-[400px] py-8 align-top text-center text-sm text-slate-500">
                  {emptyStateMessage}
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