import { Hono } from 'hono';
import { deleteRows, execute, insertAndGetId, query, queryOne } from '../utils/db';
import { hashPassword, verifyPassword } from '../utils/crypto';
import {
  extractBearerToken,
  needsRefresh,
  signUserJWT,
  verifyJWT,
} from '../utils/jwt';
import { parseCookieHeader, randomCsrfToken, validateCookieCsrf } from '../utils/csrf';
import { checkRateLimit, RATE_LIMIT_PRESETS } from '../utils/rate_limit';
import { isValidLoginEmail } from '../utils/user_auth';
import type { AppBindings } from '../types/env';
import type { User, UserJWT } from '../models/user';

const PASSWORD_MIN_LENGTH = 8;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;
const USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const USER_SESSION_COOKIE = 'tm_user_session';
const USER_CSRF_COOKIE = 'tm_user_csrf';

const app = new Hono<{ Bindings: AppBindings }>();

const AUTH_CSRF_PROTECTED_PATHS = new Set([
  '/refresh',
  '/passkey/register/challenge',
  '/passkey/register/complete',
  '/logout',
]);

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const authPath = path.startsWith('/auth') ? path.slice('/auth'.length) || '/' : path;
  if (!AUTH_CSRF_PROTECTED_PATHS.has(authPath)) {
    return next();
  }

  const csrf = validateCookieCsrf({
    method: c.req.method,
    url: c.req.url,
    headers: c.req,
    allowedOriginsRaw: c.env.APP_ORIGINS,
  });
  if (!csrf.ok) {
    return c.json(csrf.body, csrf.status);
  }
  await next();
});

type OAuth2ProviderConfig = {
  name: string;
  client_id: string;
  client_secret: string;
  auth_url: string;
  token_url: string;
  userinfo_url: string;
  scope?: string;
  redirect_uri: string;
};

type GoogleUserInfo = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
};

async function getUserRoles(db: D1Database, userId: number): Promise<string[]> {
  const rows = await query<{ role_text: string }>(
    db,
    'SELECT role_text FROM user_roles WHERE user_id = ? ORDER BY role_text ASC',
    [userId]
  );
  return rows.map((row) => row.role_text);
}

function getAllowedRoleNames(env: AppBindings): string[] {
  const fallback = env.USER_DEFAULT_ROLE || 'default';
  try {
    const parsed = JSON.parse(env.USER_ROLES || '[]') as Array<{ name?: string }>;
    const names = parsed.map((item) => String(item.name || '')).filter(Boolean);
    return names.length > 0 ? names : [fallback];
  } catch {
    return [fallback];
  }
}

