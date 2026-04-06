import { extractBearerToken, verifyJWT } from './jwt';
import type { UserJWT } from '../models/user';
import type { AppBindings } from '../types/env';
import { query, queryOne } from './db';

export type UserAuthVariables = {
  user: UserJWT;
};

export async function requireUserAuth(c: {
  req: { header(name: string): string | undefined };
  env: AppBindings;
  json: (body: unknown, status?: number) => Response;
  set: (key: 'user', value: UserJWT) => void;
}) {
  const authHeader = c.req.header('Authorization') ?? null;
  const token = extractBearerToken(authHeader);

  if (!token) {
    return c.json(
      { success: false, error: 'UNAUTHORIZED', message: 'Authorization required' },
      401
    );
  }

  const payload = await verifyJWT<UserJWT>(token, c.env);
  if (!payload || payload.type !== 'user') {
    return c.json(
      { success: false, error: 'UNAUTHORIZED', message: 'Invalid user token' },
      401
    );
  }

  const user = await queryOne<{ id: number; user_email: string | null }>(
    c.env.DB,
    'SELECT id, user_email FROM users WHERE id = ?',
    [payload.user_id]
  );

  if (!user) {
    return c.json(
      { success: false, error: 'NOT_FOUND', message: 'User not found' },
      404
    );
  }

  const roles = await query<{ role_text: string }>(
    c.env.DB,
    'SELECT role_text FROM user_roles WHERE user_id = ? ORDER BY role_text ASC',
    [payload.user_id]
  );

  c.set('user', {
    ...payload,
    user_email: user.user_email,
    roles: roles.map((row) => row.role_text),
  });
  return null;
}

export function isValidLoginEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
