import React from 'react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs from 'dayjs';

import type { DateRangeState } from '../app/types';

const pickerTextFieldSx = {
  width: 180,
  '& .MuiInputBase-input': {
    color: '#0f172a',
    WebkitTextFillColor: '#0f172a',
    fontWeight: 600,
  },
  '& .MuiOutlinedInput-root': {
    color: '#0f172a',
    backgroundColor: '#ffffff',
    '& fieldset': { borderColor: '#cbd5e1' },
    '&:hover fieldset': { borderColor: '#94a3b8' },
    '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
  },
  '& .MuiSvgIcon-root': { color: '#64748b' },
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
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <div className="flex w-full flex-wrap items-end gap-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
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
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
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
          {hasDateRange ? (
            <div className="flex h-10 items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-400">
              Time filter active
            </div>
          ) : null}
        </div>
        {children ? <div className="flex min-w-[300px] flex-1 justify-end">{children}</div> : null}
      </div>
    </LocalizationProvider>
  );
}