/// <reference types="@cloudflare/workers-types" />

import { handleAdminWalletRoutes } from './api/adminWalletHandler';
import { handleAuthRoutes } from './api/authHandler';
import { handleMarketSnapshotRoutes } from './api/marketSnapshotHandler';
import { handleSettingsRoutes } from './api/settingsHandler';
import { handleStateRoutes } from './api/stateHandler';
import { handleStrategyRoutes } from './api/strategyHandler';
import { handleWebhookRoutes } from './api/webhookHandler';
import { errorResponse, jsonResponse } from './workerCore';
import type { Env } from './workerShared';

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const handlers = [
      () => handleAuthRoutes(request, env),
      () => handleWebhookRoutes(request, env, ctx),
      () => handleStateRoutes(request, env),
      () => handleSettingsRoutes(request, env),
      () => handleStrategyRoutes(request, env, ctx),
      () => handleMarketSnapshotRoutes(request, env, ctx),
      () => handleAdminWalletRoutes(request, env),
    ];

    for (const handle of handlers) {
      const response = await handle();
      if (response) {
        return response;
      }
    }

    return jsonResponse({ error: 'Not found' }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function appRouter(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(request, env, ctx);
  }

  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }

  const status = /\.[a-z0-9]+$/i.test(url.pathname) ? 404 : 503;
  const message =
    status === 404
      ? 'Static asset not found'
      : 'Static assets binding is not configured';
  return new Response(message, { status });
}