import {
  buildRefreshAuditDetails,
  buildRefreshSummaryText,
  EMPTY_REFRESH_RPC_RECONCILIATION,
  EMPTY_REFRESH_WINDOW_COMPLETENESS,
  parseRefreshControlRequestId,
  runWithFallback,
  type RefreshRpcReconciliation,
  type RefreshWindowCompleteness,
} from '../marketRefresh';
import { nowMs, nowTs, normalizeTimestampMs } from '../time';
import { dbListOutsideTokenHoldersPage } from '../tokenHolders';
import { dbGetTokenMarketSnapshotsByTimeRange, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import { dbAddAuditLog, dbLoadSettings } from '../userStore';
import { buildTokenHolderSyncSummary, jsonResponse } from '../workerCore';
import { TOKEN_HOLDER_SYNC_SHARDS_PER_REFRESH, TOKEN_HOLDER_SYNC_TOTAL_SHARDS, type Env, type SessionUser, type SettingsState, type TokenHolderSyncSummary, type TokenMarketSnapshot } from '../workerShared';
import { requireAdmin } from '../services/accessControl';
import {
  assertMarketRefreshLeaseActive,
  dbCancelMarketRefresh,
  dbCompleteMarketRefresh,
  dbFailMarketRefresh,
  dbGetMarketRefreshState,
  dbTryStartMarketRefresh,
} from '../services/marketRefreshStateService';
import { reconcileTokenTransactionsFromRpc, reconcileWebhookTransactionDetailsInWindow } from '../services/signalStore';
import { runAndPersistStrategyEvaluation } from '../services/strategyStore';
import { loadStoredMarketSnapshotByContractAddress, syncTokenMarketSnapshotForUser } from '../services/tokenMarketService';
import { syncSolanaTokenHolderBalancesPaged } from '../services/tokenHolderSyncService';
import { buildManualRefreshStrategyTrigger } from '../strategy/triggers';
import { summarizeStrategyRuntime } from '../strategy/runtime';

const MANUAL_REFRESH_HOLDER_BACKFILL_ADDRESS_LIMIT = 50;
const MANUAL_REFRESH_HOLDER_BACKFILL_SIGNATURE_LIMIT = 20;
const MANUAL_REFRESH_HOLDER_BACKFILL_MAX_PAGES = 2;
const MANUAL_REFRESH_HOLDER_SYNC_TIME_BUDGET_MS = 12_000;

async function loadManualRefreshBackfillAddresses(
  db: D1Database,
  userId: number,
  tokenId: number,
): Promise<string[]> {
  const holderPage = await dbListOutsideTokenHoldersPage(db, userId, tokenId, {
    page: 1,
    pageSize: MANUAL_REFRESH_HOLDER_BACKFILL_ADDRESS_LIMIT,
    sort: 'newest',
  });
  return holderPage.items.map((holder) => holder.address);
}

async function runManualMarketRefreshWorkflow(
  env: Env,
  user: SessionUser,
  settings: SettingsState,
  contractAddress: string,
  rpcUrls: string[],
  startTimeMs: number | null,
  endTimeMs: number | null,
  options?: {
    ensureActive?: () => Promise<void>;
  },
): Promise<{
  marketSnapshot: TokenMarketSnapshot | null;
  strategyEvaluation: Record<string, unknown> | null;
  rpcReconciliation: RefreshRpcReconciliation;
  windowCompleteness: RefreshWindowCompleteness;
  holderSyncSummary: TokenHolderSyncSummary;
  summaryText: string;
}> {
  const ensureActive = options?.ensureActive ?? (async () => {});

  await ensureActive();
  const marketSnapshot = await syncTokenMarketSnapshotForUser(
    env.TRADINGBOT_DB,
    user.id,
    'solana',
    contractAddress,
    rpcUrls,
    {
      force: true,
      fallbackToStoredOnError: false,
    },
  );

  const tokenId = await dbResolveTradableTokenId(
    env.TRADINGBOT_DB,
    contractAddress,
  );
  let holderBackfillAddresses: string[] = [];
  if (tokenId) {
    await ensureActive();
    holderBackfillAddresses = await runWithFallback(
      () => loadManualRefreshBackfillAddresses(env.TRADINGBOT_DB, user.id, tokenId),
      `Failed to load holder backfill addresses for ${contractAddress}:`,
      [],
    );
  }

  const rpcReconciliation = await runWithFallback(
    () =>
      reconcileTokenTransactionsFromRpc(
        env.TRADINGBOT_DB,
        user.id,
        contractAddress,
        rpcUrls,
        {
          additionalAddresses: [marketSnapshot?.pairAddress ?? null],
          backfillAddresses: holderBackfillAddresses,
          backfillPerAddressLimit: MANUAL_REFRESH_HOLDER_BACKFILL_SIGNATURE_LIMIT,
          backfillMaxPages: MANUAL_REFRESH_HOLDER_BACKFILL_MAX_PAGES,
          startTimeMs,
          endTimeMs,
        },
      ),
    `RPC reconciliation failed for ${contractAddress}:`,
    EMPTY_REFRESH_RPC_RECONCILIATION,
  );

  await ensureActive();

  const windowCompleteness = await runWithFallback(
    () =>
      reconcileWebhookTransactionDetailsInWindow(
        env.TRADINGBOT_DB,
        user.id,
        contractAddress,
        rpcUrls,
        startTimeMs,
        endTimeMs,
      ),
    `Window detail reconciliation failed for ${contractAddress}:`,
    EMPTY_REFRESH_WINDOW_COMPLETENESS,
  );

  await ensureActive();

  let holderSyncSummary = buildTokenHolderSyncSummary(null);
  if (tokenId) {
    try {
      holderSyncSummary = await syncSolanaTokenHolderBalancesPaged(
        env.TRADINGBOT_DB,
        user.id,
        tokenId,
        contractAddress,
        rpcUrls,
        {
          maxShards: TOKEN_HOLDER_SYNC_SHARDS_PER_REFRESH,
          timeBudgetMs: MANUAL_REFRESH_HOLDER_SYNC_TIME_BUDGET_MS,
          allowHeliusDasFullSync: false,
          ensureActive,
        },
      );
    } catch (err: unknown) {
      console.warn(`Failed to page holder balances for ${contractAddress}:`, err);
      holderSyncSummary = buildTokenHolderSyncSummary({
        tokenId,
        runId: null,
        status: 'failed',
        source: 'rpc_owner_prefix_shards',
        nextShardIndex: 0,
        processedShardCount: 0,
        totalShardCount: TOKEN_HOLDER_SYNC_TOTAL_SHARDS,
        stagedHolderCount: 0,
        lastProgramId: null,
        lastOwnerPrefix: null,
        errorMessage: err instanceof Error ? err.message : String(err),
        startedAt: null,
        updatedAt: nowTs(),
        lastCompletedAt: null,
      });
    }

    await ensureActive();
  }

  let strategyEvaluationSummary: string | null = null;
  let strategyEvaluationPayload: Record<string, unknown> | null = null;
  try {
    const strategyResult = await runAndPersistStrategyEvaluation(
      env.TRADINGBOT_DB,
      user.id,
      {
        baseTokenAddress: settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress,
        quoteTokenAddress: settings.activeQuoteTokenAddress?.trim() || '',
        volatilityTarget: settings.volatilityTarget,
        pullbackTarget: settings.pullbackTarget,
        volumeTarget: settings.volumeTarget,
        netBuyinTarget: settings.netBuyinTarget,
        timeRangeTarget: settings.timeRangeTarget,
        maxTransactions: settings.maxTransactions,
        maxSlippage: settings.maxSlippage,
        strategyNotes: settings.strategyNotes,
      },
      buildManualRefreshStrategyTrigger({
        contractAddress,
        externalId: `manual-refresh:${user.id}:${contractAddress}:${nowMs()}`,
      }),
      marketSnapshot,
      {
        author: user.username,
        changeNote: 'Manual market snapshot refresh',
        origin: 'settings-sync',
      },
    );
    if (strategyResult) {
      strategyEvaluationSummary = `Strategy v${strategyResult.version.versionNo}: ${summarizeStrategyRuntime(strategyResult.runtime)}`;
      strategyEvaluationPayload = {
        versionNo: strategyResult.version.versionNo,
        status: strategyResult.runtime.evaluation.status,
        qualified: strategyResult.runtime.evaluation.qualified,
        shouldExecute: strategyResult.runtime.evaluation.shouldExecute,
        reasons: strategyResult.runtime.evaluation.reasons,
      };
    }
  } catch (err: unknown) {
    console.warn(`Strategy evaluation failed after manual refresh for ${contractAddress}:`, err);
  }

  const summaryText = buildRefreshSummaryText({
    marketSnapshot,
    holderSyncSummary,
    windowCompleteness,
    rpcReconciliation,
  });

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'market_snapshot.force_refreshed',
    contractAddress,
    buildRefreshAuditDetails({
      strategyEvaluationSummary,
      windowCompleteness,
      rpcReconciliation,
      holderSyncSummary,
    }),
  );

  return {
    marketSnapshot,
    strategyEvaluation: strategyEvaluationPayload,
    rpcReconciliation,
    windowCompleteness,
    holderSyncSummary,
    summaryText,
  };
}

