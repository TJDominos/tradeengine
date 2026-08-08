import { dbGetLatestTokenMarketSnapshot, dbListRpcEndpoints, dbListTradableTokens, dbResolveTradableTokenId } from '../tokenStore';
import {
  dbGetTokenHolderAggregate,
  dbGetTokenHolderSyncState,
  dbHasTokenHolderRows,
  dbListOutsideTokenHoldersPage,
  dbComputeTokenHolderAggregateFromStage,
  dbRecomputeTokenHolderAggregate,
} from '../tokenHolders';
import {
  dbListAccounts,
  dbListAuditLogs,
  dbListRecentSignalsForDebug,
  dbListTradeLogs,
  dbListWebhookTransactionLogs,
  dbLoadSettings,
} from '../userStore';
import { jsonResponse } from '../workerCore';
import type {
  Env,
  MarketRefreshStatusRecord,
  OutsideTokenHolderSort,
  TokenHolderAggregateRecord,
  TokenHolderSyncStateRecord,
  TokenMarketSnapshot,
} from '../workerShared';
import { requireAdmin, requireUser } from '../services/accessControl';
import { dbComputeManagedProfitUsdc, dbListHistoricalSetups } from '../services/historyMetricsService';
import { dbGetMarketRefreshState } from '../services/marketRefreshStateService';
import {
  dbGetActiveStrategyVersion,
  dbListStrategyEvaluations,
  dbListStrategyVersions,
  dedupeStrategyVersionsForDisplay,
} from '../services/strategyStore';

