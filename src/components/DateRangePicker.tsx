import React from 'react';
import { CalendarDays } from 'lucide-react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import dayjs from 'dayjs';

import type { DateRangeState } from '../app/types';

const pickerTextFieldSx = {
  width: 180,
  '& .MuiInputBase-input': {
    color: '#ffffff',
    WebkitTextFillColor: '#ffffff',
    fontWeight: 600,
  },
  '& .MuiOutlinedInput-root': {
    color: '#ffffff',
    backgroundColor: '#020617',
    '& fieldset': { borderColor: '#334155' },
    '&:hover fieldset': { borderColor: '#64748b' },
    '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
  },
  '& .MuiSvgIcon-root': { color: '#cbd5e1' },
};

const pickerPopperSx = {
  '& .MuiPaper-root, & .MuiPickersLayout-root': {
    backgroundColor: '#ffffff',
    color: '#0f172a',
  },
  '& .MuiPickersDay-root': { color: '#0f172a' },
  '& .MuiPickersDay-root.Mui-selected': {
    backgroundColor: '#2563eb',
    color: '#ffffff',
  },
};

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
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <div className="flex w-full flex-wrap items-end gap-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="transaction-from-date" className="text-xs font-semibold uppercase tracking-wider text-white">
            From Date
          </label>
          <DatePicker
            value={dateRange.from && dayjs(dateRange.from).isValid() ? dayjs(dateRange.from) : null}
            format="YYYY-MM-DD"
            onChange={(value) => {
              setDateRange((current) => ({
                ...current,
                from: value?.isValid() ? value.format('YYYY-MM-DD') : '',
              }));
            }}
            slotProps={{ textField: { id: 'transaction-from-date', size: 'small', sx: pickerTextFieldSx }, popper: { sx: pickerPopperSx } }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="transaction-to-date" className="text-xs font-semibold uppercase tracking-wider text-white">
            To Date
          </label>
          <DatePicker
            value={dateRange.to && dayjs(dateRange.to).isValid() ? dayjs(dateRange.to) : null}
            format="YYYY-MM-DD"
            onChange={(value) => {
              setDateRange((current) => ({
                ...current,
                to: value?.isValid() ? value.format('YYYY-MM-DD') : '',
              }));
            }}
            slotProps={{ textField: { id: 'transaction-to-date', size: 'small', sx: pickerTextFieldSx }, popper: { sx: pickerPopperSx } }}
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
            <CalendarDays size={14} className="mr-1.5" />
            {effectiveDateFilterActive ? 'Time Filter: On' : dateFilterReady ? 'Enable Time Filter' : 'Select Date Range'}
          </button>
          <span className={`text-[11px] ${effectiveDateFilterActive ? 'text-emerald-300' : 'text-slate-500'}`}>
            Default window on load: last 7 days.
          </span>
        </div>
      </div>
      {children ? <div className="flex min-w-[300px] flex-1 justify-end">{children}</div> : null}
      </div>
    </LocalizationProvider>
  );
}
