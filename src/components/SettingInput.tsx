type SettingInputProps = {
  label: string;
  sublabel?: string;
  value: string | number;
  onChange: (value: string) => void;
  options?: Array<{ label: string; value: string }>;
};

export default function SettingInput({
  label,
  sublabel,
  value,
  onChange,
  options,
}: SettingInputProps) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
        {label}
        {sublabel ? (
          <span className="ml-1.5 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] normal-case text-slate-500">
            {sublabel}
          </span>
        ) : null}
      </label>
      {options ? (
        <select
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-blue-500"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-blue-500"
        />
      )}
    </div>
  );
}