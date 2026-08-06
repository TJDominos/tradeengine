import { ApiError } from '../errors';
import {
  dbAddAuditLog,
  dbAuthenticateUser,
  dbCreateSession,
  dbCreateUser,
  dbDeleteSession,
  dbGetUserBySessionToken,
  dbSetupRequired,
} from '../userStore';
import type { Env } from '../workerShared';
import {
  buildSessionCookie,
  clearSessionCookie,
  isSecure,
  jsonResponse,
  sessionTokenFromCookie,
} from '../workerCore';
import { parseCredentialsBody, parseJsonBody } from '../workerSchema';
import { SESSION_TTL_HOURS } from '../workerShared';

export async function handleAuthRoutes(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (method === 'GET' && pathname === '/api/auth/status') {
    return handleAuthStatus(request, env);
  }
  if (method === 'POST' && pathname === '/api/auth/bootstrap') {
    return handleBootstrap(request, env);
  }
  if (method === 'POST' && pathname === '/api/auth/login') {
    return handleLogin(request, env);
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    return handleLogout(request, env);
  }

  return null;
}

async function handleAuthStatus(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (setupRequired) {
    return jsonResponse({ setupRequired: true, authenticated: false, user: null });
  }
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (!token) {
    return jsonResponse({ setupRequired: false, authenticated: false, user: null });
  }
  const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
  return jsonResponse({
    setupRequired: false,
    authenticated: !!user,
    user: user ? { username: user.username, role: user.role } : null,
  });
}

async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (!setupRequired) {
    throw new ApiError(
      403,
      'Bootstrap is disabled because an admin user already exists',
    );
  }
  const body = parseCredentialsBody(await parseJsonBody<unknown>(request));
  const user = await dbCreateUser(
    env.TRADINGBOT_DB,
    body.username,
    body.password,
  );
  const token = await dbCreateSession(
    env.TRADINGBOT_DB,
    user.id,
    SESSION_TTL_HOURS,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'auth.bootstrap',
    user.username,
    'Created initial admin account',
  );
  return jsonResponse(
    { authenticated: true, user: { username: user.username, role: user.role } },
    201,
    { 'Set-Cookie': buildSessionCookie(token, SESSION_TTL_HOURS, isSecure(request)) },
  );
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const setupRequired = await dbSetupRequired(env.TRADINGBOT_DB);
  if (setupRequired) {
    throw new ApiError(
      403,
      'Initial admin setup is required before login. Create an admin account first.',
    );
  }
  const body = parseCredentialsBody(await parseJsonBody<unknown>(request));
  const user = await dbAuthenticateUser(
    env.TRADINGBOT_DB,
    body.username,
    body.password,
  );
  const token = await dbCreateSession(
    env.TRADINGBOT_DB,
    user.id,
    SESSION_TTL_HOURS,
  );
  await dbAddAuditLog(
    env.TRADINGBOT_DB,
    user.id,
    'auth.login',
    user.username,
    'Authenticated admin session',
  );
  return jsonResponse(
    { authenticated: true, user: { username: user.username, role: user.role } },
    200,
    { 'Set-Cookie': buildSessionCookie(token, SESSION_TTL_HOURS, isSecure(request)) },
  );
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (token) {
    const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
    await dbDeleteSession(env.TRADINGBOT_DB, token);
    if (user) {
      await dbAddAuditLog(
        env.TRADINGBOT_DB,
        user.id,
        'auth.logout',
        user.username,
        'Ended admin session',
      );
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
  });
}