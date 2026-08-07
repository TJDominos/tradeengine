import React from 'react';
import { Plus, Settings, Trash2 } from 'lucide-react';

import type { EngineState, StrategyVersionDocument } from '../app/types';
import StrategySchemaForm from '../components/StrategySchemaForm';

type TradingSetupPageProps = {
  engineState: EngineState;
  strategyDraft: StrategyVersionDocument | null;
  tradableTokenForm: { network: string; contractAddress: string };
  setTradableTokenForm: React.Dispatch<React.SetStateAction<{ network: string; contractAddress: string }>>;
  rpcEndpointForm: { url: string };
  setRpcEndpointForm: React.Dispatch<React.SetStateAction<{ url: string }>>;
  submitting: string | null;
  handleAddTrackedToken: () => void;
  handleUseToken: (contractAddress: string) => void;
  handleAddRpcEndpoint: () => void;
  handleDeleteRpcEndpoint: (endpointId: number) => void;
  updateStrategyDraft: (updater: (current: StrategyVersionDocument) => StrategyVersionDocument) => void;
  handleSaveConfig: () => void;
  activeStrategyVersionNo: number | null;
  activeStrategyStatus: string | null;
};

export default function TradingSetupPage({
  engineState,
  strategyDraft,
  tradableTokenForm,
  setTradableTokenForm,
  rpcEndpointForm,
  setRpcEndpointForm,
  submitting,
  handleAddTrackedToken,
  handleUseToken,
  handleAddRpcEndpoint,
  handleDeleteRpcEndpoint,
  updateStrategyDraft,
  handleSaveConfig,
  activeStrategyVersionNo,
  activeStrategyStatus,
}: TradingSetupPageProps) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-700 bg-slate-900/95 p-6 shadow-xl shadow-slate-950/20">
        <div className="flex flex-col gap-4 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-semibold text-white">
              <Settings size={20} /> Trading Setup
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
              Manage tracked trading contracts, configure RPC failover, and deploy macro-objective strategy drafts from a single dark-theme workspace.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:min-w-[320px]">
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.18em] text-blue-300">Active Version</p>
              <p className="mt-2 text-lg font-semibold text-white">
                {activeStrategyVersionNo != null ? `v${activeStrategyVersionNo}` : 'Draft only'}
              </p>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Status</p>
              <p className="mt-2 text-lg font-semibold text-white">{activeStrategyStatus ?? 'unknown'}</p>
            </div>
          </div>
        </div>

        <p className="mt-5 rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3 text-sm leading-relaxed text-slate-300">
          Activate tracked tokens from the registry to swap the live contract without losing historical logs. Saving or deploying the strategy only affects the current strategy draft.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="rounded-2xl border border-slate-700 bg-slate-800/70 p-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                Add Trading Token
              </label>
              <p className="text-sm text-slate-500">
                Add tracked tokens explicitly with separate network and contract address fields.
              </p>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[150px_minmax(0,1fr)_auto]">
              <select
                value={tradableTokenForm.network}
                onChange={(event) =>
                  setTradableTokenForm((current) => ({
                    ...current,
                    network: event.target.value,
                  }))
                }
                className="h-11 rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="solana">Solana</option>
              </select>
              <input
                type="text"
                value={tradableTokenForm.contractAddress}
                onChange={(event) =>
                  setTradableTokenForm((current) => ({
                    ...current,
                    contractAddress: event.target.value,
                  }))
                }
                placeholder="Token contract address"
                className="h-11 rounded-xl border border-slate-700 bg-slate-900 px-3 font-mono text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
              />
              <button
                onClick={handleAddTrackedToken}
                disabled={submitting === 'token'}
                className="flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
              >
                <Plus size={14} /> Add Token
              </button>
            </div>

            <div className="mt-5 flex items-start justify-between gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                  Tracked Token Registry
                </label>
                <p className="text-sm text-slate-500">
                  Activating a tracked token saves it immediately and starts loading market data. Strategy deployment does not overwrite the registry.
                </p>
              </div>
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-300">
                {engineState.tradableTokens.length} tracked
              </span>
            </div>

            <div className="mt-3 space-y-2">
              {engineState.tradableTokens.length > 0 ? (
                engineState.tradableTokens.map((token) => (
                  <div key={token.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          {token.symbol ?? token.name ?? 'Tracked Token'}
                        </span>
                        <span className="rounded-full bg-slate-700 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                          {token.network}
                        </span>
                        {strategyDraft?.parameters.contractAddress === token.contractAddress ? (
                          <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-blue-300">
                            active
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-slate-500">
                        {token.contractAddress}
                      </div>
                    </div>
                    <button
                      onClick={() => void handleUseToken(token.contractAddress)}
                      disabled={submitting === 'use-token' || strategyDraft?.parameters.contractAddress === token.contractAddress}
                      className="rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
                    >
                      {strategyDraft?.parameters.contractAddress === token.contractAddress
                        ? 'Active'
                        : submitting === 'use-token'
                          ? 'Activating...'
                          : 'Use'}
                    </button>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-slate-700 px-4 py-4 text-sm text-slate-500">
                  Add your first tracked token to save it as the active token automatically.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-700 bg-slate-800/70 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                  Solana RPC Network
                </label>
                <p className="text-sm text-slate-500">
                  Solana requests try these custom endpoints first, then fall back to the worker environment and default mainnet RPC.
                </p>
              </div>
              <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-blue-300">
                {engineState.rpcEndpoints.length} custom RPC(s)
              </span>
            </div>

            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={rpcEndpointForm.url}
                onChange={(event) => setRpcEndpointForm({ url: event.target.value })}
                placeholder="https://solana-mainnet.rpc.example"
                className="h-11 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 font-mono text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
              />
              <button
                onClick={handleAddRpcEndpoint}
                disabled={submitting === 'rpc'}
                className="flex h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
              >
                <Plus size={14} /> Add RPC
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {engineState.rpcEndpoints.length > 0 ? (
                engineState.rpcEndpoints.map((endpoint) => (
                  <div key={endpoint.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">
                        {endpoint.network}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-slate-500">{endpoint.url}</div>
                    </div>
                    <button
                      onClick={() => void handleDeleteRpcEndpoint(endpoint.id)}
                      disabled={submitting === `rpc-delete-${endpoint.id}`}
                      className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-2 text-rose-400 transition hover:bg-rose-500/20 disabled:opacity-60"
                      title="Remove RPC endpoint"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-slate-700 px-4 py-4 text-sm text-slate-500">
                  No custom RPC endpoints yet. The worker will fall back to the environment/default mainnet RPC endpoint.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6">
          {strategyDraft ? (
            <StrategySchemaForm
              draft={strategyDraft}
              onChange={updateStrategyDraft}
              onSubmit={handleSaveConfig}
              isSubmitting={submitting === 'settings'}
              activeStrategyVersionNo={activeStrategyVersionNo}
              activeStrategyStatus={activeStrategyStatus}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-slate-700 px-4 py-4 text-sm text-slate-500">
              Strategy draft is loading.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}