import React from 'react';
import { Key, Search, Shield, Trash2 } from 'lucide-react';

import {
  RECOVERY_PHRASE_WORD_COUNTS,
} from '../app/constants';
import type { AccountRecord, WalletBalance } from '../app/types';
import BalanceBadges from './BalanceBadges';

type AdminTab = 'password' | 'import' | 'list';

type AdminImportOptionsState = {
  isRecovery: boolean;
  wordCount: number;
  derivedAccountCount: number;
};

type AdminPasswordChangeInput = {
  oldPassword: string;
  newPassword: string;
  newPasswordConfirmation: string;
};

type AdminImportInput = {
  adminPassword: string;
  privateKey: string;
  recoveryPhrase: string;
};

type AdminMessageState = {
  type: string;
  text: string;
};

type AdminModalProps = {
  open: boolean;
  onClose: () => void;
  adminTab: AdminTab;
  setAdminTab: React.Dispatch<React.SetStateAction<AdminTab>>;
  adminMsg: AdminMessageState;
  setAdminMsg: React.Dispatch<React.SetStateAction<AdminMessageState>>;
  adminImportOptions: AdminImportOptionsState;
  setAdminImportOptions: React.Dispatch<React.SetStateAction<AdminImportOptionsState>>;
  managedAccountCount: number;
  managedWallets: AccountRecord[];
  walletBalanceErrors: Record<string, string>;
  walletBalances: Record<string, WalletBalance>;
  submitting: string | null;
  onPasswordChange: (input: AdminPasswordChangeInput) => void;
  onImport: (input: AdminImportInput) => void;
  onToggleActive: (address: string, isActive: boolean, adminPassword: string) => void;
  statusUpdatingAddress: string | null;
  onDelete: (address: string, adminPassword: string) => void;
};

