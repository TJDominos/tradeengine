import React from 'react';

import type { DateRangeState } from '../app/types';

const dateInputClassName =
  'h-10 w-[180px] rounded-md border border-slate-700 bg-slate-950 px-3 text-sm font-semibold text-white outline-none transition hover:border-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

type DateRangePickerProps = {
  dateRange: DateRangeState;
  setDateRange: React.Dispatch<React.SetStateAction<DateRangeState>>;
  dateFilterReady: boolean;
  dateFilterActive: boolean;
  onDateFilterToggle: () => void;
  hasDateRange: boolean;
  children?: React.ReactNode;
};

export default function DateRangePicker({
  dateRange,
  setDateRange,
  dateFilterReady,
  dateFilterActive,
  onDateFilterToggle,
  hasDateRange,
  children,
}: DateRangePickerProps) {
  const effectiveDateFilterActive = hasDateRange && dateFilterReady && dateFilterActive;

  return (
    <div className="flex w-full flex-wrap items-end gap-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="transaction-from-date" className="text-xs font-semibold uppercase tracking-wider text-white">
            From Date
          </label>
          <input
            id="transaction-from-date"
            type="date"
            value={dateRange.from}
            onChange={(event) => {
              setDateRange((current) => ({ ...current, from: event.currentTarget.value }));
            }}
            className={dateInputClassName}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="transaction-to-date" className="text-xs font-semibold uppercase tracking-wider text-white">
            To Date
          </label>
          <input
            id="transaction-to-date"
            type="date"
            value={dateRange.to}
            onChange={(event) => {
              setDateRange((current) => ({ ...current, to: event.currentTarget.value }));
            }}
            className={dateInputClassName}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-pressed={effectiveDateFilterActive}
            onClick={onDateFilterToggle}
            disabled={!dateFilterReady}
            className={`flex h-10 items-center rounded-md border px-3 text-xs font-semibold uppercase tracking-wider shadow-sm transition ${
              effectiveDateFilterActive
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/20'
                : dateFilterReady
                  ? 'border-slate-600 bg-slate-950 text-slate-200 hover:border-slate-500 hover:bg-slate-900'
                  : 'cursor-not-allowed border-slate-800 bg-slate-950 text-slate-500'
            }`}
          >
            {effectiveDateFilterActive ? 'Time Filter: On' : dateFilterReady ? 'Enable Time Filter' : 'Select Date Range'}
          </button>
          <span className={`text-[11px] ${effectiveDateFilterActive ? 'text-emerald-300' : 'text-slate-500'}`}>
            Default window on load: last 7 days.
          </span>
        </div>
      </div>
      {children ? <div className="flex min-w-[300px] flex-1 justify-end">{children}</div> : null}
      </div>
  );
}
