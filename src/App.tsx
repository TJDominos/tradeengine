// WLT Execution Engine - Main Dashboard Component
import React, { useState, useEffect } from 'react';
import { 
  Activity, Wallet, RefreshCw, TrendingUp, TrendingDown, 
  Settings, Users, Clock, Calendar, CheckSquare, 
  Square, Trash2, Plus, Code, Lock, Search, FileText, ChevronLeft, ChevronRight, Server
} from 'lucide-react';

const CONTRACT_ADDRESS = "WLTxyz789ABCdefGHIjklMNOpqrSTUvwxYZ1234567";
const TOTAL_WLT_SUPPLY = 1000000000; // 1 Billion

const workerAlgorithmTemplate = `// --- SERVERLESS TRADING ENGINE (Cloudflare Worker) ---
// Triggered by Helius Webhooks on contract activity.
// 0 idle compute costs. Executes only when a relevant Tx happens.

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    
    // 1. Parse Helius Webhook Payload (Enriched Transactions)
    const txs = await request.json();

    for (const tx of txs) {
      console.log(\`Analyzing Tx: \${tx.signature}\`);
      
      // 2. Look for large Outsider Swaps (Whale Detection)
      const isLargeBuy = tx.events?.swap?.nativeInput?.amount > 1_000_000_000; // >1000 USDC
      
      if (isLargeBuy) {
        // 3. Trigger Pullback Strategy
        ctx.waitUntil(executePullback(env, 0.02)); // Run asynchronously in background
      }
      
      // 4. Check Volatility Bounds
      // ... logic to query pool price and compare to MA ...
    }

    // Acknowledge receipt to Helius super fast (under 200ms)
    return new Response('OK', { status: 200 });
  }
};

async function executePullback(env, percentage) {
  const connection = new Connection(env.RPC_URL);
  const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(env.BOT_SECRET_KEY)));
  
  console.log(\`Executing \${percentage * 100}% pull back...\`);
  // Build swap transaction, sign with bot wallet, and send via RPC
  // ...
}
`;

// --- FORMATTERS ---
const formatUSD = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
const formatNum = (val) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(val);

// --- REUSABLE COMPONENTS ---
const DateRangePicker = ({ dateRange, setDateRange, hasDateRange, children }: any) => (
  <div className="flex flex-wrap gap-6 items-end bg-slate-900/50 p-5 rounded-xl border border-slate-800 shadow-sm w-full">
    <div className="flex flex-wrap gap-4 items-end">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">From Date</label>
        <input 
          type="date" 
          value={dateRange.from}
          className="h-10 w-[160px] rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 [&::-webkit-calendar-picker-indicator]:invert-[0.8] [&::-webkit-calendar-picker-indicator]:opacity-70 hover:[&::-webkit-calendar-picker-indicator]:opacity-100 cursor-pointer" 
          onChange={(e) => setDateRange({...dateRange, from: e.target.value})} 
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">To Date</label>
        <input 
          type="date" 
          value={dateRange.to}
          className="h-10 w-[160px] rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 [&::-webkit-calendar-picker-indicator]:invert-[0.8] [&::-webkit-calendar-picker-indicator]:opacity-70 hover:[&::-webkit-calendar-picker-indicator]:opacity-100 cursor-pointer" 
          onChange={(e) => setDateRange({...dateRange, to: e.target.value})} 
        />
      </div>
      {hasDateRange && (
        <div className="h-10 flex items-center text-xs font-medium text-emerald-400 bg-emerald-500/10 px-3 rounded-md border border-emerald-500/20">
          <CheckSquare size={14} className="mr-1.5" /> Difference metrics active
        </div>
      )}
    </div>
    {children && (
      <div className="flex-1 flex justify-end min-w-[300px]">
        {children}
      </div>
    )}
  </div>
);

