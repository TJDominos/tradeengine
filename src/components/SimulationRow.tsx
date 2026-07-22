type SimulationRowProps = {
  left: string;
  center: string;
  right: string;
};

export default function SimulationRow({ left, center, right }: SimulationRowProps) {
  return (
    <div className="flex items-center justify-between rounded border border-slate-800 bg-slate-950 p-2">
      <span className="text-slate-500">{left}</span>
      <span className="text-blue-400">{center}</span>
      <span className="hidden text-slate-300 sm:inline">{right}</span>
    </div>
  );
}