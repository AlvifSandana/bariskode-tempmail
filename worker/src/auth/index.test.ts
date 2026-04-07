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

  it('requires turnstile token on register when configured', async () => {
    const env = createBaseEnv({
      TURNSTILE_SECRET: 'ts_secret',
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
      body: JSON.stringify({ email: 'user@example.com', password: 'password123' }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('CAPTCHA_FAILED');
  });

  it('rejects register when turnstile verification fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const env = createBaseEnv({
      TURNSTILE_SECRET: 'ts_secret',
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
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'password123',
        turnstile_token: 'ts_token',
      }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('CAPTCHA_FAILED');
    vi.unstubAllGlobals();
  });

  it('requires turnstile token on login when configured', async () => {
    const env = createBaseEnv({
      TURNSTILE_SECRET: 'ts_secret',
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
      body: JSON.stringify({ email: 'user@example.com', password: 'password123' }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('CAPTCHA_FAILED');
  });

  it('allows login to continue when turnstile verification succeeds', async () => {
    const passwordHash = await (await import('../utils/crypto')).hashPassword('password123');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const env = createBaseEnv({
      TURNSTILE_SECRET: 'ts_secret',
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
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'password123',
        turnstile_token: 'ts_token',
      }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    vi.unstubAllGlobals();
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
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toContain('tm_user_session=');
    expect(setCookie).toContain('tm_user_csrf=');
  });

  it('rejects cookie-auth logout without csrf token header', async () => {
    const env = createBaseEnv({
      APP_ORIGINS: 'http://localhost',
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        Cookie: 'tm_user_session=user-session; tm_user_csrf=csrf-cookie',
      },
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
  });

  it('allows cookie-auth logout with valid csrf token header', async () => {
    const env = createBaseEnv({
      APP_ORIGINS: 'http://localhost',
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        Cookie: 'tm_user_session=user-session; tm_user_csrf=csrf-cookie',
        'X-CSRF-Token': 'csrf-cookie',
      },
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
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

  it('starts oauth and sets nonce cookie', async () => {
    const env = createBaseEnv({
      KV: createMockKV(),
      OAUTH2_PROVIDERS: JSON.stringify([
        {
          name: 'google',
          client_id: 'cid',
          client_secret: 'csecret',
          redirect_uri: 'http://localhost:5173/user',
        },
      ]),
    });

    const res = await authApp.fetch(new Request('http://localhost/oauth2/google/start'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') || '').toContain('tm_oauth_nonce=');
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.provider).toBe('google');
    expect(String(json.data.auth_url)).toContain('state=');
  });

  it('rejects oauth callback when cookie nonce is missing', async () => {
    const state = 'state-abc';
    const env = createBaseEnv({
      KV: createMockKV({
        [`oauth:state:${state}`]: JSON.stringify({ provider: 'google', session_nonce: 'nonce-1', code_verifier: 'verifier-1' }),
      }),
      OAUTH2_PROVIDERS: JSON.stringify([
        {
          name: 'google',
          client_id: 'cid',
          client_secret: 'csecret',
          redirect_uri: 'http://localhost:5173/user',
        },
      ]),
    });

    const req = new Request('http://localhost/oauth2/google/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'code-1', state }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED');
  });

  it('completes oauth callback with provider-user link priority', async () => {
    const state = 'state-ok';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sub: 'google-sub-1', email: 'linked@example.com', email_verified: true }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const env = createBaseEnv({
      KV: createMockKV({
        [`oauth:state:${state}`]: JSON.stringify({ provider: 'google', session_nonce: 'nonce-ok', code_verifier: 'verifier-ok' }),
      }),
      OAUTH2_PROVIDERS: JSON.stringify([
        {
          name: 'google',
          client_id: 'cid',
          client_secret: 'csecret',
          redirect_uri: 'http://localhost:5173/user',
          token_url: 'https://oauth2.example/token',
          userinfo_url: 'https://oauth2.example/userinfo',
        },
      ]),
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('FROM oauth_connections')) return { id: 7, user_id: 42 };
          if (sql.includes('FROM users WHERE user_email = ?')) return null;
          if (sql.includes('SELECT id, user_email FROM users WHERE id = ?')) {
            return { id: Number(params[0]), user_email: 'linked@example.com' };
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('FROM user_roles')) return [{ role_text: 'default' }];
          return [];
        },
      }),
    });

    const req = new Request('http://localhost/oauth2/google/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'tm_oauth_nonce=nonce-ok',
      },
      body: JSON.stringify({ code: 'ok-code', state }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.user.id).toBe(42);
    expect(json.data.user.user_email).toBe('linked@example.com');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('allows passkey login when both counters are zero', async () => {
    const email = 'passkey@example.com';
    const challenge = 'challenge-0';
    const rpId = 'localhost';
    const origin = 'http://localhost';

    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const publicKey = toB64Url(new Uint8Array(spki));

    const clientDataObj = {
      type: 'webauthn.get',
      challenge,
      origin,
    };
    const clientDataRaw = new TextEncoder().encode(JSON.stringify(clientDataObj));
    const clientDataB64 = toB64Url(clientDataRaw);
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
    const authData = new Uint8Array(37);
    authData.set(rpIdHash, 0);
    authData[32] = 0x05; // user present + user verified
    // signCount is 0 by default for bytes 33..36

    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataRaw));
    const payload = new Uint8Array(authData.length + clientHash.length);
    payload.set(authData, 0);
    payload.set(clientHash, authData.length);
    const signatureRaw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, payload);

    const env = createBaseEnv({
      APP_ORIGINS: origin,
      KV: createMockKV({
        [`passkey:login:${email}:${challenge}`]: '5',
      }),
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('FROM webauthn_credentials WHERE credential_id = ?')) {
            return { user_id: 5, public_key: publicKey, counter: 0 };
          }
          if (sql.includes('SELECT id, user_email FROM users WHERE id = ?')) {
            return { id: 5, user_email: email };
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('FROM user_roles')) return [{ role_text: 'default' }];
          return [];
        },
        run: () => ({ meta: { last_row_id: 1, changes: 1 } }),
      }),
    });

    const req = new Request('http://localhost/passkey/login/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({
        email,
        credential_id: 'cred-1',
        challenge,
        client_data_json: clientDataB64,
        authenticator_data: toB64Url(authData),
        signature: toB64Url(new Uint8Array(signatureRaw)),
      }),
    });

    const res = await authApp.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.user.user_email).toBe(email);
  });
});

function toB64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
