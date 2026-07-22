import React from 'react';

import type { AccountSummary } from '../app/types';
import { formatNum, formatUSD } from '../app/utils';
import SummaryMetric from './SummaryMetric';

type SummaryBlockProps = {
  title: string;
  icon: React.ReactNode;
  data: AccountSummary;
};

export default function SummaryBlock({ title, icon, data }: SummaryBlockProps) {
  return (
    <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
      <h3 className="flex items-center gap-2 border-b border-slate-800 pb-2 font-semibold text-slate-200">
        {icon} {title}
      </h3>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <SummaryMetric label="Tracked wallets" value={`${data.trackedWallets} / ${data.total}`} />
        <SummaryMetric label="Active assets" value={String(data.activeAssets)} />
        <SummaryMetric label="Total SOL" value={formatNum(data.totalSol)} />
        <SummaryMetric label="Total USDC" value={formatUSD(data.totalUsdc)} />
        <SummaryMetric label="Token lines" value={String(data.trackedTokenLines)} />
        <SummaryMetric label="Wallets total" value={String(data.total)} />
      </div>
    </div>
  );
}