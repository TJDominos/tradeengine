import React from 'react';
import { Copy, RefreshCw, Search, Shield, Users, Wallet } from 'lucide-react';

import type {
  AccountRecord,
  AccountSummary,
  DateRangeState,
  OutsideTokenHolder,
  WalletBalance,
} from '../app/types';
import {
  compactAddress,
  formatDate,
  formatNum,
} from '../app/utils';
import AccountsTable from '../components/AccountsTable';
import DateRangePicker from '../components/DateRangePicker';
import Pagination from '../components/Pagination';
import SummaryBlock from '../components/SummaryBlock';
import SummaryMetric from '../components/SummaryMetric';

type AccountsPageProps = {
  dateRange: DateRangeState;
  setDateRange: React.Dispatch<React.SetStateAction<DateRangeState>>;
  dateFilterReady: boolean;
  dateFilterActive: boolean;
  onDateFilterToggle: () => void;
  hasDateRange: boolean;
  accountSearchTerm: string;
  onAccountSearchTermChange: (value: string) => void;
  internalSummary: AccountSummary;
  internalRows: AccountRecord[];
  internalRowsTotal: number;
  internalSort: 'newest' | 'usdc' | 'sol' | 'token';
  onInternalSortChange: (value: 'newest' | 'usdc' | 'sol' | 'token') => void;
  outsideHolderRows: OutsideTokenHolder[];
  outsideHolderRowsTotal: number;
  outsideHolderSort: 'newest' | 'largest' | 'usdc' | 'sol';
  onOutsideHolderSortChange: (value: 'newest' | 'largest' | 'usdc' | 'sol') => void;
  outsideHolderCount: number | null;
  outsideHolderTotalAmount: number | null;
  outsideHolderSummaryLoading: boolean;
  outsideHolderListLoading: boolean;
  outsideHolderPartial: boolean;
  activeTokenContractAddress: string;
  activeTokenSymbol: string;
  walletBalances: Record<string, WalletBalance>;
  walletBalanceErrors: Record<string, string>;
  walletBalancePending: Record<string, boolean>;
  requestLocked: boolean;
  balanceRefreshLocked: boolean;
  internalListLoading: boolean;
  internalPage: number;
  outsiderPage: number;
  onInternalPageChange: (page: number) => void;
  onOutsiderPageChange: (page: number) => void;
  onOpenAdmin: () => void;
  onRefreshInternalAccountBalance: (address: string) => void;
  onRefreshInternalBalances: () => void;
  onRefreshOutsideBalances: () => void;
  onToggleInternalAccountTrading: (account: AccountRecord) => void;
  managedAccountStatusUpdatingAddress: string | null;
  itemsPerPage: number;
};

