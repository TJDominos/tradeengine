import { ApiError } from '../errors';
import { dbGetLatestTokenMarketSnapshot, dbListRpcEndpoints, dbListTradableTokens, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import {
  dbGetTokenHolderAggregate,
  dbGetTokenHolderSyncState,
  dbListOutsideTokenHoldersPage,
} from '../tokenHolders';
import {
  dbGetManagedAccountSummary,
  dbListAccountsDirectory,
  dbListManagedAccountsPage,
  dbListAuditLogs,
  dbListRecentSignalsForDebug,
  dbListTradeLogs,
  dbListWebhookTransactionLogs,
  dbLoadSettings,
  dbAddAuditLog,
} from '../userStore';
import { jsonResponse } from '../workerCore';
import { parseJsonBody } from '../workerSchema';
import type {
  Env,
  MarketRefreshStatusRecord,
  OutsideTokenHolderSort,
  TokenHolderAggregateRecord,
  TokenHolderSyncStateRecord,
  TokenMarketSnapshot,
  WebhookTransactionLogRecord,
  TradeLogRecord,
} from '../workerShared';
import { requireAdmin, requireUser } from '../services/accessControl';
import { dbComputeManagedProfitUsdc, dbListHistoricalSetups } from '../services/historyMetricsService';
import { dbGetMarketRefreshState } from '../services/marketRefreshStateService';
import {
  dbCompleteTransactionLogRefresh,
  dbFailTransactionLogRefresh,
  dbGetTransactionLogRefreshState,
  dbTryStartTransactionLogRefresh,
} from '../services/transactionLogRefreshStateService';
import {
  dbGetLatestBaseTokenTransactionTimeMs,
  reconcileTokenTransactionsFromRpc,
} from '../services/signalStore';
import { StrategyAutomationService } from '../services/strategyAutomationService';
import {
  dbGetActiveStrategyVersion,
} from '../services/strategyStore';

const strategyAutomationService = new StrategyAutomationService();
const DEFAULT_TRANSACTION_LOG_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSACTION_LOG_REFRESH_CURSOR_OVERLAP_MS = 5_000;
const TRANSACTION_LOG_REFRESH_PRIMARY_MAX_PAGES = 5;

type TransactionLogRecord =
  | ({ kind: 'trade' } & TradeLogRecord)
  | ({ kind: 'webhook' } & WebhookTransactionLogRecord);

export function buildTransactionLogs(
  tradeLogs: TradeLogRecord[],
  webhookTransactionLogs: WebhookTransactionLogRecord[],
): TransactionLogRecord[] {
  const logsBySignature = new Map<string, TransactionLogRecord>();
  const unsignedLogs: TransactionLogRecord[] = [];
  const candidates: TransactionLogRecord[] = [
    ...tradeLogs
      .filter((log) => log.status !== 'FAILED')
      .map((log) => ({ kind: 'trade' as const, ...log })),
    ...webhookTransactionLogs
      .filter((log) => log.status !== 'FAILED')
      .map((log) => ({ kind: 'webhook' as const, ...log })),
  ];

  for (const log of candidates) {
    const signature = log.txSignature?.trim();
    if (!signature) {
      unsignedLogs.push(log);
    } else if (!logsBySignature.has(signature)) {
      logsBySignature.set(signature, log);
    }
  }

  return [...logsBySignature.values(), ...unsignedLogs].sort((left, right) => {
    const leftTime = left.chainTimeMs ?? left.createdAt;
    const rightTime = right.chainTimeMs ?? right.createdAt;
    if (leftTime == null && rightTime == null) return right.id - left.id;
    if (leftTime == null) return 1;
    if (rightTime == null) return -1;
    return rightTime - leftTime || right.id - left.id;
  });
}

type StrategyDebugSimulateRequest = {
  action: 'hold' | 'fill' | 'complete';
  executedVolumeUsd?: number;
  actualNetInflowUsd?: number;
  tacticsTriggeredCount?: number;
  clearPendingTasks?: boolean;
};

export function resolveTransactionLogRefreshWindow(
  latestTransactionTimeMs: number | null,
  endTimeMs = Date.now(),
): {
  startTimeMs: number;
  endTimeMs: number;
} {
  const fallbackStartTimeMs = Math.max(0, endTimeMs - DEFAULT_TRANSACTION_LOG_REFRESH_WINDOW_MS);
  const startTimeMs = latestTransactionTimeMs == null
    ? fallbackStartTimeMs
    : Math.max(
        0,
        Math.min(endTimeMs, latestTransactionTimeMs) - TRANSACTION_LOG_REFRESH_CURSOR_OVERLAP_MS,
      );

  return {
    startTimeMs,
    endTimeMs,
  };
}

function assertLocalDebugRequest(url: URL): void {
  if (url.protocol === 'http:') {
    return;
  }
  const hostname = url.hostname.trim().toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new ApiError(404, 'Not found');
  }
}

