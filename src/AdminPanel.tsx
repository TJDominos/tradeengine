import React from 'react';
import { Eye, EyeOff, Key, Shield, Trash2 } from 'lucide-react';

type AdminTab = 'password' | 'import' | 'list';
type ImportMode = 'private-key' | 'recovery';

interface AdminPanelProps {
  isOpen: boolean;
  onClose: () => void;
  engineState: {
    internalAccs: Array<{
      address: string;
      label: string;
      type: string;
      createdAt: number;
    }>;
  };
  walletBalances: Record<string, WalletBalance>;
  walletBalanceErrors: Record<string, string>;
  walletBalancePending: Record<string, boolean>;
  onRefresh: () => Promise<void>;
}

interface WalletBalanceToken {
  mint: string;
  symbol: string;
  network: string;
  amount: string;
  decimals: number | null;
}

interface WalletBalance {
  address: string;
  sol: string;
  usdc: string;
  tokens: WalletBalanceToken[];
  updatedAt: number;
}

interface AdminPasswordForm {
  old: string;
  next: string;
  confirm: string;
}

interface AdminImportForm {
  label: string;
  importMode: ImportMode;
  privateKey: string;
  recoveryPhrase: string;
}

interface AdminMessage {
  type: '' | 'error' | 'success';
  text: string;
}

function compactAddress(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function formatDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString();
}