export default function AccountsPage({
  dateRange,
  setDateRange,
  dateFilterReady,
  dateFilterActive,
  onDateFilterToggle,
  hasDateRange,
  accountSearchTerm,
  onAccountSearchTermChange,
  internalSummary,
  internalRows,
  internalRowsTotal,
  internalSort,
  onInternalSortChange,
  outsideHolderRows,
  outsideHolderRowsTotal,
  outsideHolderSort,
  onOutsideHolderSortChange,
  outsideHolderCount,
  outsideHolderTotalAmount,
  outsideHolderSummaryLoading,
  outsideHolderListLoading,
  outsideHolderPartial,
  activeTokenContractAddress,
  activeTokenSymbol,
  walletBalances,
  walletBalanceErrors,
  walletBalancePending,
  requestLocked,
  balanceRefreshLocked,
  internalListLoading,
  internalPage,
  outsiderPage,
  onInternalPageChange,
  onOutsiderPageChange,
  onOpenAdmin,
  onRefreshInternalAccountBalance,
  onRefreshInternalBalances,
  onRefreshOutsideBalances,
  onToggleInternalAccountTrading,
  managedAccountStatusUpdatingAddress,
  itemsPerPage,
}: AccountsPageProps) {
  const outsideHolderCountValue = outsideHolderSummaryLoading
    ? 'Fetching...'
    : outsideHolderCount != null
      ? formatNum(outsideHolderCount)
      : 'Unavailable';
  const outsideHolderAmountValue = outsideHolderSummaryLoading
    ? 'Fetching...'
    : outsideHolderTotalAmount != null
      ? `${formatNum(outsideHolderTotalAmount)} ${activeTokenSymbol}`
      : 'Unavailable';
  const outsideHolderStatusValue = outsideHolderSummaryLoading
    ? 'Syncing'
    : outsideHolderPartial
      ? 'Partial (syncing)'
      : outsideHolderCount != null
        ? 'Ready'
        : 'Unavailable';
  const tokenAmountSortActive = outsideHolderSort === 'largest';
  const newestSortActive = outsideHolderSort === 'newest';
  const usdcSortActive = outsideHolderSort === 'usdc';
  const solSortActive = outsideHolderSort === 'sol';
  const displayOutsideHolderRows = outsideHolderRows;

  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Ignore clipboard failures; the full address remains visible via the cell title.
    }
  };

  return (
    <div className="space-y-6">
      <DateRangePicker
        dateRange={dateRange}
        setDateRange={setDateRange}
        dateFilterReady={dateFilterReady}
        dateFilterActive={dateFilterActive}
        onDateFilterToggle={onDateFilterToggle}
        hasDateRange={hasDateRange}
      >
        <div className="flex w-full flex-col gap-1.5 md:w-[400px]">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Managed / Outside Address Search
          </label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-500" />
            <input
              type="text"
              placeholder="Search by wallet address or label across all accounts..."
              value={accountSearchTerm}
              onChange={(event) => onAccountSearchTermChange(event.target.value)}
              className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 pl-9 pr-3 text-sm outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </DateRangePicker>

      <SummaryBlock title="Internal Account Summary" icon={<Wallet size={16} className="text-blue-400" />} data={internalSummary} />
      <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
        <h3 className="flex items-center gap-2 border-b border-slate-800 pb-2 font-semibold text-slate-200">
          <Users size={16} className="text-amber-400" /> Outside Holder Summary
        </h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <SummaryMetric label="Tracked outside holders" value={outsideHolderCountValue} />
          <SummaryMetric label={`${activeTokenSymbol} total`} value={outsideHolderAmountValue} />
          <SummaryMetric label="Listed outside holders" value={String(outsideHolderRowsTotal)} />
          <SummaryMetric label="Status" value={outsideHolderStatusValue} />
        </div>
      </div>

      <AccountsTable
        title="Internal Account List"
        icon={<Wallet size={16} className="text-blue-400" />}
        count={internalRowsTotal}
        rows={internalRows}
        typeLabel="Managed"
        typeClass="text-emerald-400"
        balances={walletBalances}
        balanceErrors={walletBalanceErrors}
        balancePending={walletBalancePending}
        balanceRefreshLocked={balanceRefreshLocked}
        requestLocked={requestLocked}
        trackedTokenMint={activeTokenContractAddress}
        trackedTokenSymbol={activeTokenSymbol}
        emptyText={internalListLoading ? 'Fetching internal account data...' : 'No internal accounts found.'}
        sortValue={internalSort}
        onSortChange={onInternalSortChange}
        onRefreshBalance={onRefreshInternalAccountBalance}
        onToggleTradingAccount={onToggleInternalAccountTrading}
        togglePendingAddress={managedAccountStatusUpdatingAddress}
        actionButton={
          <div className="flex items-center gap-3">
            <button
              onClick={onRefreshInternalBalances}
              disabled={balanceRefreshLocked}
              className="flex h-9 items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw size={14} /> Refresh Wallet Balances
            </button>
            <button
              onClick={onOpenAdmin}
              className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm text-white hover:bg-slate-700"
            >
              <Shield size={14} className="text-amber-500" /> Admin
            </button>
          </div>
        }
      >
        <Pagination currentPage={internalPage} totalItems={internalRowsTotal} itemsPerPage={itemsPerPage} onPageChange={onInternalPageChange} />
      </AccountsTable>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
          <h3 className="flex items-center gap-2 font-semibold text-slate-200">
            <Users size={16} className="text-amber-400" /> Outside Holders
            <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{outsideHolderRowsTotal} found</span>
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={onRefreshOutsideBalances}
              disabled={balanceRefreshLocked}
              title="Refresh balances for the currently loaded outside-holder page"
              className="flex h-9 items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw size={14} /> Refresh Visible Balances
            </button>
          </div>
        </div>
        <div className="min-h-[300px] overflow-x-auto">
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Label</th>
                <th className="px-4 py-3 font-medium">Wallet / Address</th>
                <th className="px-4 py-3 text-right font-medium">
                  <button
                    type="button"
                    onClick={() => onOutsideHolderSortChange('largest')}
                    aria-pressed={tokenAmountSortActive}
                    className={`inline-flex w-full items-center justify-end gap-1 transition ${
                      tokenAmountSortActive ? 'text-amber-300' : 'text-slate-400 hover:text-amber-300'
                    }`}
                  >
                    <span>Token Amount</span>
                    <span aria-hidden="true">↓</span>
                  </button>
                </th>
                <th className="px-4 py-3 text-right font-medium text-blue-400">
                  <button
                    type="button"
                    onClick={() => onOutsideHolderSortChange('usdc')}
                    aria-pressed={usdcSortActive}
                    className={`inline-flex w-full items-center justify-end gap-1 transition ${
                      usdcSortActive ? 'text-blue-300' : 'text-slate-400 hover:text-blue-300'
                    }`}
                  >
                    <span>USDC Bal</span>
                    <span aria-hidden="true">↓</span>
                  </button>
                </th>
                <th className="px-4 py-3 text-right font-medium text-amber-400">
                  <button
                    type="button"
                    onClick={() => onOutsideHolderSortChange('sol')}
                    aria-pressed={solSortActive}
                    className={`inline-flex w-full items-center justify-end gap-1 transition ${
                      solSortActive ? 'text-amber-300' : 'text-slate-400 hover:text-amber-300'
                    }`}
                  >
                    <span>SOL Bal</span>
                    <span aria-hidden="true">↓</span>
                  </button>
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  <button
                    type="button"
                    onClick={() => onOutsideHolderSortChange('newest')}
                    aria-pressed={newestSortActive}
                    className={`inline-flex w-full items-center justify-end gap-1 transition ${
                      newestSortActive ? 'text-blue-400' : 'text-slate-400 hover:text-blue-300'
                    }`}
                  >
                    <span>New</span>
                    <span aria-hidden="true">↓</span>
                  </button>
                </th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {displayOutsideHolderRows.map((holder) => {
                const balance = walletBalances[holder.address];
                const pending = walletBalancePending[holder.address];
                const balanceError = walletBalanceErrors[holder.address];
                const holderTypeLabel = holder.ownership === 'internal' ? 'Internal' : 'Outside';
                const holderTypeClass = holder.ownership === 'internal' ? 'text-emerald-300' : 'text-sky-300';
                return (
                  <tr key={holder.address} className="transition-colors hover:bg-slate-800/50">
                    <td className={`px-4 py-2 text-xs font-medium ${holderTypeClass}`}>
                      {holderTypeLabel}
                    </td>
                    <td className="px-4 py-2 text-xs font-bold text-slate-200">{holder.label ?? '-'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">
                      <div className="flex items-center gap-1.5">
                        <span title={holder.address}>{compactAddress(holder.address)}</span>
                        <button
                          type="button"
                          onClick={() => void handleCopyAddress(holder.address)}
                          className="rounded border border-slate-700 bg-slate-950 p-1 text-slate-500 transition hover:border-slate-500 hover:text-slate-200"
                          title="Copy address"
                          aria-label={`Copy ${holder.address}`}
                        >
                          <Copy size={10} />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right text-xs font-medium text-slate-200">
                      {formatNum(holder.amountHolding)} {activeTokenSymbol}
                    </td>
                    <td className="px-4 py-2 text-right text-xs font-medium">
                      {balanceError ? <span className="text-rose-400">Failed</span> : balance ? formatNum(Number.parseFloat(balance.usdc) || 0) : pending ? '...' : '-'}
                    </td>
                    <td className="px-4 py-2 text-right text-xs font-medium">
                      {balanceError ? <span className="text-rose-400">Failed</span> : balance ? formatNum(Number.parseFloat(balance.sol) || 0) : pending ? '...' : '-'}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-slate-400">
                      {holder.firstSeenAt ? formatDate(holder.firstSeenAt) : '-'}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">{holder.source}</td>
                    <td className="px-4 py-2 text-right text-xs text-slate-500">{formatDate(holder.updatedAt)}</td>
                  </tr>
                );
              })}
              {displayOutsideHolderRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-slate-500">
                    {outsideHolderListLoading ? 'Fetching outside holder data...' : 'No outside holders found.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pagination
          currentPage={outsiderPage}
          totalItems={outsideHolderRowsTotal}
          itemsPerPage={itemsPerPage}
          onPageChange={onOutsiderPageChange}
        />
      </div>
    </div>
  );
}