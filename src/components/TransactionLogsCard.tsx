import { CheckSquare, Copy, FileText, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import React from 'react';

import type {
  DashboardTransactionLog,
  TransactionLogOwnershipFilter,
  WalletOwnershipMeta,
} from '../app/types';
import {
  compactAddress,
  formatDate,
  formatTokenPrice,
  formatUSD,
  formatNum,
  formatWebhookEventLabel,
  getTransactionLogEndpointOwnership,
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
  transactionLogActionEventOptions: string[];
  transactionLogActionEventFilters: string[];
  onTransactionLogActionEventFiltersChange: (filters: string[]) => void;
  transactionLogOwnershipFilter: TransactionLogOwnershipFilter;
  onTransactionLogOwnershipFilterChange: (filter: TransactionLogOwnershipFilter) => void;
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
  transactionLogActionEventOptions,
  transactionLogActionEventFilters,
  onTransactionLogActionEventFiltersChange,
  transactionLogOwnershipFilter,
  onTransactionLogOwnershipFilterChange,
  transactionLogCurrentPage,
  onTransactionLogPageChange,
  transactionLogDateFilterActive,
  itemsPerPage,
  activeTokenPriceUsd,
  onTransactionAddressClick,
  walletOwnershipLookup,
}: TransactionLogsCardProps) {
  const actionEventFilterRef = React.useRef<HTMLDetailsElement>(null);

  React.useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const filterMenu = actionEventFilterRef.current;
      if (filterMenu?.open && event.target instanceof Node && !filterMenu.contains(event.target)) {
        filterMenu.open = false;
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const hasSearchFilter = transactionLogSearchTerm.trim().length > 0;
  const hasActionEventFilter = transactionLogActionEventFilters.length > 0;
  const hasOwnershipFilter = transactionLogOwnershipFilter !== 'all';
  const hasTransactionLogFilter = hasSearchFilter || hasActionEventFilter || hasOwnershipFilter;
  const emptyStateMessage = totalTransactionLogsCount === 0
    ? 'No trade or webhook records yet.'
    : filteredTransactionLogsCount === 0 && hasTransactionLogFilter && transactionLogDateFilterActive
      ? 'No transaction logs match the selected filters in the selected date range.'
      : filteredTransactionLogsCount === 0 && hasTransactionLogFilter
        ? 'No transaction logs match the selected filters.'
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
          : meta.ownership === 'lp'
            ? 'border border-cyan-500/20 bg-cyan-500/10 text-cyan-300'
          : meta.ownership === 'external'
            ? 'border border-amber-500/20 bg-amber-500/10 text-amber-300'
            : meta.ownership === 'system'
              ? 'border border-slate-700 bg-slate-800 text-slate-300'
              : 'border border-slate-700 bg-slate-900 text-slate-400'
      }`}>
        {meta.ownership === 'lp' ? 'LP' : meta.ownership}
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <FileText size={18} /> Transaction Log
          <span className="ml-4 flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"></span> LIVE
          </span>
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <details ref={actionEventFilterRef} className="relative">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 text-sm text-slate-200 transition hover:bg-slate-700 [&::-webkit-details-marker]:hidden">
              <SlidersHorizontal size={14} />
              Action / Event
              <span className="text-xs text-slate-400">
                {transactionLogActionEventFilters.length === 0
                  ? 'All'
                  : `${transactionLogActionEventFilters.length} selected`}
              </span>
            </summary>
            <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-md border border-slate-700 bg-slate-900 p-3 shadow-xl">
              <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-400">
                <span>Action / Event</span>
                {transactionLogActionEventFilters.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => onTransactionLogActionEventFiltersChange([])}
                    className="text-blue-300 transition hover:text-blue-200"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {transactionLogActionEventOptions.length > 0 ? transactionLogActionEventOptions.map((option) => (
                  <label key={option} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
                    <input
                      type="checkbox"
                      checked={transactionLogActionEventFilters.includes(option)}
                      onChange={() => {
                        const nextFilters = transactionLogActionEventFilters.includes(option)
                          ? transactionLogActionEventFilters.filter((filter) => filter !== option)
                          : [...transactionLogActionEventFilters, option];
                        onTransactionLogActionEventFiltersChange(nextFilters);
                      }}
                      className="accent-blue-500"
                    />
                    {option}
                  </label>
                )) : (
                  <span className="px-2 py-1.5 text-sm text-slate-500">No actions or events</span>
                )}
              </div>
            </div>
          </details>
          <div className="flex h-9 items-center rounded-md border border-slate-700 bg-slate-950 p-0.5" role="group" aria-label="Transaction log ownership filter">
            {(['external', 'all', 'internal'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={transactionLogOwnershipFilter === filter}
                onClick={() => onTransactionLogOwnershipFilterChange(filter)}
                className={`h-8 rounded px-2.5 text-xs font-semibold uppercase tracking-wider transition ${
                  transactionLogOwnershipFilter === filter
                    ? 'bg-blue-500/20 text-blue-300'
                    : 'text-slate-500 hover:text-slate-200'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
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
              <th className="px-4 py-2 font-medium">Token Price</th>
              <th className="px-4 py-2 font-medium">USDC Amount</th>
              <th className="px-4 py-2 text-center font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Tx / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {currentTransactionLogs.map((log) => {
              const displayTime = log.chainTimeMs ?? log.createdAt;
              const walletOwnershipMeta = resolveWalletOwnershipMeta(
                log.walletAddress,
                walletOwnershipLookup,
                'external',
              );
              const endpointOwnership = getTransactionLogEndpointOwnership(log, walletOwnershipLookup);
              const webhookFromOwnership = log.kind === 'webhook' ? endpointOwnership.from : null;
              const webhookToOwnership = log.kind === 'webhook' ? endpointOwnership.to : null;
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
                  : log.tokenAmount;
              const usdcAmount =
                log.kind === 'webhook'
                  ? log.usdcAmount
                  : log.usdcAmount;
              const estimatedUsdcAmount =
                usdcAmount == null && log.kind === 'webhook' && tokenAmount != null && activeTokenPriceUsd != null
                  ? tokenAmount * activeTokenPriceUsd
                  : null;
              const calculatedTokenPriceUsd =
                usdcAmount != null && tokenAmount != null && Number.isFinite(usdcAmount) && Number.isFinite(tokenAmount) && tokenAmount > 0
                  ? usdcAmount / tokenAmount
                  : null;
              const tokenPriceUsd = calculatedTokenPriceUsd ?? (log.kind === 'webhook' ? log.tokenPriceUsd : log.executedPrice);
              const displayTokenPriceUsd = tokenPriceUsd != null && Number.isFinite(tokenPriceUsd) && tokenPriceUsd > 0
                ? tokenPriceUsd
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
                      {renderAddress(log.fromWalletAddress, 'from')}
                      {renderOwnershipMeta(
                        log.kind === 'webhook'
                          ? (webhookFromOwnership ?? walletOwnershipMeta)
                          : resolveWalletOwnershipMeta(
                              log.fromWalletAddress,
                              walletOwnershipLookup,
                              log.action === 'BUY' ? 'lp' : 'internal',
                            ),
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="space-y-1 text-slate-500">
                      {renderAddress(log.toWalletAddress, 'to')}
                      {log.kind === 'webhook'
                        ? renderOwnershipMeta(
                            webhookToOwnership ?? { ownership: 'system', accountLabel: null },
                            { showSourceLabel: sourceLabel },
                          )
                        : renderOwnershipMeta(
                            resolveWalletOwnershipMeta(
                              log.toWalletAddress,
                              walletOwnershipLookup,
                              log.action === 'SELL' ? 'lp' : 'internal',
                            ),
                            { showSourceLabel: sourceLabel },
                          )}
                    </div>
                  </td>
                  <td className={`px-4 py-1.5 text-xs font-bold ${actionClass}`}>{actionLabel}</td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">{tokenAmount != null ? formatNum(tokenAmount) : '-'}</td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">
                    {actionLabel === 'BUY' || actionLabel === 'SELL'
                      ? displayTokenPriceUsd != null ? formatTokenPrice(displayTokenPriceUsd) : '-'
                      : '-'}
                  </td>
                  <td className="px-4 py-1.5 text-xs text-slate-300">
                    {usdcAmount != null
                      ? formatUSD(usdcAmount)
                      : estimatedUsdcAmount != null
                        ? `~${formatUSD(estimatedUsdcAmount)}`
                        : '-'}
                  </td>
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