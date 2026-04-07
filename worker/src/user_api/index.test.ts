import { describe, expect, it } from 'vitest';
import userApi from './index';
import { createBaseEnv, createMockKV } from '../test/helpers';

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
