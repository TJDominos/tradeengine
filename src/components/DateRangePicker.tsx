import React from 'react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs from 'dayjs';

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
                  sx: {
                    width: 180,
                    '& .MuiInputBase-input': { color: '#ffffff' },
                    '& .MuiInputLabel-root': { color: '#cbd5e1' },
                    '& .MuiInputLabel-root.Mui-focused': { color: '#ffffff' },
                    '& .MuiOutlinedInput-root': {
                      color: '#ffffff',
                      backgroundColor: '#020617',
                      '& fieldset': { borderColor: '#334155' },
                      '&:hover fieldset': { borderColor: '#475569' },
                      '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
                    },
                    '& .MuiSvgIcon-root': { color: '#94a3b8' },
                  },
                },
                popper: {
                  sx: {
                    '& .MuiPaper-root': {
                      backgroundColor: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid #334155',
                    },
                    '& .MuiPickersCalendarHeader-label': { color: '#ffffff' },
                    '& .MuiDayCalendar-weekDayLabel': { color: '#cbd5e1' },
                    '& .MuiPickersDay-root': { color: '#e2e8f0' },
                    '& .MuiPickersDay-root.Mui-selected': {
                      backgroundColor: '#2563eb',
                      color: '#ffffff',
                    },
                  },
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
                  sx: {
                    width: 180,
                    '& .MuiInputBase-input': { color: '#ffffff' },
                    '& .MuiInputLabel-root': { color: '#cbd5e1' },
                    '& .MuiInputLabel-root.Mui-focused': { color: '#ffffff' },
                    '& .MuiOutlinedInput-root': {
                      color: '#ffffff',
                      backgroundColor: '#020617',
                      '& fieldset': { borderColor: '#334155' },
                      '&:hover fieldset': { borderColor: '#475569' },
                      '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
                    },
                    '& .MuiSvgIcon-root': { color: '#94a3b8' },
                  },
                },
                popper: {
                  sx: {
                    '& .MuiPaper-root': {
                      backgroundColor: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid #334155',
                    },
                    '& .MuiPickersCalendarHeader-label': { color: '#ffffff' },
                    '& .MuiDayCalendar-weekDayLabel': { color: '#cbd5e1' },
                    '& .MuiPickersDay-root': { color: '#e2e8f0' },
                    '& .MuiPickersDay-root.Mui-selected': {
                      backgroundColor: '#2563eb',
                      color: '#ffffff',
                    },
                  },
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