export default function AdminPanel({
  isOpen,
  onClose,
  engineState,
  walletBalances,
  walletBalanceErrors,
  walletBalancePending,
  onRefresh,
}: AdminPanelProps) {
  const [adminTab, setAdminTab] = React.useState<AdminTab>('password');
  const [adminPasswordForm, setAdminPasswordForm] =
    React.useState<AdminPasswordForm>({ old: '', next: '', confirm: '' });
  const [adminImportForm, setAdminImportForm] = React.useState<AdminImportForm>({
    label: '',
    importMode: 'private-key',
    privateKey: '',
    recoveryPhrase: '',
  });
  const [adminMsg, setAdminMsg] = React.useState<AdminMessage>({
    type: '',
    text: '',
  });
  const [showOldPassword, setShowOldPassword] = React.useState(false);
  const [showNewPassword, setShowNewPassword] = React.useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false);

  if (!isOpen) return null;

  const managedWallets = engineState.internalAccs.filter(
    (account) => account.type === 'managed',
  );

  const handleChangePassword = async () => {
    if (adminPasswordForm.next !== adminPasswordForm.confirm) {
      setAdminMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    if (adminPasswordForm.next.length < 12) {
      setAdminMsg({
        type: 'error',
        text: 'New password must be at least 12 characters long.',
      });
      return;
    }

    setAdminMsg({ type: '', text: 'Updating password…' });
    try {
      const response = await fetch('/api/admin/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          oldPassword: adminPasswordForm.old,
          newPassword: adminPasswordForm.next,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        setAdminMsg({
          type: 'error',
          text: data.error || data.message || 'Failed to change password.',
        });
        return;
      }
      setAdminPasswordForm({ old: '', next: '', confirm: '' });
      setAdminMsg({
        type: 'success',
        text: data.message || 'Password updated successfully.',
      });
    } catch {
      setAdminMsg({ type: 'error', text: 'Network error while changing password.' });
    }
  };

  const handleImportWallet = async () => {
    if (!adminImportForm.label.trim()) {
      setAdminMsg({ type: 'error', text: 'Wallet label is required.' });
      return;
    }

    if (adminImportForm.importMode === 'private-key') {
      if (!adminImportForm.privateKey.trim()) {
        setAdminMsg({ type: 'error', text: 'Private key input is required.' });
        return;
      }
    } else {
      const words = adminImportForm.recoveryPhrase
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (words.length !== 12 && words.length !== 24) {
        setAdminMsg({
          type: 'error',
          text: 'Recovery phrase must contain 12 or 24 words.',
        });
        return;
      }
    }

    setAdminMsg({ type: '', text: 'Importing wallet…' });
    try {
      const response = await fetch('/api/admin/private-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          label: adminImportForm.label,
          privateKey:
            adminImportForm.importMode === 'private-key'
              ? adminImportForm.privateKey
              : undefined,
          recoveryPhrase:
            adminImportForm.importMode === 'recovery'
              ? adminImportForm.recoveryPhrase
              : undefined,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        account?: { address: string };
      };
      if (!response.ok) {
        setAdminMsg({
          type: 'error',
          text: data.error || 'Failed to import wallet.',
        });
        return;
      }
      setAdminImportForm({
        label: '',
        importMode: 'private-key',
        privateKey: '',
        recoveryPhrase: '',
      });
      await onRefresh();
      setAdminMsg({
        type: 'success',
        text: `Imported wallet ${data.account?.address ?? ''}`.trim(),
      });
      setAdminTab('list');
    } catch {
      setAdminMsg({ type: 'error', text: 'Network error while importing wallet.' });
    }
  };

  const handleDeleteWallet = async (address: string, label: string) => {
    if (!window.confirm(`Delete managed wallet "${label}"?`)) return;
    if (!window.confirm('This action cannot be undone. Continue?')) return;

    try {
      const response = await fetch(`/api/admin/private-keys/${address}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) {
        setAdminMsg({
          type: 'error',
          text: data.error || 'Failed to delete wallet.',
        });
        return;
      }
      await onRefresh();
      setAdminMsg({
        type: 'success',
        text: data.message || 'Wallet deleted successfully.',
      });
    } catch {
      setAdminMsg({ type: 'error', text: 'Network error while deleting wallet.' });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/90 p-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Shield className="size-5 text-amber-400" />
            Admin Panel
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex border-b border-slate-800 bg-slate-950/40">
          <AdminTabButton
            label="Change Password"
            active={adminTab === 'password'}
            onClick={() => {
              setAdminTab('password');
              setAdminMsg({ type: '', text: '' });
            }}
          />
          <AdminTabButton
            label="Import Wallet"
            active={adminTab === 'import'}
            onClick={() => {
              setAdminTab('import');
              setAdminMsg({ type: '', text: '' });
            }}
          />
          <AdminTabButton
            label="Manage Wallets"
            active={adminTab === 'list'}
            onClick={() => {
              setAdminTab('list');
              setAdminMsg({ type: '', text: '' });
            }}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {adminMsg.text && (
            <div
              className={`mb-4 rounded-xl border p-3 text-sm ${
                adminMsg.type === 'error'
                  ? 'border-rose-500/20 bg-rose-500/10 text-rose-300'
                  : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              {adminMsg.text}
            </div>
          )}

          {adminTab === 'password' && (
            <div className="space-y-4">
              <PasswordField
                label="Current Password"
                value={adminPasswordForm.old}
                visible={showOldPassword}
                onToggle={() => setShowOldPassword((current) => !current)}
                onChange={(value) =>
                  setAdminPasswordForm((current) => ({ ...current, old: value }))
                }
              />
              <PasswordField
                label="New Password"
                helper="Use at least 12 characters."
                value={adminPasswordForm.next}
                visible={showNewPassword}
                onToggle={() => setShowNewPassword((current) => !current)}
                onChange={(value) =>
                  setAdminPasswordForm((current) => ({ ...current, next: value }))
                }
              />
              <PasswordField
                label="Confirm New Password"
                value={adminPasswordForm.confirm}
                visible={showConfirmPassword}
                onToggle={() => setShowConfirmPassword((current) => !current)}
                onChange={(value) =>
                  setAdminPasswordForm((current) => ({
                    ...current,
                    confirm: value,
                  }))
                }
              />
              <button
                onClick={handleChangePassword}
                className="w-full rounded-xl bg-amber-600 px-4 py-3 font-semibold text-white transition hover:bg-amber-500"
              >
                Change Password
              </button>
            </div>
          )}

          {adminTab === 'import' && (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <button
                  onClick={() =>
                    setAdminImportForm((current) => ({
                      ...current,
                      importMode: 'private-key',
                    }))
                  }
                  className={`rounded-xl border px-4 py-3 text-left transition ${
                    adminImportForm.importMode === 'private-key'
                      ? 'border-amber-500 bg-amber-950/40 text-amber-200'
                      : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  <div className="font-semibold">Private Key</div>
                  <div className="mt-1 text-xs text-slate-400">
                    Accepts base58 or 64-byte JSON array input.
                  </div>
                </button>
                <button
                  onClick={() =>
                    setAdminImportForm((current) => ({
                      ...current,
                      importMode: 'recovery',
                    }))
                  }
                  className={`rounded-xl border px-4 py-3 text-left transition ${
                    adminImportForm.importMode === 'recovery'
                      ? 'border-amber-500 bg-amber-950/40 text-amber-200'
                      : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  <div className="font-semibold">Recovery Phrase</div>
                  <div className="mt-1 text-xs text-slate-400">
                    Supports 12-word and 24-word BIP39 phrases.
                  </div>
                </button>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-300">
                  Wallet Label
                </label>
                <input
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-amber-500"
                  value={adminImportForm.label}
                  onChange={(event) =>
                    setAdminImportForm((current) => ({
                      ...current,
                      label: event.target.value,
                    }))
                  }
                  placeholder="e.g. Main Trading Wallet"
                />
              </div>

              {adminImportForm.importMode === 'private-key' ? (
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-300">
                    Private Key
                  </label>
                  <textarea
                    className="h-32 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono text-xs text-slate-100 outline-none transition focus:border-amber-500"
                    value={adminImportForm.privateKey}
                    onChange={(event) =>
                      setAdminImportForm((current) => ({
                        ...current,
                        privateKey: event.target.value,
                      }))
                    }
                    placeholder="Paste a Solana base58 private key or 64-byte JSON array"
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-300">
                    Recovery Phrase
                  </label>
                  <textarea
                    className="h-32 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-amber-500"
                    value={adminImportForm.recoveryPhrase}
                    onChange={(event) =>
                      setAdminImportForm((current) => ({
                        ...current,
                        recoveryPhrase: event.target.value,
                      }))
                    }
                    placeholder="Enter a 12-word or 24-word recovery phrase separated by spaces"
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    Uses the default Solana derivation path m/44'/501'/0'/0'.
                  </p>
                </div>
              )}

              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400">
                Imported secrets are encrypted server-side with AES-256-GCM and are
                never returned by the API.
              </div>

              <button
                onClick={handleImportWallet}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-3 font-semibold text-white transition hover:bg-amber-500"
              >
                <Key className="size-4" /> Import Wallet
              </button>
            </div>
          )}

          {adminTab === 'list' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div>
                  <div className="font-semibold text-white">Managed wallets</div>
                  <div className="text-sm text-slate-400">
                    {managedWallets.length} wallet{managedWallets.length === 1 ? '' : 's'} imported
                  </div>
                </div>
                <button
                  onClick={() => void onRefresh()}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
                >
                  Refresh
                </button>
              </div>

              {managedWallets.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/50 p-6 text-sm text-slate-400">
                  No managed wallets imported yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {managedWallets.map((account) => (
                    <div
                      key={account.address}
                      className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-white">
                            {account.label}
                          </div>
                          <div className="mt-1 font-mono text-xs text-blue-300">
                            {account.address}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            Imported {formatDate(account.createdAt)}
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            void handleDeleteWallet(account.address, account.label)
                          }
                          className="inline-flex items-center gap-1 rounded-lg bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20"
                        >
                          <Trash2 className="size-4" /> Delete
                        </button>
                      </div>

                      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                        <WalletBalanceSummary
                          address={account.address}
                          balance={walletBalances[account.address]}
                          loading={walletBalancePending[account.address] ?? false}
                          error={walletBalanceErrors[account.address]}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 border-b-2 px-4 py-3 text-sm font-medium transition ${
        active
          ? 'border-amber-500 text-amber-300'
          : 'border-transparent text-slate-400 hover:text-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

function PasswordField({
  label,
  helper,
  value,
  visible,
  onToggle,
  onChange,
}: {
  label: string;
  helper?: string;
  value: string;
  visible: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-slate-300">
        {label}
      </label>
      {helper && <p className="mb-2 text-xs text-slate-500">{helper}</p>}
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 pr-11 text-sm text-slate-100 outline-none transition focus:border-amber-500"
        />
        <button
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-slate-300"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  );
}

function WalletBalanceSummary({
  address,
  balance,
  loading,
  error,
}: {
  address: string;
  balance?: WalletBalance;
  loading: boolean;
  error?: string;
}) {
  if (loading) {
    return <p className="text-xs text-slate-500">Loading balances…</p>;
  }
  if (error) {
    return <p className="text-xs text-rose-300">{error}</p>;
  }
  if (!balance) {
    return (
      <p className="text-xs text-slate-500">
        No balance data loaded for {compactAddress(address)} yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-xs text-slate-200">
        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1">
          SOL {balance.sol}
        </span>
        <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-1">
          USDC {balance.usdc}
        </span>
      </div>
      {balance.tokens.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-slate-300">
          {balance.tokens.map((token) => (
            <span
              key={`${token.network}-${token.mint}`}
              className="rounded-full border border-blue-900 bg-blue-950/40 px-2 py-1"
            >
              {token.symbol} {token.amount}
            </span>
          ))}
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Updated {formatDate(balance.updatedAt)}
      </p>
    </div>
  );
}
