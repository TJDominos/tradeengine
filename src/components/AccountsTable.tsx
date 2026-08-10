import React from 'react';
import { RefreshCw } from 'lucide-react';

import type { AccountRecord, WalletBalance } from '../app/types';
import { findWalletTokenAmount, formatDate, formatNum, formatUSD, parseAmount } from '../app/utils';
import BalanceBadges from './BalanceBadges';

type AccountsTableProps = {
  title: string;
  icon: React.ReactNode;
  count: number;
  rows: AccountRecord[];
  typeLabel: string;
  typeClass: string;
  balances: Record<string, WalletBalance>;
  balanceErrors: Record<string, string>;
  balancePending: Record<string, boolean>;
  balanceRefreshLocked: boolean;
  requestLocked: boolean;
  trackedTokenMint: string;
  trackedTokenSymbol: string;
  emptyText: string;
  actionButton?: React.ReactNode;
  sortValue?: 'newest' | 'usdc' | 'sol' | 'token';
  onSortChange?: (value: 'newest' | 'usdc' | 'sol' | 'token') => void;
  onRefreshBalance?: (address: string) => void;
  onToggleTradingAccount?: (account: AccountRecord) => void;
  togglePendingAddress?: string | null;
  children?: React.ReactNode;
};

export default function AccountsTable({
  title,
  icon,
  count,
  rows,
  typeLabel,
  typeClass,
  balances,
  balanceErrors,
  balancePending,
  balanceRefreshLocked,
  requestLocked,
  trackedTokenMint,
  trackedTokenSymbol,
  emptyText,
  actionButton,
  sortValue,
  onSortChange,
  onRefreshBalance,
  onToggleTradingAccount,
  togglePendingAddress,
  children,
}: AccountsTableProps) {
  const showTradingControl = typeof onToggleTradingAccount === 'function';
  const showBalanceRefresh = typeof onRefreshBalance === 'function';
  const sortInteractive = typeof onSortChange === 'function';

  const renderSortHeader = (
    key: 'newest' | 'usdc' | 'sol' | 'token',
    label: string,
    align: 'left' | 'right' = 'right',
    activeClass = 'text-blue-300',
  ) => (
    <button
      type="button"
      onClick={() => onSortChange?.(key)}
      aria-pressed={sortValue === key}
      className={`inline-flex w-full items-center gap-1 transition ${
        align === 'right' ? 'justify-end' : 'justify-start'
      } ${sortValue === key ? activeClass : 'text-slate-400 hover:text-slate-200'}`}
    >
      <span>{label}</span>
      <span aria-hidden="true">↓</span>
    </button>
  );

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
        <h3 className="flex items-center gap-2 font-semibold text-slate-200">
          {icon} {title}
          <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{count} found</span>
        </h3>
        {actionButton}
      </div>
      <div className="min-h-[300px] overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-950/50 text-slate-400">
            <tr>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Label</th>
              <th className="px-4 py-3 font-medium">Wallet / Address</th>
              <th className="px-4 py-3 text-right font-medium text-blue-400">
                {sortInteractive
                  ? renderSortHeader('usdc', 'USDC Bal', 'right', 'text-blue-300')
                  : 'USDC Bal'}
              </th>
              <th className="px-4 py-3 text-right font-medium text-amber-400">
                {sortInteractive
                  ? renderSortHeader('sol', 'SOL Bal', 'right', 'text-amber-300')
                  : 'SOL Bal'}
              </th>
              <th className="px-4 py-3 text-right font-medium text-emerald-400">
                {sortInteractive
                  ? renderSortHeader('token', `${trackedTokenSymbol} Amount`, 'right', 'text-emerald-300')
                  : `${trackedTokenSymbol} Amount`}
              </th>
              <th className="px-4 py-3 font-medium">Tracked Pairs</th>
              <th className="px-4 py-3 text-right font-medium">
                {sortInteractive
                  ? renderSortHeader('newest', 'Imported', 'right', 'text-slate-200')
                  : 'Imported'}
              </th>
              {showTradingControl ? <th className="px-4 py-3 text-right font-medium">Trading</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((account) => {
              const balance = balances[account.address];
              const pending = balancePending[account.address];
              const balanceError = balanceErrors[account.address];
              return (
                <tr key={account.id} className="transition-colors hover:bg-slate-800/50">
                  <td className={`px-4 py-2 text-xs font-medium ${typeClass}`}>{typeLabel}</td>
                  <td className="px-4 py-2 text-xs font-medium">
                    <span className={`rounded-full px-2 py-0.5 ${account.isActive ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
                      {account.isActive ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs font-bold text-slate-200">{account.label}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-400">
                    <div className="flex items-center gap-2">
                      <span>{account.address}</span>
                      {showBalanceRefresh ? (
                        <button
                          type="button"
                          onClick={() => onRefreshBalance?.(account.address)}
                          disabled={pending || balanceRefreshLocked}
                          className="rounded border border-slate-700 bg-slate-950 p-1 text-slate-400 transition hover:border-slate-500 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
                          title={pending ? 'Refreshing wallet balance' : 'Refresh wallet balance'}
                          aria-label={pending ? `Refreshing ${account.address} wallet balance` : `Refresh ${account.address} wallet balance`}
                        >
                          <RefreshCw size={10} className={pending ? 'animate-spin' : ''} />
                        </button>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right text-xs font-medium">{balance ? formatUSD(parseAmount(balance.usdc)) : pending ? '...' : '-'}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium">{balance ? formatNum(parseAmount(balance.sol)) : pending ? '...' : '-'}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium text-slate-200">
                    {trackedTokenMint && balance ? formatNum(findWalletTokenAmount(balance, trackedTokenMint)) : pending ? '...' : '-'}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-300">
                    {balanceError ? <span className="text-rose-400">Failed</span> : <BalanceBadges balance={balance} />}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-slate-500">{formatDate(account.createdAt)}</td>
                  {showTradingControl ? (
                    <td className="px-4 py-2 text-right text-xs font-medium">
                      <button
                        type="button"
                        onClick={() => onToggleTradingAccount?.(account)}
                        disabled={togglePendingAddress === account.address || requestLocked}
                        className={`rounded-md border px-3 py-1.5 transition ${
                          account.isActive
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                        } disabled:cursor-not-allowed disabled:opacity-60`}
                      >
                        {togglePendingAddress === account.address
                          ? 'Updating...'
                          : account.isActive
                            ? 'Disable Trading'
                            : 'Enable Trading'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={showTradingControl ? 10 : 9} className="py-8 text-center text-slate-500">{emptyText}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {children}
    </div>
  );
}