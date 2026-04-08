import { extractBearerToken, verifyAdminPassword, verifyJWT } from './jwt';
import type { AppBindings } from '../types/env';
import { parseCookieHeader } from './csrf';
import { queryOne } from './db';

type UserJwtPayload = {
  user_id: number;
  type: string;
};

async function hasAdminRole(env: AppBindings, userId: number): Promise<boolean> {
  const row = await queryOne<{ ok: number }>(
    env.DB,
    'SELECT 1 as ok FROM user_roles WHERE user_id = ? AND role_text = ? LIMIT 1',
    [userId, 'admin']
  );
  return !!row;
}

async function canAuthenticateAsAdminByUserToken(env: AppBindings, token: string | null): Promise<boolean> {
  if (!token) return false;
  const payload = await verifyJWT<UserJwtPayload>(token, env);
  if (!payload || payload.type !== 'user' || !payload.user_id) return false;
  return hasAdminRole(env, payload.user_id);
}

export async function requireAdminAuth(c: {
  req: { header(name: string): string | undefined };
  env: AppBindings;
  json: (body: unknown, status?: number) => Response;
}) {
  const authHeader = c.req.header('Authorization') ?? null;

  if (verifyAdminPassword(authHeader, c.env.ADMIN_PASSWORDS)) {
    return null;
  }

  const cookieToken = parseCookieHeader(c.req.header('Cookie'))['tm_user_session'] || null;
  const bearerToken = extractBearerToken(authHeader);
  const tokens = Array.from(new Set([cookieToken, bearerToken].filter(Boolean)));

  for (const token of tokens) {
    if (await canAuthenticateAsAdminByUserToken(c.env, token || null)) {
      return null;
    }
  }

  return c.json(
    { success: false, error: 'UNAUTHORIZED', message: 'Invalid admin credentials' },
    401
  );

}