export default function AdminModal({
  open,
  onClose,
  adminTab,
  setAdminTab,
  adminMsg,
  setAdminMsg,
  adminImportOptions,
  setAdminImportOptions,
  managedAccountCount,
  managedWallets,
  walletBalanceErrors,
  walletBalances,
  submitting,
  onPasswordChange,
  onImport,
  onToggleActive,
  statusUpdatingAddress,
  onDelete,
}: AdminModalProps) {
  const [manageSearchTerm, setManageSearchTerm] = React.useState('');
  const listPasswordRef = React.useRef<HTMLInputElement>(null);
  const requestLocked = submitting != null;

  const readAndClearListPassword = () => {
    const password = listPasswordRef.current?.value ?? '';
    if (listPasswordRef.current) {
      listPasswordRef.current.value = '';
    }
    return password;
  };

  React.useEffect(() => {
    if (!open) {
      setManageSearchTerm('');
    }
  }, [open]);

  const filteredManagedWallets = React.useMemo(() => {
    const trimmed = manageSearchTerm.trim().toLowerCase();
    if (!trimmed) {
      return managedWallets;
    }
    return managedWallets.filter(
      (account) =>
        account.label.toLowerCase().includes(trimmed) ||
        account.address.toLowerCase().includes(trimmed),
    );
  }, [manageSearchTerm, managedWallets]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 p-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Shield size={18} className="text-amber-500" />
            Admin Panel
          </h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-white">
            X
          </button>
        </div>

        <div className="flex border-b border-slate-800 bg-slate-900/50">
          <button onClick={() => { setAdminTab('password'); setAdminMsg({ type: '', text: '' }); }} className={`flex-1 py-3 text-sm font-medium ${adminTab === 'password' ? 'border-b-2 border-amber-500 text-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>Password</button>
          <button onClick={() => { setAdminTab('import'); setAdminMsg({ type: '', text: '' }); }} className={`flex-1 py-3 text-sm font-medium ${adminTab === 'import' ? 'border-b-2 border-amber-500 text-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>Import Key</button>
          <button onClick={() => { setAdminTab('list'); setAdminMsg({ type: '', text: '' }); }} className={`flex-1 py-3 text-sm font-medium ${adminTab === 'list' ? 'border-b-2 border-amber-500 text-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>Manage</button>
        </div>

        <div className="space-y-4 overflow-y-auto p-6">
          {adminMsg.text ? (
            <div className={`rounded p-3 text-sm ${adminMsg.type === 'error' ? 'border border-rose-500/20 bg-rose-500/10 text-rose-400' : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'}`}>
              {adminMsg.text}
            </div>
          ) : null}

          {adminTab === 'password' ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const oldPassword = String(data.get('oldPassword') ?? '');
                const newPassword = String(data.get('newPassword') ?? '');
                const newPasswordConfirmation = String(data.get('newPasswordConfirmation') ?? '');
                form.reset();
                onPasswordChange({ oldPassword, newPassword, newPasswordConfirmation });
              }}
            >
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Old Password</span>
                <input name="oldPassword" type="password" autoComplete="current-password" className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">New Password</span>
                <input name="newPassword" type="password" autoComplete="new-password" className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Confirm Password</span>
                <input name="newPasswordConfirmation" type="password" autoComplete="new-password" className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>
              <button
                type="submit"
                disabled={requestLocked}
                className="mt-2 w-full rounded bg-amber-600 py-2.5 font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting === 'admin-password' ? 'Updating...' : 'Change Password'}
              </button>
            </form>
          ) : null}

          {adminTab === 'import' ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const input = {
                  adminPassword: String(data.get('adminPassword') ?? ''),
                  privateKey: String(data.get('privateKey') ?? ''),
                  recoveryPhrase: String(data.get('recoveryPhrase') ?? '').trim().toLowerCase(),
                };
                form.reset();
                onImport(input);
              }}
            >
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Admin Password</span>
                <input name="adminPassword" type="password" autoComplete="current-password" className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>

              <div className="flex overflow-hidden rounded-md border border-slate-800 bg-slate-950">
                <button type="button" onClick={() => setAdminImportOptions({ ...adminImportOptions, isRecovery: false })} className={`flex-1 py-1.5 text-xs font-medium ${!adminImportOptions.isRecovery ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Private Key</button>
                <button type="button" onClick={() => setAdminImportOptions({ ...adminImportOptions, isRecovery: true })} className={`flex-1 py-1.5 text-xs font-medium ${adminImportOptions.isRecovery ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Recovery Phrase</button>
              </div>

              {!adminImportOptions.isRecovery ? (
                <label className="block space-y-1.5">
                  <span className="text-xs font-semibold uppercase text-slate-400">Private Key (Phantom/Solana)</span>
                  <input name="privateKey" type="password" autoComplete="off" placeholder="Base58 Private Key" className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-amber-500" />
                </label>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1 text-center">
                    <h4 className="font-semibold">Recovery Phrase</h4>
                    <p className="text-xs text-slate-400">Import an existing wallet with a 12, 15, 18, 21, or 24-word recovery phrase.</p>
                  </div>
                  <div className="rounded-xl border-2 border-amber-500/30 bg-amber-500/10 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-amber-300">How Many Derived Accounts To Import</div>
                        <div className="mt-1 text-xs text-amber-100">Currently imported internal wallets: {managedAccountCount}</div>
                        <div className="mt-1 text-xs text-amber-100">This import will add {adminImportOptions.derivedAccountCount} more derived accounts beyond the currently imported set.</div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2">
                      {[20, 40, 70, 100].map((count) => (
                        <button
                          key={count}
                          type="button"
                          onClick={() => setAdminImportOptions({ ...adminImportOptions, derivedAccountCount: count })}
                          className={`rounded border px-2 py-2 text-xs font-semibold ${adminImportOptions.derivedAccountCount === count ? 'border-amber-500 bg-amber-600 text-white' : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-amber-500/50 hover:text-white'}`}
                        >
                          Add {count}
                        </button>
                      ))}
                    </div>
                    <label className="mt-3 block space-y-1.5">
                      <span className="text-xs font-semibold uppercase text-slate-300">Custom Count</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={adminImportOptions.derivedAccountCount}
                        onChange={(event) => {
                          const nextCount = Number.parseInt(event.target.value, 10);
                          setAdminImportOptions({
                            ...adminImportOptions,
                            derivedAccountCount: Number.isFinite(nextCount) ? nextCount : 1,
                          });
                        }}
                        className="w-full rounded border-2 border-amber-500/40 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500"
                      />
                      <p className="text-[10px] leading-tight text-slate-400">
                        This adds the next N derived accounts after the ones you already imported.
                      </p>
                    </label>
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold uppercase text-slate-400">Word Count</span>
                    <div className="grid grid-cols-5 gap-2">
                      {RECOVERY_PHRASE_WORD_COUNTS.map((count) => (
                        <button
                          key={count}
                          type="button"
                          onClick={() => setAdminImportOptions({ ...adminImportOptions, wordCount: count })}
                          className={`rounded border px-2 py-1 text-xs font-medium ${adminImportOptions.wordCount === count ? 'border-amber-500 bg-amber-600 text-white' : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'}`}
                        >
                          {count}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <textarea
                      name="recoveryPhrase"
                      rows={3}
                      autoComplete="off"
                      placeholder={`Enter ${adminImportOptions.wordCount} words separated by spaces`}
                      className="w-full resize-y rounded border border-slate-800 bg-slate-900 p-2 text-sm text-slate-200 outline-none focus:border-amber-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="rounded border border-slate-800 bg-slate-950/60 p-2 text-xs text-slate-500">
                      Derived accounts are calculated and encrypted on the backend after import.
                    </div>
                  </div>
                </div>
              )}

              <div className="text-[10px] leading-tight text-slate-500">Keys are encrypted on the backend and saved as internal engine wallets.</div>
              <button
                type="submit"
                disabled={requestLocked}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded bg-amber-600 py-2.5 font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Key size={16} /> Import Wallet
              </button>
            </form>
          ) : null}

          {adminTab === 'list' ? (
            <div className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Admin Password (Required only for deletion)</span>
                <input name="adminPassword" type="password" autoComplete="current-password" ref={listPasswordRef} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Search Managed Wallets</span>
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
                  <input
                    type="text"
                    value={manageSearchTerm}
                    onChange={(event) => setManageSearchTerm(event.target.value)}
                    placeholder="Search by label or wallet address"
                    className="w-full rounded border border-slate-800 bg-slate-950 py-2 pl-9 pr-3 text-sm outline-none focus:border-amber-500"
                  />
                </div>
              </label>
              <div className="mt-4 overflow-hidden rounded-md border border-slate-800 bg-slate-950/50">
                <div className="flex justify-between border-b border-slate-800 bg-slate-900/50 p-3 text-xs font-semibold text-slate-400">
                  <span>Imported Wallets</span>
                  <span>{filteredManagedWallets.length} / {managedWallets.length}</span>
                </div>
                <div className="max-h-60 space-y-2 overflow-y-auto p-2">
                  {filteredManagedWallets.length === 0 ? (
                    <div className="py-4 text-center text-xs text-slate-500">
                      {managedWallets.length === 0 ? 'No imported wallets found.' : 'No managed wallets match this search.'}
                    </div>
                  ) : (
                    filteredManagedWallets.map((account, index) => (
                      <div key={account.address} className="rounded border border-slate-800 bg-slate-900 p-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="w-4 font-mono text-xs text-slate-500">{index + 1}.</span>
                            <div>
                              <div className="text-xs font-semibold text-slate-200">{account.label}</div>
                              <div className="w-40 truncate font-mono text-xs text-slate-300" title={account.address}>{account.address}</div>
                              <div className={`mt-1 text-[10px] ${account.isActive ? 'text-emerald-300' : 'text-slate-500'}`}>
                                {account.isActive ? 'Trading Enabled' : 'Trading Disabled'}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => onToggleActive(account.address, !account.isActive, readAndClearListPassword())}
                              disabled={statusUpdatingAddress === account.address || requestLocked}
                              className={`rounded border px-2 py-1 text-xs font-semibold transition ${
                                account.isActive
                                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                              } disabled:cursor-not-allowed disabled:opacity-60`}
                            >
                              {statusUpdatingAddress === account.address
                                ? 'Updating...'
                                : account.isActive
                                  ? 'Disable Trading'
                                  : 'Enable Trading'}
                            </button>
                            <button
                              onClick={() => onDelete(account.address, readAndClearListPassword())}
                              disabled={requestLocked}
                              className="flex items-center gap-1 rounded bg-rose-500/10 p-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                              title="Delete Key"
                            >
                              <Trash2 size={14} /> {submitting === `admin-delete-${account.address}` ? 'Deleting...' : 'Delete'}
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 text-[11px] text-slate-400">
                          {walletBalanceErrors[account.address] ? <span className="text-rose-400">{walletBalanceErrors[account.address]}</span> : <BalanceBadges balance={walletBalances[account.address]} />}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}