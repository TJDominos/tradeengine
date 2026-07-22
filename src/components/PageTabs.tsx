import { Activity, Archive, Settings, Users } from 'lucide-react';

import type { TabId } from '../app/types';
import TabButton from './TabButton';

type PageTabsProps = {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
};

export default function PageTabs({ activeTab, onTabChange }: PageTabsProps) {
  return (
    <div className="mb-6 inline-flex h-10 items-center justify-center self-start rounded-md border border-slate-800 bg-slate-900 p-1 text-slate-400 shadow-sm">
      <TabButton active={activeTab === 'dashboard'} onClick={() => onTabChange('dashboard')} icon={<Activity size={16} />} label="Dashboard" />
      <TabButton active={activeTab === 'accounts'} onClick={() => onTabChange('accounts')} icon={<Users size={16} />} label="Accounts" />
      <TabButton active={activeTab === 'setup'} onClick={() => onTabChange('setup')} icon={<Settings size={16} />} label="Trading Setup" />
      <TabButton active={activeTab === 'setups'} onClick={() => onTabChange('setups')} icon={<Archive size={16} />} label="Strategy Versions" />
    </div>
  );
}