import { describe, expect, it } from 'vitest';
import userApi from './index';
import { createBaseEnv, createMockDB, createMockKV } from '../test/helpers';
import { signAddressJWT, signUserJWT } from '../utils/jwt';

describe('user_api csrf guards', () => {
  it('rejects cross-origin cookie-auth mutating request', async () => {
    const env = createBaseEnv({
      APP_ORIGINS: 'https://app.example.com',
      KV: createMockKV(),
    });

    const req = new Request('https://api.example.com/bind_address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        Cookie: 'tm_user_session=session-token; tm_user_csrf=csrf-token',
        'X-CSRF-Token': 'csrf-token',
      },
      body: JSON.stringify({ address_token: 'dummy' }),
    });

    const res = await userApi.fetch(req, env);
    expect(res.status).toBe(403);
  });

  it('rejects same-origin cookie-auth mutating request with bad token', async () => {
    const env = createBaseEnv({
      APP_ORIGINS: 'https://app.example.com',
      KV: createMockKV(),
    });

    const req = new Request('https://api.example.com/bind_address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
        Cookie: 'tm_user_session=session-token; tm_user_csrf=csrf-token',
        'X-CSRF-Token': 'csrf-other',
      },
      body: JSON.stringify({ address_token: 'dummy' }),
    });

    const res = await userApi.fetch(req, env);
    expect(res.status).toBe(403);
  });

  it('allows same-origin cookie-auth mutating request with valid csrf (then auth may fail)', async () => {
    const env = createBaseEnv({
      APP_ORIGINS: 'https://app.example.com',
      KV: createMockKV(),
    });

    const req = new Request('https://api.example.com/bind_address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
        Cookie: 'tm_user_session=session-token; tm_user_csrf=csrf-token',
        'X-CSRF-Token': 'csrf-token',
      },
      body: JSON.stringify({ address_token: 'dummy' }),
    });

    const res = await userApi.fetch(req, env);
    expect(res.status).not.toBe(403);
  });
});

