import { describe, expect, it } from 'vitest';
import { validateCookieCsrf } from './csrf';

function headersFrom(input: Record<string, string>) {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    normalized.set(key.toLowerCase(), value);
  }
  return {
    header(name: string) {
      return normalized.get(name.toLowerCase());
    },
  };
}

describe('csrf validation', () => {
  it('allows same-origin cookie-auth request with matching token', () => {
    const result = validateCookieCsrf({
      method: 'POST',
      url: 'https://app.example.com/auth/logout',
      allowedOriginsRaw: 'https://app.example.com',
      headers: headersFrom({
        Origin: 'https://app.example.com',
        Cookie: 'tm_user_session=sess; tm_user_csrf=csrf-ok',
        'X-CSRF-Token': 'csrf-ok',
      }),
    });

    expect(result.ok).toBe(true);
  });

  it('rejects cookie-auth request from cross-origin origin', () => {
    const result = validateCookieCsrf({
      method: 'POST',
      url: 'https://app.example.com/user_api/bind_address',
      allowedOriginsRaw: 'https://app.example.com',
      headers: headersFrom({
        Origin: 'https://evil.example.com',
        Cookie: 'tm_user_session=sess; tm_user_csrf=csrf-ok',
        'X-CSRF-Token': 'csrf-ok',
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.body.message).toContain('origin');
    }
  });

  it('rejects cookie-auth request with invalid csrf token', () => {
    const result = validateCookieCsrf({
      method: 'DELETE',
      url: 'https://app.example.com/user_api/unbind_address',
      allowedOriginsRaw: 'https://app.example.com',
      headers: headersFrom({
        Origin: 'https://app.example.com',
        Cookie: 'tm_user_session=sess; tm_user_csrf=csrf-cookie',
        'X-CSRF-Token': 'csrf-wrong',
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.body.message).toContain('token');
    }
  });

  it('allows mutating request without cookie session (bearer/non-browser path)', () => {
    const result = validateCookieCsrf({
      method: 'POST',
      url: 'https://api.example.com/auth/refresh',
      allowedOriginsRaw: 'https://app.example.com',
      headers: headersFrom({
        Authorization: 'Bearer abc.def.ghi',
      }),
    });

    expect(result.ok).toBe(true);
  });

  it('allows referer-origin fallback when origin header is absent', () => {
    const result = validateCookieCsrf({
      method: 'POST',
      url: 'https://app.example.com/auth/logout',
      allowedOriginsRaw: 'https://app.example.com',
      headers: headersFrom({
        Referer: 'https://app.example.com/user',
        Cookie: 'tm_user_session=sess; tm_user_csrf=csrf-ok',
        'X-CSRF-Token': 'csrf-ok',
      }),
    });

    expect(result.ok).toBe(true);
  });
});
