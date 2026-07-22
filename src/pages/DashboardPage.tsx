import React from 'react';

import { CONTRACT_ADDRESS } from '../app/constants';
import type { DateRangeState, TokenMarketSnapshot } from '../app/types';
import { formatLivePrice, formatNum, formatOptionalUsd, formatUSD } from '../app/utils';
import DateRangePicker from '../components/DateRangePicker';
import StatCard from '../components/StatCard';

type DashboardPageProps = {
  dateRange: DateRangeState;
  setDateRange: React.Dispatch<React.SetStateAction<DateRangeState>>;
  hasDateRange: boolean;
  marketSnapshotSubtitle: string;
  settingsContractAddress: string;
  activeTokenSymbol: string;
  activeTokenName: string;
  activeTokenContractAddress: string;
  totalInternalTokenAmount: number;
  managedAccountsCount: number;
  profitUsdc: number;
  dashboardSnapshot: TokenMarketSnapshot | null;
  managedWalletsCount: number;
  logsSection: React.ReactNode;
};

export default function DashboardPage({
  dateRange,
  setDateRange,
  hasDateRange,
  marketSnapshotSubtitle,
  settingsContractAddress,
  activeTokenSymbol,
  activeTokenName,
  activeTokenContractAddress,
  totalInternalTokenAmount,
  managedAccountsCount,
  profitUsdc,
  dashboardSnapshot,
  managedWalletsCount,
  logsSection,
}: DashboardPageProps) {
  return (
    <div className="space-y-6">
      <DateRangePicker dateRange={dateRange} setDateRange={setDateRange} hasDateRange={hasDateRange}>
        <div className="text-right text-xs text-slate-400">
          {marketSnapshotSubtitle}
        </div>
      </DateRangePicker>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Token Contract Address" value={settingsContractAddress || CONTRACT_ADDRESS || 'Not Configured'} isAddress />
        <StatCard
          title={`Total ${activeTokenSymbol} Amount (Internal)`}
          value={activeTokenContractAddress ? formatNum(totalInternalTokenAmount) : 'Not Configured'}
          subtitle={`${managedAccountsCount} internal wallet(s)`}
        />
        <StatCard title="Profit (USDC)" value={formatUSD(profitUsdc)} />
        <StatCard title="FDV" value={formatOptionalUsd(dashboardSnapshot?.fdv)} subtitle={marketSnapshotSubtitle} />
        <StatCard
          title={`Price: ${activeTokenName}`}
          value={formatLivePrice(dashboardSnapshot?.priceUsd)}
          subtitle={marketSnapshotSubtitle}
        />
        <StatCard
          title="Liquidity (USDC)"
          value={formatOptionalUsd(dashboardSnapshot?.liquidityUsd)}
          subtitle={marketSnapshotSubtitle}
        />
        <StatCard
          title="Total Outsiders (>$1)"
          value={dashboardSnapshot?.outsidersOverOneUsd != null ? String(dashboardSnapshot.outsidersOverOneUsd) : 'Unavailable'}
          subtitle={
            dashboardSnapshot?.outsidersOverOneUsd != null
              ? managedWalletsCount === 0
                ? 'No internal wallets are configured, so all holders count as outsiders.'
                : `Excludes ${managedWalletsCount} internal wallet(s)`
              : marketSnapshotSubtitle
          }
        />
        <StatCard
          title="Number of Transaction and Volumes"
          value={dashboardSnapshot?.totalTransactions24h != null ? formatNum(dashboardSnapshot.totalTransactions24h) : 'Unavailable'}
          subtitle={dashboardSnapshot?.volume24h != null ? `24h volume ${formatUSD(dashboardSnapshot.volume24h)}` : marketSnapshotSubtitle}
        />
      </div>

      <div className="mt-8">{logsSection}</div>
    </div>
  );
}