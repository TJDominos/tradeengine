import React from 'react';
import { Shield, Key, Trash2, Lock, Eye, EyeOff } from 'lucide-react';

interface AdminPanelProps {
  isOpen: boolean;
  onClose: () => void;
  engineState: any;
  onRefresh: () => void;
}

interface AdminPasswordForm {
  old: string;
  new1: string;
  new2: string;
}

interface AdminImportForm {
  key: string;
  password: string;
  label: string;
}

interface AdminMessage {
  type: '' | 'error' | 'success';
  text: string;
}

export default function AdminPanel({ isOpen, onClose, engineState, onRefresh }: AdminPanelProps) {
  const [adminTab, setAdminTab] = React.useState('password'); // password, import, list
  const [adminPasswordForm, setAdminPasswordForm] = React.useState<AdminPasswordForm>({ old: '', new1: '', new2: '' });
  const [adminImportForm, setAdminImportForm] = React.useState<AdminImportForm>({ key: '', password: '', label: '' });
  const [adminMsg, setAdminMsg] = React.useState<AdminMessage>({ type: '', text: '' });
  const [showOldPassword, setShowOldPassword] = React.useState(false);
  const [showNewPassword1, setShowNewPassword1] = React.useState(false);
  const [showNewPassword2, setShowNewPassword2] = React.useState(false);
  const [showImportPassword, setShowImportPassword] = React.useState(false);
  const [showPrivateKey, setShowPrivateKey] = React.useState(false);

  if (!isOpen) return null;

  const handleChangePassword = async () => {
    if (adminPasswordForm.new1 !== adminPasswordForm.new2) {
      setAdminMsg({ type: 'error', text: 'Passwords do not match' });
      return;
    }
    if (adminPasswordForm.new1.length < 12) {
      setAdminMsg({ type: 'error', text: 'Password must be at least 12 characters' });
      return;
    }

    setAdminMsg({ type: '', text: 'Updating...' });
    try {
      const res = await fetch('/api/admin/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          oldPassword: adminPasswordForm.old,
          newPassword: adminPasswordForm.new1,
        }),
      });

      const data = (await res.json()) as any;
      if (!res.ok) {
        setAdminMsg({ type: 'error', text: data?.error || data?.message || 'Failed to change password' });
      } else {
        setAdminMsg({ type: 'success', text: 'Password updated successfully' });
        setAdminPasswordForm({ old: '', new1: '', new2: '' });
      }
    } catch (e) {
      setAdminMsg({ type: 'error', text: 'Network error' });
    }
  };

  const handleImportKey = async () => {
    if (!adminImportForm.key || !adminImportForm.label) {
      setAdminMsg({ type: 'error', text: 'Please fill all fields' });
      return;
    }

    setAdminMsg({ type: '', text: 'Importing...' });
    try {
      const res = await fetch('/api/private-keys/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          label: adminImportForm.label,
          privateKey: adminImportForm.key,
        }),
      });

      const data = (await res.json()) as any;
      if (!res.ok) {
        setAdminMsg({ type: 'error', text: data?.error || data?.message || 'Failed to import key' });
      } else {
        setAdminMsg({ type: 'success', text: `Imported successfully: ${data?.account?.address || 'wallet'}` });
        setAdminImportForm({ key: '', password: '', label: '' });
        onRefresh();
      }
    } catch (e) {
      setAdminMsg({ type: 'error', text: 'Network error' });
    }
  };

  const handleDeleteKey = async (address: string, label: string) => {
    if (!window.confirm(`Delete wallet "${label}"?`)) return;
    if (!window.confirm('This action cannot be undone. Are you sure?')) return;

    try {
      const res = await fetch(`/api/admin/private-keys/${address}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      const data = (await res.json()) as any;
      if (!res.ok) {
        setAdminMsg({ type: 'error', text: data?.error || data?.message || 'Failed to delete wallet' });
      } else {
        setAdminMsg({ type: 'success', text: 'Wallet deleted successfully' });
        onRefresh();
      }
    } catch (e) {
      setAdminMsg({ type: 'error', text: 'Network error' });
    }
  };

  const managedWallets = engineState?.internalAccs?.filter((acc: any) => acc.type === 'managed') || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden max-h-[85vh]">
        <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/80">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <Shield size={18} className="text-amber-500" />
            Admin Panel
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="flex border-b border-slate-800 bg-slate-900/50">
          <button
            onClick={() => {
              setAdminTab('password');
              setAdminMsg({ type: '', text: '' });
            }}
            className={`flex-1 py-3 text-sm font-medium ${
              adminTab === 'password' ? 'text-amber-400 border-b-2 border-amber-500' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Change Password
          </button>
          <button
            onClick={() => {
              setAdminTab('import');
              setAdminMsg({ type: '', text: '' });
            }}
            className={`flex-1 py-3 text-sm font-medium ${
              adminTab === 'import' ? 'text-amber-400 border-b-2 border-amber-500' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Import Wallet
          </button>
          <button
            onClick={() => {
              setAdminTab('list');
              setAdminMsg({ type: '', text: '' });
            }}
            className={`flex-1 py-3 text-sm font-medium ${
              adminTab === 'list' ? 'text-amber-400 border-b-2 border-amber-500' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Manage Wallets
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {adminMsg.text && (
            <div
              className={`p-3 rounded text-sm ${
                adminMsg.type === 'error'
                  ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                  : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              }`}
            >
              {adminMsg.text}
            </div>
          )}

          {adminTab === 'password' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400 uppercase">Current Password</label>
                <div className="relative">
                  <input
                    type={showOldPassword ? 'text' : 'password'}
                    value={adminPasswordForm.old}
                    onChange={(e) => setAdminPasswordForm({ ...adminPasswordForm, old: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm focus:border-amber-500 outline-none pr-10"
                  />
                  <button
                    onClick={() => setShowOldPassword(!showOldPassword)}
                    className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                  >
                    {showOldPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400 uppercase">New Password (12+ chars)</label>
                <div className="relative">
                  <input
                    type={showNewPassword1 ? 'text' : 'password'}
                    value={adminPasswordForm.new1}
                    onChange={(e) => setAdminPasswordForm({ ...adminPasswordForm, new1: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm focus:border-amber-500 outline-none pr-10"
                  />
                  <button
                    onClick={() => setShowNewPassword1(!showNewPassword1)}
                    className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                  >
                    {showNewPassword1 ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400 uppercase">Confirm New Password</label>
                <div className="relative">
                  <input
                    type={showNewPassword2 ? 'text' : 'password'}
                    value={adminPasswordForm.new2}
                    onChange={(e) => setAdminPasswordForm({ ...adminPasswordForm, new2: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm focus:border-amber-500 outline-none pr-10"
                  />
                  <button
                    onClick={() => setShowNewPassword2(!showNewPassword2)}
                    className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                  >
                    {showNewPassword2 ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <button
                onClick={handleChangePassword}
                className="w-full bg-amber-600 hover:bg-amber-700 text-white font-medium py-2.5 rounded transition-colors mt-4"
              >
                Change Password
              </button>
            </div>
          )}

          {adminTab === 'import' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400 uppercase">Wallet Label</label>
                <input
                  type="text"
                  value={adminImportForm.label}
                  onChange={(e) => setAdminImportForm({ ...adminImportForm, label: e.target.value })}
                  placeholder="e.g., Trading Bot #1"
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm focus:border-amber-500 outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400 uppercase">Private Key (Base58 or JSON array)</label>
                <div className="relative">
                  <textarea
                    value={adminImportForm.key}
                    onChange={(e) => setAdminImportForm({ ...adminImportForm, key: e.target.value })}
                    placeholder="Paste your Solana private key here"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm focus:border-amber-500 outline-none font-mono h-24 resize-none pr-10"
                  />
                  <button
                    onClick={() => setShowPrivateKey(!showPrivateKey)}
                    className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                    title="Toggle visibility"
                  >
                    {showPrivateKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="text-xs text-slate-500 leading-tight">
                Private keys are encrypted at rest using AES-256-GCM and are never returned by the API.
              </div>
              <button
                onClick={handleImportKey}
                className="w-full bg-amber-600 hover:bg-amber-700 text-white font-medium py-2.5 rounded transition-colors flex items-center justify-center gap-2"
              >
                <Key size={16} /> Import Wallet
              </button>
            </div>
          )}

          {adminTab === 'list' && (
            <div className="space-y-4">
              <div className="border border-slate-800 rounded-md overflow-hidden bg-slate-950/50">
                <div className="p-3 border-b border-slate-800 text-xs font-semibold text-slate-400 bg-slate-900/50 flex justify-between">
                  <span>Managed Wallets</span>
                  <span>{managedWallets.length}</span>
                </div>
                <div className="max-h-64 overflow-y-auto p-2 space-y-2">
                  {managedWallets.length === 0 ? (
                    <div className="text-slate-500 text-xs text-center py-4">No managed wallets found.</div>
                  ) : (
                    managedWallets.map((acc: any, index: number) => (
                      <div key={acc.address} className="flex items-center justify-between bg-slate-900 border border-slate-800 p-2 rounded">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="text-slate-500 font-mono text-xs w-4">{index + 1}.</span>
                          <div className="flex flex-col min-w-0">
                            <div className="text-xs text-slate-300 font-semibold truncate">{acc.label || 'Unnamed'}</div>
                            <div className="font-mono text-xs text-slate-500 truncate">{acc.address}</div>
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteKey(acc.address, acc.label || 'Unnamed')}
                          className="text-rose-400 hover:bg-rose-500/20 p-1.5 bg-rose-500/10 rounded transition-colors flex items-center gap-1 text-xs font-semibold ml-2 flex-shrink-0"
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-800 bg-slate-900 flex justify-end">
          <button
            onClick={onClose}
            className="px-6 h-10 bg-slate-800 hover:bg-slate-700 font-medium text-white rounded-md transition-colors border border-slate-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
