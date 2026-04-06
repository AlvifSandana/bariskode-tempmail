import {
  ADDRESS_NAME_MIN_LENGTH,
  ADDRESS_NAME_MAX_LENGTH,
} from '../constants';

interface Env {
  DOMAINS: string;
  PREFIX: string;
  DISABLE_CUSTOM_ADDRESS_NAME: string;
  DEFAULT_DOMAINS: string;
  CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST: string;
}

/**
 * Generate a random address name
 */
export function generateRandomName(length: number = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a full email address with domain
 */
export function generateAddress(env: Env, customName?: string): string {
  const domains = parseDomains(env.DOMAINS);
  const prefix = env.PREFIX || 'tmp';
  
  // Choose domain
  let domain = domains[0];
  
  // If custom name provided
  if (customName) {
    const name = sanitizeName(customName);
    return `${name}@${domain}`;
  }
  
  // Generate random address
  const randomPart = generateRandomName(8);
  const name = prefix ? `${prefix}_${randomPart}` : randomPart;
  
  return `${name}@${domain}`;
}

/**
 * Parse domains from comma-separated string
 */
export function parseDomains(domainsStr: string): string[] {
  return domainsStr
    .split(',')
    .map(d => d.trim())
    .filter(d => d.length > 0);
}

/**
 * Get default domains (from DEFAULT_DOMAINS or fallback to DOMAINS)
 */
export function getDefaultDomains(env: Env): string[] {
  if (env.DEFAULT_DOMAINS) {
    return parseDomains(env.DEFAULT_DOMAINS);
  }
  return parseDomains(env.DOMAINS);
}

/**
 * Validate address name format
 */
export function validateName(name: string): { valid: boolean; error?: string } {
  // Check length
  if (name.length < ADDRESS_NAME_MIN_LENGTH) {
    return { valid: false, error: `Name must be at least ${ADDRESS_NAME_MIN_LENGTH} characters` };
  }
  if (name.length > ADDRESS_NAME_MAX_LENGTH) {
    return { valid: false, error: `Name must be at most ${ADDRESS_NAME_MAX_LENGTH} characters` };
  }
  
  // Check format: lowercase letters and numbers only
  if (!/^[a-z0-9_]+$/.test(name)) {
    return { valid: false, error: 'Name can only contain lowercase letters, numbers, and underscores' };
  }
  
  // Check not starting with number
  if (/^[0-9]/.test(name)) {
    return { valid: false, error: 'Name cannot start with a number' };
  }
  
  return { valid: true };
}

/**
 * Sanitize name - convert to lowercase, remove invalid characters
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .substring(0, ADDRESS_NAME_MAX_LENGTH);
}

/**
 * Validate full email address format
 */
export function validateAddress(address: string): { valid: boolean; error?: string } {
  const emailRegex = /^[a-z0-9_.+-]+@[a-z0-9-]+\.[a-z0-9-.]+$/i;
  
  if (!emailRegex.test(address)) {
    return { valid: false, error: 'Invalid email address format' };
  }
  
  return { valid: true };
}

/**
 * Parse email address to extract local part and domain
 */
export function parseAddress(address: string): { local: string; domain: string } | null {
  const match = address.match(/^([^@]+)@([^@]+)$/);
  if (!match) return null;
  
  return {
    local: match[1].toLowerCase(),
    domain: match[2].toLowerCase(),
  };
}

/**
 * Check if domain is allowed
 */
export function isDomainAllowed(domain: string, env: Env): boolean {
  const allowedDomains = parseDomains(env.DOMAINS);
  return allowedDomains.includes(domain.toLowerCase());
}

/**
 * Check if custom address name is allowed
 */
export function isCustomNameAllowed(env: Env): boolean {
  return env.DISABLE_CUSTOM_ADDRESS_NAME !== 'true';
}

/**
 * Check if name is in blacklist
 */
export function isNameBlacklisted(name: string, blacklist: string[]): boolean {
  const lowerName = name.toLowerCase();
  return blacklist.some(blacklisted => {
    // Support wildcard: tmp_* matches tmp_abc, tmp_xyz, etc.
    if (blacklisted.includes('*')) {
      const pattern = blacklisted.replace(/\*/g, '.*');
      return new RegExp(`^${pattern}$`, 'i').test(lowerName);
    }
    return blacklisted.toLowerCase() === lowerName;
  });
}

/**
 * Extract sender email from various formats
 * Handles: "Name <email@domain.com>", email@domain.com, etc.
 */
export function extractSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase().trim();
  
  // Try to find email-like pattern
  const emailMatch = from.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) return emailMatch[0].toLowerCase().trim();
  
  return from.toLowerCase().trim();
}

/**
 * Check if sender is in whitelist/blacklist
 */
export function checkSenderList(
  senderEmail: string,
  whitelist: string[],
  blacklist: string[]
): { allowed: boolean; reason?: string } {
  const sender = senderEmail.toLowerCase();
  
  // Check whitelist first (if whitelist exists, only allow whitelisted senders)
  if (whitelist.length > 0) {
    const inWhitelist = whitelist.some(w => {
      if (w.startsWith('*@')) {
        // Wildcard domain: *@example.com
        return sender.endsWith(w.substring(1));
      }
      return w.toLowerCase() === sender;
    });
    
    if (!inWhitelist) {
      return { allowed: false, reason: 'Sender not in whitelist' };
    }
  }
  
  // Check blacklist
  const inBlacklist = blacklist.some(b => {
    if (b.startsWith('*@')) {
      // Wildcard domain: *@example.com
      return sender.endsWith(b.substring(1));
    }
    return b.toLowerCase() === sender;
  });
  
  if (inBlacklist) {
    return { allowed: false, reason: 'Sender is blacklisted' };
  }
  
  return { allowed: true };
}
