import { Hono } from 'hono';
import { deleteRows, insertAndGetId, query, queryOne } from '../utils/db';
import { hashPassword, verifyPassword } from '../utils/crypto';
import {
  extractBearerToken,
  needsRefresh,
  signUserJWT,
  verifyJWT,
} from '../utils/jwt';
import { checkRateLimit, RATE_LIMIT_PRESETS } from '../utils/rate_limit';
import { isValidLoginEmail } from '../utils/user_auth';
import type { AppBindings } from '../types/env';
import type { User, UserJWT } from '../models/user';

const PASSWORD_MIN_LENGTH = 8;

const app = new Hono<{ Bindings: AppBindings }>();

async function getUserRoles(db: D1Database, userId: number): Promise<string[]> {
  const rows = await query<{ role_text: string }>(
    db,
    'SELECT role_text FROM user_roles WHERE user_id = ? ORDER BY role_text ASC',
    [userId]
  );
  return rows.map((row) => row.role_text);
}

function getAllowedRoleNames(env: AppBindings): string[] {
  const fallback = env.USER_DEFAULT_ROLE || 'default';
  try {
    const parsed = JSON.parse(env.USER_ROLES || '[]') as Array<{ name?: string }>;
    const names = parsed.map((item) => String(item.name || '')).filter(Boolean);
    return names.length > 0 ? names : [fallback];
  } catch {
    return [fallback];
  }
}

app.post('/register', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!isValidLoginEmail(email)) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Invalid email format' }, 400);
    }

    if (password.length < PASSWORD_MIN_LENGTH) {
      return c.json(
        { success: false, error: 'INVALID_REQUEST', message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` },
        400
      );
    }

    const existing = await queryOne<User>(c.env.DB, 'SELECT * FROM users WHERE user_email = ?', [email]);
    if (existing) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Unable to register with provided credentials' }, 400);
    }

    const allowedRoles = getAllowedRoleNames(c.env);
    const configuredDefaultRole = c.env.USER_DEFAULT_ROLE || 'default';
    const defaultRole = allowedRoles.includes(configuredDefaultRole) ? configuredDefaultRole : allowedRoles[0];

    let userId = 0;
    try {
      userId = await insertAndGetId(c.env.DB, 'users', {
        user_email: email,
        password: await hashPassword(password),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('unique')) {
        return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Unable to register with provided credentials' }, 400);
      }
      throw error;
    }

    try {
      await insertAndGetId(c.env.DB, 'user_roles', {
        user_id: userId,
        role_text: defaultRole,
      });
    } catch (error) {
      await deleteRows(c.env.DB, 'users', 'id = ?', [userId]);
      throw error;
    }

    const token = await signUserJWT(userId, email, [defaultRole], c.env);

    return c.json({
      success: true,
      data: {
        token,
        user: {
          id: userId,
          user_email: email,
          roles: [defaultRole],
        },
      },
    });
  } catch (error) {
    console.error('[Auth] register error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Registration failed' }, 500);
  }
});

app.post('/login', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!isValidLoginEmail(email) || !password) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Email and password are required' }, 400);
    }

    const user = await queryOne<User>(c.env.DB, 'SELECT * FROM users WHERE user_email = ?', [email]);
    if (!user || !user.password) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401);
    }

    const validPassword = await verifyPassword(password, user.password);
    if (!validPassword) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401);
    }

    const roles = await getUserRoles(c.env.DB, user.id);
    const token = await signUserJWT(user.id, user.user_email, roles, c.env);

    return c.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          user_email: user.user_email,
          roles,
        },
      },
    });
  } catch (error) {
    console.error('[Auth] login error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Login failed' }, 500);
  }
});

app.post('/refresh', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const authHeader = c.req.header('Authorization') ?? null;
    const token = extractBearerToken(authHeader);
    if (!token) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Authorization required' }, 401);
    }

    const payload = await verifyJWT<UserJWT>(token, c.env);
    if (!payload || payload.type !== 'user') {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid user token' }, 401);
    }

    const dbUser = await queryOne<{ id: number; user_email: string | null }>(
      c.env.DB,
      'SELECT id, user_email FROM users WHERE id = ?',
      [payload.user_id]
    );
    if (!dbUser) {
      return c.json({ success: false, error: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    const roles = await getUserRoles(c.env.DB, payload.user_id);
    const refreshedToken = needsRefresh(token)
      ? await signUserJWT(payload.user_id, dbUser.user_email, roles, c.env)
      : token;

    return c.json({
      success: true,
      data: {
        token: refreshedToken,
        refreshed: refreshedToken !== token,
        user: {
          id: payload.user_id,
          user_email: dbUser.user_email,
          roles,
        },
      },
    });
  } catch (error) {
    console.error('[Auth] refresh error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Token refresh failed' }, 500);
  }
});

export default app;
