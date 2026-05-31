import { AppState } from '../types';

const getSavedArr = (key: string) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
};

export const initialState: AppState = {
  activeTab: 'dashboard',
  engineState: null,
  lastUpdated: new Date().toLocaleTimeString(),
  
  dateRange: { from: '', to: '' },
  
  accountSearchTerm: '',
  internalPage: 1,
  outsiderPage: 1,
  
  logSearchTerm: '',
  logCurrentPage: 1,
  
  volTarget: '4.5',
  pullbackTarget: '2.0',
  contractAddress: '',
  workerUrl: '',
  
  savedContractAddresses: getSavedArr('savedContractAddresses'),
  savedWorkerUrls: getSavedArr('savedWorkerUrls'),
};
