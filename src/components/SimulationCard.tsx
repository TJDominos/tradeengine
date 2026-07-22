type SimulationCardProps = {
  label: string;
  value: string;
  accent?: 'emerald' | 'rose';
};

export default function SimulationCard({
  label,
  value,
  accent,
}: SimulationCardProps) {
  const accentClass =
    accent === 'emerald'
      ? 'text-emerald-400'
      : accent === 'rose'
        ? 'text-rose-400'
        : 'text-white';
  return (
    <div className="rounded border border-slate-700/50 bg-slate-800/50 p-4">
      <p className="text-[10px] font-bold uppercase text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-medium ${accentClass}`}>{value}</p>
    </div>
  );
}