function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomBase64Url(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function normalizeProviderName(value: string): string {
  return value.trim().toLowerCase();
}

function parseOAuthProviders(env: AppBindings): OAuth2ProviderConfig[] {
  try {
    const parsed = JSON.parse(env.OAUTH2_PROVIDERS || '[]') as OAuth2ProviderConfig[];
    return parsed
      .filter((provider) => provider && normalizeProviderName(provider.name) === 'google')
      .filter((provider) => provider.client_id && provider.client_secret && provider.redirect_uri)
      .map((provider) => ({
        ...provider,
        name: normalizeProviderName(provider.name),
        auth_url: provider.auth_url || 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: provider.token_url || 'https://oauth2.googleapis.com/token',
        userinfo_url: provider.userinfo_url || 'https://openidconnect.googleapis.com/v1/userinfo',
        scope: provider.scope || 'openid email profile',
      }));
  } catch {
    return [];
  }
}

async function resolveOrCreateUserByEmail(env: AppBindings, email: string): Promise<{ id: number; roles: string[] }> {
  const normalizedEmail = email.trim().toLowerCase();
  let user = await queryOne<User>(env.DB, 'SELECT * FROM users WHERE user_email = ?', [normalizedEmail]);
  const allowedRoles = getAllowedRoleNames(env);
  const configuredDefaultRole = env.USER_DEFAULT_ROLE || 'default';
  const defaultRole = allowedRoles.includes(configuredDefaultRole) ? configuredDefaultRole : allowedRoles[0];

  if (!user) {
    const userId = await insertAndGetId(env.DB, 'users', {
      user_email: normalizedEmail,
      password: null,
    });

    await insertAndGetId(env.DB, 'user_roles', {
      user_id: userId,
      role_text: defaultRole,
    });

    user = await queryOne<User>(env.DB, 'SELECT * FROM users WHERE id = ?', [userId]);
  }

  const roles = await getUserRoles(env.DB, user!.id);
  return { id: user!.id, roles: roles.length > 0 ? roles : [defaultRole] };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return new Uint8Array(digest);
}

function parseAllowedOriginsRaw(origins: string | undefined): string[] {
  return (origins || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getUserSessionToken(c: { req: { header(name: string): string | undefined } }): string | null {
  const authHeader = c.req.header('Authorization') ?? null;
  const bearer = extractBearerToken(authHeader);
  if (bearer) return bearer;
  const cookies = parseCookieHeader(c.req.header('Cookie'));
  const fromCookie = String(cookies[USER_SESSION_COOKIE] || '').trim();
  return fromCookie || null;
}

function setUserSessionCookie(c: { header(name: string, value: string): void }, token: string) {
  const csrfToken = randomCsrfToken();
  c.header(
    'Set-Cookie',
    `${USER_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${USER_SESSION_TTL_SECONDS}`,
    { append: true }
  );
  c.header(
    'Set-Cookie',
    `${USER_CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Secure; SameSite=Lax; Path=/; Max-Age=${USER_SESSION_TTL_SECONDS}`,
    { append: true }
  );
}

function clearUserSessionCookie(c: { header(name: string, value: string): void }) {
  c.header('Set-Cookie', `${USER_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
  c.header('Set-Cookie', `${USER_CSRF_COOKIE}=; Secure; SameSite=Lax; Path=/; Max-Age=0`, { append: true });
}

function getRequestOrigin(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function getRpId(url: string): string {
  return new URL(url).hostname;
}

function parseClientDataJSON(clientDataJsonB64: string): {
  type: string;
  challenge: string;
  origin: string;
  rawBytes: Uint8Array;
} | null {
  try {
    const rawBytes = fromBase64Url(clientDataJsonB64);
    const parsed = JSON.parse(new TextDecoder().decode(rawBytes)) as {
      type?: string;
      challenge?: string;
      origin?: string;
    };
    if (!parsed.type || !parsed.challenge || !parsed.origin) return null;
    return {
      type: parsed.type,
      challenge: parsed.challenge,
      origin: parsed.origin,
      rawBytes,
    };
  } catch {
    return null;
  }
}

function parseAuthenticatorData(authData: Uint8Array): {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
} | null {
  if (authData.length < 37) return null;
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount =
    (authData[33] << 24) |
    (authData[34] << 16) |
    (authData[35] << 8) |
    authData[36];
  return { rpIdHash, flags, signCount: signCount >>> 0 };
}

async function verifyWebAuthnAssertion(params: {
  rpId: string;
  challenge: string;
  expectedOrigin: string[];
  clientDataJsonB64: string;
  authenticatorDataB64: string;
  signatureB64: string;
  publicKeySpkiB64: string;
  expectedType: 'webauthn.get' | 'webauthn.create';
}): Promise<{ valid: boolean; signCount: number }> {
  const clientData = parseClientDataJSON(params.clientDataJsonB64);
  if (!clientData) return { valid: false, signCount: 0 };
  if (clientData.type !== params.expectedType) return { valid: false, signCount: 0 };
  if (clientData.challenge !== params.challenge) return { valid: false, signCount: 0 };
  if (!params.expectedOrigin.includes(clientData.origin)) return { valid: false, signCount: 0 };

  const authData = fromBase64Url(params.authenticatorDataB64);
  const parsedAuthData = parseAuthenticatorData(authData);
  if (!parsedAuthData) return { valid: false, signCount: 0 };

  const rpIdHashExpected = await sha256Bytes(new TextEncoder().encode(params.rpId));
  if (!bytesEqual(parsedAuthData.rpIdHash, rpIdHashExpected)) {
    return { valid: false, signCount: 0 };
  }

  const userPresent = (parsedAuthData.flags & 0x01) !== 0;
  if (!userPresent) return { valid: false, signCount: 0 };
  const userVerified = (parsedAuthData.flags & 0x04) !== 0;
  if (!userVerified) return { valid: false, signCount: 0 };

  const clientHash = await sha256Bytes(clientData.rawBytes);
  const signedPayload = new Uint8Array(authData.length + clientHash.length);
  signedPayload.set(authData, 0);
  signedPayload.set(clientHash, authData.length);

  try {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      fromBase64Url(params.publicKeySpkiB64),
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      false,
      ['verify']
    );

    const verified = await crypto.subtle.verify(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      publicKey,
      fromBase64Url(params.signatureB64),
      signedPayload
    );

    return { valid: verified, signCount: parsedAuthData.signCount };
  } catch {
    return { valid: false, signCount: 0 };
  }
}

function decodeCborLength(data: Uint8Array, offset: number, additionalInfo: number): { length: number; next: number } {
  if (additionalInfo < 24) return { length: additionalInfo, next: offset };
  if (additionalInfo === 24) return { length: data[offset], next: offset + 1 };
  if (additionalInfo === 25) {
    return { length: (data[offset] << 8) | data[offset + 1], next: offset + 2 };
  }
  if (additionalInfo === 26) {
    return {
      length: (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3],
      next: offset + 4,
    };
  }
  throw new Error('Unsupported CBOR length encoding');
}

function decodeCborItem(data: Uint8Array, start = 0): { value: unknown; next: number } {
  const initial = data[start];
  const majorType = initial >> 5;
  const additionalInfo = initial & 0x1f;
  let offset = start + 1;

  if (majorType === 0 || majorType === 1) {
    const { length, next } = decodeCborLength(data, offset, additionalInfo);
    const num = length;
    return { value: majorType === 0 ? num : -1 - num, next };
  }

  if (majorType === 2 || majorType === 3) {
    const { length, next } = decodeCborLength(data, offset, additionalInfo);
    offset = next;
    const slice = data.slice(offset, offset + length);
    offset += length;
    if (majorType === 2) return { value: slice, next: offset };
    return { value: new TextDecoder().decode(slice), next: offset };
  }

  if (majorType === 4) {
    const { length, next } = decodeCborLength(data, offset, additionalInfo);
    offset = next;
    const arr: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const item = decodeCborItem(data, offset);
      arr.push(item.value);
      offset = item.next;
    }
    return { value: arr, next: offset };
  }

  if (majorType === 5) {
    const { length, next } = decodeCborLength(data, offset, additionalInfo);
    offset = next;
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < length; i++) {
      const keyItem = decodeCborItem(data, offset);
      offset = keyItem.next;
      const valueItem = decodeCborItem(data, offset);
      offset = valueItem.next;
      map.set(keyItem.value, valueItem.value);
    }
    return { value: map, next: offset };
  }

  if (majorType === 7) {
    if (additionalInfo === 20) return { value: false, next: offset };
    if (additionalInfo === 21) return { value: true, next: offset };
    if (additionalInfo === 22) return { value: null, next: offset };
  }

  throw new Error('Unsupported CBOR item');
}

function parseAttestationObject(attestationObjectB64: string): {
  fmt: string;
  authData: Uint8Array;
} | null {
  try {
    const decoded = decodeCborItem(fromBase64Url(attestationObjectB64));
    if (!(decoded.value instanceof Map)) return null;
    const map = decoded.value as Map<unknown, unknown>;
    const fmt = map.get('fmt');
    const authData = map.get('authData');
    if (typeof fmt !== 'string' || !(authData instanceof Uint8Array)) return null;
    return { fmt, authData };
  } catch {
    return null;
  }
}

async function coseEc2ToSpki(cosePublicKeyBytes: Uint8Array): Promise<string | null> {
  try {
    const decoded = decodeCborItem(cosePublicKeyBytes);
    if (!(decoded.value instanceof Map)) return null;
    const map = decoded.value as Map<unknown, unknown>;

    const kty = map.get(1);
    const alg = map.get(3);
    const crv = map.get(-1);
    const x = map.get(-2);
    const y = map.get(-3);
    if (kty !== 2 || alg !== -7 || crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      return null;
    }

    const uncompressed = new Uint8Array(1 + x.length + y.length);
    uncompressed[0] = 0x04;
    uncompressed.set(x, 1);
    uncompressed.set(y, 1 + x.length);

    const imported = await crypto.subtle.importKey(
      'raw',
      uncompressed,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true,
      ['verify']
    );
    const spki = await crypto.subtle.exportKey('spki', imported);
    return toBase64Url(new Uint8Array(spki));
  } catch {
    return null;
  }
}

async function parseRegistrationAuthData(authData: Uint8Array): Promise<{
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId: string;
  publicKeySpki: string;
} | null> {
  if (authData.length < 55) return null;
  const parsed = parseAuthenticatorData(authData);
  if (!parsed) return null;

  const attestedCredentialDataFlag = (parsed.flags & 0x40) !== 0;
  if (!attestedCredentialDataFlag) return null;

  const credIdLenOffset = 53;
  const credentialIdLength = (authData[credIdLenOffset] << 8) | authData[credIdLenOffset + 1];
  const credentialIdStart = credIdLenOffset + 2;
  const credentialIdEnd = credentialIdStart + credentialIdLength;
  if (credentialIdEnd > authData.length) return null;
  const credentialId = toBase64Url(authData.slice(credentialIdStart, credentialIdEnd));

  const coseStart = credentialIdEnd;
  const coseDecoded = decodeCborItem(authData, coseStart);
  const coseBytes = authData.slice(coseStart, coseDecoded.next);
  const publicKeySpki = await coseEc2ToSpki(coseBytes);
  if (!publicKeySpki) return null;

  return {
    rpIdHash: parsed.rpIdHash,
    flags: parsed.flags,
    signCount: parsed.signCount,
    credentialId,
    publicKeySpki,
  };
}

app.post('/register', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!isValidLoginEmail(email)) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Invalid email format' }, 400);
    }

    if (password.length < PASSWORD_MIN_LENGTH) {
      return c.json(
        { success: false, error: 'INVALID_REQUEST', message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` },
        400
      );
    }

    const existing = await queryOne<User>(c.env.DB, 'SELECT * FROM users WHERE user_email = ?', [email]);
    if (existing) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Unable to register with provided credentials' }, 400);
    }

    const allowedRoles = getAllowedRoleNames(c.env);
    const configuredDefaultRole = c.env.USER_DEFAULT_ROLE || 'default';
    const defaultRole = allowedRoles.includes(configuredDefaultRole) ? configuredDefaultRole : allowedRoles[0];

    let userId = 0;
    try {
      userId = await insertAndGetId(c.env.DB, 'users', {
        user_email: email,
        password: await hashPassword(password),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('unique')) {
        return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Unable to register with provided credentials' }, 400);
      }
      throw error;
    }

    try {
      await insertAndGetId(c.env.DB, 'user_roles', {
        user_id: userId,
        role_text: defaultRole,
      });
    } catch (error) {
      await deleteRows(c.env.DB, 'users', 'id = ?', [userId]);
      throw error;
    }

    const token = await signUserJWT(userId, email, [defaultRole], c.env);
    setUserSessionCookie(c, token);

    return c.json({
      success: true,
      data: {
        token,
        user: {
          id: userId,
          user_email: email,
          roles: [defaultRole],
        },
      },
    });
  } catch (error) {
    console.error('[Auth] register error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Registration failed' }, 500);
  }
});

