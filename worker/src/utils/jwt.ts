import * as jose from 'jose';
import type { AddressJWT } from '../models/address';
import type { UserJWT } from '../models/user';

interface Env {
  JWT_SECRET: string;
}

/**
 * Sign a JWT for address authentication
 */
export async function signAddressJWT(
  addressId: number,
  address: string,
  env: Env,
  expiryDays: number = 30
): Promise<string> {
  const secret = new TextEncoder().encode(env.JWT_SECRET);
  
  const payload: Omit<AddressJWT, 'iat' | 'exp'> = {
    address_id: addressId,
    address,
    type: 'address',
  };

  const token = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expiryDays}d`)
    .sign(secret);

  return token;
}

/**
 * Sign a JWT for user authentication
 */
export async function signUserJWT(
  userId: number,
  userEmail: string | null,
  roles: string[],
  env: Env,
  expiryDays: number = 30
): Promise<string> {
  const secret = new TextEncoder().encode(env.JWT_SECRET);
  
  const payload: Omit<UserJWT, 'iat' | 'exp'> = {
    user_id: userId,
    user_email: userEmail,
    roles,
    type: 'user',
  };

  const token = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expiryDays}d`)
    .sign(secret);

  return token;
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJWT<T = AddressJWT | UserJWT>(
  token: string,
  env: Env
): Promise<T | null> {
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });

    return payload as T;
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

/**
 * Decode JWT without verification (for reading payload)
 */
export function decodeJWT(token: string): jose.JWTPayload | null {
  try {
    return jose.decodeJwt(token);
  } catch (error) {
    console.error('JWT decode failed:', error);
    return null;
  }
}

/**
 * Check if JWT needs refresh (expires within threshold days)
 */
export function needsRefresh(token: string, thresholdDays: number = 7): boolean {
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) return true;

  const expiresAt = payload.exp * 1000; // Convert to milliseconds
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  return expiresAt - now < thresholdMs;
}

/**
 * Extract JWT from Authorization header
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }
  
  return parts[1];
}

/**
 * Timing-safe string comparison
 * Prevents timing attacks when comparing sensitive strings
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

/**
 * Verify admin password from Authorization header
 * Uses timing-safe comparison to prevent timing attacks
 */
export function verifyAdminPassword(authHeader: string | null, adminPasswords: string): boolean {
  if (!authHeader) return false;
  
  const token = extractBearerToken(authHeader);
  if (!token) return false;
  
  const passwords = adminPasswords.split(',').map(p => p.trim());
  
  // Use timing-safe comparison for each password
  for (const password of passwords) {
    if (timingSafeEqual(token, password)) {
      return true;
    }
  }
  
  return false;
}