export async function handleStateRoutes(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (method === 'GET' && pathname === '/api/health') {
    await env.TRADINGBOT_DB.prepare('SELECT 1').first();
    return jsonResponse({
      ok: true,
      backend: 'cloudflare-worker',
      databaseConnected: true,
      databasePath: 'D1:tradingbot',
    });
  }

  if (method === 'GET' && pathname === '/api/debug/webhook-transactions') {
    const user = await requireAdmin(request, env);
    const limitText = url.searchParams.get('limit');
    const limit = Number.isInteger(Number.parseInt(limitText ?? '', 10))
      ? Math.min(Math.max(Number.parseInt(limitText ?? '', 10), 1), 50)
      : 10;

    const [signalCountRow, recentSignals, groupedWebhookTransactions, tradeLogCountRow] =
      await Promise.all([
        env.TRADINGBOT_DB
          .prepare('SELECT COUNT(*) AS cnt FROM signals WHERE source LIKE ?1')
          .bind(`%:user:${user.id}`)
          .first<{ cnt: number }>(),
        dbListRecentSignalsForDebug(env.TRADINGBOT_DB, user.id, limit),
        dbListWebhookTransactionLogs(env.TRADINGBOT_DB, user.id),
        env.TRADINGBOT_DB
          .prepare('SELECT COUNT(*) AS cnt FROM trade_logs')
          .first<{ cnt: number }>(),
      ]);

    return jsonResponse({
      user: { id: user.id, username: user.username },
      signalCount: signalCountRow?.cnt ?? 0,
      tradeLogCount: tradeLogCountRow?.cnt ?? 0,
      groupedWebhookTransactionCount: groupedWebhookTransactions.length,
      groupedWebhookTransactions: groupedWebhookTransactions.slice(0, limit),
      recentSignals,
    });
  }

  if (method === 'GET' && pathname === '/api/state') {
    const user = await requireUser(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    let activeStrategyVersion = await dbGetActiveStrategyVersion(
      env.TRADINGBOT_DB,
      user.id,
    ).catch(() => null);
    let [
      internalAccs,
      activityLogs,
      tradeLogs,
      webhookTransactionLogs,
      tradableTokens,
      historicalSetups,
      strategyVersions,
      strategyEvaluations,
      rpcEndpoints,
    ] =
      await Promise.all([
        dbListAccounts(env.TRADINGBOT_DB, user.id, 'managed'),
        dbListAuditLogs(env.TRADINGBOT_DB, user.id, user.username),
        dbListTradeLogs(env.TRADINGBOT_DB),
        dbListWebhookTransactionLogs(env.TRADINGBOT_DB, user.id),
        dbListTradableTokens(env.TRADINGBOT_DB),
        dbListHistoricalSetups(env.TRADINGBOT_DB, user.id),
        dbListStrategyVersions(env.TRADINGBOT_DB, user.id),
        dbListStrategyEvaluations(env.TRADINGBOT_DB, user.id),
        dbListRpcEndpoints(env.TRADINGBOT_DB, user.id),
      ]);

    let marketSnapshot: TokenMarketSnapshot | null = null;
    let tokenHolderAggregate: TokenHolderAggregateRecord | null = null;
    let tokenHolderSyncState: TokenHolderSyncStateRecord | null = null;
    let marketRefreshStatus: MarketRefreshStatusRecord | null = null;
    const outsideTokenHolders = [];
    let tokenId: number | null = null;
    const activeBaseTokenAddress = settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
    const activeQuoteTokenAddress = settings.activeQuoteTokenAddress?.trim() || null;
    if (activeBaseTokenAddress) {
      try {
        marketRefreshStatus = await dbGetMarketRefreshState(
          env.TRADINGBOT_DB,
          user.id,
          activeBaseTokenAddress,
        );
        tokenId = await dbResolveTradableTokenId(
          env.TRADINGBOT_DB,
          activeBaseTokenAddress,
          activeQuoteTokenAddress ?? undefined,
        );
        if (tokenId) {
          marketSnapshot = await dbGetLatestTokenMarketSnapshot(
            env.TRADINGBOT_DB,
            tokenId,
          );
        }
      } catch (err: unknown) {
        console.warn(
          `Failed to load token market snapshot for ${activeBaseTokenAddress}:`,
          err,
        );
      }

      try {
        if (tokenId) {
          tokenHolderSyncState = await dbGetTokenHolderSyncState(
            env.TRADINGBOT_DB,
            tokenId,
          );
          tokenHolderAggregate = await dbGetTokenHolderAggregate(
            env.TRADINGBOT_DB,
            tokenId,
          );
          if (
            tokenHolderSyncState?.runId &&
            (tokenHolderSyncState.status === 'running' || tokenHolderSyncState.status === 'failed')
          ) {
            tokenHolderAggregate =
              (await dbComputeTokenHolderAggregateFromStage(
                env.TRADINGBOT_DB,
                user.id,
                tokenId,
                tokenHolderSyncState.runId,
                tokenHolderSyncState.updatedAt,
              )) ?? tokenHolderAggregate;
          }
          if (
            !tokenHolderAggregate &&
            (await dbHasTokenHolderRows(env.TRADINGBOT_DB, tokenId))
          ) {
            tokenHolderAggregate = await dbRecomputeTokenHolderAggregate(
              env.TRADINGBOT_DB,
              user.id,
              tokenId,
              {
                source: 'state_recompute',
              },
            );
          }
        }
      } catch (err: unknown) {
        console.warn(
          `Failed to load token holder aggregate for ${activeBaseTokenAddress}:`,
          err,
        );
      }
    }

    const dedupedStrategyDisplay = dedupeStrategyVersionsForDisplay(
      strategyVersions,
      activeStrategyVersion,
    );
    strategyVersions = dedupedStrategyDisplay.versions;
    activeStrategyVersion = dedupedStrategyDisplay.activeVersion;

    const profitUsdc = activeBaseTokenAddress
      ? await dbComputeManagedProfitUsdc(
          env.TRADINGBOT_DB,
          user.id,
          activeBaseTokenAddress,
          marketSnapshot?.priceUsd ?? null,
        )
      : 0;

    if (
      marketSnapshot &&
      (marketSnapshot.totalHolders == null ||
        !Number.isFinite(marketSnapshot.totalHolders)) &&
      tokenHolderAggregate?.activeHolderCount != null
    ) {
      marketSnapshot = {
        ...marketSnapshot,
        totalHolders: tokenHolderAggregate.activeHolderCount,
      };
    }

    return jsonResponse({
      auth: { username: user.username, role: user.role },
      settings,
      internalAccs,
      logs: activityLogs,
      activityLogs,
      tradeLogs,
      webhookTransactionLogs,
      tradableTokens,
      historicalSetups,
      activeStrategyVersion,
      strategyVersions,
      strategyEvaluations,
      tokenHolderAggregate,
      tokenHolderSyncState,
      marketRefreshStatus,
      outsideTokenHolders,
      rpcEndpoints,
      marketSnapshot,
      marketSnapshotHistory: [],
      profitUsdc,
      stats: {
        managedAccounts: internalAccs.length,
        tradeExecutionEnabled: false,
      },
      system: {
        backend: 'cloudflare-worker',
        databasePath: 'D1:tradingbot',
        databaseConnected: true,
      },
    });
  }

  if (method === 'GET' && pathname === '/api/token-holders') {
    const user = await requireUser(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const normalizedContractAddress = settings.baseTokenAddress.trim();
    if (!normalizedContractAddress) {
      return jsonResponse({ items: [], page: 1, pageSize: 20, totalItems: 0 });
    }

    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    if (!tokenId) {
      return jsonResponse({ items: [], page: 1, pageSize: 20, totalItems: 0 });
    }

    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10);
    const searchTerm = url.searchParams.get('search') ?? '';
    const sortParam = url.searchParams.get('sort');
    const sort: OutsideTokenHolderSort = sortParam === 'largest' ? 'largest' : 'newest';

    const result = await dbListOutsideTokenHoldersPage(
      env.TRADINGBOT_DB,
      user.id,
      tokenId,
      {
        page: Number.isFinite(page) ? page : 1,
        pageSize: Math.min(Math.max(Number.isFinite(pageSize) ? pageSize : 20, 1), 20),
        searchTerm,
        sort,
      },
    );

    return jsonResponse(result);
  }

  return null;
}
