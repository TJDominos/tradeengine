type SetupDataProps = {
  label: string;
  value: string;
};

export default function SetupData({ label, value }: SetupDataProps) {
  return (
    <div>
      <span className="mb-1 block text-xs text-slate-500">{label}</span>
      <span className="font-medium text-slate-300">{value}</span>
    </div>
  );
}