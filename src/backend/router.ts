/// <reference types="@cloudflare/workers-types" />

import { ApiError } from './errors';
import { handleAdminWalletRoutes } from './api/adminWalletHandler';
import { handleAuthRoutes } from './api/authHandler';
import { handleMarketSnapshotRoutes } from './api/marketSnapshotHandler';
import { handleSettingsRoutes } from './api/settingsHandler';
import { handleStateRoutes } from './api/stateHandler';
import { handleStrategyRoutes } from './api/strategyHandler';
import { handleWebhookRoutes } from './api/webhookHandler';
import { errorResponse, jsonResponse } from './workerCore';
import type { Env } from './workerShared';

const DEFAULT_API_TIMEOUT_MS = 10_000;
const STATE_API_TIMEOUT_MS = 15_000;
const LONG_RUNNING_API_TIMEOUT_MS = 25_000;
const HEALTH_API_TIMEOUT_MS = 2_000;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

function withSecurityHeaders(response: Response, isApi = false): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isApi) {
    headers.set('Cache-Control', 'no-store');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    // Webhook ingress must acknowledge on its own schedule; the timeout race below
    // would turn a slow delivery into a 504 and get the webhook deactivated upstream.
    const webhookResponse = await handleWebhookRoutes(request, env, ctx);
    if (webhookResponse) {
      return webhookResponse;
    }

    return await withApiTimeout(
      request,
      (async () => {
        const handlers = [
          () => handleAuthRoutes(request, env),
          () => handleStateRoutes(request, env, ctx),
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

  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    const secureUrl = new URL(request.url);
    secureUrl.protocol = 'https:';
    return Response.redirect(secureUrl.toString(), 301);
  }

  if (url.pathname.startsWith('/api/')) {
    const response = await handleApi(request, env, ctx);
    const securedResponse = withSecurityHeaders(response, true);
    if (url.protocol === 'https:') {
      securedResponse.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return securedResponse;
  }

  if (env.ASSETS) {
    const response = await env.ASSETS.fetch(request);
    const securedResponse = withSecurityHeaders(response);
    if (url.protocol === 'https:') {
      securedResponse.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return securedResponse;
  }

  const status = /\.[a-z0-9]+$/i.test(url.pathname) ? 404 : 503;
  const message =
    status === 404
      ? 'Static asset not found'
      : 'Static assets binding is not configured';
  return new Response(message, { status });
}