app.post('/login', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!isValidLoginEmail(email) || !password) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Email and password are required' }, 400);
    }

    const user = await queryOne<User>(c.env.DB, 'SELECT * FROM users WHERE user_email = ?', [email]);
    if (!user || !user.password) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401);
    }

    const validPassword = await verifyPassword(password, user.password);
    if (!validPassword) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401);
    }

    const roles = await getUserRoles(c.env.DB, user.id);
    const token = await signUserJWT(user.id, user.user_email, roles, c.env);
    setUserSessionCookie(c, token);

    return c.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          user_email: user.user_email,
          roles,
        },
      },
    });
  } catch (error) {
    console.error('[Auth] login error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Login failed' }, 500);
  }
});

app.post('/refresh', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const token = getUserSessionToken(c);
    if (!token) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Authorization required' }, 401);
    }

    const payload = await verifyJWT<UserJWT>(token, c.env);
    if (!payload || payload.type !== 'user') {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid user token' }, 401);
    }

    const dbUser = await queryOne<{ id: number; user_email: string | null }>(
      c.env.DB,
      'SELECT id, user_email FROM users WHERE id = ?',
      [payload.user_id]
    );
    if (!dbUser) {
      return c.json({ success: false, error: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    const roles = await getUserRoles(c.env.DB, payload.user_id);
    const refreshedToken = needsRefresh(token)
      ? await signUserJWT(payload.user_id, dbUser.user_email, roles, c.env)
      : token;
    setUserSessionCookie(c, refreshedToken);

    return c.json({
      success: true,
      data: {
        token: refreshedToken,
        refreshed: refreshedToken !== token,
        user: {
          id: payload.user_id,
          user_email: dbUser.user_email,
          roles,
        },
      },
    });
  } catch (error) {
    console.error('[Auth] refresh error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Token refresh failed' }, 500);
  }
});

