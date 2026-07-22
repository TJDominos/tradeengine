type SummaryMetricProps = {
  label: string;
  value: string;
};

export default function SummaryMetric({ label, value }: SummaryMetricProps) {
  return (
    <div>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}