import { ApiError } from '../errors';
import { dbGetUserBySessionToken } from '../userStore';
import { sessionTokenFromCookie } from '../workerCore';
import type { Env, SessionUser } from '../workerShared';

export async function requireUser(
  request: Request,
  env: Env,
): Promise<SessionUser> {
  const token = sessionTokenFromCookie(request.headers.get('Cookie'));
  if (!token) throw new ApiError(401, 'Login required');
  const user = await dbGetUserBySessionToken(env.TRADINGBOT_DB, token);
  if (!user) throw new ApiError(401, 'Login required');
  return user;
}

export async function requireAdmin(
  request: Request,
  env: Env,
): Promise<SessionUser> {
  const user = await requireUser(request, env);
  if (user.role !== 'admin') {
    throw new ApiError(403, 'Admin permissions are required for this action');
  }
  return user;
}