app.get('/oauth2/providers', async (c) => {
  const providers = parseOAuthProviders(c.env).map((provider) => ({
    name: provider.name,
    auth_url: provider.auth_url,
  }));
  return c.json({ success: true, data: { providers } });
});

app.get('/oauth2/:provider/start', async (c) => {
  try {
    const providerName = normalizeProviderName(c.req.param('provider') || '');
    const provider = parseOAuthProviders(c.env).find((item) => item.name === providerName);
    if (!provider) {
      return c.json({ success: false, error: 'NOT_FOUND', message: 'OAuth provider not configured' }, 404);
    }

    const state = randomToken(24);
    const sessionNonce = randomToken(18);
    const codeVerifier = randomBase64Url(32);
    const codeChallengeBytes = await sha256Bytes(new TextEncoder().encode(codeVerifier));
    const codeChallenge = toBase64Url(codeChallengeBytes);
    await c.env.KV.put(`oauth:state:${state}`, JSON.stringify({ provider: provider.name, session_nonce: sessionNonce, code_verifier: codeVerifier, created_at: Date.now() }), {
      expirationTtl: OAUTH_STATE_TTL_SECONDS,
    });
    c.header(
      'Set-Cookie',
      `tm_oauth_nonce=${encodeURIComponent(sessionNonce)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OAUTH_STATE_TTL_SECONDS}`
    );

    const authUrl = new URL(provider.auth_url);
    authUrl.searchParams.set('client_id', provider.client_id);
    authUrl.searchParams.set('redirect_uri', provider.redirect_uri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', provider.scope || 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    return c.json({
      success: true,
      data: {
        provider: provider.name,
        state,
        auth_url: authUrl.toString(),
      },
    });
  } catch (error) {
    console.error('[Auth] oauth start error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to start OAuth flow' }, 500);
  }
});

