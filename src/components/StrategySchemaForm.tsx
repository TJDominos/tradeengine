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
                      <textarea
                        value={String(displayValue)}
                        disabled={!field.editable}
                        onChange={(event) => saveValue(event.target.value)}
                        placeholder={field.placeholder}
                        className="min-h-24 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    ) : field.fieldType === 'select' ? (
                      <select
                        value={String(displayValue)}
                        disabled={!field.editable}
                        onChange={(event) => saveValue(event.target.value)}
                        className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {(field.options ?? []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : field.fieldType === 'boolean' ? (
                      <label className="flex h-10 items-center justify-between rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200">
                        <span>{field.placeholder ?? 'Enabled'}</span>
                        <input
                          type="checkbox"
                          checked={Boolean(displayValue)}
                          disabled={!field.editable}
                          onChange={(event) => saveValue(event.target.checked)}
                          className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-blue-500"
                        />
                      </label>
                    ) : (
                      <div className="relative">
                        <input
                          type={field.fieldType === 'number' ? 'number' : 'text'}
                          value={String(displayValue)}
                          disabled={!field.editable}
                          onChange={(event) => saveValue(event.target.value)}
                          placeholder={field.placeholder}
                          className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 pr-16 text-sm outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        {field.unitLabel ? (
                          <span className="absolute right-3 top-2.5 text-xs text-slate-500">{field.unitLabel}</span>
                        ) : null}
                      </div>
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