import { Activity, FileText } from 'lucide-react';

import type {
  AuditLog,
  DashboardLogTab,
  DashboardTransactionLog,
  WalletOwnershipMeta,
} from '../app/types';
import ActivityLogsCard from './ActivityLogsCard';
import TabButton from './TabButton';
import TransactionLogsCard from './TransactionLogsCard';

type DashboardLogsSectionProps = {
  dashboardLogTab: DashboardLogTab;
  onDashboardLogTabChange: (tab: DashboardLogTab) => void;
  currentTransactionLogs: DashboardTransactionLog[];
  filteredTransactionLogsCount: number;
  transactionLogSearchTerm: string;
  onTransactionLogSearchTermChange: (value: string) => void;
  transactionLogCurrentPage: number;
  onTransactionLogPageChange: (page: number) => void;
  walletOwnershipLookup: Map<string, WalletOwnershipMeta>;
  currentActivityLogs: AuditLog[];
  filteredActivityLogsCount: number;
  activityLogSearchTerm: string;
  onActivityLogSearchTermChange: (value: string) => void;
  activityLogCurrentPage: number;
  onActivityLogPageChange: (page: number) => void;
  itemsPerPage: number;
};

export default function DashboardLogsSection({
  dashboardLogTab,
  onDashboardLogTabChange,
  currentTransactionLogs,
  filteredTransactionLogsCount,
  transactionLogSearchTerm,
  onTransactionLogSearchTermChange,
  transactionLogCurrentPage,
  onTransactionLogPageChange,
  walletOwnershipLookup,
  currentActivityLogs,
  filteredActivityLogsCount,
  activityLogSearchTerm,
  onActivityLogSearchTermChange,
  activityLogCurrentPage,
  onActivityLogPageChange,
  itemsPerPage,
}: DashboardLogsSectionProps) {
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-xl border border-slate-800 bg-slate-900 p-1 shadow-sm">
        <TabButton
          active={dashboardLogTab === 'transaction'}
          onClick={() => onDashboardLogTabChange('transaction')}
          icon={<FileText size={14} />}
          label="Transaction Log"
        />
        <TabButton
          active={dashboardLogTab === 'activity'}
          onClick={() => onDashboardLogTabChange('activity')}
          icon={<Activity size={14} />}
          label="Activity Log"
        />
      </div>
      {dashboardLogTab === 'transaction' ? (
        <TransactionLogsCard
          currentTransactionLogs={currentTransactionLogs}
          filteredTransactionLogsCount={filteredTransactionLogsCount}
          transactionLogSearchTerm={transactionLogSearchTerm}
          onTransactionLogSearchTermChange={onTransactionLogSearchTermChange}
          transactionLogCurrentPage={transactionLogCurrentPage}
          onTransactionLogPageChange={onTransactionLogPageChange}
          itemsPerPage={itemsPerPage}
          walletOwnershipLookup={walletOwnershipLookup}
        />
      ) : (
        <ActivityLogsCard
          currentActivityLogs={currentActivityLogs}
          filteredActivityLogsCount={filteredActivityLogsCount}
          activityLogSearchTerm={activityLogSearchTerm}
          onActivityLogSearchTermChange={onActivityLogSearchTermChange}
          activityLogCurrentPage={activityLogCurrentPage}
          onActivityLogPageChange={onActivityLogPageChange}
          itemsPerPage={itemsPerPage}
        />
      )}
    </div>
  );
}