async function handleOAuthCallback(providerNameInput: string, code: string, state: string, sessionNonce: string, env: AppBindings) {
  const providerName = normalizeProviderName(providerNameInput);
  const provider = parseOAuthProviders(env).find((item) => item.name === providerName);
  if (!provider) {
    return { ok: false as const, status: 404, body: { success: false, error: 'NOT_FOUND', message: 'OAuth provider not configured' } };
  }

  const statePayload = await env.KV.get(`oauth:state:${state}`);
  if (!statePayload) {
    return { ok: false as const, status: 401, body: { success: false, error: 'UNAUTHORIZED', message: 'Invalid OAuth state' } };
  }
  await env.KV.delete(`oauth:state:${state}`);

  const stateData = JSON.parse(statePayload) as { provider?: string; session_nonce?: string; code_verifier?: string };
  if (normalizeProviderName(stateData.provider || '') !== provider.name) {
    return { ok: false as const, status: 401, body: { success: false, error: 'UNAUTHORIZED', message: 'OAuth provider mismatch' } };
  }
  if (!sessionNonce || String(stateData.session_nonce || '') !== sessionNonce) {
    return { ok: false as const, status: 401, body: { success: false, error: 'UNAUTHORIZED', message: 'OAuth session nonce mismatch' } };
  }
  const codeVerifier = String(stateData.code_verifier || '');
  if (!codeVerifier) {
    return { ok: false as const, status: 401, body: { success: false, error: 'UNAUTHORIZED', message: 'OAuth PKCE verifier missing' } };
  }

  const tokenResponse = await fetch(provider.token_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: provider.client_id,
      client_secret: provider.client_secret,
      redirect_uri: provider.redirect_uri,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!tokenResponse.ok) {
    return { ok: false as const, status: 401, body: { success: false, error: 'UNAUTHORIZED', message: 'OAuth token exchange failed' } };
  }

  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenBody.access_token) {
    return { ok: false as const, status: 401, body: { success: false, error: 'UNAUTHORIZED', message: 'OAuth provider did not return access token' } };
  }

  const userInfoResponse = await fetch(provider.userinfo_url, {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
    },
  });
  if (!userInfoResponse.ok) {
    return { ok: false as const, status: 401, body: { success: false, error: 'UNAUTHORIZED', message: 'OAuth userinfo request failed' } };
  }

  const profile = (await userInfoResponse.json().catch(() => ({}))) as GoogleUserInfo;
  const email = String(profile.email || '').trim().toLowerCase();
  const providerUserId = String(profile.sub || '').trim();

  if (!email || !providerUserId || profile.email_verified !== true) {
    return { ok: false as const, status: 401, body: { success: false, error: 'UNAUTHORIZED', message: 'OAuth identity is missing verified email' } };
  }

  const existingConnection = await queryOne<{ id: number; user_id: number }>(
    env.DB,
    'SELECT id, user_id FROM oauth_connections WHERE provider = ? AND provider_id = ?',
    [provider.name, providerUserId]
  );
  const emailUser = await queryOne<{ id: number; user_email: string | null }>(
    env.DB,
    'SELECT id, user_email FROM users WHERE user_email = ?',
    [email]
  );

  let userId = 0;
  if (existingConnection) {
    userId = existingConnection.user_id;
    if (emailUser && emailUser.id !== userId) {
      return { ok: false as const, status: 409, body: { success: false, error: 'CONFLICT', message: 'OAuth account is already linked to another user' } };
    }
  } else if (emailUser) {
    userId = emailUser.id;
    await insertAndGetId(env.DB, 'oauth_connections', {
      user_id: userId,
      provider: provider.name,
      provider_id: providerUserId,
    });
  } else {
    const created = await resolveOrCreateUserByEmail(env, email);
    userId = created.id;
    await insertAndGetId(env.DB, 'oauth_connections', {
      user_id: userId,
      provider: provider.name,
      provider_id: providerUserId,
    });
  }

  const dbUser = await queryOne<{ id: number; user_email: string | null }>(env.DB, 'SELECT id, user_email FROM users WHERE id = ?', [userId]);
  if (!dbUser) {
    return { ok: false as const, status: 404, body: { success: false, error: 'NOT_FOUND', message: 'User not found after OAuth verification' } };
  }
  const roles = await getUserRoles(env.DB, userId);

  const token = await signUserJWT(userId, dbUser.user_email, roles, env);
  return {
    ok: true as const,
    status: 200,
    body: {
      success: true,
      data: {
        token,
        user: {
          id: userId,
          user_email: dbUser.user_email,
          roles,
        },
      },
    },
  };
}