const Pagination = ({ currentPage, totalItems, itemsPerPage, onPageChange }: any) => {
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (totalPages <= 1) return null;
  
  const indexOfFirstLog = (currentPage - 1) * itemsPerPage;
  const indexOfLastLog = Math.min(currentPage * itemsPerPage, totalItems);

  return (
    <div className="p-3 border-t border-slate-800 bg-slate-900/50 flex justify-between items-center text-sm">
      <span className="text-slate-500 text-xs">
        Showing {indexOfFirstLog + 1} to {indexOfLastLog} of {totalItems} entries
      </span>
      <div className="flex gap-1">
        <button 
          onClick={() => onPageChange(Math.max(currentPage - 1, 1))}
          disabled={currentPage === 1}
          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-slate-300 transition-colors cursor-pointer flex items-center gap-1"
        >
          <ChevronLeft size={14} /> Prev
        </button>
        <span className="px-3 py-1 text-slate-400 text-xs font-medium flex items-center">
          {currentPage} / {totalPages}
        </span>
        <button 
          onClick={() => onPageChange(Math.min(currentPage + 1, totalPages))}
          disabled={currentPage === totalPages}
          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-slate-300 transition-colors cursor-pointer flex items-center gap-1"
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
};

const SummaryBlock = ({ title, icon, data }: any) => (
  <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-sm space-y-4">
    <h3 className="font-semibold flex items-center gap-2 text-slate-200 border-b border-slate-800 pb-2">
      {icon} {title}
    </h3>
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
      <div>
        <p className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">Accts w/ Assets (&gt;$1)</p>
        <p className="text-lg font-bold text-white">{data.activeAssets} <span className="text-xs text-slate-500 font-normal">/ {data.total}</span></p>
      </div>
      <div>
        <p className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">Total WLT Amount</p>
        <p className="text-lg font-bold text-amber-400">{formatNum(data.totalWlt)} <span className="text-xs text-slate-500 font-normal">({data.fdvPct}%)</span></p>
      </div>
      <div>
        <p className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">Total USDC Bal</p>
        <p className="text-lg font-bold text-blue-400">{formatUSD(data.totalUsdc)}</p>
      </div>
      <div>
        <p className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">USDC Deposit</p>
        <p className="text-lg font-bold text-slate-200">{formatUSD(data.totalDeposit)}</p>
      </div>
      <div>
        <p className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">Profit Amount</p>
        <p className={`text-lg font-bold ${data.totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {formatUSD(data.totalProfit)}
        </p>
      </div>
      <div>
        <p className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">USDC Withdraw</p>
        <p className="text-lg font-bold text-rose-400">-{formatUSD(data.usdcWithdraw)}</p>
      </div>
      <div>
        <p className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">WLT Withdraw</p>
        <p className="text-lg font-bold text-rose-400">-{formatNum(data.wltWithdraw)}</p>
      </div>
    </div>
  </div>
);

function TabButton({ active, onClick, icon, label }: any) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-sm px-4 py-1.5 text-sm font-medium transition-all cursor-pointer ${
        active 
          ? 'bg-slate-800 text-slate-100 shadow-sm' 
          : 'hover:bg-slate-800/50 hover:text-slate-300'
      }`}
    >
      <span className="flex items-center gap-2">
        {icon} {label}
      </span>
    </button>
  );
}

