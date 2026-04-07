import { parseAllowedOrigins } from './runtime';

const USER_SESSION_COOKIE = 'tm_user_session';
const USER_CSRF_COOKIE = 'tm_user_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function randomCsrfToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function parseCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    const value = rest.join('=') || '';
    try {
      out[rawKey] = decodeURIComponent(value);
    } catch {
      out[rawKey] = value;
    }
  }
  return out;
}

function originFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

type CsrfValidationInput = {
  method: string;
  url: string;
  headers: {
    header: (name: string) => string | undefined;
  };
  allowedOriginsRaw?: string;
};

type CsrfValidationResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      body: {
        success: false;
        error: 'FORBIDDEN';
        message: string;
      };
    };

export function validateCookieCsrf(input: CsrfValidationInput): CsrfValidationResult {
  if (!MUTATING_METHODS.has(input.method.toUpperCase())) {
    return { ok: true };
  }

  const cookies = parseCookieHeader(input.headers.header('Cookie'));
  if (!cookies[USER_SESSION_COOKIE]) {
    return { ok: true };
  }

  const originHeader = input.headers.header('Origin');
  const origin = originHeader || originFromReferer(input.headers.header('Referer'));
  const requestOrigin = new URL(input.url).origin;
  const allowedOrigins = parseAllowedOrigins(input.allowedOriginsRaw);
  const allowed = new Set(allowedOrigins.length > 0 ? allowedOrigins : [requestOrigin]);

  if (!origin || !allowed.has(origin)) {
    return {
      ok: false,
      status: 403,
      body: {
        success: false,
        error: 'FORBIDDEN',
        message: 'CSRF validation failed: invalid request origin',
      },
    };
  }

  const csrfCookie = String(cookies[USER_CSRF_COOKIE] || '');
  const csrfHeader = String(input.headers.header(CSRF_HEADER) || '');
  if (!csrfCookie || !csrfHeader || !timingSafeEqual(csrfCookie, csrfHeader)) {
    return {
      ok: false,
      status: 403,
      body: {
        success: false,
        error: 'FORBIDDEN',
        message: 'CSRF validation failed: invalid token',
      },
    };
  }

  return { ok: true };
}
