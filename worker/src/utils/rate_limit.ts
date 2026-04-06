import { KVNamespace } from '@cloudflare/workers-types';

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Maximum requests per window
  keyPrefix?: string;    // Optional prefix for the key
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/**
 * Check and increment rate limit counter in KV
 */
export async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const { windowMs, maxRequests, keyPrefix = 'rate_limit' } = config;
  
  const key = `${keyPrefix}:${identifier}`;
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  const resetAt = windowStart + windowMs;
  
  // Get current count
  const stored = await kv.get(key);
  let count = 0;
  let storedWindowStart = windowStart;
  
  if (stored) {
    const parts = stored.split(':');
    count = parseInt(parts[0], 10) || 0;
    storedWindowStart = parseInt(parts[1], 10) || windowStart;
  }
  
  // Check if window has reset
  if (storedWindowStart < windowStart) {
    count = 0;
  }
  
  // Increment count
  count++;
  
  // Store new count with window timestamp
  await kv.put(key, `${count}:${windowStart}`, {
    expirationTtl: Math.ceil(windowMs / 1000) + 60, // Expire after window + buffer
  });
  
  // Check if over limit
  if (count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }
  
  return {
    allowed: true,
    remaining: maxRequests - count,
    resetAt,
  };
}

/**
 * Reset rate limit counter
 */
export async function resetRateLimit(
  kv: KVNamespace,
  identifier: string,
  keyPrefix: string = 'rate_limit'
): Promise<void> {
  const key = `${keyPrefix}:${identifier}`;
  await kv.delete(key);
}

/**
 * Get current rate limit status without incrementing
 */
export async function getRateLimitStatus(
  kv: KVNamespace,
  identifier: string,
  config: RateLimitConfig
): Promise<{ count: number; resetAt: number }> {
  const { windowMs, keyPrefix = 'rate_limit' } = config;
  
  const key = `${keyPrefix}:${identifier}`;
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  const resetAt = windowStart + windowMs;
  
  const stored = await kv.get(key);
  if (!stored) {
    return { count: 0, resetAt };
  }
  
  const [countStr, storedTimeStr] = stored.split(':');
  const storedTime = parseInt(storedTimeStr || '0', 10);
  
  // Check if window has reset
  if (storedTime < windowStart) {
    return { count: 0, resetAt };
  }
  
  return {
    count: parseInt(countStr, 10),
    resetAt,
  };
}

/**
 * Rate limit presets
 */
export const RATE_LIMIT_PRESETS = {
  // For new address creation
  NEW_ADDRESS: {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 10,
    keyPrefix: 'new_address',
  },
  
  // For mail list fetching
  GET_MAILS: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60,
    keyPrefix: 'get_mails',
  },
  
  // For sending emails
  SEND_MAIL: {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 20,
    keyPrefix: 'send_mail',
  },
  
  // For admin API
  ADMIN_API: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100,
    keyPrefix: 'admin_api',
  },
  
  // For auth endpoints
  AUTH: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 10,
    keyPrefix: 'auth',
  },
} as const;

/**
 * Check if IP is blacklisted
 */
export async function isIPBlacklisted(
  kv: KVNamespace,
  ip: string
): Promise<boolean> {
  const key = `ip_blacklist:${ip}`;
  const blacklisted = await kv.get(key);
  return blacklisted === '1';
}

/**
 * Add IP to blacklist
 */
export async function blacklistIP(
  kv: KVNamespace,
  ip: string,
  ttlSeconds: number = 86400 // Default 24 hours
): Promise<void> {
  const key = `ip_blacklist:${ip}`;
  await kv.put(key, '1', { expirationTtl: ttlSeconds });
}

/**
 * Remove IP from blacklist
 */
export async function unblacklistIP(
  kv: KVNamespace,
  ip: string
): Promise<void> {
  const key = `ip_blacklist:${ip}`;
  await kv.delete(key);
}
