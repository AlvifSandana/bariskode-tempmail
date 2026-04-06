/**
 * Password hashing utilities using Web Crypto API
 * Since bcrypt doesn't work in Cloudflare Workers, we use PBKDF2
 */

const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;
const ALGORITHM = 'PBKDF2';
const HASH_ALGORITHM = 'SHA-512';

/**
 * Generate a random salt
 */
export function generateSalt(): string {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return bufferToHex(salt);
}

/**
 * Hash a password with PBKDF2
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = generateSalt();
  const hash = await deriveKey(password, salt);
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;

  const derivedHash = await deriveKey(password, salt);
  return timingSafeEqual(hash, derivedHash);
}

/**
 * Timing-safe string comparison for derived secrets
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
 * Derive a key from password using PBKDF2
 */
async function deriveKey(password: string, saltHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  const saltBuffer = hexToBuffer(saltHex);

  // Import password as key
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: ALGORITHM },
    false,
    ['deriveBits']
  );

  // Derive bits using PBKDF2
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: ALGORITHM,
      salt: saltBuffer,
      iterations: ITERATIONS,
      hash: HASH_ALGORITHM,
    },
    passwordKey,
    KEY_LENGTH * 8
  );

  return bufferToHex(new Uint8Array(derivedBits));
}

/**
 * Convert buffer to hex string
 */
function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to buffer
 */
function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Generate a random token
 */
export function generateToken(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes);
}

/**
 * Generate a simple random string (for address names, etc.)
 */
export function generateRandomString(length: number = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  
  return Array.from(bytes)
    .map(b => chars[b % chars.length])
    .join('');
}

/**
 * Simple hash function (for checksums, not passwords)
 */
export async function simpleHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  return bufferToHex(new Uint8Array(hashBuffer));
}
