import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import MuiCheckbox from '@mui/material/Checkbox';
import InputAdornment from '@mui/material/InputAdornment';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import TextField from '@mui/material/TextField';

import type { StrategyVersionDocument } from '../app/strategyTypes';
import {
  getStrategyFieldsForSection,
  readStrategyFieldValue,
  STRATEGY_SECTION_SCHEMAS,
  updateStrategyFieldValue,
} from '../app/strategyFormSchema';

type StrategySchemaFormProps = {
  draft: StrategyVersionDocument;
  onChange: (updater: (current: StrategyVersionDocument) => StrategyVersionDocument) => void;
};

const capabilityClassNames = {
  supported: 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
  partial: 'border border-amber-500/20 bg-amber-500/10 text-amber-300',
  planned: 'border border-slate-700 bg-slate-800 text-slate-300',
} as const;

export default function StrategySchemaForm({ draft, onChange }: StrategySchemaFormProps) {
  return (
    <div className="space-y-4">
      {STRATEGY_SECTION_SCHEMAS.map((section) => {
        const fields = getStrategyFieldsForSection(section.id);
        return (
          <div key={section.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
                  {section.title}
                </h4>
                <p className="mt-1 text-xs text-slate-500">{section.description}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {fields.map((field) => {
                const rawValue = readStrategyFieldValue(draft, field.path);
                const displayValue = field.formatValue
                  ? field.formatValue(rawValue)
                  : Array.isArray(rawValue)
                    ? rawValue.join(', ')
                    : typeof rawValue === 'boolean'
                      ? rawValue
                      : rawValue == null
                        ? ''
                        : String(rawValue);
                const commonMeta = (
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
                      {field.label}
                    </label>
                    <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${capabilityClassNames[field.capability]}`}>
                      {field.capability}
                    </span>
                  </div>
                );

                const saveValue = (nextValue: string | boolean) => {
                  const parsed = field.parseInput ? field.parseInput(nextValue) : nextValue;
                  onChange((current) => updateStrategyFieldValue(current, field.path, parsed));
                };

                return (
                  <div key={field.id} className={field.fieldType === 'textarea' ? 'md:col-span-2' : ''}>
                    {commonMeta}
                    {field.description ? (
                      <p className="mb-2 text-xs text-slate-500">{field.description}</p>
                    ) : null}

                    {field.fieldType === 'textarea' ? (
                      <TextField
                        multiline
                        minRows={4}
                        fullWidth
                        value={String(displayValue)}
                        disabled={!field.editable}
                        onChange={(event) => saveValue(event.target.value)}
                        placeholder={field.placeholder}
                        variant="outlined"
                        size="small"
                        sx={{
                          '& .MuiOutlinedInput-root': {
                            color: '#e2e8f0',
                            backgroundColor: '#020617',
                            '& fieldset': { borderColor: '#334155' },
                            '&:hover fieldset': { borderColor: '#475569' },
                            '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
                          },
                          '& .MuiInputBase-input::placeholder': { color: '#64748b', opacity: 1 },
                        }}
                      />
                    ) : field.fieldType === 'select' ? (
                      <FormControl
                        fullWidth
                        size="small"
                        disabled={!field.editable}
                        sx={{
                          '& .MuiOutlinedInput-root': {
                            color: '#e2e8f0',
                            backgroundColor: '#020617',
                            '& fieldset': { borderColor: '#334155' },
                            '&:hover fieldset': { borderColor: '#475569' },
                            '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
                          },
                          '& .MuiSvgIcon-root': { color: '#94a3b8' },
                        }}
                      >
                        <InputLabel shrink sx={{ color: '#94a3b8', position: 'static', transform: 'none', mb: 0.75, fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                          Select Value
                        </InputLabel>
                        <Select
                          value={String(displayValue)}
                          onChange={(event: SelectChangeEvent<string>) => saveValue(event.target.value)}
                          displayEmpty
                          MenuProps={{
                            slotProps: {
                              paper: {
                                sx: {
                                  bgcolor: '#0f172a',
                                  color: '#e2e8f0',
                                  border: '1px solid #334155',
                                },
                              },
                            },
                          }}
                        >
                          {(field.options ?? []).map((option) => (
                            <MenuItem key={option.value} value={option.value}>
                              {option.label}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    ) : field.fieldType === 'boolean' ? (
                      <div className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2">
                        <FormControlLabel
                          control={
                            <MuiCheckbox
                              checked={Boolean(displayValue)}
                              disabled={!field.editable}
                              onChange={(event) => saveValue(event.target.checked)}
                              sx={{
                                color: '#94a3b8',
                                '&.Mui-checked': { color: '#3b82f6' },
                              }}
                            />
                          }
                          label={field.placeholder ?? 'Enabled'}
                          sx={{ color: '#e2e8f0', m: 0 }}
                        />
                      </div>
                    ) : (
                      <TextField
                        type={field.fieldType === 'number' ? 'number' : 'text'}
                        fullWidth
                        size="small"
                        value={String(displayValue)}
                        disabled={!field.editable}
                        onChange={(event) => saveValue(event.target.value)}
                        placeholder={field.placeholder}
                        slotProps={{
                          input: {
                            endAdornment: field.unitLabel ? (
                              <InputAdornment position="end">{field.unitLabel}</InputAdornment>
                            ) : undefined,
                          },
                        }}
                        sx={{
                          '& .MuiOutlinedInput-root': {
                            color: '#e2e8f0',
                            backgroundColor: '#020617',
                            '& fieldset': { borderColor: '#334155' },
                            '&:hover fieldset': { borderColor: '#475569' },
                            '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
                          },
                          '& .MuiInputBase-input::placeholder': { color: '#64748b', opacity: 1 },
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}