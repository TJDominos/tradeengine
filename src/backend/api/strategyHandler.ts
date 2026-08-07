import { ApiError } from '../errors';
import { normalizeStrategyDocument } from '../strategy/migrations';
import {
  strategyEngineDurableObjectNameFor,
  type StrategyEngineDurableObjectConfigureRequest,
} from '../strategy/strategyEngineDO';
import { parseJsonBody } from '../workerSchema';
import { dbCreateTradableToken, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import { dbAddAuditLog, dbLoadSettings, dbSaveSettings } from '../userStore';
import { fetchSolanaMintDecimals, jsonResponse, normalizePubkey, parseJsonText } from '../workerCore';
import type { Env, TokenMarketSnapshot } from '../workerShared';
import { requireAdmin } from '../services/accessControl';
import { dbCreateHistoricalSetupSnapshot } from '../services/historyMetricsService';
import { StrategyAutomationService } from '../services/strategyAutomationService';
import {
  dbDeletePreviousStrategyVersions,
  dbGetActiveStrategyVersion,
  removePendingStrategy,
  dbSaveActiveStrategyVersionDocument,
  mapStrategyDocumentToSettingsUpdate,
} from '../services/strategyStore';
import { loadStoredMarketSnapshotByContractAddress } from '../services/tokenMarketService';

const strategyAutomationService = new StrategyAutomationService();

function parseAbortRequestBody(body: unknown): { reason: string } {
  if (body == null) {
    return { reason: 'Manual user abort' };
  }
  if (typeof body !== 'object') {
    throw new ApiError(400, 'Abort request body must be a JSON object');
  }
  const { reason } = body as { reason?: unknown };
  if (reason == null) {
    return { reason: 'Manual user abort' };
  }
  if (typeof reason !== 'string') {
    throw new ApiError(400, 'Abort reason must be a string');
  }
  return {
    reason: reason.trim() || 'Manual user abort',
  };
}

async function parseOptionalJsonObject(request: Request): Promise<unknown | null> {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return null;
  }
  return parseJsonText<unknown>(rawBody);
}

