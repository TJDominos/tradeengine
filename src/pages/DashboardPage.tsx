import React from 'react';

import { CONTRACT_ADDRESS } from '../app/constants';
import type { DateRangeState, TokenHolderAggregate, TokenMarketSnapshot, TradableToken } from '../app/types';
import { formatLivePrice, formatNum, formatOptionalUsd, formatUSD } from '../app/utils';
import DateRangePicker from '../components/DateRangePicker';
import StatCard from '../components/StatCard';

function mintPreview(mintAddress: string): string {
  if (mintAddress.length <= 18) {
    return mintAddress || 'Not configured';
  }
  return `${mintAddress.slice(0, 8)}...${mintAddress.slice(-8)}`;
}

function pairValue(baseTokenAddress: string, quoteTokenAddress: string): string {
  return `${baseTokenAddress}::${quoteTokenAddress}`;
}

function pairLabel(token: TradableToken): string {
  const baseLabel = token.symbol ?? token.name ?? mintPreview(token.baseTokenAddress);
  const quoteLabel =
    token.quoteTokenSymbol ?? token.quoteTokenName ?? mintPreview(token.quoteTokenAddress);
  return `${baseLabel} / ${quoteLabel}`;
}

type DashboardPageProps = {
  dateRange: DateRangeState;
  setDateRange: React.Dispatch<React.SetStateAction<DateRangeState>>;
  dateFilterReady: boolean;
  dateFilterActive: boolean;
  onDateFilterToggle: () => void;
  hasDateRange: boolean;
  marketSnapshotSubtitle: string;
  settingsContractAddress: string;
  settingsQuoteTokenAddress: string;
  activeTokenSymbol: string;
  activeTokenName: string;
  activeTokenContractAddress: string;
  tradableTokens: TradableToken[];
  submitting: string | null;
  onUseToken: (contractAddress: string, quoteTokenAddress: string) => void;
  totalInternalTokenAmount: number;
  managedAccountsCount: number;
  internalAccountsCount: number;
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
  settingsQuoteTokenAddress,
  activeTokenSymbol,
  activeTokenName,
  activeTokenContractAddress,
  tradableTokens,
  submitting,
  onUseToken,
  totalInternalTokenAmount,
  managedAccountsCount,
  internalAccountsCount,
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
    ? 'Set an active pair to load holder data.'
    : tokenHolderAggregateLoading
      ? 'Loading internal accounts that hold the selected pair token...'
      : internalHolderCount != null
        ? `Internal accounts with a positive ${activeTokenSymbol} balance for the selected pair.`
        : 'Holder aggregate unavailable';
  const outsideHolderSubtitle = !hasActiveToken
    ? 'Set an active pair to load holder data.'
    : tokenHolderAggregateLoading
      ? 'Loading holder counts and token total...'
      : outsiderAmountHolding != null
        ? `Token total ${formatNum(outsiderAmountHolding)} ${activeTokenSymbol}`
        : 'Holder aggregate unavailable';
  const pairOptions = React.useMemo(
    () =>
      tradableTokens.map((token) => ({
        value: pairValue(token.baseTokenAddress, token.quoteTokenAddress),
        label: pairLabel(token),
        baseTokenAddress: token.baseTokenAddress,
        quoteTokenAddress: token.quoteTokenAddress,
      })),
    [tradableTokens],
  );
  const activePairValue =
    settingsContractAddress && settingsQuoteTokenAddress
      ? pairValue(settingsContractAddress, settingsQuoteTokenAddress)
      : '';
  const activePairOption = pairOptions.find((option) => option.value === activePairValue) ?? null;
  const selectedPairValue = activePairOption?.value ?? '';
  const activePairDisplay = activePairOption?.label
    ?? (settingsContractAddress
      ? `${mintPreview(settingsContractAddress)} / ${mintPreview(settingsQuoteTokenAddress)}`
      : 'Not Configured');
  const activePairSubtitle = settingsContractAddress
    ? settingsQuoteTokenAddress
      ? `${settingsContractAddress} / ${settingsQuoteTokenAddress}`
      : settingsContractAddress
    : CONTRACT_ADDRESS
      ? `${CONTRACT_ADDRESS} / quote not set`
      : 'Select a tracked pair to begin.';

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

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              Select Trading Pair
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Switch the live execution pair and keep token-specific addresses scoped here.
            </p>
          </div>
          <div className="w-full lg:max-w-xl">
            <select
              value={selectedPairValue}
              onChange={(event) => {
                const nextPair = pairOptions.find((option) => option.value === event.target.value);
                if (nextPair) {
                  void onUseToken(nextPair.baseTokenAddress, nextPair.quoteTokenAddress);
                }
              }}
              disabled={pairOptions.length === 0 || submitting === 'use-token'}
              className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">
                {pairOptions.length === 0
                  ? 'No tracked pairs in registry'
                  : activePairOption
                    ? 'Select a tracked pair'
                    : hasActiveToken
                      ? `${activePairDisplay} (not in registry)`
                      : 'Select a tracked pair'}
              </option>
              {pairOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Active Pair" value={activePairDisplay} subtitle={activePairSubtitle} />
        <StatCard
          title={`Total ${activeTokenSymbol} Amount (Internal)`}
          value={activeTokenContractAddress ? formatNum(totalInternalTokenAmount) : 'Not Configured'}
          subtitle={`${managedAccountsCount} enabled trading wallet(s) / ${internalAccountsCount} total internal`}
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