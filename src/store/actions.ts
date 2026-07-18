import { AppState } from '../types';

const formatWithCommas = (val: string) => {
  const clean = val.replace(/[^0-9.-]/g, '');
  if (!clean) return '';
  const parts = clean.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts.join('.');
};

const buildBackendUrl = (workerUrl: string, path: string): string | null => {
  const trimmed = workerUrl.trim();
  if (!trimmed) return null;
  const base = trimmed.startsWith('http') ? trimmed : 'https://' + trimmed;
  return base.replace(/\/$/, '') + path;
};

export const createActions = (set: any, get: any) => ({
  setActiveTab: (tab: string) => set({ activeTab: tab }),
  setDateRange: (range: { from: string; to: string }) => set({ dateRange: range }),
  
  setAccountSearchTerm: (term: string) => set({ accountSearchTerm: term }),
  setInternalPage: (page: number) => set({ internalPage: page }),
  setOutsiderPage: (page: number) => set({ outsiderPage: page }),
  
  setLogSearchTerm: (term: string) => set({ logSearchTerm: term }),
  setLogCurrentPage: (page: number) => set({ logCurrentPage: page }),
  
  setVolTarget: (val: string) => set({ volTarget: val }),
  setPullbackTarget: (val: string) => set({ pullbackTarget: val }),
  setVolumeTarget: (val: string) => set({ volumeTarget: formatWithCommas(val) }),
  setNetBuyinTarget: (val: string) => set({ netBuyinTarget: formatWithCommas(val) }),
  setTimeRangeTarget: (val: string) => set({ timeRangeTarget: val }),
  setMaxTransactions: (val: string) => set({ maxTransactions: val }),
  setMaxSlippage: (val: string) => set({ maxSlippage: val }),
  setTradingAlgorithm: (val: string) => set({ tradingAlgorithm: val }),
  setSecretName: (val: string) => set({ secretName: val }),
  setContractAddress: (val: string) => set({ contractAddress: val }),
  setWorkerUrl: (val: string) => set({ workerUrl: val }),
  setCfAccessClientId: (val: string) => set({ cfAccessClientId: val }),
  setCfAccessClientSecret: (val: string) => set({ cfAccessClientSecret: val }),
  
  saveContractAddress: () => {
    const { contractAddress, savedContractAddresses } = get();
    if (contractAddress && !savedContractAddresses.includes(contractAddress)) {
      const newArr = [...savedContractAddresses, contractAddress];
      set({ savedContractAddresses: newArr });
      localStorage.setItem('savedContractAddresses', JSON.stringify(newArr));
    }
  },
  saveWorkerUrl: () => {
    const { workerUrl, savedWorkerUrls } = get();
    if (workerUrl && !savedWorkerUrls.includes(workerUrl)) {
      const newArr = [...savedWorkerUrls, workerUrl];
      set({ savedWorkerUrls: newArr });
      localStorage.setItem('savedWorkerUrls', JSON.stringify(newArr));
    }
  },
  saveSecretName: () => {
    const { secretName, savedSecretNames } = get();
    if (secretName && !savedSecretNames.includes(secretName)) {
      const newArr = [...savedSecretNames, secretName];
      set({ savedSecretNames: newArr });
      // Secret env-var names are not persisted to localStorage
    }
  },
  deleteSavedItem: (key: string, val: string) => {
    if (key === 'savedContractAddresses') {
       const newArr = get().savedContractAddresses.filter((v: string) => v !== val);
       set({ savedContractAddresses: newArr });
       localStorage.setItem('savedContractAddresses', JSON.stringify(newArr));
    } else if (key === 'savedWorkerUrls') {
       const newArr = get().savedWorkerUrls.filter((v: string) => v !== val);
       set({ savedWorkerUrls: newArr });
       localStorage.setItem('savedWorkerUrls', JSON.stringify(newArr));
    } else if (key === 'savedSecretNames') {
       const newArr = get().savedSecretNames.filter((v: string) => v !== val);
       set({ savedSecretNames: newArr });
       // Secret env-var names are not persisted to localStorage
    }
  },

  handleToggleAccount: async (id: string) => {
    const { workerUrl } = get();
    const endpoint = buildBackendUrl(workerUrl, '/api/toggleAccount');
    if (!endpoint) {
      console.error("Backend URL not configured");
      return;
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        const data = await res.json();
        set({ engineState: data });
      }
    } catch (e) {
       console.error("Failed to toggle acc", e);
    }
  },

  fetchState: async () => {
    const { workerUrl } = get();
    const endpoint = buildBackendUrl(workerUrl, '/api/state');

    if (!endpoint) {
      set({
        engineState: {
          error: "Backend URL Not Configured",
          details: "Enter the Rust backend URL in the Settings tab (e.g. http://localhost:3000 for local dev)."
        }
      });
      return;
    }

    try {
      const res = await fetch(endpoint);
      if (!res.ok) {
        let errDetails = '';
        try {
          const errBody = await res.json();
          errDetails = errBody.error ? ` - ${errBody.error}` : '';
        } catch (_) {}
        throw new Error(`HTTP error! status: ${res.status}${errDetails}`);
      }
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error("Received non-JSON response from backend");
      }
      const data = await res.json();
      
      const payload: Partial<AppState> = {
        engineState: data,
        lastUpdated: new Date().toLocaleTimeString()
      };
      
      if (data.settings) {
        if (data.settings.contractAddress) {
          payload.contractAddress = data.settings.contractAddress;
        }
        if (data.settings.volatilityTarget !== undefined) {
          payload.volTarget = ((parseFloat(data.settings.volatilityTarget) || 0.045) * 100).toFixed(1);
        }
        if (data.settings.pullbackTarget !== undefined) {
          payload.pullbackTarget = ((parseFloat(data.settings.pullbackTarget) || 0.02) * 100).toFixed(1);
        }
        if (data.settings.volumeTarget !== undefined) {
          payload.volumeTarget = formatWithCommas(data.settings.volumeTarget.toString());
        }
        if (data.settings.netBuyinTarget !== undefined) {
          payload.netBuyinTarget = formatWithCommas(data.settings.netBuyinTarget.toString());
        }
        if (data.settings.timeRangeTarget !== undefined) {
          payload.timeRangeTarget = data.settings.timeRangeTarget.toString();
        }
        if (data.settings.maxTransactions !== undefined) {
          payload.maxTransactions = data.settings.maxTransactions.toString();
        }
        if (data.settings.maxSlippage !== undefined) {
          payload.maxSlippage = data.settings.maxSlippage.toString();
        }
        if (data.settings.tradingAlgorithm !== undefined) {
          payload.tradingAlgorithm = data.settings.tradingAlgorithm;
        }
      }
      
      set(payload);
    } catch (e: any) {
      console.error("Failed to fetch engine state", e);
      set({
        engineState: {
          error: "Execution Engine Unreachable",
          details: `Check that the backend is running and the URL is correct.\nError: ${e.message}`
        }
      });
    }
  },

  handleSaveConfig: async () => {
    const { workerUrl, volTarget, pullbackTarget, volumeTarget, netBuyinTarget, timeRangeTarget, maxTransactions, maxSlippage, tradingAlgorithm, contractAddress, secretName } = get();
    const actions = get().actions;
    const endpoint = buildBackendUrl(workerUrl, '/api/settings');

    if (!endpoint) {
      alert("Backend URL not configured. Please set it in the Settings tab.");
      return;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          volatilityTarget: volTarget,
          pullbackTarget: pullbackTarget,
          volumeTarget: volumeTarget.replace(/,/g, ''),
          netBuyinTarget: netBuyinTarget.replace(/,/g, ''),
          timeRangeTarget: timeRangeTarget,
          maxTransactions: maxTransactions,
          maxSlippage: maxSlippage,
          tradingAlgorithm: tradingAlgorithm,
          contractAddress: contractAddress,
          secretName: secretName
        })
      });
      if (!res.ok) {
        let errDetails = '';
        try {
          const errBody = await res.json();
          errDetails = errBody.error ? ` - ${errBody.error}` : '';
        } catch (_) {}
        throw new Error(`HTTP Error: ${res.status} ${res.statusText}${errDetails}`);
      }
      alert('Strategy Configuration Updated and Deployed');
      set({ secretName: '' });
      actions.fetchState();
    } catch (e: any) {
      console.error(e);
      alert(`Error saving config: ${e.message}`);
    }
  },

  handleTestTrade: async () => {
    const { workerUrl } = get();
    const actions = get().actions;
    const endpoint = buildBackendUrl(workerUrl, '/api/trade');

    if (!endpoint) {
      alert("Backend URL not configured. Please set it in the Settings tab.");
      return;
    }

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: "SOL/USDC", action: "buy" }),
      });
      if (!res.ok) {
        let errDetails = '';
        try {
          const errBody = await res.json();
          errDetails = errBody.error ? ` - ${errBody.error}` : '';
        } catch (_) {}
        throw new Error(`HTTP Error: ${res.status} ${res.statusText}${errDetails}`);
      }
      const data = await res.json();
      alert(`Test Trade Result: ${data.message || JSON.stringify(data)}`);
      actions.fetchState();
    } catch (e: any) {
      console.error(e);
      alert(`Error running test trade: ${e.message}`);
    }
  }
});
