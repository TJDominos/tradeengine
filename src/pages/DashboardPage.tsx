import React from 'react';

import { CONTRACT_ADDRESS } from '../app/constants';
import type { DateRangeState, TokenHolderAggregate, TokenMarketSnapshot } from '../app/types';
import { formatLivePrice, formatNum, formatOptionalUsd, formatUSD } from '../app/utils';
import DateRangePicker from '../components/DateRangePicker';
import StatCard from '../components/StatCard';

type DashboardPageProps = {
  dateRange: DateRangeState;
  setDateRange: React.Dispatch<React.SetStateAction<DateRangeState>>;
  dateFilterReady: boolean;
  dateFilterActive: boolean;
  onDateFilterToggle: () => void;
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
  tokenHolderAggregate: TokenHolderAggregate | null;
  tokenHolderAggregateLoading: boolean;
  transactionCount: number;
  transactionVolumeUsd: number;
  logsSection: React.ReactNode;
};

export default function DashboardPage({
  dateRange,
  setDateRange,
  dateFilterReady,
  dateFilterActive,
  onDateFilterToggle,
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
  tokenHolderAggregate,
  tokenHolderAggregateLoading,
  transactionCount,
  transactionVolumeUsd,
  logsSection,
}: DashboardPageProps) {
  const hasActiveToken = Boolean(activeTokenContractAddress);
  const internalHolderCount = tokenHolderAggregate?.internalHolderCount ?? null;
  const internalAmountHolding = tokenHolderAggregate?.internalAmountHolding ?? null;
  const outsiderHolderCount = tokenHolderAggregate?.outsiderHolderCount ?? null;
  const totalHolders = dashboardSnapshot?.totalHolders ?? null;
  const outsiderAmountHolding = tokenHolderAggregate
    ? Math.max(
        0,
        tokenHolderAggregate.totalAmountHolding - tokenHolderAggregate.internalAmountHolding,
      )
    : null;
  const internalHolderValue = !hasActiveToken
    ? 'Not Configured'
    : tokenHolderAggregateLoading
      ? 'Fetching...'
      : internalHolderCount != null
        ? formatNum(internalHolderCount)
        : 'Unavailable';
  const outsideHolderValue = !hasActiveToken
    ? 'Not Configured'
    : tokenHolderAggregateLoading
      ? 'Fetching...'
      : outsiderHolderCount != null
        ? formatNum(outsiderHolderCount)
        : 'Unavailable';
  const totalHoldersValue = !hasActiveToken
    ? 'Not Configured'
    : totalHolders != null
      ? formatNum(totalHolders)
      : 'Unavailable';
  const internalHolderSubtitle = !hasActiveToken
    ? 'Set an active token to load holder data.'
    : tokenHolderAggregateLoading
      ? 'Loading holder counts and token total...'
      : internalAmountHolding != null
        ? `Token total ${formatNum(internalAmountHolding)} ${activeTokenSymbol}`
        : 'Holder aggregate unavailable';
  const outsideHolderSubtitle = !hasActiveToken
    ? 'Set an active token to load holder data.'
    : tokenHolderAggregateLoading
      ? 'Loading holder counts and token total...'
      : outsiderAmountHolding != null
        ? `Token total ${formatNum(outsiderAmountHolding)} ${activeTokenSymbol}`
        : 'Holder aggregate unavailable';

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
          title="Number of Transaction and Volumes"
          value={formatNum(transactionCount)}
          subtitle={`Selected range volume ${formatUSD(transactionVolumeUsd)}`}
        />
        <StatCard
          title="Total Token Holders"
          value={totalHoldersValue}
          subtitle={marketSnapshotSubtitle}
        />
        <StatCard
          title="Internal Token Holders"
          value={internalHolderValue}
          subtitle={internalHolderSubtitle}
        />
        <StatCard
          title="Outside Token Holders"
          value={outsideHolderValue}
          subtitle={outsideHolderSubtitle}
        />
      </div>

      <div className="mt-8">{logsSection}</div>
    </div>
  );
}