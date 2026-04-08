import { describe, expect, it } from 'vitest';
import adminApi from './index';
import { createBaseEnv, createMockDB, createMockKV } from '../test/helpers';
import { signUserJWT } from '../utils/jwt';

describe('admin_api auth and csrf guards', () => {
  it('rejects cross-origin cookie admin session on mutating request', async () => {
    const env = createBaseEnv({
      APP_ORIGINS: 'https://app.example.com',
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT 1 as ok FROM user_roles')) {
            return Number(params[0]) === 1 && params[1] === 'admin' ? { ok: 1 } : null;
          }
          return null;
        },
      }),
      KV: createMockKV(),
    });
    const adminToken = await signUserJWT(1, 'admin@example.com', ['admin'], env);

    const req = new Request('https://api.example.com/cleanup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        Cookie: `tm_user_session=${encodeURIComponent(adminToken)}; tm_user_csrf=csrf-token`,
        'X-CSRF-Token': 'csrf-token',
      },
      body: JSON.stringify({ mode: 'old_emails' }),
    });

    const res = await adminApi.fetch(req, env);
    expect(res.status).toBe(403);
  });

  it('allows cookie admin session with valid csrf and origin', async () => {
    const env = createBaseEnv({
      APP_ORIGINS: 'https://app.example.com',
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT 1 as ok FROM user_roles')) {
            return Number(params[0]) === 2 && params[1] === 'admin' ? { ok: 1 } : null;
          }
          return null;
        },
      }),
      KV: createMockKV(),
    });
    const adminToken = await signUserJWT(2, 'admin2@example.com', ['admin'], env);

    const req = new Request('https://api.example.com/cleanup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
        Cookie: `tm_user_session=${encodeURIComponent(adminToken)}; tm_user_csrf=csrf-token`,
        'X-CSRF-Token': 'csrf-token',
      },
      body: JSON.stringify({ mode: 'unsupported_mode' }),
    });

    const res = await adminApi.fetch(req, env);
    // Auth + CSRF passed; handler returns invalid mode
    expect(res.status).toBe(400);
  });

  it('allows legacy admin password bearer without csrf cookie', async () => {
    const env = createBaseEnv({
      ADMIN_PASSWORDS: 'admin-secret',
      DB: createMockDB({
        first: (sql) => {
          if (sql.includes('COUNT(*) as count')) return { count: 0 };
          return null;
        },
      }),
      KV: createMockKV(),
    });

    const req = new Request('https://api.example.com/stats', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer admin-secret',
      },
    });

    const res = await adminApi.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json() as { success?: boolean };
    expect(json.success).toBe(true);
  });
});
