import React from 'react';

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
  trackedTokenMint: string;
  trackedTokenSymbol: string;
  emptyText: string;
  actionButton?: React.ReactNode;
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
  trackedTokenMint,
  trackedTokenSymbol,
  emptyText,
  actionButton,
  children,
}: AccountsTableProps) {
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
              <th className="px-4 py-3 font-medium">Label</th>
              <th className="px-4 py-3 font-medium">Wallet / Address</th>
              <th className="px-4 py-3 text-right font-medium text-blue-400">USDC Bal</th>
              <th className="px-4 py-3 text-right font-medium text-amber-400">SOL Bal</th>
              <th className="px-4 py-3 text-right font-medium text-emerald-400">{trackedTokenSymbol} Amount</th>
              <th className="px-4 py-3 font-medium">Tracked Tokens</th>
              <th className="px-4 py-3 text-right font-medium">Imported</th>
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
                  <td className="px-4 py-2 text-xs font-bold text-slate-200">{account.label}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-400">{account.address}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium">{balance ? formatUSD(parseAmount(balance.usdc)) : pending ? '...' : '-'}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium">{balance ? formatNum(parseAmount(balance.sol)) : pending ? '...' : '-'}</td>
                  <td className="px-4 py-2 text-right text-xs font-medium text-slate-200">
                    {trackedTokenMint && balance ? formatNum(findWalletTokenAmount(balance, trackedTokenMint)) : pending ? '...' : '-'}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-300">
                    {balanceError ? <span className="text-rose-400">Failed</span> : <BalanceBadges balance={balance} />}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-slate-500">{formatDate(account.createdAt)}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-slate-500">{emptyText}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {children}
    </div>
  );
}