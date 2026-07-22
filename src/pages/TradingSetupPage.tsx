import React from 'react';
import { Code, Plus, Settings, Trash2 } from 'lucide-react';

import type { EngineState, SettingsState, TokenMarketSnapshot, TradableToken } from '../app/types';
import SettingInput from '../components/SettingInput';

type TradingSetupPageProps = {
  engineState: EngineState;
  settings: SettingsState;
  tradableTokenForm: { network: string; contractAddress: string };
  setTradableTokenForm: React.Dispatch<React.SetStateAction<{ network: string; contractAddress: string }>>;
  rpcEndpointForm: { url: string };
  setRpcEndpointForm: React.Dispatch<React.SetStateAction<{ url: string }>>;
  submitting: string | null;
  handleAddTrackedToken: () => void;
  handleUseToken: (contractAddress: string) => void;
  handleAddRpcEndpoint: () => void;
  handleDeleteRpcEndpoint: (endpointId: number) => void;
  updateStrategySettings: (updater: (current: SettingsState) => SettingsState) => void;
  handleSaveConfig: () => void;
  tradingAlgorithm: string;
  setTradingAlgorithm: React.Dispatch<React.SetStateAction<string>>;
  onPersistAlgorithm: () => void;
  onOpenSimulation: () => void;
};

export default function TradingSetupPage({
  engineState,
  settings,
  tradableTokenForm,
  setTradableTokenForm,
  rpcEndpointForm,
  setRpcEndpointForm,
  submitting,
  handleAddTrackedToken,
  handleUseToken,
  handleAddRpcEndpoint,
  handleDeleteRpcEndpoint,
  updateStrategySettings,
  handleSaveConfig,
  tradingAlgorithm,
  setTradingAlgorithm,
  onPersistAlgorithm,
  onOpenSimulation,
}: TradingSetupPageProps) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div className="h-fit space-y-5 rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm">
        <h3 className="flex items-center gap-2 border-b border-slate-800 pb-4 text-lg font-semibold">
          <Settings size={18} /> Trading Parameters
        </h3>

        <div className="space-y-4">
          <p className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
            Add a token below, then use the token registry to switch the active trading contract.
            Updating the active trading token never deletes historical transaction records.
          </p>

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
                        {settings.contractAddress === token.contractAddress ? (
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
                      disabled={submitting === 'use-token' || settings.contractAddress === token.contractAddress}
                      className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-60"
                    >
                      {settings.contractAddress === token.contractAddress
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

          <SettingInput
            label="Time Range Target"
            sublabel="Target Pre-Condition"
            value={settings.timeRangeTarget}
            onChange={(value) => updateStrategySettings((current) => ({ ...current, timeRangeTarget: value }))}
            options={[
              { label: '1 Hour', value: '1h' },
              { label: '6 Hours', value: '6h' },
              { label: '12 Hours', value: '12h' },
              { label: '24 Hours', value: '24h' },
              { label: '3 Days', value: '3d' },
              { label: '1 Week', value: '1w' },
            ]}
          />

          <div className="grid grid-cols-2 gap-4">
            <SettingInput label="Max Transactions" sublabel="Time Range Limit" value={settings.maxTransactions} onChange={(value) => updateStrategySettings((current) => ({ ...current, maxTransactions: Number(value) }))} />
            <SettingInput label="Max Slippage" sublabel="Min 0.0001" value={settings.maxSlippage} onChange={(value) => updateStrategySettings((current) => ({ ...current, maxSlippage: Number(value) }))} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <SettingInput label="Volume Target (USDC)" value={settings.volumeTarget} onChange={(value) => updateStrategySettings((current) => ({ ...current, volumeTarget: Number(value) }))} />
            <SettingInput label="Net Buyin Target" sublabel="Negative = Sell" value={settings.netBuyinTarget} onChange={(value) => updateStrategySettings((current) => ({ ...current, netBuyinTarget: Number(value) }))} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <SettingInput label="Volatility Target (%)" value={settings.volatilityTarget} onChange={(value) => updateStrategySettings((current) => ({ ...current, volatilityTarget: Number(value) }))} />
            <SettingInput label="Outsider Pull Back (%)" value={settings.pullbackTarget} onChange={(value) => updateStrategySettings((current) => ({ ...current, pullbackTarget: Number(value) }))} />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
              Strategy Notes
            </label>
            <textarea
              value={settings.strategyNotes}
              onChange={(event) => updateStrategySettings((current) => ({ ...current, strategyNotes: event.target.value }))}
              className="min-h-28 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <button
            onClick={handleSaveConfig}
            disabled={submitting === 'settings'}
            className="h-11 w-full cursor-pointer rounded-md border border-blue-500 bg-blue-600 font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting === 'settings' ? 'Saving...' : 'Save Strategy Configuration'}
          </button>
        </div>
      </div>

      <div className="flex min-h-[500px] flex-col rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm">
        <h3 className="flex items-center gap-2 border-b border-slate-800 pb-4 text-lg font-semibold">
          <Code size={18} /> Trading Algorithm (Cloudflare + Helius)
        </h3>
        <textarea
          className="mt-4 flex-1 resize-none rounded-md border border-slate-700 bg-slate-950 p-4 font-mono text-[13px] leading-relaxed text-emerald-400 outline-none focus:border-blue-500"
          value={tradingAlgorithm}
          onChange={(event) => setTradingAlgorithm(event.target.value)}
          placeholder="// Write your trading algorithm logic here"
        ></textarea>
        <div className="mt-4 flex gap-3 border-t border-slate-800 pt-4">
          <button
            onClick={onPersistAlgorithm}
            className="h-10 flex-1 cursor-pointer rounded-md bg-emerald-600 font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            Update
          </button>
          <button
            onClick={onOpenSimulation}
            className="h-10 flex-1 cursor-pointer rounded-md border border-slate-700 bg-slate-800 font-medium text-white shadow-sm hover:bg-slate-700"
          >
            Simulation Summary
          </button>
        </div>
      </div>
    </div>
  );
}