function StatCard({ title, value, diff, hasRange, copyable, negative, isAddress }: any) {
  return (
    <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-sm hover:border-slate-700 transition-colors overflow-hidden">
      <p className="text-slate-400 text-xs font-semibold mb-2 uppercase tracking-wider">{title}</p>
      <div className="flex items-end justify-between mt-1">
        <h2 className={`font-bold ${
            isAddress 
              ? 'text-blue-400 font-mono text-[13px] break-all leading-relaxed' 
            : copyable 
              ? 'text-blue-400 font-mono text-[22px] cursor-pointer hover:text-blue-300' 
            : 'text-2xl text-white'
          }`}
        >
          {value}
        </h2>
      </div>
      {hasRange && diff && (
        <div className="mt-4 pt-3 border-t border-slate-800 flex justify-between items-center">
          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Diff</span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${negative ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
            {diff}
          </span>
        </div>
      )}
    </div>
  );
}

// --- MAIN APP ---
export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [engineState, setEngineState] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(new Date().toLocaleTimeString());
  
  // Shared States
  const [dateRange, setDateRange] = useState({ from: '', to: '' });
  const hasDateRange = dateRange.from !== '' && dateRange.to !== '';

  // Accounts Tab States
  const [accountSearchTerm, setAccountSearchTerm] = useState('');
  const [internalPage, setInternalPage] = useState(1);
  const [outsiderPage, setOutsiderPage] = useState(1);
  
  // Log Tab States
  const [logSearchTerm, setLogSearchTerm] = useState('');
  const [logCurrentPage, setLogCurrentPage] = useState(1);
  
  // Settings Tab Forms
  const [volTarget, setVolTarget] = useState('4.5');
  const [pullbackTarget, setPullbackTarget] = useState('2.0');
  const [secretName, setSecretName] = useState('');
  const [contractAddress, setContractAddress] = useState('WLTxyz789ABCdefGHIjklMNOpqrSTUvwxYZ1234567');
  const [workerUrl, setWorkerUrl] = useState('');
  
  const ITEMS_PER_PAGE = 50;

  // --- BACKEND DATA POLLING ---
  const fetchState = async () => {
    try {
      const endpoint = workerUrl ? `${workerUrl.replace(/\/$/, "")}/api/state` : '/api/state';
      const res = await fetch(endpoint);
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error("Received non-JSON response from /api/state");
      }
      const data = await res.json();
      setEngineState(data);
      if (data.settings) {
         setContractAddress(data.settings.contractAddress || contractAddress);
      }
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      console.error("Failed to fetch engine state", e);
    }
  };

  useEffect(() => {
    fetchState();
    // Poll the backend every 3 seconds to simulate a live trading terminal
    const interval = setInterval(fetchState, 3000);
    return () => clearInterval(interval);
  }, [workerUrl]);

  const handleRefresh = () => {
    fetchState();
  };

  const handleSaveConfig = async () => {
    try {
      const endpoint = workerUrl ? `${workerUrl.replace(/\/$/, "")}/api/settings` : '/api/settings';
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          volatilityTarget: volTarget,
          pullbackTarget: pullbackTarget,
          secret: secretName,
          contractAddress: contractAddress
        })
      });
      alert('Strategy Configuration Updated and Deployed');
      setSecretName(''); // Clear out after deploy
      fetchState();     // Refresh standard dashboard state
    } catch (e) {
      console.error(e);
      alert('Error saving config');
    }
  };

  if (!engineState) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-4">
        <Server className="animate-pulse" size={32} />
        <p className="font-mono uppercase tracking-wider text-sm">Initializing WLT Core Engine...</p>
      </div>
    );
  }

  // --- TAB 1: DASHBOARD ---
  const renderDashboard = () => {
    const totalInternalWLT = engineState.internalAccs.reduce((acc, curr) => acc + curr.wlt, 0);
    const totalProfit = engineState.internalAccs.reduce((acc, curr) => acc + curr.profit, 0);
    const internalFdvPct = ((totalInternalWLT / engineState.stats.totalWlt) * 100).toFixed(2);

    return (
      <div className="space-y-6">
        <DateRangePicker dateRange={dateRange} setDateRange={setDateRange} hasDateRange={hasDateRange} />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          <StatCard title="Contract Address" value={CONTRACT_ADDRESS} copyable isAddress />
          <StatCard title="Total WLT Amount (Internal)" value={`${formatNum(totalInternalWLT)} (${internalFdvPct}%)`} diff="+0.02%" hasRange={hasDateRange} />
          <StatCard title="Profit (USDC)" value={formatUSD(totalProfit)} diff={formatUSD(450.20)} hasRange={hasDateRange} />
          <StatCard 
            title="FDV" 
            value={formatUSD(engineState.stats.fdv)} 
            diff="+$12.5k" 
            hasRange={hasDateRange} 
          />
          <StatCard 
            title="Price: WLT (Live)" 
            value={formatNum(engineState.stats.price)} 
            diff="+0.0001" 
            hasRange={hasDateRange} 
          />
          <StatCard title="Liquidity (USDC)" value={formatUSD(engineState.stats.liqUsdc)} diff="-$1.2k" hasRange={hasDateRange} negative />
          <StatCard title="Total Outsiders (>$1)" value={engineState.stats.totalOutsiders} diff="+4" hasRange={hasDateRange} />
        </div>
      </div>
    );
  };

  // --- TAB 2: ACCOUNTS ---
  const renderAccounts = () => {
    // 1. Filtering Logic (Global Search across both tables)
    const filteredInternal = engineState.internalAccs.filter(acc => 
      acc.address.toLowerCase().includes(accountSearchTerm.toLowerCase()) ||
      acc.tag.toLowerCase().includes(accountSearchTerm.toLowerCase())
    );
    const filteredOutsider = engineState.outsiderAccs.filter(acc => 
      acc.address.toLowerCase().includes(accountSearchTerm.toLowerCase()) ||
      acc.tag.toLowerCase().includes(accountSearchTerm.toLowerCase())
    );

    // 2. Pagination Slices
    const internalCurrentSlice = filteredInternal.slice((internalPage - 1) * ITEMS_PER_PAGE, internalPage * ITEMS_PER_PAGE);
    const outsiderCurrentSlice = filteredOutsider.slice((outsiderPage - 1) * ITEMS_PER_PAGE, outsiderPage * ITEMS_PER_PAGE);

    // 3. Summaries Calculation
    const calcSummary = (accs) => {
      // Active assets 
      const activeAssets = accs.filter(a => a.wlt > 0 || a.usdc > 0).length;
      const totalWlt = accs.reduce((sum, a) => sum + (a.wlt || 0), 0);
      return {
        total: accs.length,
        activeAssets,
        totalWlt,
        fdvPct: ((totalWlt / engineState.stats.totalWlt) * 100).toFixed(2),
        totalUsdc: accs.reduce((sum, a) => sum + (a.usdc || 0), 0),
        totalDeposit: accs.reduce((sum, a) => sum + (a.deposit || a.usdcBuyin || 0), 0),
        totalProfit: accs.reduce((sum, a) => sum + (a.profit || 0), 0),
        usdcWithdraw: accs.reduce((sum, a) => sum + (a.usdcWithdraw || 0), 0),
        wltWithdraw: accs.reduce((sum, a) => sum + (a.wltWithdraw || 0), 0),
      };
    };

    const internalSummary = calcSummary(engineState.internalAccs);
    const outsiderSummary = calcSummary(engineState.outsiderAccs);

    return (
      <div className="space-y-6">
        {/* Date Filter & Injected Global Search on Same Row */}
        <DateRangePicker dateRange={dateRange} setDateRange={setDateRange} hasDateRange={hasDateRange}>
          <div className="flex flex-col gap-1.5 w-full md:w-[400px]">
             <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Global Address Search</label>
             <div className="relative">
               <Search size={16} className="absolute left-3 top-2.5 text-slate-500" />
               <input 
                 type="text" 
                 placeholder="Search by wallet address or tag across all accounts..." 
                 value={accountSearchTerm}
                 onChange={(e) => {
                   setAccountSearchTerm(e.target.value);
                   setInternalPage(1);
                   setOutsiderPage(1);
                 }}
                 className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md pl-9 pr-3 text-sm focus:border-blue-500 outline-none transition-colors" 
               />
             </div>
          </div>
        </DateRangePicker>

        {/* Summaries */}
        <SummaryBlock title="Internal Account Summary" icon={<Wallet size={16} className="text-blue-400"/>} data={internalSummary} />
        <SummaryBlock title="Outsider Account Summary" icon={<Users size={16} className="text-amber-400"/>} data={outsiderSummary} />

        {/* Internal Accounts Table */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/80">
            <h3 className="font-semibold flex items-center gap-2 text-slate-200">
              <Wallet size={16} className="text-blue-400"/> Internal Account List 
              <span className="bg-slate-800 text-xs px-2 py-0.5 rounded text-slate-400">{filteredInternal.length} found</span>
            </h3>
          </div>
          <div className="overflow-x-auto min-h-[300px]">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="px-4 py-3 font-medium">Trading</th>
                  <th className="px-4 py-3 font-medium">Tag</th>
                  <th className="px-4 py-3 font-medium">Wallet / Address</th>
                  <th className="px-4 py-3 font-medium text-right text-blue-400">USDC Bal</th>
                  <th className="px-4 py-3 font-medium text-right text-purple-400">SOL Bal</th>
                  <th className="px-4 py-3 font-medium text-right text-amber-400">WLT Bal</th>
                  <th className="px-4 py-3 font-medium text-right">Profit/Loss (USDC)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {internalCurrentSlice.map((acc, i) => (
                  <tr key={`${acc.id}-${i}`} className={`hover:bg-slate-800/50 transition-colors ${acc.selected ? 'bg-blue-500/5' : ''}`}>
                    <td className="px-4 py-2 font-medium text-xs">
                      <input 
                        type="checkbox" 
                        checked={acc.selected} 
                        onChange={async () => {
                          const res = await fetch('/api/toggleAccount', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: acc.id })
                          });
                          const data = await res.json();
                          setEngineState(data);
                        }}
                        className="cursor-pointer appearance-none w-4 h-4 rounded border border-slate-600 checked:bg-blue-500 checked:border-blue-500 flex items-center justify-center relative after:content-[''] after:absolute after:w-[3px] after:h-[7px] after:border-r-2 after:border-b-2 after:border-white after:rotate-45 after:-mt-0.5 checked:after:block after:hidden"
                      />
                    </td>
                    <td className="px-4 py-2 font-bold text-xs">{acc.tag}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">
                      <span className="bg-slate-800 text-slate-200 px-1.5 py-0.5 rounded mr-2 border border-slate-700">{acc.wallet}</span>
                      {acc.address}
                    </td>
                    <td className="px-4 py-2 text-right font-medium text-xs">{formatUSD(acc.usdc)}</td>
                    <td className="px-4 py-2 text-right font-medium text-xs">{formatNum(acc.sol)}</td>
                    <td className="px-4 py-2 text-right font-mono font-medium text-amber-400 text-xs">{formatNum(acc.wlt)}</td>
                    <td className={`px-4 py-2 text-right font-medium text-xs ${acc.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {formatUSD(acc.profit)}
                    </td>
                  </tr>
                ))}
                {internalCurrentSlice.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-slate-500">No internal accounts found.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination currentPage={internalPage} totalItems={filteredInternal.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setInternalPage} />
        </div>
      </div>
    );
  };

  // --- TAB 3: TRADING SETUP ---
  const renderSetup = () => (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5 shadow-sm h-fit">
        <h3 className="font-semibold flex items-center gap-2 border-b border-slate-800 pb-4 text-lg"><Settings size={18}/> Trading Parameters</h3>
        
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">Trading Contract Address</label>
            <input 
              type="text" 
              value={contractAddress} 
              onChange={(e) => setContractAddress(e.target.value)} 
              className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md px-3 text-sm font-mono focus:border-blue-500 outline-none transition-colors" 
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">Cloudflare Worker API URL (Optional)</label>
            <input 
              type="text" 
              value={workerUrl} 
              onChange={(e) => setWorkerUrl(e.target.value)} 
              placeholder="e.g. https://solana-bot.<yourname>.workers.dev"
              className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md px-3 text-sm font-mono focus:border-blue-500 outline-none transition-colors" 
            />
            <p className="text-[10px] text-slate-500 mt-1">If provided, this dashboard acts as a frontend to your deployed Worker.</p>
          </div>
          
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">Solana RPC Network</label>
            <div className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md px-3 flex items-center text-sm font-mono text-blue-400 transition-colors">
               {engineState?.settings?.rpcUrl || 'Mainnet RPC Pool Active'}
            </div>
          </div>
          
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 flex justify-between uppercase tracking-wider">
              Secret or Env Var Name
              <span className="text-blue-400 text-[10px] normal-case bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">{engineState?.settings?.secretLoaded ? `Loaded (${engineState.settings.secretName})` : 'Not Loaded'}</span>
            </label>
            <div className="relative">
              <input 
                 type="password" 
                 value={secretName}
                 onChange={(e) => setSecretName(e.target.value)}
                 placeholder={engineState?.settings?.secretLoaded ? "Enter to replace Key / Env Var" : "Paste Base58, JSON Array, or ENV Name"} 
                 className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md px-3 text-sm font-mono focus:border-blue-500 outline-none transition-colors" 
              />
              <Lock size={14} className="absolute right-3 top-3 text-slate-500" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">Dev Target (USDC)</label>
              <input type="text" defaultValue="500,000" className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md px-3 text-sm focus:border-blue-500 outline-none transition-colors" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">
                Net Buyin Target
                <span className="normal-case text-[10px] text-slate-500 ml-1.5 bg-slate-800 px-1.5 py-0.5 rounded">(Negative = Sell)</span>
              </label>
              <input type="text" defaultValue="50,000" className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md px-3 text-sm focus:border-blue-500 outline-none transition-colors" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">Volatility Target (%)</label>
              <input 
                 type="text" 
                 value={volTarget} 
                 onChange={(e) => setVolTarget(e.target.value)}
                 className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md px-3 text-sm focus:border-blue-500 outline-none transition-colors" 
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">Outsider Pull Back (%)</label>
              <input 
                 type="text" 
                 value={pullbackTarget} 
                 onChange={(e) => setPullbackTarget(e.target.value)}
                 className="w-full h-10 bg-slate-950 border border-slate-700 rounded-md px-3 text-sm focus:border-blue-500 outline-none transition-colors" 
              />
            </div>
          </div>
        </div>

        <button onClick={handleSaveConfig} className="w-full mt-4 h-11 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-md transition-colors shadow-sm cursor-pointer">
          Deploy Engine Configuration
        </button>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col shadow-sm min-h-[500px]">
        <h3 className="font-semibold flex items-center gap-2 border-b border-slate-800 pb-4 text-lg"><Code size={18}/> Trading Algorithm (Cloudflare + Helius)</h3>
        <textarea 
          className="w-full flex-1 mt-4 bg-slate-950 border border-slate-700 rounded-md p-4 text-[13px] font-mono leading-relaxed text-emerald-400 focus:border-blue-500 outline-none resize-none transition-colors"
          defaultValue={workerAlgorithmTemplate}
        ></textarea>
      </div>
    </div>
  );

  // --- TAB 4: TRANSACTION LOGS ---
  const renderLogs = () => {
    const filteredLogs = engineState.logs.filter(log => 
      log.address.toLowerCase().includes(logSearchTerm.toLowerCase()) || 
      log.tag.toLowerCase().includes(logSearchTerm.toLowerCase()) ||
      log.status.toLowerCase().includes(logSearchTerm.toLowerCase())
    );

    const currentLogs = filteredLogs.slice((logCurrentPage - 1) * ITEMS_PER_PAGE, logCurrentPage * ITEMS_PER_PAGE);

    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-sm">
        <div className="p-4 border-b border-slate-800 bg-slate-900/80 flex justify-between items-center">
          <h3 className="font-semibold flex items-center gap-2 text-lg">
             <FileText size={18}/> Live Network Activity Log
             <span className="flex items-center gap-1.5 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full ml-4 font-mono">
               <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> LIVE
             </span>
          </h3>
          <div className="flex gap-2">
             <div className="relative">
               <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
               <input 
                 type="text" 
                 placeholder="Search logs..." 
                 value={logSearchTerm}
                 onChange={(e) => {
                   setLogSearchTerm(e.target.value);
                   setLogCurrentPage(1);
                 }}
                 className="bg-slate-950 border border-slate-700 rounded-md pl-8 pr-3 py-1.5 text-sm focus:border-blue-500 outline-none w-64" 
               />
             </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap min-h-[400px]">
            <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Address</th>
                <th className="px-4 py-2 font-medium">Strategy</th>
                <th className="px-4 py-2 font-medium text-right">WLT Amount</th>
                <th className="px-4 py-2 font-medium text-right">USDC Amount</th>
                <th className="px-4 py-2 font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {currentLogs.map((log, idx) => {
                const isWltPositive = log.wlt.startsWith('+');
                const isUsdcPositive = log.usdc.startsWith('+');
                return (
                  <tr key={`${log.id}-${idx}`} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-4 py-1.5 text-slate-400 text-xs">{log.date}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-slate-500">{log.address.substring(0,20)}...</td>
                    <td className="px-4 py-1.5 font-bold text-xs text-slate-200">{log.tag}</td>
                    <td className={`px-4 py-1.5 text-right font-mono text-xs ${isWltPositive ? 'text-emerald-400' : 'text-rose-400'}`}>{log.wlt}</td>
                    <td className={`px-4 py-1.5 text-right font-mono text-xs ${isUsdcPositive ? 'text-emerald-400' : 'text-rose-400'}`}>{log.usdc}</td>
                    <td className="px-4 py-1.5 text-center">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-semibold border inline-flex items-center gap-1 ${
                        log.status === 'confirmed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                      }`}>
                        {log.status === 'confirmed' && <CheckSquare size={10} />}
                        {log.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {currentLogs.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-slate-500 text-sm">No activity recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <Pagination currentPage={logCurrentPage} totalItems={filteredLogs.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setLogCurrentPage} />
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans p-4 md:p-6 flex flex-col">
      
      {/* Top Navigation & Status */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2 tracking-tight">
            <Activity className="text-blue-500" /> WLT Execution Engine
          </h1>
          <p className="text-slate-400 text-sm mt-1.5 flex items-center gap-2">
            <span className="font-mono text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">{CONTRACT_ADDRESS}</span>
            <span className="text-slate-700">|</span>
            <Clock size={14} /> Time Updated: {lastUpdated}
          </p>
        </div>
        
        <button onClick={handleRefresh} className="flex items-center gap-2 px-4 h-10 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors text-sm font-medium shadow-sm cursor-pointer">
          <RefreshCw size={16} /> Force Sync
        </button>
      </div>

      {/* Tabs Styled as Shadcn UI Segmented Control */}
      <div className="inline-flex h-10 items-center justify-center rounded-md bg-slate-900 p-1 text-slate-400 border border-slate-800 mb-6 shadow-sm self-start">
        <TabButton active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} icon={<Activity size={16}/>} label="Dashboard" />
        <TabButton active={activeTab === 'accounts'} onClick={() => setActiveTab('accounts')} icon={<Users size={16}/>} label="Accounts" />
        <TabButton active={activeTab === 'setup'} onClick={() => setActiveTab('setup')} icon={<Settings size={16}/>} label="Trading Setup" />
        <TabButton active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} icon={<FileText size={16}/>} label="Transaction Logs" />
      </div>

      {/* Main Content Area */}
      <div className="flex-1">
        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'accounts' && renderAccounts()}
        {activeTab === 'setup' && renderSetup()}
        {activeTab === 'logs' && renderLogs()}
      </div>

    </div>
  );
}
