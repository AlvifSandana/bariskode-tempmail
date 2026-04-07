import type { AppBindings } from '../types/env';

export type RuntimeValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function parseAllowedOrigins(origins: string | undefined): string[] {
  if (!origins) return [];
  return origins
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

export function validateRuntimeConfig(env: AppBindings): RuntimeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!env.DOMAINS || env.DOMAINS.trim() === '') {
    errors.push('DOMAINS must be configured');
  }

  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || env.JWT_SECRET.includes('change-this')) {
    errors.push('JWT_SECRET must be set to a secure non-placeholder value with at least 32 characters');
  }

  if (!env.ADMIN_PASSWORDS || env.ADMIN_PASSWORDS.includes('change-this')) {
    errors.push('ADMIN_PASSWORDS must be set to secure value');
  }

  const origins = parseAllowedOrigins(env.APP_ORIGINS);
  if (origins.length === 0) {
    warnings.push('APP_ORIGINS is empty; CORS will be restricted to no browser origins');
  }

  if (env.WEBHOOK_URL && !env.WEBHOOK_SECRET) {
    errors.push('WEBHOOK_URL requires WEBHOOK_SECRET in production-safe configuration');
  }

  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_WEBHOOK_SECRET) {
    warnings.push('TELEGRAM_BOT_TOKEN is configured without TELEGRAM_BOT_WEBHOOK_SECRET; bot endpoint will reject requests');
  }

  const currentlyUnused = [
    'TURNSTILE_SECRET',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USERNAME',
    'SMTP_PASSWORD',
    'DKIM_PRIVATE_KEY',
    'S3_REGION',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_BUCKET',
  ] as const;

  const enabledUnused = currentlyUnused.filter((key) => {
    const value = env[key];
    return value !== undefined && String(value).trim() !== '';
  });

  if (enabledUnused.length > 0) {
    warnings.push(`Configured env vars not active yet: ${enabledUnused.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