app.get('/oauth2/:provider/callback', async (c) => {
  try {
    const provider = c.req.param('provider');
    const code = String(c.req.query('code') || '');
    const state = String(c.req.query('state') || '');

    if (!code || !state) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'code and state are required' }, 400);
    }

    const cookies = parseCookieHeader(c.req.header('Cookie'));
    const sessionNonce = String(cookies.tm_oauth_nonce || '');
    const result = await handleOAuthCallback(provider, code, state, sessionNonce, c.env);
    c.header('Set-Cookie', 'tm_oauth_nonce=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0', { append: true });
    if (result.ok && result.body && (result.body as { data?: { token?: string } }).data?.token) {
      setUserSessionCookie(c, (result.body as { data: { token: string } }).data.token);
    }
    return c.json(result.body, result.status);
  } catch (error) {
    console.error('[Auth] oauth callback error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'OAuth callback failed' }, 500);
  }
});

app.post('/oauth2/:provider/callback', async (c) => {
  try {
    const provider = c.req.param('provider');
    const body = await c.req.json().catch(() => ({}));
    const code = String(body.code || '');
    const state = String(body.state || '');

    if (!code || !state) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'code and state are required' }, 400);
    }

    const cookies = parseCookieHeader(c.req.header('Cookie'));
    const sessionNonce = String(cookies.tm_oauth_nonce || '');
    const result = await handleOAuthCallback(provider, code, state, sessionNonce, c.env);
    c.header('Set-Cookie', 'tm_oauth_nonce=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0', { append: true });
    if (result.ok && result.body && (result.body as { data?: { token?: string } }).data?.token) {
      setUserSessionCookie(c, (result.body as { data: { token: string } }).data.token);
    }
    return c.json(result.body, result.status);
  } catch (error) {
    console.error('[Auth] oauth callback error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'OAuth callback failed' }, 500);
  }
});

