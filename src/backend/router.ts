/// <reference types="@cloudflare/workers-types" />

import { ApiError } from './errors';
import { handleAdminWalletRoutes } from './api/adminWalletHandler';
import { handleAuthRoutes } from './api/authHandler';
import { handleMarketSnapshotRoutes } from './api/marketSnapshotHandler';
import { handleSettingsRoutes } from './api/settingsHandler';
import { handleStateRoutes } from './api/stateHandler';
import { handleStrategyRoutes } from './api/strategyHandler';
import { handleWebhookRoutes } from './api/webhookHandler';
import { initializeAllSchemas } from './services/dbSetup';
import { errorResponse, jsonResponse } from './workerCore';
import type { Env } from './workerShared';

const DEFAULT_API_TIMEOUT_MS = 10_000;
const STATE_API_TIMEOUT_MS = 15_000;
const LONG_RUNNING_API_TIMEOUT_MS = 25_000;
const HEALTH_API_TIMEOUT_MS = 2_000;

function shouldInitializeCoreAuthSchema(pathname: string): boolean {
  return pathname === '/api/auth/bootstrap' || pathname === '/api/auth/login';
}

function isReadOnlyStatePath(pathname: string): boolean {
  return pathname === '/api/state' || pathname === '/api/profit';
}

function resolveApiTimeoutMs(pathname: string): number {
  if (pathname === '/api/health') {
    return HEALTH_API_TIMEOUT_MS;
  }
  if (pathname === '/api/state') {
    return STATE_API_TIMEOUT_MS;
  }
  if (pathname === '/api/transaction-logs/refresh') {
    return LONG_RUNNING_API_TIMEOUT_MS;
  }
  if (pathname === '/api/strategy/active') {
    return LONG_RUNNING_API_TIMEOUT_MS;
  }
  if (pathname.startsWith('/api/webhook') || pathname.startsWith('/api/webhooks/')) {
    return LONG_RUNNING_API_TIMEOUT_MS;
  }
  return DEFAULT_API_TIMEOUT_MS;
}

async function withApiTimeout(
  request: Request,
  operation: Promise<Response>,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const timeoutMs = resolveApiTimeoutMs(pathname);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new ApiError(
          504,
          `${pathname} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });

  return Promise.race([
    operation.finally(() => {
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
      }
    }),
    timeoutPromise,
  ]);
}

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    return await withApiTimeout(
      request,
      (async () => {
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith('/api/auth/')) {
          if (shouldInitializeCoreAuthSchema(pathname)) {
            await initializeAllSchemas(env);
          }
        } else if (pathname !== '/api/health' && !isReadOnlyStatePath(pathname)) {
          await initializeAllSchemas(env);
        }

        const handlers = [
          () => handleAuthRoutes(request, env),
          () => handleWebhookRoutes(request, env, ctx),
          () => handleStateRoutes(request, env),
          () => handleSettingsRoutes(request, env),
          () => handleStrategyRoutes(request, env, ctx),
          () => handleMarketSnapshotRoutes(request, env, ctx),
          () => handleAdminWalletRoutes(request, env, ctx),
        ];

        for (const handle of handlers) {
          const response = await handle();
          if (response) {
            return response;
          }
        }

        return jsonResponse({ error: 'Not found' }, 404);
      })(),
    );
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