export async function handleStrategyRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (method === 'POST' && pathname === '/api/strategy/active') {
    const user = await requireAdmin(request, env);
    const previousActiveStrategyVersion = await dbGetActiveStrategyVersion(
      env.TRADINGBOT_DB,
      user.id,
    );
    const document = normalizeStrategyDocument(
      await parseJsonBody<unknown>(request),
    );

    const normalizedContractAddress = document.parameters.contractAddress.trim()
      ? normalizePubkey(document.parameters.contractAddress)
      : '';
    const normalizedDocument = normalizeStrategyDocument({
      ...document,
      parameters: {
        ...document.parameters,
        contractAddress: normalizedContractAddress,
      },
      metadata: {
        ...document.metadata,
        author: user.username,
        changeNote:
          document.metadata.changeNote ||
          document.parameters.notes ||
          'Strategy document updated',
        origin: 'manual',
      },
    });

    const strategySave = await dbSaveActiveStrategyVersionDocument(
      env.TRADINGBOT_DB,
      user.id,
      normalizedDocument,
      {
        changeNote:
          normalizedDocument.metadata.changeNote ||
          normalizedDocument.parameters.notes ||
          'Strategy document updated',
      },
    );

    const settingsUpdate = mapStrategyDocumentToSettingsUpdate(normalizedDocument);
    await dbSaveSettings(env.TRADINGBOT_DB, user.id, settingsUpdate);
    const updatedSettings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    await dbCreateHistoricalSetupSnapshot(
      env.TRADINGBOT_DB,
      user.id,
      updatedSettings,
    );

    const previousContractAddress = previousActiveStrategyVersion?.document.parameters.contractAddress.trim()
      ? normalizePubkey(previousActiveStrategyVersion.document.parameters.contractAddress)
      : null;

    if (normalizedContractAddress) {
      const stubId = env.STRATEGY_ENGINE_DO.idFromName(
        strategyEngineDurableObjectNameFor(user.id, normalizedContractAddress),
      );
      const stub = env.STRATEGY_ENGINE_DO.get(stubId);
      const doRequest: StrategyEngineDurableObjectConfigureRequest = {
        userId: user.id,
        versionId: strategySave.version.id,
        strategyDocument: normalizedDocument,
      };
      await stub.fetch('https://strategy-engine/configure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(doRequest),
      });
    }

    if (
      previousContractAddress &&
      previousContractAddress !== normalizedContractAddress
    ) {
      const previousStubId = env.STRATEGY_ENGINE_DO.idFromName(
        strategyEngineDurableObjectNameFor(user.id, previousContractAddress),
      );
      const previousStub = env.STRATEGY_ENGINE_DO.get(previousStubId);
      await previousStub.fetch('https://strategy-engine/clear', {
        method: 'POST',
      });
    }

    let marketSnapshot: TokenMarketSnapshot | null = null;
    if (normalizedContractAddress) {
      const rpcUrls = await dbResolveSolanaRpcUrls(
        env.TRADINGBOT_DB,
        user.id,
        env.SOLANA_RPC_URL,
      );

      const existingTokenId = await dbResolveTradableTokenId(
        env.TRADINGBOT_DB,
        normalizedContractAddress,
      );
      if (!existingTokenId) {
        try {
          const decimals = await fetchSolanaMintDecimals(
            rpcUrls,
            normalizedContractAddress,
          ).catch(() => null);
          await dbCreateTradableToken(
            env.TRADINGBOT_DB,
            {
              network: 'solana',
              contractAddress: normalizedContractAddress,
            },
            decimals,
          );
        } catch (err: unknown) {
          console.warn(
            `Failed to ensure tracked token metadata for strategy contract ${normalizedContractAddress}:`,
            err,
          );
        }
      }
      marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
        env.TRADINGBOT_DB,
        normalizedContractAddress,
      );
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.version_activated',
      normalizedContractAddress || 'none',
      strategySave.created
        ? `Activated strategy version v${strategySave.version.versionNo}.`
        : `Strategy version v${strategySave.version.versionNo} remains active.`,
    );

    const queuedStrategy = await strategyAutomationService.enqueueStrategyVersion(
      env,
      user.id,
      strategySave.version,
    );
    await strategyAutomationService.startNextStrategy(env);

    return jsonResponse({
      activeStrategyVersion: strategySave.version,
      settings: updatedSettings,
      marketSnapshot,
      queuedStrategy,
    });
  }

  if (method === 'GET' && pathname === '/api/strategy/current') {
    await requireAdmin(request, env);
    const queueSnapshot = await strategyAutomationService.getQueueSnapshot(env);
    return jsonResponse(queueSnapshot);
  }

  if (method === 'POST' && pathname === '/api/strategy/abort') {
    const user = await requireAdmin(request, env);
    const body = await parseOptionalJsonObject(request);
    const { reason } = parseAbortRequestBody(body);
    const abortedStrategy = await strategyAutomationService.abortCurrentStrategy(env, reason);

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.abort_requested',
      abortedStrategy?.versionId ?? 'strategy-queue',
      abortedStrategy
        ? `Aborted queued strategy ${abortedStrategy.versionId}. Reason: ${reason}`
        : `Abort requested but no active strategy was running. Reason: ${reason}`,
    );

    return jsonResponse({
      aborted: abortedStrategy != null,
      reason,
      strategy: abortedStrategy,
      report: abortedStrategy?.report ?? null,
    });
  }

  if (method === 'POST' && pathname === '/api/strategy/resume') {
    const user = await requireAdmin(request, env);
    const wasBusy = (await strategyAutomationService.getActiveStrategyStub(env)) != null;
    const startedStrategy = await strategyAutomationService.startNextStrategy(env, {
      force: true,
    });
    const started = !wasBusy && startedStrategy != null;

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.resume_requested',
      startedStrategy?.versionId ?? 'strategy-queue',
      started
        ? `Manually resumed queue and started strategy ${startedStrategy?.versionId}.`
        : wasBusy
          ? 'Resume requested while a strategy is already running.'
          : 'Resume requested but the strategy queue is empty.',
    );

    return jsonResponse({
      started,
      queueEmpty: !wasBusy && startedStrategy == null,
      alreadyRunning: wasBusy,
      strategy: startedStrategy,
    });
  }

  if (
    method === 'POST' &&
    pathname.startsWith('/api/strategy/pending/') &&
    pathname.endsWith('/cancel')
  ) {
    const user = await requireAdmin(request, env);
    const versionId = decodeURIComponent(
      pathname.slice('/api/strategy/pending/'.length, -'/cancel'.length),
    ).trim();
    if (!versionId) {
      throw new ApiError(400, 'Pending strategy versionId is required');
    }

    const removedStrategy = await removePendingStrategy(env, versionId);
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.pending_removed',
      removedStrategy?.versionId ?? versionId,
      removedStrategy
        ? `Removed pending strategy ${removedStrategy.versionId} from the serial queue.`
        : `Pending strategy ${versionId} was not found in the serial queue.`,
    );

    return jsonResponse({
      removed: removedStrategy != null,
      strategy: removedStrategy,
    });
  }

  if (method === 'POST' && pathname === '/api/strategy/versions/cleanup') {
    const user = await requireAdmin(request, env);
    const cleanup = await dbDeletePreviousStrategyVersions(
      env.TRADINGBOT_DB,
      user.id,
    );

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'strategy.versions_cleaned',
      cleanup.keptVersion?.document.parameters.contractAddress || 'strategy',
      cleanup.keptVersion
        ? `Deleted ${cleanup.deletedVersions} automatic strategy version(s) and ${cleanup.deletedEvaluations} related evaluation(s). Kept manual v${cleanup.keptVersion.versionNo} active.`
        : `Deleted ${cleanup.deletedVersions} automatic strategy version(s) and ${cleanup.deletedEvaluations} related evaluation(s). No manual strategy version remains active.`,
    );

    return jsonResponse({
      deletedVersions: cleanup.deletedVersions,
      deletedEvaluations: cleanup.deletedEvaluations,
      activeStrategyVersion: cleanup.keptVersion,
    });
  }

  return null;
}