app.post('/passkey/register/challenge', async (c) => {
  try {
    const token = getUserSessionToken(c);
    if (!token) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Authorization required' }, 401);
    }

    const payload = await verifyJWT<UserJWT>(token, c.env);
    if (!payload || payload.type !== 'user') {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid user token' }, 401);
    }

    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await c.env.KV.put(`passkey:register:${payload.user_id}:${challenge}`, '1', {
      expirationTtl: PASSKEY_CHALLENGE_TTL_SECONDS,
    });

    const rpId = getRpId(c.req.url);
    const allowedOrigins = parseAllowedOriginsRaw(c.env.APP_ORIGINS);
    const requestOrigin = getRequestOrigin(c.req.url);
    const origins = allowedOrigins.length > 0 ? allowedOrigins : [requestOrigin];

    const user = await queryOne<{ id: number; user_email: string | null }>(
      c.env.DB,
      'SELECT id, user_email FROM users WHERE id = ?',
      [payload.user_id]
    );
    if (!user || !user.user_email) {
      return c.json({ success: false, error: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    const credentialRows = await query<{ credential_id: string }>(
      c.env.DB,
      'SELECT credential_id FROM webauthn_credentials WHERE user_id = ? ORDER BY id ASC',
      [payload.user_id]
    );

    return c.json({
      success: true,
      data: {
        challenge,
        rp_id: rpId,
        origins,
        user: {
          id: user.id,
          email: user.user_email,
        },
        credential_ids: credentialRows.map((row) => row.credential_id),
      },
    });
  } catch (error) {
    console.error('[Auth] passkey register challenge error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to prepare passkey registration' }, 500);
  }
});

app.post('/passkey/register/complete', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const token = getUserSessionToken(c);
    if (!token) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Authorization required' }, 401);
    }

    const payload = await verifyJWT<UserJWT>(token, c.env);
    if (!payload || payload.type !== 'user') {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid user token' }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const challenge = String(body.challenge || '');
    const clientDataJson = String(body.client_data_json || '').trim();
    const attestationObject = String(body.attestation_object || '').trim();
    const transports = Array.isArray(body.transports) ? body.transports.map((item: unknown) => String(item)) : [];

    if (!challenge || !clientDataJson || !attestationObject) {
      return c.json(
        {
          success: false,
          error: 'INVALID_REQUEST',
          message: 'challenge, client_data_json and attestation_object are required',
        },
        400
      );
    }

    const challengeKey = `passkey:register:${payload.user_id}:${challenge}`;
    const exists = await c.env.KV.get(challengeKey);
    if (!exists) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey challenge expired or invalid' }, 401);
    }
    await c.env.KV.delete(challengeKey);

    const rpId = getRpId(c.req.url);
    const allowedOrigins = parseAllowedOriginsRaw(c.env.APP_ORIGINS);
    const requestOrigin = getRequestOrigin(c.req.url);
    const clientData = parseClientDataJSON(clientDataJson);
    if (!clientData) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Invalid client_data_json' }, 400);
    }
    if (clientData.type !== 'webauthn.create' || clientData.challenge !== challenge) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey challenge mismatch' }, 401);
    }
    const expectedOrigins = allowedOrigins.length > 0 ? allowedOrigins : [requestOrigin];
    if (!expectedOrigins.includes(clientData.origin)) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey origin mismatch' }, 401);
    }

    const attestation = parseAttestationObject(attestationObject);
    if (!attestation) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Invalid attestation_object' }, 400);
    }

    const registration = await parseRegistrationAuthData(attestation.authData);
    if (!registration) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid attestation auth data' }, 401);
    }

    const rpIdHashExpected = await sha256Bytes(new TextEncoder().encode(rpId));
    if (!bytesEqual(registration.rpIdHash, rpIdHashExpected)) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey RP ID mismatch' }, 401);
    }

    const userPresent = (registration.flags & 0x01) !== 0;
    if (!userPresent) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey user presence is required' }, 401);
    }
    const userVerified = (registration.flags & 0x04) !== 0;
    if (!userVerified) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey user verification is required' }, 401);
    }

    const existing = await queryOne<{ id: number; user_id: number }>(
      c.env.DB,
      'SELECT id, user_id FROM webauthn_credentials WHERE credential_id = ?',
      [registration.credentialId]
    );

    if (existing && existing.user_id !== payload.user_id) {
      return c.json({ success: false, error: 'FORBIDDEN', message: 'Credential already registered to another user' }, 403);
    }

    if (existing) {
      await deleteRows(c.env.DB, 'webauthn_credentials', 'id = ?', [existing.id]);
    }

    await insertAndGetId(c.env.DB, 'webauthn_credentials', {
      user_id: payload.user_id,
      credential_id: registration.credentialId,
      public_key: registration.publicKeySpki,
      counter: registration.signCount,
      transports: JSON.stringify(transports),
    });

    return c.json({ success: true, data: { credential_id: registration.credentialId } });
  } catch (error) {
    console.error('[Auth] passkey register complete error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to register passkey' }, 500);
  }
});

