import React from 'react';

type TabButtonProps = {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
};

export default function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-sm px-4 py-1.5 text-sm font-medium transition-all ${
        active ? 'bg-slate-800 text-slate-100 shadow-sm' : 'hover:bg-slate-800/50 hover:text-slate-300'
      }`}
    >
      <span className="flex items-center gap-2">
        {icon} {label}
      </span>
    </button>
  );
}