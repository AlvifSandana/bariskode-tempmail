import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import commonApi from './index';
import { createBaseEnv, createMockDB, createMockKV } from '../test/helpers';
import { hashPassword } from '../utils/crypto';
import { signAddressJWT } from '../utils/jwt';

describe('common api send_mail and address_auth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('authenticates address password and returns jwt', async () => {
    const passwordHash = await hashPassword('addr-pass');
    const env = createBaseEnv({
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT * FROM address WHERE name = ?')) {
            return {
              id: 99,
              name: params[0],
              password: passwordHash,
              created_at: '2025-01-01',
              updated_at: '2025-01-01',
              source_ip: null,
              balance: 0,
            };
          }
          return null;
        },
      }),
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/address_auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'tmp@example.com', password: 'addr-pass' }),
    });

    const res = await commonApi.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.address).toBe('tmp@example.com');
    expect(typeof json.data.token).toBe('string');
  });

  it('rejects invalid address password', async () => {
    const passwordHash = await hashPassword('addr-pass');
    const env = createBaseEnv({
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT * FROM address WHERE name = ?')) {
            return {
              id: 99,
              name: params[0],
              password: passwordHash,
              created_at: '2025-01-01',
              updated_at: '2025-01-01',
              source_ip: null,
              balance: 0,
            };
          }
          return null;
        },
      }),
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/address_auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'tmp@example.com', password: 'wrong-pass' }),
    });

    const res = await commonApi.fetch(req, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('rejects invalid send_mail recipient', async () => {
    const env = createBaseEnv({
      DB: createMockDB({
        run: () => ({ meta: { last_row_id: 1, changes: 1 } }),
      }),
      KV: createMockKV(),
    });
    const token = await signAddressJWT(1, 'tmp@example.com', env);

    const req = new Request('http://localhost/send_mail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ to: 'invalid', subject: 'Hi', body: 'Hello' }),
    });

    const res = await commonApi.fetch(req, env);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('uses Resend API when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '', json: async () => ({ id: 're_1' }) });
    vi.stubGlobal('fetch', fetchMock);

    const env = createBaseEnv({
      DB: createMockDB({
        run: () => ({ meta: { last_row_id: 123, changes: 1 } }),
      }),
      KV: createMockKV(),
      RESEND_API_KEY: 're_test_key',
    });
    const token = await signAddressJWT(1, 'tmp@example.com', env);

    const req = new Request('http://localhost/send_mail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ to: 'user@example.com', subject: 'Hi', body: 'Hello' }),
    });

    const res = await commonApi.fetch(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.mode).toBe('resend_api');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects missing auth on send_mail', async () => {
    const env = createBaseEnv({
      DB: createMockDB({ run: () => ({ meta: { last_row_id: 1, changes: 1 } }) }),
      KV: createMockKV(),
    });

    const req = new Request('http://localhost/send_mail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ to: 'user@example.com', subject: 'Hi', body: 'Hello' }),
    });

    const res = await commonApi.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('rejects CRLF in subject to prevent header injection', async () => {
    const env = createBaseEnv({
      DB: createMockDB({ run: () => ({ meta: { last_row_id: 1, changes: 1 } }) }),
      KV: createMockKV(),
    });
    const token = await signAddressJWT(1, 'tmp@example.com', env);

    const req = new Request('http://localhost/send_mail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ to: 'user@example.com', subject: 'Hello\r\nBcc:evil@example.com', body: 'Hello' }),
    });

    const res = await commonApi.fetch(req, env);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('returns generic error when Resend fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, text: async () => 'provider internal detail' });
    vi.stubGlobal('fetch', fetchMock);

    const env = createBaseEnv({
      DB: createMockDB({ run: () => ({ meta: { last_row_id: 123, changes: 1 } }) }),
      KV: createMockKV(),
      RESEND_API_KEY: 're_test_key',
    });
    const token = await signAddressJWT(1, 'tmp@example.com', env);

    const req = new Request('http://localhost/send_mail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': '127.0.0.1',
      },
      body: JSON.stringify({ to: 'user@example.com', subject: 'Hi', body: 'Hello' }),
    });

    const res = await commonApi.fetch(req, env);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.message).toBe('Outbound delivery failed');
  });
});
