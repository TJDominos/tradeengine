import { Lock, Shield } from 'lucide-react';

import type { AuthStatus } from '../app/types';

type AuthInput = {
  username: string;
  password: string;
};

type AuthPanelProps = {
  auth: AuthStatus | null;
  onBootstrap: (input: AuthInput) => void;
  onLogin: (input: AuthInput) => void;
  submitting: string | null;
};

export default function AuthPanel({
  auth,
  onBootstrap,
  onLogin,
  submitting,
}: AuthPanelProps) {
  if (!auth) return null;

  if (auth.setupRequired) {
    return (
      <div className="mx-auto mt-10 max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3 text-white">
          <Shield className="text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold">Create the initial admin user</h1>
            <p className="mt-1 text-sm text-slate-400">
              Bootstrap is only available once. Passwords must be at least 12 characters.
            </p>
          </div>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const input = {
              username: String(data.get('username') ?? ''),
              password: String(data.get('password') ?? ''),
            };
            form.reset();
            onBootstrap(input);
          }}
        >
          <input
            name="username"
            className="h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-4 text-sm outline-none focus:border-blue-500"
            placeholder="Admin username"
          />
          <input
            name="password"
            className="h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-4 text-sm outline-none focus:border-blue-500"
            type="password"
            placeholder="Strong password"
          />
          <button
            type="submit"
            className="h-11 w-full rounded-md bg-emerald-600 font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            disabled={submitting != null}
          >
            {submitting === 'bootstrap' ? 'Creating admin...' : 'Create admin account'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-10 max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-sm">
      <div className="mb-6 flex items-center gap-3 text-white">
        <Lock className="text-blue-400" />
        <div>
          <h1 className="text-2xl font-bold">Admin login required</h1>
          <p className="mt-1 text-sm text-slate-400">
            The dashboard remains locked until an authenticated session is established.
          </p>
        </div>
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const input = {
            username: String(data.get('username') ?? ''),
            password: String(data.get('password') ?? ''),
          };
          form.reset();
          onLogin(input);
        }}
      >
        <input
          name="username"
          className="h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-4 text-sm outline-none focus:border-blue-500"
          placeholder="Username"
        />
        <input
          name="password"
          className="h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-4 text-sm outline-none focus:border-blue-500"
          type="password"
          placeholder="Password"
        />
        <button
          type="submit"
          className="h-11 w-full rounded-md bg-blue-600 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          disabled={submitting != null}
        >
          {submitting === 'login' ? 'Signing in...' : 'Log in'}
        </button>
      </form>
    </div>
  );
}