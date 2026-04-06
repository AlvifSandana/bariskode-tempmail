import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import authApp from './index';
import { createBaseEnv, createMockDB, createMockKV, getCurrentRateLimitWindow } from '../test/helpers';
import { signUserJWT } from '../utils/jwt';

describe('auth routes smoke tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects invalid register email', async () => {
    const env = createBaseEnv({
      DB: createMockDB({
        first: () => null,
        run: () => ({ meta: { last_row_id: 1, changes: 1 } }),
      }),
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ email: 'invalid', password: 'password123' }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('rejects login for unknown user', async () => {
    const env = createBaseEnv({
      DB: createMockDB({
        first: () => null,
        all: () => [],
      }),
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ email: 'missing@example.com', password: 'password123' }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED');
  });

  it('rejects login for wrong password', async () => {
    const passwordHash = await (await import('../utils/crypto')).hashPassword('password123');
    const env = createBaseEnv({
      DB: createMockDB({
        first: (sql) => {
          if (sql.includes('FROM users WHERE user_email')) {
            return {
              id: 1,
              user_email: 'user@example.com',
              password: passwordHash,
              created_at: '2025-01-01',
              updated_at: '2025-01-01',
            };
          }
          return null;
        },
        all: () => [{ role_text: 'default' }],
      }),
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ email: 'user@example.com', password: 'wrong-password' }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED');
  });

  it('logs in successfully with valid credentials', async () => {
    const passwordHash = await (await import('../utils/crypto')).hashPassword('password123');
    const env = createBaseEnv({
      DB: createMockDB({
        first: (sql) => {
          if (sql.includes('FROM users WHERE user_email')) {
            return {
              id: 1,
              user_email: 'user@example.com',
              password: passwordHash,
              created_at: '2025-01-01',
              updated_at: '2025-01-01',
            };
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('FROM user_roles')) {
            return [{ role_text: 'default' }];
          }
          return [];
        },
      }),
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ email: 'user@example.com', password: 'password123' }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.user.user_email).toBe('user@example.com');
    expect(typeof json.data.token).toBe('string');
  });

  it('returns 429 when auth rate limit is exceeded', async () => {
    const windowStart = getCurrentRateLimitWindow(15 * 60 * 1000);
    const env = createBaseEnv({
      DB: createMockDB({
        first: () => null,
        all: () => [],
      }),
      KV: createMockKV({
        'auth:127.0.0.1': `10:${windowStart}`,
      }),
    });

    const req = new Request('http://localhost/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ email: 'user@example.com', password: 'password123' }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('RATE_LIMITED');
  });

  it('rejects refresh without authorization', async () => {
    const env = createBaseEnv({
      DB: createMockDB({ first: () => null, all: () => [] }),
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/refresh', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '127.0.0.1',
      },
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED');
  });

  it('refreshes valid user token and returns current db user data', async () => {
    const env = createBaseEnv({
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT id, user_email FROM users WHERE id = ?')) {
            return { id: params[0], user_email: 'fresh@example.com' };
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('FROM user_roles')) {
            return [{ role_text: 'default' }, { role_text: 'vip' }];
          }
          return [];
        },
      }),
      KV: createMockKV(),
    });
    const token = await signUserJWT(5, 'stale@example.com', ['default'], env, 1);

    const req = new Request('http://localhost/refresh', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': '127.0.0.1',
      },
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.user.user_email).toBe('fresh@example.com');
    expect(json.data.user.roles).toEqual(['default', 'vip']);
    expect(typeof json.data.refreshed).toBe('boolean');
  });
});
