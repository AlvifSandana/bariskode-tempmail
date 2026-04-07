import { describe, expect, it, vi } from 'vitest';
import { extractTurnstileToken, verifyTurnstileToken } from './turnstile';

describe('turnstile utils', () => {
  it('extracts token from supported request body keys', () => {
    expect(extractTurnstileToken({ turnstile_token: 'a' })).toBe('a');
    expect(extractTurnstileToken({ captcha_token: 'b' })).toBe('b');
    expect(extractTurnstileToken({ cf_turnstile_response: 'c' })).toBe('c');
    expect(extractTurnstileToken({ 'cf-turnstile-response': 'd' })).toBe('d');
  });

  it('returns empty string when no token is present', () => {
    expect(extractTurnstileToken({})).toBe('');
    expect(extractTurnstileToken(null)).toBe('');
  });

  it('verifies token and omits invalid remoteip value', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyTurnstileToken({
      secret: 'secret',
      token: 'token',
      remoteIp: 'unknown',
    });

    expect(result.success).toBe(true);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = String(init?.body || '');
    expect(body).not.toContain('remoteip=unknown');
    vi.unstubAllGlobals();
  });
});
