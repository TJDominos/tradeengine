import { parseActiveTokenUpdateRequest, parseJsonBody, parseRpcEndpointCreateRequest, parseTradableTokenCreateRequest, parseTradableTokenUpdateRequest } from '../workerSchema';
import {
  checkTradableTokenWebhookSupport,
  dbAddRpcEndpoint,
  dbCreateTradableToken,
  dbDeleteRpcEndpoint,
  dbDeleteTradableToken,
  dbResolveSolanaRpcUrls,
  dbResolveTradableTokenId,
  dbUpdateTradableToken,
} from '../tokenStore';
import { dbAddAuditLog, dbLoadSettings, dbSaveActiveContractAddress, dbSaveSettings } from '../userStore';
import { fetchSolanaMintDecimals, jsonResponse, normalizePubkey } from '../workerCore';
import type { Env, SettingsUpdateRequest, TokenMarketSnapshot } from '../workerShared';
import { SOLANA_USDC_MINT } from '../workerShared';
import { requireAdmin } from '../services/accessControl';
import { dbCreateHistoricalSetupSnapshot } from '../services/historyMetricsService';
import { loadStoredMarketSnapshotByContractAddress } from '../services/tokenMarketService';

export async function handleSettingsRoutes(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (method === 'POST' && pathname === '/api/settings') {
    const user = await requireAdmin(request, env);
    const body = await parseJsonBody<SettingsUpdateRequest>(request);
    const normalizedContractAddress = body.baseTokenAddress.trim()
      ? normalizePubkey(body.baseTokenAddress)
      : '';
    let rpcUrls: string[] | null = null;
    if (normalizedContractAddress) {
      rpcUrls = await dbResolveSolanaRpcUrls(
        env.TRADINGBOT_DB,
        user.id,
        env.SOLANA_RPC_URL,
      );
      const decimals = await fetchSolanaMintDecimals(
        rpcUrls,
        normalizedContractAddress,
      ).catch(() => null);
      await dbCreateTradableToken(
        env.TRADINGBOT_DB,
        {
          network: 'solana',
          baseTokenAddress: normalizedContractAddress,
          quoteTokenAddress: SOLANA_USDC_MINT,
        },
        decimals,
      );
    }
    await dbSaveSettings(env.TRADINGBOT_DB, user.id, {
      ...body,
      baseTokenAddress: normalizedContractAddress,
    });
    const updated = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    await dbCreateHistoricalSetupSnapshot(env.TRADINGBOT_DB, user.id, updated);
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'settings.updated',
      'settings',
      'Trading settings were updated. No strategy version was created automatically.',
    );

    return jsonResponse(updated);
  }

  if (method === 'POST' && pathname === '/api/settings/active-token') {
    const user = await requireAdmin(request, env);
    const body = parseActiveTokenUpdateRequest(
      await parseJsonBody<unknown>(request),
    );
    const normalizedContractAddress = await dbSaveActiveContractAddress(
      env.TRADINGBOT_DB,
      user.id,
      body.baseTokenAddress,
      body.quoteTokenAddress,
    );
    const normalizedQuoteTokenAddress =
      typeof body.quoteTokenAddress === 'string' && body.quoteTokenAddress.trim().length > 0
        ? normalizePubkey(body.quoteTokenAddress)
        : SOLANA_USDC_MINT;

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
        normalizedQuoteTokenAddress,
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
              baseTokenAddress: normalizedContractAddress,
              quoteTokenAddress: normalizedQuoteTokenAddress,
            },
            decimals,
          );
        } catch (err: unknown) {
          console.warn(
            `Failed to ensure tracked pair metadata for ${normalizedContractAddress}:`,
            err,
          );
        }
      }
      marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
        env.TRADINGBOT_DB,
        normalizedContractAddress,
        normalizedQuoteTokenAddress,
      );
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      normalizedContractAddress ? 'token.activated' : 'token.cleared',
      normalizedContractAddress || 'none',
      normalizedContractAddress
        ? marketSnapshot
          ? 'Activated the tracked pair and reused the latest stored market data. No strategy version was created automatically.'
          : 'Activated the tracked pair. Market data will refresh only on manual refresh or webhook events. No strategy version was created automatically.'
        : 'Cleared the active tracked pair. No strategy version was created automatically.',
    );

    return jsonResponse({
      contractAddress: normalizedContractAddress,
      quoteTokenAddress: normalizedQuoteTokenAddress,
      marketSnapshot,
    });
  }

  if (method === 'POST' && pathname === '/api/tradable-tokens') {
    const user = await requireAdmin(request, env);
    const body = parseTradableTokenCreateRequest(
      await parseJsonBody<unknown>(request),
    );
    const normalizedAddress = normalizePubkey(body.baseTokenAddress);
    const normalizedQuoteTokenAddress = normalizePubkey(body.quoteTokenAddress);
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );
    const decimals = await fetchSolanaMintDecimals(
      rpcUrls,
      normalizedAddress,
    ).catch(() => null);
    const token = await dbCreateTradableToken(
      env.TRADINGBOT_DB,
      {
        network: body.network,
        baseTokenAddress: normalizedAddress,
        quoteTokenAddress: normalizedQuoteTokenAddress,
        ammPoolAddress: body.ammPoolAddress,
      },
      decimals,
    );
    const webhookCheck = await checkTradableTokenWebhookSupport(
      rpcUrls,
      normalizedAddress,
    );
    const marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
      env.TRADINGBOT_DB,
      normalizedAddress,
      normalizedQuoteTokenAddress,
    );
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'token.added',
      token.baseTokenAddress,
      [
        marketSnapshot
          ? `Added tradable pair on ${token.network} and reused the latest stored market snapshot.`
          : `Added tradable pair on ${token.network}. Market data will refresh only on manual refresh or webhook events.`,
        webhookCheck.ok
          ? webhookCheck.latestSignature
            ? 'Webhook RPC verification passed.'
            : 'Webhook RPC verification passed, but no recent signatures were found for this mint yet.'
          : `Webhook RPC verification failed: ${webhookCheck.errorMessage ?? 'unknown RPC error'}`,
      ].join(' '),
    );
    return jsonResponse({ token, marketSnapshot, webhookCheck }, 201);
  }

  if (method === 'POST' && /^\/api\/tradable-tokens\/\d+$/.test(pathname)) {
    const user = await requireAdmin(request, env);
    const tokenId = Number.parseInt(url.pathname.split('/').pop() ?? '', 10);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return jsonResponse({ error: 'Tracked pair id is invalid' }, 400);
    }

    const body = parseTradableTokenUpdateRequest(
      await parseJsonBody<unknown>(request),
    );
    const token = await dbUpdateTradableToken(env.TRADINGBOT_DB, tokenId, {
      ammPoolAddress: body.ammPoolAddress,
    });

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'token.updated',
      token.baseTokenAddress,
      token.ammPoolAddress
        ? `Updated tracked pair AMM pool for ${token.network}.`
        : `Cleared tracked pair AMM pool for ${token.network}.`,
    );

    return jsonResponse({ token });
  }

  if (method === 'DELETE' && /^\/api\/tradable-tokens\/\d+$/.test(pathname)) {
    const user = await requireAdmin(request, env);
    const tokenId = Number.parseInt(url.pathname.split('/').pop() ?? '', 10);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return jsonResponse({ error: 'Tracked pair id is invalid' }, 400);
    }

    const token = await dbDeleteTradableToken(env.TRADINGBOT_DB, tokenId);
    const settings = await dbLoadSettings(env.TRADINGBOT_DB, user.id);
    const activeBaseTokenAddress = settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress;
    const activeQuoteTokenAddress = settings.activeQuoteTokenAddress?.trim() || SOLANA_USDC_MINT;
    const clearedActiveContractAddress =
      activeBaseTokenAddress === token.baseTokenAddress &&
      activeQuoteTokenAddress === token.quoteTokenAddress;
    if (clearedActiveContractAddress) {
      await dbSaveActiveContractAddress(env.TRADINGBOT_DB, user.id, '', '');
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'token.deleted',
      token.baseTokenAddress,
      clearedActiveContractAddress
        ? `Removed tracked pair on ${token.network} and cleared the active pair selection.`
        : `Removed tracked pair on ${token.network}.`,
    );

    return jsonResponse({
      success: true,
      token,
      clearedActiveContractAddress,
    });
  }

  if (method === 'POST' && pathname === '/api/rpc-endpoints') {
    const user = await requireAdmin(request, env);
    const body = parseRpcEndpointCreateRequest(
      await parseJsonBody<unknown>(request),
    );
    const endpoint = await dbAddRpcEndpoint(env.TRADINGBOT_DB, user.id, body);
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'rpc.endpoint_added',
      endpoint.url,
      `Added ${endpoint.network} RPC endpoint`,
    );
    return jsonResponse({ endpoint }, 201);
  }

  if (method === 'DELETE' && /^\/api\/rpc-endpoints\/\d+$/.test(pathname)) {
    const user = await requireAdmin(request, env);
    const endpointId = Number.parseInt(url.pathname.split('/').pop() ?? '', 10);
    if (!Number.isInteger(endpointId) || endpointId <= 0) {
      return jsonResponse({ error: 'RPC endpoint id is invalid' }, 400);
    }
    const endpoint = await dbDeleteRpcEndpoint(
      env.TRADINGBOT_DB,
      user.id,
      endpointId,
    );
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'rpc.endpoint_deleted',
      endpoint.url,
      `Removed ${endpoint.network} RPC endpoint`,
    );
    return jsonResponse({ success: true });
  }

  return null;
}
