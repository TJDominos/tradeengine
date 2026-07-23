import React from 'react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs from 'dayjs';

import type { DateRangeState } from '../app/types';

const pickerTextFieldSx = {
  width: 180,
  '& .MuiInputLabel-root, & .MuiFormLabel-root': {
    color: '#ffffff',
  },
  '& .MuiInputBase-input': {
    color: '#ffffff',
    WebkitTextFillColor: '#ffffff',
    fontWeight: 600,
  },
  '& .MuiInputBase-input::placeholder': {
    color: '#ffffff',
    opacity: 1,
  },
  '& .MuiPickersSectionList-root, & .MuiPickersSectionList-section, & .MuiPickersInputBase-sectionsContainer': {
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
  '& .MuiPaper-root': {
    backgroundColor: '#ffffff',
    color: '#0f172a',
    border: '1px solid #cbd5e1',
    boxShadow: '0 18px 50px rgba(15, 23, 42, 0.22)',
  },
  '& .MuiPickersLayout-root': {
    backgroundColor: '#ffffff',
    color: '#0f172a',
  },
  '& .MuiPickersCalendarHeader-label': {
    color: '#0f172a',
    fontWeight: 700,
  },
  '& .MuiPickersCalendarHeader-switchViewButton, & .MuiPickersArrowSwitcher-button': {
    color: '#334155',
  },
  '& .MuiDayCalendar-weekDayLabel': {
    color: '#64748b',
    fontWeight: 600,
  },
  '& .MuiPickersDay-root': {
    color: '#0f172a',
  },
  '& .MuiPickersDay-root.Mui-disabled': {
    color: '#cbd5e1',
  },
  '& .MuiPickersDay-root:hover': {
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
  },
  '& .MuiPickersDay-root.Mui-selected': {
    backgroundColor: '#2563eb',
    color: '#ffffff',
  },
  '& .MuiPickersYear-yearButton, & .MuiPickersMonth-monthButton': {
    color: '#0f172a',
  },
  '& .MuiPickersYear-yearButton.Mui-selected, & .MuiPickersMonth-monthButton.Mui-selected': {
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
            <label className="text-xs font-semibold uppercase tracking-wider text-white">
              From Date
            </label>
            <DatePicker
              value={dateRange.from ? dayjs(dateRange.from) : null}
              format="YYYY-MM-DD"
              onChange={(value) =>
                setDateRange((current) => ({
                  ...current,
                  from: value && value.isValid() ? value.format('YYYY-MM-DD') : '',
                }))
              }
              slotProps={{
                textField: {
                  size: 'small',
                  sx: pickerTextFieldSx,
                },
                popper: {
                  sx: pickerPopperSx,
                },
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-white">
              To Date
            </label>
            <DatePicker
              value={dateRange.to ? dayjs(dateRange.to) : null}
              format="YYYY-MM-DD"
              onChange={(value) =>
                setDateRange((current) => ({
                  ...current,
                  to: value && value.isValid() ? value.format('YYYY-MM-DD') : '',
                }))
              }
              slotProps={{
                textField: {
                  size: 'small',
                  sx: pickerTextFieldSx,
                },
                popper: {
                  sx: pickerPopperSx,
                },
              }}
            />
          </div>
          <button
            type="button"
            aria-pressed={effectiveDateFilterActive}
            onClick={onDateFilterToggle}
            disabled={!dateFilterReady}
            className={`flex h-10 items-center rounded-md border px-3 text-xs font-semibold uppercase tracking-wider shadow-sm transition ${
              effectiveDateFilterActive
                ? 'border-blue-500/30 bg-blue-500/15 text-white hover:bg-blue-500/20'
                : dateFilterReady
                  ? 'border-slate-600 bg-slate-950 text-slate-200 hover:border-slate-500 hover:bg-slate-900'
                  : 'cursor-not-allowed border-slate-800 bg-slate-950 text-slate-500'
            }`}
          >
            {effectiveDateFilterActive ? 'Time Filter Active' : dateFilterReady ? 'Enable Time Filter' : 'Select Date Range'}
          </button>
        </div>
        {children ? <div className="flex min-w-[300px] flex-1 justify-end">{children}</div> : null}
      </div>
    </LocalizationProvider>
  );
}