function parseStrategyDebugSimulateRequest(body: unknown): StrategyDebugSimulateRequest {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Debug simulation request must be a JSON object');
  }

  const raw = body as Record<string, unknown>;
  const action = typeof raw.action === 'string' ? raw.action.trim() : '';
  if (action !== 'hold' && action !== 'fill' && action !== 'complete') {
    throw new ApiError(400, 'action must be hold, fill, or complete');
  }

  const executedVolumeUsd = raw.executedVolumeUsd;
  if (
    executedVolumeUsd != null &&
    (typeof executedVolumeUsd !== 'number' || !Number.isFinite(executedVolumeUsd) || executedVolumeUsd < 0)
  ) {
    throw new ApiError(400, 'executedVolumeUsd must be a non-negative number');
  }

  const actualNetInflowUsd = raw.actualNetInflowUsd;
  if (
    actualNetInflowUsd != null &&
    (typeof actualNetInflowUsd !== 'number' || !Number.isFinite(actualNetInflowUsd))
  ) {
    throw new ApiError(400, 'actualNetInflowUsd must be a finite number');
  }

  const tacticsTriggeredCount = raw.tacticsTriggeredCount;
  if (
    tacticsTriggeredCount != null &&
    (typeof tacticsTriggeredCount !== 'number' || !Number.isFinite(tacticsTriggeredCount) || tacticsTriggeredCount < 0)
  ) {
    throw new ApiError(400, 'tacticsTriggeredCount must be a non-negative number');
  }

  const clearPendingTasks = raw.clearPendingTasks;
  if (clearPendingTasks != null && typeof clearPendingTasks !== 'boolean') {
    throw new ApiError(400, 'clearPendingTasks must be a boolean');
  }

  return {
    action,
    executedVolumeUsd: typeof executedVolumeUsd === 'number' ? executedVolumeUsd : undefined,
    actualNetInflowUsd:
      typeof actualNetInflowUsd === 'number' ? actualNetInflowUsd : undefined,
    tacticsTriggeredCount:
      typeof tacticsTriggeredCount === 'number' ? tacticsTriggeredCount : undefined,
    clearPendingTasks:
      typeof clearPendingTasks === 'boolean' ? clearPendingTasks : undefined,
  };
}