describe('user_api role-based limits', () => {
  it('rejects bind_address when role max_address is reached', async () => {
    const env = createBaseEnv({
      KV: createMockKV(),
      USER_ROLES: '[{"name":"default","domains":["example.com"],"prefix":"tmp","max_address":1}]',
      USER_DEFAULT_ROLE: 'default',
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT id, user_email FROM users WHERE id = ?')) {
            return { id: 1, user_email: 'user@example.com' };
          }
          if (sql.includes('SELECT * FROM address WHERE id = ?')) {
            return {
              id: Number(params[0]),
              name: 'tmp_test@example.com',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              password: null,
              source_ip: '127.0.0.1',
              balance: 0,
            };
          }
          if (sql.includes('SELECT user_id FROM user_address WHERE address_id = ? LIMIT 1')) {
            return null;
          }
          if (sql.includes('SELECT id FROM user_address WHERE user_id = ? AND address_id = ?')) {
            return null;
          }
          if (sql.includes('SELECT COUNT(*) as count FROM user_address WHERE user_id = ?')) {
            return { count: 1 };
          }
          if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
            return null;
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('SELECT role_text FROM user_roles WHERE user_id = ?')) {
            return [{ role_text: 'default' }];
          }
          return [];
        },
        run: () => ({ meta: { last_row_id: 1, changes: 0 } }),
      }),
    });

    const userToken = await signUserJWT(1, 'user@example.com', ['default'], env);
    const addressToken = await signAddressJWT(2, 'tmp_test@example.com', env);

    const req = new Request('https://api.example.com/bind_address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ address_token: addressToken }),
    });

    const res = await userApi.fetch(req, env);
    const json = await res.json() as { error?: string; success?: boolean };

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error).toBe('ROLE_LIMIT_REACHED');
  });

  it('uses default-role fallback when user role is unknown and allows bind under limit', async () => {
    const env = createBaseEnv({
      KV: createMockKV(),
      USER_ROLES: '[{"name":"default","domains":["example.com"],"prefix":"tmp","max_address":2}]',
      USER_DEFAULT_ROLE: 'default',
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT id, user_email FROM users WHERE id = ?')) {
            return { id: 1, user_email: 'user@example.com' };
          }
          if (sql.includes('SELECT * FROM address WHERE id = ?')) {
            return {
              id: Number(params[0]),
              name: 'tmp_test@example.com',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              password: null,
              source_ip: '127.0.0.1',
              balance: 0,
            };
          }
          if (sql.includes('SELECT user_id FROM user_address WHERE address_id = ? LIMIT 1')) {
            return null;
          }
          if (sql.includes('SELECT id FROM user_address WHERE user_id = ? AND address_id = ?')) {
            return null;
          }
          if (sql.includes('SELECT COUNT(*) as count FROM user_address WHERE user_id = ?')) {
            return { count: 1 };
          }
          if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
            return null;
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('SELECT role_text FROM user_roles WHERE user_id = ?')) {
            return [{ role_text: 'legacy_role' }];
          }
          return [];
        },
        run: () => ({ meta: { last_row_id: 1, changes: 1 } }),
      }),
    });

    const userToken = await signUserJWT(1, 'user@example.com', ['legacy_role'], env);
    const addressToken = await signAddressJWT(2, 'tmp_test@example.com', env);

    const req = new Request('https://api.example.com/bind_address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ address_token: addressToken }),
    });

    const res = await userApi.fetch(req, env);
    const json = await res.json() as { success?: boolean };

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });

  it('rejects bind_address when no role policy can be resolved', async () => {
    const env = createBaseEnv({
      KV: createMockKV(),
      USER_ROLES: '[]',
      USER_DEFAULT_ROLE: 'unknown_default',
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT id, user_email FROM users WHERE id = ?')) {
            return { id: 1, user_email: 'user@example.com' };
          }
          if (sql.includes('SELECT * FROM address WHERE id = ?')) {
            return {
              id: Number(params[0]),
              name: 'tmp_test@example.com',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              password: null,
              source_ip: '127.0.0.1',
              balance: 0,
            };
          }
          if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
            return null;
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('SELECT role_text FROM user_roles WHERE user_id = ?')) {
            return [{ role_text: 'legacy_role' }];
          }
          return [];
        },
        run: () => ({ meta: { last_row_id: 1, changes: 1 } }),
      }),
    });

    const userToken = await signUserJWT(1, 'user@example.com', ['legacy_role'], env);
    const addressToken = await signAddressJWT(2, 'tmp_test@example.com', env);

    const req = new Request('https://api.example.com/bind_address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ address_token: addressToken }),
    });

    const res = await userApi.fetch(req, env);
    const json = await res.json() as { success?: boolean; error?: string };

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error).toBe('FORBIDDEN');
  });

  it('rejects bind_address when address domain is outside role domains', async () => {
    const env = createBaseEnv({
      KV: createMockKV(),
      USER_ROLES: '[{"name":"vip","domains":["vip.example.com"],"prefix":"vip","max_address":5}]',
      USER_DEFAULT_ROLE: 'vip',
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT id, user_email FROM users WHERE id = ?')) {
            return { id: 1, user_email: 'user@example.com' };
          }
          if (sql.includes('SELECT * FROM address WHERE id = ?')) {
            return {
              id: Number(params[0]),
              name: 'tmp_test@example.com',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              password: null,
              source_ip: '127.0.0.1',
              balance: 0,
            };
          }
          if (sql.includes('SELECT user_id FROM user_address WHERE address_id = ? LIMIT 1')) {
            return null;
          }
          if (sql.includes('SELECT id FROM user_address WHERE user_id = ? AND address_id = ?')) {
            return null;
          }
          if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
            return null;
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('SELECT role_text FROM user_roles WHERE user_id = ?')) {
            return [{ role_text: 'vip' }];
          }
          return [];
        },
        run: () => ({ meta: { last_row_id: 1, changes: 1 } }),
      }),
    });

    const userToken = await signUserJWT(1, 'user@example.com', ['vip'], env);
    const addressToken = await signAddressJWT(2, 'tmp_test@example.com', env);

    const req = new Request('https://api.example.com/bind_address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ address_token: addressToken }),
    });

    const res = await userApi.fetch(req, env);
    const json = await res.json() as { success?: boolean; error?: string };

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error).toBe('FORBIDDEN');
  });
});