export async function handleMarketSnapshotRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (method === 'GET' && pathname === '/api/market-snapshots') {
    const user = await requireAdmin(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const contractAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
    const quoteTokenAddress = settings.activeQuoteTokenAddress?.trim() || undefined;

    if (!contractAddress) {
      return jsonResponse(
        { error: 'Set an active trading token before querying market snapshots' },
        400,
      );
    }

    const startTimeParam = url.searchParams.get('startTime');
    const endTimeParam = url.searchParams.get('endTime');
    const limitParam = url.searchParams.get('limit');

    const now = nowMs();
    let startTime = now - 7 * 24 * 60 * 60 * 1000;
    let endTime = now;
    let limit = 100;

    if (startTimeParam) {
      const parsed = Number.parseInt(startTimeParam, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        startTime = normalizeTimestampMs(parsed);
      }
    }

    if (endTimeParam) {
      const parsed = Number.parseInt(endTimeParam, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        endTime = normalizeTimestampMs(parsed);
      }
    }

    if (limitParam) {
      const parsed = Number.parseInt(limitParam, 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 500) {
        limit = parsed;
      }
    }

    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      contractAddress,
      quoteTokenAddress,
    );

    if (!tokenId) {
      return jsonResponse({ error: 'Token not found' }, 404);
    }

    const snapshots = await dbGetTokenMarketSnapshotsByTimeRange(
      env.TRADINGBOT_DB,
      tokenId,
      startTime,
      endTime,
      limit,
    );

    return jsonResponse({ snapshots });
  }

  if (method === 'POST' && pathname === '/api/market-snapshot/refresh') {
    const user = await requireAdmin(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const contractAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
    const quoteTokenAddress = settings.activeQuoteTokenAddress?.trim() || undefined;
    if (!contractAddress) {
      return jsonResponse(
        { error: 'Set an active trading token before forcing a live market refresh' },
        400,
      );
    }

    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );
    const startTimeMs = (() => {
      const raw = url.searchParams.get('startTime');
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(parsed) && parsed > 0 ? normalizeTimestampMs(parsed) : null;
    })();
    const endTimeMs = (() => {
      const raw = url.searchParams.get('endTime');
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(parsed) && parsed > 0 ? normalizeTimestampMs(parsed) : null;
    })();

    const currentSnapshot = await loadStoredMarketSnapshotByContractAddress(
      env.TRADINGBOT_DB,
      contractAddress,
      quoteTokenAddress,
    );
    const refreshStart = await dbTryStartMarketRefresh(
      env.TRADINGBOT_DB,
      user.id,
      contractAddress,
    );

    if (!refreshStart.acquired) {
      return jsonResponse(
        {
          accepted: true,
          status: 'running',
          marketSnapshot: currentSnapshot,
          marketRefreshStatus: refreshStart.state,
        },
        202,
      );
    }

    const requestId = refreshStart.state.requestId;
    if (!requestId) {
      return jsonResponse({ error: 'Failed to initialize market refresh request' }, 500);
    }

    ctx.waitUntil(
      (async () => {
        try {
          const result = await runManualMarketRefreshWorkflow(
            env,
            user,
            settings,
            contractAddress,
            rpcUrls,
            startTimeMs,
            endTimeMs,
            {
              ensureActive: async () => {
                await assertMarketRefreshLeaseActive(
                  env.TRADINGBOT_DB,
                  user.id,
                  contractAddress,
                  requestId,
                );
              },
            },
          );
          await dbCompleteMarketRefresh(
            env.TRADINGBOT_DB,
            user.id,
            contractAddress,
            requestId,
            result.summaryText,
          );
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error(`Background market refresh failed for ${contractAddress}:`, err);
          await dbFailMarketRefresh(
            env.TRADINGBOT_DB,
            user.id,
            contractAddress,
            requestId,
            errorMessage,
          ).catch((updateErr) => {
            console.error('Failed to persist market refresh failure state:', updateErr);
          });
        }
      })(),
    );

    return jsonResponse(
      {
        accepted: true,
        status: 'started',
        marketSnapshot: currentSnapshot,
        marketRefreshStatus: refreshStart.state,
      },
      202,
    );
  }

  if (method === 'POST' && pathname === '/api/market-snapshot/refresh/cancel') {
    const user = await requireAdmin(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const contractAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
    if (!contractAddress) {
      return jsonResponse({ error: 'No active token configured for refresh cancellation' }, 400);
    }

    const requestId = parseRefreshControlRequestId(url, await request.text());
    if (!requestId) {
      return jsonResponse({ error: 'requestId is required' }, 400);
    }

    await dbCancelMarketRefresh(
      env.TRADINGBOT_DB,
      user.id,
      contractAddress,
      requestId,
      'Market refresh canceled: browser session disconnected',
    );
    const state = await dbGetMarketRefreshState(
      env.TRADINGBOT_DB,
      user.id,
      contractAddress,
    );

    return jsonResponse({
      ok: true,
      marketRefreshStatus: state,
    });
  }

  return null;
}