export async function handleStateRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
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

  if (method === 'POST' && pathname === '/api/debug/strategy/current/simulate') {
    assertLocalDebugRequest(url);
    const user = await requireAdmin(request, env);
    const body = parseStrategyDebugSimulateRequest(
      await parseJsonBody<unknown>(request),
    );
    const simulated = await strategyAutomationService.simulateActiveStrategy(env, body);
    if (!simulated) {
      throw new ApiError(409, 'No active strategy is currently running');
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.debug_simulated',
      simulated.record.versionId,
      `Local debug simulation executed for active strategy (${body.action}).`,
    );

    return jsonResponse({
      simulated: true,
      strategy: simulated.record,
      state: simulated.state,
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

  if (method === 'GET' && pathname === '/api/profit') {
    const user = await requireUser(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const baseTokenAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
    const quoteTokenAddress = settings.activeQuoteTokenAddress?.trim() || undefined;
    if (!baseTokenAddress) {
      return jsonResponse({ baseTokenAddress: '', profitUsdc: 0 });
    }

    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      baseTokenAddress,
      quoteTokenAddress,
    );
    const marketSnapshot = tokenId
      ? await dbGetLatestTokenMarketSnapshot(env.TRADINGBOT_DB, tokenId)
      : null;
    const profitUsdc = await dbComputeManagedProfitUsdc(
      env.TRADINGBOT_DB,
      user.id,
      baseTokenAddress,
      marketSnapshot?.priceUsd ?? null,
    );
    return jsonResponse({ baseTokenAddress, profitUsdc });
  }

  if (method === 'GET' && pathname === '/api/transaction-logs/refresh/status') {
    const user = await requireAdmin(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const contractAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
    const transactionLogRefreshStatus = contractAddress
      ? await dbGetTransactionLogRefreshState(
          env.TRADINGBOT_DB,
          user.id,
          contractAddress,
        )
      : null;
    return jsonResponse({ transactionLogRefreshStatus });
  }

  if (method === 'GET' && pathname === '/api/state') {
    const user = await requireUser(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const activeBaseTokenAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
    const activeQuoteTokenAddress = settings.activeQuoteTokenAddress?.trim() || null;
    const [
      internalAccs,
      internalAccountSummary,
      activityLogs,
      tradeLogs,
      webhookTransactionLogs,
      tradableTokens,
      historicalSetups,
      rpcEndpoints,
      activeStrategyVersion,
    ] =
      await Promise.all([
        dbListAccountsDirectory(env.TRADINGBOT_DB, user.id, 'managed'),
        dbGetManagedAccountSummary(
          env.TRADINGBOT_DB,
          user.id,
          activeBaseTokenAddress,
        ),
        dbListAuditLogs(env.TRADINGBOT_DB, user.id, user.username),
        dbListTradeLogs(env.TRADINGBOT_DB),
        dbListWebhookTransactionLogs(env.TRADINGBOT_DB, user.id),
        dbListTradableTokens(env.TRADINGBOT_DB),
        dbListHistoricalSetups(env.TRADINGBOT_DB, user.id),
        dbListRpcEndpoints(env.TRADINGBOT_DB, user.id),
        dbGetActiveStrategyVersion(env.TRADINGBOT_DB, user.id).catch(() => null),
      ]);
    const internalAccountDirectory = internalAccs;

    let marketSnapshot: TokenMarketSnapshot | null = null;
    let tokenHolderAggregate: TokenHolderAggregateRecord | null = null;
    let tokenHolderSyncState: TokenHolderSyncStateRecord | null = null;
    let marketRefreshStatus: MarketRefreshStatusRecord | null = null;
    const outsideTokenHolders = [];
    let tokenId: number | null = null;
    if (activeBaseTokenAddress) {
      try {
        [marketRefreshStatus, tokenId] = await Promise.all([
          dbGetMarketRefreshState(
            env.TRADINGBOT_DB,
            user.id,
            activeBaseTokenAddress,
          ),
          dbResolveTradableTokenId(
            env.TRADINGBOT_DB,
            activeBaseTokenAddress,
            activeQuoteTokenAddress ?? undefined,
          ),
        ]);
        if (tokenId) {
          [marketSnapshot, tokenHolderSyncState, tokenHolderAggregate] =
            await Promise.all([
              dbGetLatestTokenMarketSnapshot(env.TRADINGBOT_DB, tokenId),
              dbGetTokenHolderSyncState(env.TRADINGBOT_DB, tokenId),
              dbGetTokenHolderAggregate(env.TRADINGBOT_DB, tokenId),
            ]);
        }
      } catch (err: unknown) {
        console.warn(
          `Failed to load active token state for ${activeBaseTokenAddress}:`,
          err,
        );
      }
    }

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
      internalAccountDirectory,
      internalAccountSummary,
      logs: activityLogs,
      activityLogs,
      tradeLogs,
      webhookTransactionLogs,
      transactionLogs: buildTransactionLogs(tradeLogs, webhookTransactionLogs),
      tradableTokens,
      historicalSetups,
      activeStrategyVersion,
      strategyVersions: [],
      strategyEvaluations: [],
      tokenHolderAggregate,
      tokenHolderSyncState,
      marketRefreshStatus,
      outsideTokenHolders,
      rpcEndpoints,
      marketSnapshot,
      marketSnapshotHistory: [],
      profitUsdc: 0,
      stats: {
        managedAccounts: internalAccountSummary.activeAccounts,
        tradeExecutionEnabled: false,
      },
      system: {
        backend: 'cloudflare-worker',
        databasePath: 'D1:tradingbot',
        databaseConnected: true,
      },
    });
  }

  if (method === 'POST' && pathname === '/api/transaction-logs/refresh') {
    const user = await requireAdmin(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const contractAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();

    if (!contractAddress) {
      return jsonResponse(
        { error: 'Set an active trading token before refreshing transaction logs' },
        400,
      );
    }

    const latestTransactionTimeMs = await dbGetLatestBaseTokenTransactionTimeMs(
      env.TRADINGBOT_DB,
      user.id,
      contractAddress,
    );
    const { startTimeMs, endTimeMs } = resolveTransactionLogRefreshWindow(
      latestTransactionTimeMs,
    );

    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );
    const refreshStart = await dbTryStartTransactionLogRefresh(
      env.TRADINGBOT_DB,
      user.id,
      contractAddress,
    );
    if (!refreshStart.acquired) {
      return jsonResponse({
        ok: true,
        accepted: true,
        status: 'running',
        contractAddress,
        transactionLogRefreshStatus: refreshStart.state,
      }, 202);
    }
    const requestId = refreshStart.state.requestId;
    if (!requestId) {
      return jsonResponse({ error: 'Failed to initialize transaction log refresh request' }, 500);
    }

    ctx.waitUntil(
      (async () => {
        try {
          const reconciliation = await reconcileTokenTransactionsFromRpc(
            env.TRADINGBOT_DB,
            user.id,
            contractAddress,
            rpcUrls,
            {
              perAddressMaxPages: TRANSACTION_LOG_REFRESH_PRIMARY_MAX_PAGES,
              startTimeMs,
              endTimeMs,
            },
          );
          const insertedTransactions = reconciliation.insertedSignals;
          const holderDeltasApplied = reconciliation.holderDeltasApplied;
          const enrichedTransactions = 0;
          const summaryText = insertedTransactions > 0
            ? `Transaction Log refresh completed: ${insertedTransactions} new, ${holderDeltasApplied} holder updates.`
            : `Transaction Log refresh completed: no missing transactions found after scanning ${reconciliation.scannedSignatures}.`;
          await dbCompleteTransactionLogRefresh(
            env.TRADINGBOT_DB,
            user.id,
            contractAddress,
            requestId,
            {
              summaryText,
              scannedTransactions: reconciliation.scannedSignatures,
              insertedTransactions,
              holderDeltasApplied,
              enrichedTransactions,
            },
          );
          console.log('[transaction-log-refresh] completed', {
            userId: user.id,
            contractAddress,
            reconciliation,
          });
        } catch (err) {
          console.error('[transaction-log-refresh] failed', err);
          const errorMessage = err instanceof Error ? err.message : String(err);
          await dbFailTransactionLogRefresh(
            env.TRADINGBOT_DB,
            user.id,
            contractAddress,
            requestId,
            errorMessage,
          ).catch((updateErr) => {
            console.error('Failed to persist transaction log refresh failure state:', updateErr);
          });
        }
      })(),
    );

    return jsonResponse({
      ok: true,
      accepted: true,
      status: 'started',
      contractAddress,
      latestTransactionTimeMs,
      startTimeMs,
      endTimeMs,
      transactionLogRefreshStatus: refreshStart.state,
    }, 202);
  }

  if (method === 'GET' && pathname === '/api/accounts/managed') {
    const user = await requireUser(request, env);
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10);
    const searchTerm = url.searchParams.get('search') ?? '';
    const sortParam = url.searchParams.get('sort');

    const result = await dbListManagedAccountsPage(
      env.TRADINGBOT_DB,
      user.id,
      {
        page: Number.isFinite(page) ? page : 1,
        pageSize: Math.min(Math.max(Number.isFinite(pageSize) ? pageSize : 20, 1), 20),
        searchTerm,
        sort:
          sortParam === 'usdc' || sortParam === 'sol' || sortParam === 'token'
            ? sortParam
            : 'newest',
      },
    );

    return jsonResponse(result);
  }

  if (method === 'GET' && pathname === '/api/token-holders') {
    const user = await requireUser(request, env);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const normalizedContractAddress =
      settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress.trim();
    if (!normalizedContractAddress) {
      return jsonResponse({
        items: [],
        page: 1,
        pageSize: 20,
        totalItems: 0,
        latestUpdatedAt: null,
        changeToken: '',
        latestChangedAddresses: [],
        unchanged: false,
      });
    }

    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    if (!tokenId) {
      return jsonResponse({
        items: [],
        page: 1,
        pageSize: 20,
        totalItems: 0,
        latestUpdatedAt: null,
        changeToken: '',
        latestChangedAddresses: [],
        unchanged: false,
      });
    }

    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10);
    const searchTerm = url.searchParams.get('search') ?? '';
    const sortParam = url.searchParams.get('sort');
    const knownChangeToken = url.searchParams.get('changeToken') ?? '';
    const knownLatestUpdatedAtParam = Number.parseInt(
      url.searchParams.get('latestUpdatedAt') ?? '',
      10,
    );
    const sort: OutsideTokenHolderSort =
      sortParam === 'largest' || sortParam === 'usdc' || sortParam === 'sol'
        ? sortParam
        : 'newest';

    const result = await dbListOutsideTokenHoldersPage(
      env.TRADINGBOT_DB,
      user.id,
      tokenId,
      {
        page: Number.isFinite(page) ? page : 1,
        pageSize: Math.min(Math.max(Number.isFinite(pageSize) ? pageSize : 20, 1), 20),
        searchTerm,
        sort,
        knownChangeToken,
        knownLatestUpdatedAt: Number.isFinite(knownLatestUpdatedAtParam)
          ? knownLatestUpdatedAtParam
          : null,
      },
    );

    return jsonResponse(result);
  }

  return null;
}
