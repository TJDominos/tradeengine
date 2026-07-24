import type {
  TokenHolderSyncSummary,
  TokenMarketSnapshot,
} from './workerShared';

export type RefreshRpcReconciliation = {
  scannedSignatures: number;
  insertedSignals: number;
  duplicates: number;
  skippedIrrelevant: number;
};

export type RefreshWindowCompleteness = {
  expectedTransactions: number;
  completeTransactionsBefore: number;
  enrichedTransactions: number;
  completeTransactionsAfter: number;
};

export const EMPTY_REFRESH_WINDOW_COMPLETENESS: RefreshWindowCompleteness = {
  expectedTransactions: 0,
  completeTransactionsBefore: 0,
  enrichedTransactions: 0,
  completeTransactionsAfter: 0,
};

export const EMPTY_REFRESH_RPC_RECONCILIATION: RefreshRpcReconciliation = {
  scannedSignatures: 0,
  insertedSignals: 0,
  duplicates: 0,
  skippedIrrelevant: 0,
};

export async function runWithFallback<T>(
  action: () => Promise<T>,
  warning: string,
  fallback: T,
): Promise<T> {
  try {
    return await action();
  } catch (err: unknown) {
    console.warn(warning, err);
    return fallback;
  }
}

export function buildHolderSyncAuditDetails(summary: TokenHolderSyncSummary): string {
  if (summary.status === 'completed') {
    return `Holder sync completed with ${summary.activeHolderCount} active holders, upserted ${summary.upsertedCount}, zeroed ${summary.zeroedCount}.`;
  }
  if (summary.status === 'failed') {
    return `Holder sync failed after ${summary.processedShardCount}/${summary.totalShardCount} shards. ${summary.errorMessage ?? 'Unknown error'}.`;
  }
  return `Holder sync is running ${summary.processedShardCount}/${summary.totalShardCount} shards, processed ${summary.shardsProcessedThisRun} shard(s) this refresh, staged ${summary.stagedHolderCount} holders so far.`;
}

export function buildHolderSyncNotice(summary: TokenHolderSyncSummary): string {
  if (summary.status === 'completed') {
    return ` Holder sync completed with ${summary.activeHolderCount} holders.`;
  }
  if (summary.status === 'failed') {
    return ` Holder sync failed: ${summary.errorMessage ?? 'unknown error'}.`;
  }
  if (summary.status === 'running') {
    return ` Holder sync ${summary.processedShardCount}/${summary.totalShardCount} shards, staged ${summary.stagedHolderCount} holders so far.`;
  }
  return '';
}

export function buildRefreshSummaryText(input: {
  marketSnapshot: TokenMarketSnapshot | null;
  holderSyncSummary: TokenHolderSyncSummary;
  windowCompleteness: RefreshWindowCompleteness;
  rpcReconciliation: RefreshRpcReconciliation;
}): string {
  if (input.marketSnapshot?.priceUsd == null) {
    return 'Token metadata loaded. Price data not yet available in Jupiter.';
  }

  const holderCountMessage =
    input.marketSnapshot.totalHolders != null
      ? ` Holder count reported: ${input.marketSnapshot.totalHolders}.`
      : '';

  return `Market data refreshed.${holderCountMessage} Window transactions ${input.windowCompleteness.expectedTransactions}, complete before ${input.windowCompleteness.completeTransactionsBefore}, enriched ${input.windowCompleteness.enrichedTransactions}, complete after ${input.windowCompleteness.completeTransactionsAfter}. RPC reconciliation scanned ${input.rpcReconciliation.scannedSignatures} signatures and inserted ${input.rpcReconciliation.insertedSignals} transaction record(s).${buildHolderSyncNotice(input.holderSyncSummary)}`;
}

export function buildRefreshAuditDetails(input: {
  strategyEvaluationSummary: string | null;
  windowCompleteness: RefreshWindowCompleteness;
  rpcReconciliation: RefreshRpcReconciliation;
  holderSyncSummary: TokenHolderSyncSummary;
}): string {
  const strategyPrefix = input.strategyEvaluationSummary
    ? `${input.strategyEvaluationSummary} `
    : '';
  return `Forced a live market snapshot refresh and stored a new historical record. ${strategyPrefix}Window transactions ${input.windowCompleteness.expectedTransactions}, complete before ${input.windowCompleteness.completeTransactionsBefore}, enriched ${input.windowCompleteness.enrichedTransactions}, complete after ${input.windowCompleteness.completeTransactionsAfter}. RPC reconciliation scanned ${input.rpcReconciliation.scannedSignatures} signatures and inserted ${input.rpcReconciliation.insertedSignals} missing transactions. ${buildHolderSyncAuditDetails(input.holderSyncSummary)}`;
}

export function parseRefreshControlRequestId(
  url: URL,
  bodyText: string,
): string | null {
  const fromQuery = url.searchParams.get('requestId')?.trim() ?? '';
  if (fromQuery.length > 0) {
    return fromQuery;
  }
  if (!bodyText.trim()) {
    return null;
  }

  try {
    const body = JSON.parse(bodyText) as { requestId?: unknown };
    const requestId =
      typeof body.requestId === 'string' ? body.requestId.trim() : '';
    return requestId.length > 0 ? requestId : null;
  } catch {
    return null;
  }
}