app.post('/passkey/login/challenge', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidLoginEmail(email)) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Invalid email format' }, 400);
    }

    const user = await queryOne<{ id: number; user_email: string | null }>(
      c.env.DB,
      'SELECT id, user_email FROM users WHERE user_email = ?',
      [email]
    );
    if (!user) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'No passkey available for this account' }, 401);
    }

    const credentials = await query<{ credential_id: string }>(
      c.env.DB,
      'SELECT credential_id FROM webauthn_credentials WHERE user_id = ? ORDER BY id ASC',
      [user.id]
    );
    if (credentials.length === 0) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'No passkey available for this account' }, 401);
    }

    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await c.env.KV.put(`passkey:login:${email}:${challenge}`, String(user.id), {
      expirationTtl: PASSKEY_CHALLENGE_TTL_SECONDS,
    });

    const rpId = getRpId(c.req.url);
    const allowedOrigins = parseAllowedOriginsRaw(c.env.APP_ORIGINS);
    const requestOrigin = getRequestOrigin(c.req.url);

    return c.json({
      success: true,
      data: {
        challenge,
        credential_ids: credentials.map((row) => row.credential_id),
        rp_id: rpId,
        origins: allowedOrigins.length > 0 ? allowedOrigins : [requestOrigin],
      },
    });
  } catch (error) {
    console.error('[Auth] passkey login challenge error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to prepare passkey login' }, 500);
  }
});

app.post('/passkey/login/complete', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json(
        { success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter },
        429
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const credentialId = String(body.credential_id || '').trim();
    const challenge = String(body.challenge || '');
    const clientDataJson = String(body.client_data_json || '').trim();
    const authenticatorData = String(body.authenticator_data || '').trim();
    const signature = String(body.signature || '').trim();

    if (!email || !credentialId || !challenge || !clientDataJson || !authenticatorData || !signature) {
      return c.json(
        {
          success: false,
          error: 'INVALID_REQUEST',
          message: 'email, credential_id, challenge, client_data_json, authenticator_data and signature are required',
        },
        400
      );
    }

    const challengeKey = `passkey:login:${email}:${challenge}`;
    const challengeValue = await c.env.KV.get(challengeKey);
    if (!challengeValue) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey challenge expired or invalid' }, 401);
    }
    await c.env.KV.delete(challengeKey);

    const credential = await queryOne<{ user_id: number; public_key: string; counter: number }>(
      c.env.DB,
      'SELECT user_id, public_key, counter FROM webauthn_credentials WHERE credential_id = ?',
      [credentialId]
    );
    if (!credential) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Unknown passkey credential' }, 401);
    }
    if (Number(challengeValue) !== credential.user_id) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey challenge user mismatch' }, 401);
    }

    const user = await queryOne<{ id: number; user_email: string | null }>(
      c.env.DB,
      'SELECT id, user_email FROM users WHERE id = ?',
      [credential.user_id]
    );
    if (!user || user.user_email?.toLowerCase() !== email) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey login mismatch' }, 401);
    }

    const rpId = getRpId(c.req.url);
    const allowedOrigins = parseAllowedOriginsRaw(c.env.APP_ORIGINS);
    const requestOrigin = getRequestOrigin(c.req.url);
    const verification = await verifyWebAuthnAssertion({
      rpId,
      challenge,
      expectedOrigin: allowedOrigins.length > 0 ? allowedOrigins : [requestOrigin],
      clientDataJsonB64: clientDataJson,
      authenticatorDataB64: authenticatorData,
      signatureB64: signature,
      publicKeySpkiB64: credential.public_key,
      expectedType: 'webauthn.get',
    });

    if (!verification.valid) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid passkey signature' }, 401);
    }

    const oldCounter = Number(credential.counter) || 0;
    const newCounter = Number(verification.signCount) || 0;
    if (oldCounter !== 0 && newCounter !== 0 && newCounter <= oldCounter) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Passkey counter replay detected' }, 401);
    }

    await execute(c.env.DB, 'UPDATE webauthn_credentials SET counter = ? WHERE credential_id = ?', [
      newCounter,
      credentialId,
    ]);

    const roles = await getUserRoles(c.env.DB, user.id);
    const token = await signUserJWT(user.id, user.user_email, roles, c.env);
    setUserSessionCookie(c, token);

    return c.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          user_email: user.user_email,
          roles,
        },
      },
    });
  } catch (error) {
    console.error('[Auth] passkey login complete error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Passkey login failed' }, 500);
  }
});

app.post('/logout', async (c) => {
  clearUserSessionCookie(c);
  return c.json({ success: true, data: { logged_out: true } });
});

export default app;
