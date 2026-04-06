import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBaseEnv } from '../test/helpers';
import {
  decodeJWT,
  extractBearerToken,
  needsRefresh,
  signAddressJWT,
  signUserJWT,
  verifyAdminPassword,
  verifyJWT,
} from './jwt';

describe('jwt utils', () => {
  const env = createBaseEnv();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs and verifies address jwt', async () => {
    const token = await signAddressJWT(1, 'tmp@example.com', env);
    const payload = await verifyJWT<{ address_id: number; address: string; type: string }>(token, env);
    expect(payload?.address_id).toBe(1);
    expect(payload?.address).toBe('tmp@example.com');
    expect(payload?.type).toBe('address');
  });

  it('signs and verifies user jwt', async () => {
    const token = await signUserJWT(5, 'user@example.com', ['default'], env);
    const payload = await verifyJWT<{ user_id: number; user_email: string | null; roles: string[]; type: string }>(token, env);
    expect(payload?.user_id).toBe(5);
    expect(payload?.roles).toEqual(['default']);
    expect(payload?.type).toBe('user');
  });

  it('extracts bearer token', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('Basic abc123')).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it('decodes jwt payload', async () => {
    const token = await signUserJWT(10, 'decode@example.com', ['default'], env);
    const payload = decodeJWT(token);
    expect(payload?.type).toBe('user');
  });

  it('detects refresh need correctly for token lifetime', async () => {
    const shortToken = await signUserJWT(1, 'user@example.com', ['default'], env, 1);
    const longToken = await signUserJWT(1, 'user@example.com', ['default'], env, 30);
    expect(needsRefresh(shortToken)).toBe(true);
    expect(needsRefresh(longToken)).toBe(false);
  });

  it('verifies admin password from bearer token', () => {
    expect(verifyAdminPassword('Bearer admin-secret', 'admin-secret,other')).toBe(true);
    expect(verifyAdminPassword('Bearer wrong', 'admin-secret,other')).toBe(false);
  });
});
