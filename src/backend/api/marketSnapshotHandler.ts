import {
  parseRefreshControlRequestId,
} from '../marketRefresh';
import { nowMs, normalizeTimestampMs } from '../time';
import { dbGetTokenHolderAggregate } from '../tokenHolders';
import { dbGetTokenMarketSnapshotsByTimeRange, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import { dbAddAuditLog, dbLoadSettings } from '../userStore';
import { jsonResponse } from '../workerCore';
import { type Env, type SessionUser, type TokenMarketSnapshot } from '../workerShared';
import { requireAdmin } from '../services/accessControl';
import {
  assertMarketRefreshLeaseActive,
  dbCancelMarketRefresh,
  dbCompleteMarketRefresh,
  dbFailMarketRefresh,
  dbGetMarketRefreshState,
  dbTryStartMarketRefresh,
} from '../services/marketRefreshStateService';
import { loadStoredMarketSnapshotByContractAddress, syncTokenMarketSnapshotForUser } from '../services/tokenMarketService';
import { syncSolanaTokenHolderBalancesPaged } from '../services/tokenHolderSyncService';

function buildDashboardRefreshSummaryText(
  marketSnapshot: TokenMarketSnapshot | null,
  outsideAccountRefreshScheduled: boolean,
): string {
  if (!marketSnapshot) {
    return 'Dashboard market data refresh completed, but no live market snapshot is available.';
  }

  if (marketSnapshot.priceUsd == null) {
    return 'Dashboard market data refreshed. Price data is not yet available in Jupiter.';
  }

  const holderCountMessage =
    marketSnapshot.totalHolders != null
      ? ` Holder count reported: ${marketSnapshot.totalHolders}.`
      : '';

  const outsideAccountRefreshMessage = outsideAccountRefreshScheduled
    ? ' Outside account refresh scheduled.'
    : '';

  return `Dashboard market data refreshed.${holderCountMessage}${outsideAccountRefreshMessage}`;
}

async function runManualMarketRefreshWorkflow(
  env: Env,
  user: SessionUser,
  contractAddress: string,
  rpcUrls: string[],
  knownHolderCount: number,
  options?: {
    ensureActive?: () => Promise<void>;
  },
): Promise<{
  marketSnapshot: TokenMarketSnapshot | null;
  summaryText: string;
  shouldRefreshOutsideAccounts: boolean;
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

  const shouldRefreshOutsideAccounts =
    marketSnapshot?.totalHolders != null &&
    marketSnapshot.totalHolders > knownHolderCount;
  const summaryText = buildDashboardRefreshSummaryText(
    marketSnapshot,
    shouldRefreshOutsideAccounts,
  );

  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'market_snapshot.force_refreshed',
    contractAddress,
    marketSnapshot
      ? shouldRefreshOutsideAccounts
        ? 'Refreshed dashboard market data, stored a new market snapshot record, and scheduled an outside account refresh.'
        : 'Refreshed dashboard market data and stored a new market snapshot record.'
      : 'Attempted to refresh dashboard market data, but no live market snapshot was available.',
  );

  return {
    marketSnapshot,
    summaryText,
    shouldRefreshOutsideAccounts,
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

  if (method === 'GET' && pathname === '/api/market-snapshot/refresh/status') {
    const user = await requireAdmin(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const contractAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();

    if (!contractAddress) {
      return jsonResponse({ marketRefreshStatus: null });
    }

    const marketRefreshStatus = await dbGetMarketRefreshState(
      env.TRADINGBOT_DB,
      user.id,
      contractAddress,
    );

    return jsonResponse({ marketRefreshStatus });
  }

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

    const currentSnapshot = await loadStoredMarketSnapshotByContractAddress(
      env.TRADINGBOT_DB,
      contractAddress,
      quoteTokenAddress,
    );
    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      contractAddress,
      quoteTokenAddress,
    );
    const tokenHolderAggregate = tokenId
      ? await dbGetTokenHolderAggregate(env.TRADINGBOT_DB, tokenId).catch(() => null)
      : null;
    const knownHolderCount = Math.max(
      currentSnapshot?.totalHolders ?? 0,
      tokenHolderAggregate?.activeHolderCount ?? 0,
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
            contractAddress,
            rpcUrls,
            knownHolderCount,
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
          const outsideAccountRefreshPromise =
            result.shouldRefreshOutsideAccounts && tokenId
              ? syncSolanaTokenHolderBalancesPaged(
                  env.TRADINGBOT_DB,
                  user.id,
                  tokenId,
                  contractAddress,
                  rpcUrls,
                ).catch((err: unknown) => {
                  console.warn(
                    `Background outside account refresh failed for ${contractAddress}:`,
                    err,
                  );
                })
              : null;
          await dbCompleteMarketRefresh(
            env.TRADINGBOT_DB,
            user.id,
            contractAddress,
            requestId,
            result.summaryText,
          );
          if (outsideAccountRefreshPromise) {
            await outsideAccountRefreshPromise;
          }
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
