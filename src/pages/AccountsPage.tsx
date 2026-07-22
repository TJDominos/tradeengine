import React from 'react';
import { RefreshCw, Search, Shield, Users, Wallet } from 'lucide-react';

import type { AccountRecord, AccountSummary, DateRangeState, WalletBalance } from '../app/types';
import AccountsTable from '../components/AccountsTable';
import DateRangePicker from '../components/DateRangePicker';
import Pagination from '../components/Pagination';
import SummaryBlock from '../components/SummaryBlock';

type AccountsPageProps = {
  dateRange: DateRangeState;
  setDateRange: React.Dispatch<React.SetStateAction<DateRangeState>>;
  hasDateRange: boolean;
  accountSearchTerm: string;
  onAccountSearchTermChange: (value: string) => void;
  internalSummary: AccountSummary;
  outsiderSummary: AccountSummary;
  filteredInternal: AccountRecord[];
  filteredOutsider: AccountRecord[];
  internalCurrentSlice: AccountRecord[];
  outsiderCurrentSlice: AccountRecord[];
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
  hasDateRange,
  accountSearchTerm,
  onAccountSearchTermChange,
  internalSummary,
  outsiderSummary,
  filteredInternal,
  filteredOutsider,
  internalCurrentSlice,
  outsiderCurrentSlice,
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
  return (
    <div className="space-y-6">
      <DateRangePicker dateRange={dateRange} setDateRange={setDateRange} hasDateRange={hasDateRange}>
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
      <SummaryBlock title="Outsider Account Summary" icon={<Users size={16} className="text-amber-400" />} data={outsiderSummary} />

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

      <AccountsTable
        title="Outsider Account List"
        icon={<Users size={16} className="text-amber-400" />}
        count={filteredOutsider.length}
        rows={outsiderCurrentSlice}
        typeLabel="Watch"
        typeClass="text-amber-400"
        balances={walletBalances}
        balanceErrors={walletBalanceErrors}
        balancePending={walletBalancePending}
        emptyText="No outsider accounts found."
        actionButton={
          <button
            onClick={onRefreshBalances}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 text-sm text-white hover:bg-slate-700"
          >
            <RefreshCw size={14} /> Refresh Balances
          </button>
        }
      >
        <Pagination currentPage={outsiderPage} totalItems={filteredOutsider.length} itemsPerPage={itemsPerPage} onPageChange={onOutsiderPageChange} />
      </AccountsTable>
    </div>
  );
}