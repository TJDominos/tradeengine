type StatCardProps = {
  title: string;
  value: string;
  subtitle?: React.ReactNode;
  copyable?: boolean;
  isAddress?: boolean;
};

export default function StatCard({
  title,
  value,
  subtitle,
  copyable,
  isAddress,
}: StatCardProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-sm transition-colors hover:border-slate-700">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </p>
      <div className="mt-1 flex items-end justify-between">
        <h2
          className={`font-bold ${
            isAddress
              ? 'break-all font-mono text-[13px] leading-relaxed text-blue-400'
              : copyable
                ? 'cursor-pointer font-mono text-[22px] text-blue-400 hover:text-blue-300'
                : 'text-2xl text-white'
          }`}
        >
          {value}
        </h2>
      </div>
      {subtitle ? <div className="mt-3 text-xs text-slate-500">{subtitle}</div> : null}
    </div>
  );
}