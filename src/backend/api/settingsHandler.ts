import { parseActiveTokenUpdateRequest, parseJsonBody, parseRpcEndpointCreateRequest, parseTradableTokenCreateRequest } from '../workerSchema';
import { dbAddRpcEndpoint, dbCreateTradableToken, dbDeleteRpcEndpoint, dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import { dbAddAuditLog, dbLoadSettings, dbSaveActiveContractAddress, dbSaveSettings } from '../userStore';
import { fetchSolanaMintDecimals, jsonResponse, normalizePubkey } from '../workerCore';
import type { Env, SettingsUpdateRequest, TokenMarketSnapshot } from '../workerShared';
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
    const normalizedContractAddress = body.contractAddress.trim()
      ? normalizePubkey(body.contractAddress)
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
        { network: 'solana', contractAddress: normalizedContractAddress },
        decimals,
      );
    }
    await dbSaveSettings(env.TRADINGBOT_DB, user.id, {
      ...body,
      contractAddress: normalizedContractAddress,
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
      body.contractAddress,
    );

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
            `Failed to ensure tracked token metadata for ${normalizedContractAddress}:`,
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
      normalizedContractAddress ? 'token.activated' : 'token.cleared',
      normalizedContractAddress || 'none',
      normalizedContractAddress
        ? marketSnapshot
          ? 'Activated the tracked token and reused the latest stored market data. No strategy version was created automatically.'
          : 'Activated the tracked token. Market data will refresh only on manual refresh or webhook events. No strategy version was created automatically.'
        : 'Cleared the active tracked token. No strategy version was created automatically.',
    );

    return jsonResponse({
      contractAddress: normalizedContractAddress,
      marketSnapshot,
    });
  }

  if (method === 'POST' && pathname === '/api/tradable-tokens') {
    const user = await requireAdmin(request, env);
    const body = parseTradableTokenCreateRequest(
      await parseJsonBody<unknown>(request),
    );
    const normalizedAddress = normalizePubkey(body.contractAddress);
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
      { network: body.network, contractAddress: normalizedAddress },
      decimals,
    );
    const marketSnapshot = await loadStoredMarketSnapshotByContractAddress(
      env.TRADINGBOT_DB,
      normalizedAddress,
    );
    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'token.added',
      token.contractAddress,
      marketSnapshot
        ? `Added tradable token on ${token.network} and reused the latest stored market snapshot.`
        : `Added tradable token on ${token.network}. Market data will refresh only on manual refresh or webhook events.`,
    );
    return jsonResponse({ token, marketSnapshot }, 201);
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
