import React from 'react';

import type { DateRangeState } from '../app/types';

type DateRangePickerProps = {
  dateRange: DateRangeState;
  setDateRange: React.Dispatch<React.SetStateAction<DateRangeState>>;
  hasDateRange: boolean;
  children?: React.ReactNode;
};

export default function DateRangePicker({
  dateRange,
  setDateRange,
  hasDateRange,
  children,
}: DateRangePickerProps) {
  return (
    <div className="flex w-full flex-wrap items-end gap-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            From Date
          </label>
          <input
            type="date"
            value={dateRange.from}
            className="h-10 w-[160px] cursor-pointer rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
            onChange={(event) =>
              setDateRange((current) => ({ ...current, from: event.target.value }))
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            To Date
          </label>
          <input
            type="date"
            value={dateRange.to}
            className="h-10 w-[160px] cursor-pointer rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
            onChange={(event) =>
              setDateRange((current) => ({ ...current, to: event.target.value }))
            }
          />
        </div>
        {hasDateRange ? (
          <div className="flex h-10 items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-400">
            Time filter active
          </div>
        ) : null}
      </div>
      {children ? <div className="flex min-w-[300px] flex-1 justify-end">{children}</div> : null}
    </div>
  );
}