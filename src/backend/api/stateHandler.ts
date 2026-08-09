import { ApiError } from '../errors';
import { dbGetLatestTokenMarketSnapshot, dbListRpcEndpoints, dbListTradableTokens, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
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
  dbAddAuditLog,
} from '../userStore';
import { base58Encode, decodeBase64Bytes, jsonResponse, solanaRpc } from '../workerCore';
import { parseJsonBody } from '../workerSchema';
import type {
  Env,
  MarketRefreshStatusRecord,
  OutsideTokenHolderPageRecord,
  OutsideTokenHolderSort,
  TokenHolderAggregateRecord,
  TokenHolderSyncStateRecord,
  TokenMarketSnapshot,
} from '../workerShared';
import { SOLANA_SPL_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID } from '../workerShared';
import { requireAdmin, requireUser } from '../services/accessControl';
import { dbComputeManagedProfitUsdc, dbListHistoricalSetups } from '../services/historyMetricsService';
import { dbGetMarketRefreshState } from '../services/marketRefreshStateService';
import { StrategyAutomationService } from '../services/strategyAutomationService';
import {
  dbGetActiveStrategyVersion,
  dbListStrategyEvaluations,
  dbListStrategyVersions,
  dedupeStrategyVersionsForDisplay,
} from '../services/strategyStore';

const strategyAutomationService = new StrategyAutomationService();

async function resolveSolanaTokenAccountOwners(
  rpcUrls: string[],
  addresses: string[],
): Promise<Map<string, string>> {
  const ownerByAddress = new Map<string, string>();
  if (rpcUrls.length === 0 || addresses.length === 0) {
    return ownerByAddress;
  }

  const uniqueAddresses = [...new Set(addresses.filter(Boolean))];
  const tokenProgramIds = new Set([
    SOLANA_SPL_TOKEN_PROGRAM_ID,
    SOLANA_TOKEN_2022_PROGRAM_ID,
  ]);
  const chunkSize = 100;

  for (let index = 0; index < uniqueAddresses.length; index += chunkSize) {
    const chunk = uniqueAddresses.slice(index, index + chunkSize);
    const result = await solanaRpc<{
      value: Array<
        | {
            owner?: string;
            data: [string, string] | string;
          }
        | null
      >;
    }>(rpcUrls, 'getMultipleAccounts', [
      chunk,
      {
        encoding: 'base64',
        dataSlice: { offset: 32, length: 32 },
      },
    ]);

    for (let offset = 0; offset < chunk.length; offset += 1) {
      const accountInfo = result.value?.[offset] ?? null;
      if (!accountInfo || !tokenProgramIds.has(accountInfo.owner ?? '')) {
        continue;
      }

      const data = Array.isArray(accountInfo.data)
        ? accountInfo.data[0]
        : accountInfo.data;
      if (typeof data !== 'string' || data.length === 0) {
        continue;
      }

      const bytes = decodeBase64Bytes(data);
      if (bytes.length < 32) {
        continue;
      }

      const tokenAccountAddress = chunk[offset];
      const ownerAddress = base58Encode(bytes.slice(0, 32));
      if (ownerAddress && ownerAddress !== tokenAccountAddress) {
        ownerByAddress.set(tokenAccountAddress, ownerAddress);
      }
    }
  }

  return ownerByAddress;
}

function normalizeOutsideTokenHolderPageAddresses(
  page: OutsideTokenHolderPageRecord,
  ownerByAddress: Map<string, string>,
): OutsideTokenHolderPageRecord {
  if (ownerByAddress.size === 0) {
    return page;
  }

  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      address: ownerByAddress.get(item.address) ?? item.address,
    })),
    latestChangedAddresses: [...new Set(
      page.latestChangedAddresses.map(
        (address) => ownerByAddress.get(address) ?? address,
      ),
    )],
  };
}

type StrategyDebugSimulateRequest = {
  action: 'hold' | 'fill' | 'complete';
  executedVolumeUsd?: number;
  actualNetInflowUsd?: number;
  tacticsTriggeredCount?: number;
  clearPendingTasks?: boolean;
};

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

    const enabledManagedAccounts = internalAccs.filter((account) => account.isActive);

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
        managedAccounts: enabledManagedAccounts.length,
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
        knownChangeToken,
        knownLatestUpdatedAt: Number.isFinite(knownLatestUpdatedAtParam)
          ? knownLatestUpdatedAtParam
          : null,
      },
    );

    let normalizedResult = result;
    if (result.items.length > 0 || result.latestChangedAddresses.length > 0) {
      try {
        const rpcUrls = await dbResolveSolanaRpcUrls(
          env.TRADINGBOT_DB,
          user.id,
          env.SOLANA_RPC_URL,
        );
        const ownerByAddress = await resolveSolanaTokenAccountOwners(
          rpcUrls,
          [
            ...result.items.map((item) => item.address),
            ...result.latestChangedAddresses,
          ],
        );
        normalizedResult = normalizeOutsideTokenHolderPageAddresses(
          result,
          ownerByAddress,
        );
      } catch (err: unknown) {
        console.warn('Failed to normalize token holder addresses to owner wallets:', err);
      }
    }

    return jsonResponse(normalizedResult);
  }

  return null;
}
