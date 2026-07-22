import React from 'react';
import { Key, Shield, Trash2 } from 'lucide-react';

import type { AccountRecord, WalletBalance } from '../app/types';
import BalanceBadges from './BalanceBadges';

type AdminTab = 'password' | 'import' | 'list';

type AdminPasswordFormState = {
  old: string;
  new1: string;
  new2: string;
};

type AdminImportFormState = {
  key: string;
  password: string;
  recoveryPhrase: string[];
  isRecovery: boolean;
  wordCount: number;
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
  adminPasswordForm: AdminPasswordFormState;
  setAdminPasswordForm: React.Dispatch<React.SetStateAction<AdminPasswordFormState>>;
  adminImportForm: AdminImportFormState;
  setAdminImportForm: React.Dispatch<React.SetStateAction<AdminImportFormState>>;
  managedWallets: AccountRecord[];
  walletBalanceErrors: Record<string, string>;
  walletBalances: Record<string, WalletBalance>;
  onPasswordChange: () => void;
  onImport: () => void;
  onDelete: (address: string) => void;
};

export default function AdminModal({
  open,
  onClose,
  adminTab,
  setAdminTab,
  adminMsg,
  setAdminMsg,
  adminPasswordForm,
  setAdminPasswordForm,
  adminImportForm,
  setAdminImportForm,
  managedWallets,
  walletBalanceErrors,
  walletBalances,
  onPasswordChange,
  onImport,
  onDelete,
}: AdminModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
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

        <div className="space-y-4 p-6">
          {adminMsg.text ? (
            <div className={`rounded p-3 text-sm ${adminMsg.type === 'error' ? 'border border-rose-500/20 bg-rose-500/10 text-rose-400' : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'}`}>
              {adminMsg.text}
            </div>
          ) : null}

          {adminTab === 'password' ? (
            <div className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Old Password</span>
                <input type="password" value={adminPasswordForm.old} onChange={(event) => setAdminPasswordForm({ ...adminPasswordForm, old: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">New Password</span>
                <input type="password" value={adminPasswordForm.new1} onChange={(event) => setAdminPasswordForm({ ...adminPasswordForm, new1: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Confirm Password</span>
                <input type="password" value={adminPasswordForm.new2} onChange={(event) => setAdminPasswordForm({ ...adminPasswordForm, new2: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>
              <button onClick={onPasswordChange} className="mt-2 w-full rounded bg-amber-600 py-2.5 font-medium text-white hover:bg-amber-700">Change Password</button>
            </div>
          ) : null}

          {adminTab === 'import' ? (
            <div className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Admin Password</span>
                <input type="password" value={adminImportForm.password} onChange={(event) => setAdminImportForm({ ...adminImportForm, password: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>

              <div className="flex overflow-hidden rounded-md border border-slate-800 bg-slate-950">
                <button onClick={() => setAdminImportForm({ ...adminImportForm, isRecovery: false })} className={`flex-1 py-1.5 text-xs font-medium ${!adminImportForm.isRecovery ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Private Key</button>
                <button onClick={() => setAdminImportForm({ ...adminImportForm, isRecovery: true })} className={`flex-1 py-1.5 text-xs font-medium ${adminImportForm.isRecovery ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Recovery Phrase</button>
              </div>

              {!adminImportForm.isRecovery ? (
                <label className="block space-y-1.5">
                  <span className="text-xs font-semibold uppercase text-slate-400">Private Key (Phantom/Solana)</span>
                  <input type="password" value={adminImportForm.key} onChange={(event) => setAdminImportForm({ ...adminImportForm, key: event.target.value })} placeholder="Base58 Private Key" className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-amber-500" />
                </label>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1 text-center">
                    <h4 className="font-semibold">Recovery Phrase</h4>
                    <p className="text-xs text-slate-400">Import an existing wallet with your 12 or 24-word recovery phrase.</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {adminImportForm.recoveryPhrase.slice(0, adminImportForm.wordCount).map((word, index) => (
                      <div key={index} className="relative">
                        <span className="absolute left-2.5 top-2 text-xs text-slate-500">{index + 1}.</span>
                        <input
                          type="text"
                          value={word}
                          onChange={(event) => {
                            const nextPhrase = [...adminImportForm.recoveryPhrase];
                            nextPhrase[index] = event.target.value.trim().toLowerCase();
                            setAdminImportForm({ ...adminImportForm, recoveryPhrase: nextPhrase });
                          }}
                          className="w-full rounded border border-slate-800 bg-slate-900 py-1.5 pl-7 pr-2 text-sm text-slate-200 outline-none focus:border-amber-500"
                        />
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      const newCount = adminImportForm.wordCount === 12 ? 24 : 12;
                      const nextPhrase = Array(24).fill('');
                      adminImportForm.recoveryPhrase.forEach((word, index) => {
                        nextPhrase[index] = word;
                      });
                      setAdminImportForm({ ...adminImportForm, wordCount: newCount, recoveryPhrase: nextPhrase });
                    }}
                    className="w-full py-1 text-sm text-slate-400 hover:text-slate-200"
                  >
                    I have a {adminImportForm.wordCount === 12 ? '24' : '12'}-word recovery phrase
                  </button>
                </div>
              )}

              <div className="text-[10px] leading-tight text-slate-500">Keys are encrypted on the backend and saved as internal engine wallets.</div>
              <button onClick={onImport} className="mt-2 flex w-full items-center justify-center gap-2 rounded bg-amber-600 py-2.5 font-medium text-white hover:bg-amber-700">
                <Key size={16} /> Import Wallet
              </button>
            </div>
          ) : null}

          {adminTab === 'list' ? (
            <div className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase text-slate-400">Admin Password (Required for deletion)</span>
                <input type="password" value={adminImportForm.password} onChange={(event) => setAdminImportForm({ ...adminImportForm, password: event.target.value })} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
              </label>
              <div className="mt-4 overflow-hidden rounded-md border border-slate-800 bg-slate-950/50">
                <div className="flex justify-between border-b border-slate-800 bg-slate-900/50 p-3 text-xs font-semibold text-slate-400">
                  <span>Imported Wallets</span>
                  <span>{managedWallets.length}</span>
                </div>
                <div className="max-h-60 space-y-2 overflow-y-auto p-2">
                  {managedWallets.length === 0 ? (
                    <div className="py-4 text-center text-xs text-slate-500">No imported wallets found.</div>
                  ) : (
                    managedWallets.map((account, index) => (
                      <div key={account.address} className="rounded border border-slate-800 bg-slate-900 p-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="w-4 font-mono text-xs text-slate-500">{index + 1}.</span>
                            <div>
                              <div className="text-xs font-semibold text-slate-200">{account.label}</div>
                              <div className="w-40 truncate font-mono text-xs text-slate-300" title={account.address}>{account.address}</div>
                            </div>
                          </div>
                          <button onClick={() => onDelete(account.address)} className="flex items-center gap-1 rounded bg-rose-500/10 p-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20" title="Delete Key">
                            <Trash2 size={14} /> Delete
                          </button>
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