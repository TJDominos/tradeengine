import React from 'react';
import { RefreshCw, Search, Shield, Users, Wallet } from 'lucide-react';

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
  filteredInternal: AccountRecord[];
  internalCurrentSlice: AccountRecord[];
  outsideHolderRows: OutsideTokenHolder[];
  filteredOutsideHoldersCount: number;
  outsideHolderCount: number | null;
  outsideHolderTotalAmount: number | null;
  outsideHolderLoading: boolean;
  outsideHolderPartial: boolean;
  activeTokenSymbol: string;
  walletBalances: Record<string, WalletBalance>;
  walletBalanceErrors: Record<string, string>;
  walletBalancePending: Record<string, boolean>;
  internalPage: number;
  outsiderPage: number;
  onInternalPageChange: (page: number) => void;
  onOutsiderPageChange: (page: number) => void;
  onOpenAdmin: () => void;
  onRefreshBalances: () => void;
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
  filteredInternal,
  internalCurrentSlice,
  outsideHolderRows,
  filteredOutsideHoldersCount,
  outsideHolderCount,
  outsideHolderTotalAmount,
  outsideHolderLoading,
  outsideHolderPartial,
  activeTokenSymbol,
  walletBalances,
  walletBalanceErrors,
  walletBalancePending,
  internalPage,
  outsiderPage,
  onInternalPageChange,
  onOutsiderPageChange,
  onOpenAdmin,
  onRefreshBalances,
  itemsPerPage,
}: AccountsPageProps) {
  const outsideHolderCountValue = outsideHolderLoading
    ? 'Fetching...'
    : outsideHolderCount != null
      ? formatNum(outsideHolderCount)
      : 'Unavailable';
  const outsideHolderAmountValue = outsideHolderLoading
    ? 'Fetching...'
    : outsideHolderTotalAmount != null
      ? `${formatNum(outsideHolderTotalAmount)} ${activeTokenSymbol}`
      : 'Unavailable';
  const outsideHolderStatusValue = outsideHolderLoading
    ? 'Syncing'
    : outsideHolderPartial
      ? 'Partial (syncing)'
      : outsideHolderCount != null
        ? 'Ready'
        : 'Unavailable';

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
            Global Address Search
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
          <SummaryMetric label="Outside holders" value={outsideHolderCountValue} />
          <SummaryMetric label={`${activeTokenSymbol} total`} value={outsideHolderAmountValue} />
          <SummaryMetric label="Listed holders" value={String(filteredOutsideHoldersCount)} />
          <SummaryMetric label="Status" value={outsideHolderStatusValue} />
        </div>
      </div>

      <AccountsTable
        title="Internal Account List"
        icon={<Wallet size={16} className="text-blue-400" />}
        count={filteredInternal.length}
        rows={internalCurrentSlice}
        typeLabel="Managed"
        typeClass="text-emerald-400"
        balances={walletBalances}
        balanceErrors={walletBalanceErrors}
        balancePending={walletBalancePending}
        emptyText="No internal accounts found."
        actionButton={
          <button
            onClick={onOpenAdmin}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm text-white hover:bg-slate-700"
          >
            <Shield size={14} className="text-amber-500" /> Admin
          </button>
        }
      >
        <Pagination currentPage={internalPage} totalItems={filteredInternal.length} itemsPerPage={itemsPerPage} onPageChange={onInternalPageChange} />
      </AccountsTable>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
          <h3 className="flex items-center gap-2 font-semibold text-slate-200">
            <Users size={16} className="text-amber-400" /> Outside Holder List
            <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{filteredOutsideHoldersCount} found</span>
          </h3>
          <button
            onClick={onRefreshBalances}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm text-white hover:bg-slate-700"
          >
            <RefreshCw size={14} /> Refresh Wallet Balances
          </button>
        </div>
        <div className="min-h-[300px] overflow-x-auto">
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Label</th>
                <th className="px-4 py-3 font-medium">Wallet / Address</th>
                <th className="px-4 py-3 text-right font-medium text-amber-300">Token Amount</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {outsideHolderRows.map((holder) => (
                <tr key={holder.address} className="transition-colors hover:bg-slate-800/50">
                  <td className={`px-4 py-2 text-xs font-medium ${holder.ownership === 'watch' ? 'text-amber-300' : 'text-sky-300'}`}>
                    {holder.ownership === 'watch' ? 'Watch' : 'Outside'}
                  </td>
                  <td className="px-4 py-2 text-xs font-bold text-slate-200">{holder.label ?? '-'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-400">{compactAddress(holder.address)}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium text-slate-200">
                    {formatNum(holder.amountHolding)} {activeTokenSymbol}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400">{holder.source}</td>
                  <td className="px-4 py-2 text-right text-xs text-slate-500">{formatDate(holder.updatedAt)}</td>
                </tr>
              ))}
              {outsideHolderRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    {outsideHolderLoading ? 'Fetching outside holder data...' : 'No outside holders found.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pagination
          currentPage={outsiderPage}
          totalItems={filteredOutsideHoldersCount}
          itemsPerPage={itemsPerPage}
          onPageChange={onOutsiderPageChange}
        />
      </div>
    </div>
  );
}