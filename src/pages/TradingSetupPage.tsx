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
    <div className="grid grid-cols-1 gap-6">
      <div className="h-fit space-y-5 rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm">
        <h3 className="flex items-center gap-2 border-b border-slate-800 pb-4 text-lg font-semibold">
          <Settings size={18} /> Strategy Editor
        </h3>

        <div className="space-y-4">
          <p className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
            Add a token below, then use the token registry to switch the active trading contract.
            Updating the active trading token never deletes historical transaction records.
          </p>

          <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4 text-sm text-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-blue-300">Active Version</p>
                <p className="mt-1 font-semibold text-white">
                  {activeStrategyVersionNo != null ? `v${activeStrategyVersionNo}` : 'Not published yet'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-blue-300">Status</p>
                <p className="mt-1 font-semibold text-white">{activeStrategyStatus ?? 'unknown'}</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
                Add Trading Token
              </label>
              <p className="text-xs text-slate-500">
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
                className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-blue-500"
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
                className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm outline-none focus:border-blue-500"
              />
              <button
                onClick={handleAddTrackedToken}
                disabled={submitting === 'token'}
                className="flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                <Plus size={14} /> Add Token
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
                  Tracked Token Registry
                </label>
                <p className="text-xs text-slate-500">
                  Activating a tracked token saves it immediately and starts loading market data. Save Configuration only applies to strategy settings.
                </p>
              </div>
              <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-400">
                {engineState.tradableTokens.length} tracked
              </span>
            </div>

            <div className="mt-3 space-y-2">
              {engineState.tradableTokens.length > 0 ? (
                engineState.tradableTokens.map((token) => (
                  <div key={token.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-slate-200">
                          {token.symbol ?? token.name ?? 'Tracked Token'}
                        </span>
                        <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                          {token.network}
                        </span>
                        {strategyDraft?.parameters.contractAddress === token.contractAddress ? (
                          <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-blue-300">
                            active
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate font-mono text-[11px] text-slate-500">
                        {token.contractAddress}
                      </div>
                    </div>
                    <button
                      onClick={() => void handleUseToken(token.contractAddress)}
                      disabled={submitting === 'use-token' || strategyDraft?.parameters.contractAddress === token.contractAddress}
                      className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-60"
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
                <div className="rounded-md border border-dashed border-slate-700 px-3 py-3 text-xs text-slate-500">
                  Add your first tracked token to save it as the active token automatically.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
                  Solana RPC Network
                </label>
                <p className="text-xs text-slate-500">
                  Solana requests try these custom endpoints first, then fall back to the worker environment and default mainnet RPC.
                </p>
              </div>
              <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-blue-300">
                {engineState.rpcEndpoints.length} custom RPC(s)
              </span>
            </div>

            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={rpcEndpointForm.url}
                onChange={(event) => setRpcEndpointForm({ url: event.target.value })}
                placeholder="https://solana-mainnet.rpc.example"
                className="h-10 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 font-mono text-sm outline-none focus:border-blue-500"
              />
              <button
                onClick={handleAddRpcEndpoint}
                disabled={submitting === 'rpc'}
                className="flex h-10 items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              >
                <Plus size={14} /> Add RPC
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {engineState.rpcEndpoints.length > 0 ? (
                engineState.rpcEndpoints.map((endpoint) => (
                  <div key={endpoint.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                        {endpoint.network}
                      </div>
                      <div className="truncate font-mono text-[11px] text-slate-500">{endpoint.url}</div>
                    </div>
                    <button
                      onClick={() => void handleDeleteRpcEndpoint(endpoint.id)}
                      disabled={submitting === `rpc-delete-${endpoint.id}`}
                      className="rounded-md border border-rose-500/20 bg-rose-500/10 p-2 text-rose-400 hover:bg-rose-500/20 disabled:opacity-60"
                      title="Remove RPC endpoint"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="rounded-md border border-dashed border-slate-700 px-3 py-3 text-xs text-slate-500">
                  No custom RPC endpoints yet. The worker will fall back to the environment/default mainnet RPC endpoint.
                </div>
              )}
            </div>
          </div>

          {strategyDraft ? (
            <StrategySchemaForm draft={strategyDraft} onChange={updateStrategyDraft} />
          ) : (
            <div className="rounded-md border border-dashed border-slate-700 px-3 py-3 text-xs text-slate-500">
              Strategy draft is loading.
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <button
            onClick={handleSaveConfig}
            disabled={submitting === 'settings'}
            className="h-11 w-full cursor-pointer rounded-md border border-blue-500 bg-blue-600 font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting === 'settings' ? 'Saving...' : 'Save and Activate Strategy Version'}
          </button>
        </div>
      </div>
    </div>
  );
}