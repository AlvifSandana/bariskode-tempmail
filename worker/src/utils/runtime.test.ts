import { describe, expect, it } from 'vitest';
import { createBaseEnv } from '../test/helpers';
import { parseAllowedOrigins, validateRuntimeConfig } from './runtime';

describe('runtime config', () => {
  it('parses allowed origins list', () => {
    expect(parseAllowedOrigins('https://a.com, https://b.com ,,')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('fails on placeholder or weak secrets', () => {
    const result = validateRuntimeConfig(
      createBaseEnv({
        JWT_SECRET: 'change-this-to-random-secret-string-at-least-32-chars',
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((err) => err.includes('JWT_SECRET'))).toBe(true);
  });

  it('fails closed when webhook url set without secret', () => {
    const result = validateRuntimeConfig(
      createBaseEnv({
        APP_ORIGINS: 'https://mail.example.com',
        WEBHOOK_URL: 'https://example.com/hook',
        WEBHOOK_SECRET: '',
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((err) => err.includes('WEBHOOK_SECRET'))).toBe(true);
  });

  it('passes with minimal secure config', () => {
    const result = validateRuntimeConfig(
      createBaseEnv({
        APP_ORIGINS: 'https://mail.example.com',
        OAUTH2_PROVIDERS: '',
      })
    );
    expect(result.valid).toBe(true);
  });

  it('warns when unused env vars are configured', () => {
    const result = validateRuntimeConfig(
      createBaseEnv({
        APP_ORIGINS: 'https://mail.example.com',
        SMTP_HOST: 'smtp.example.com',
      })
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('Configured env vars not active yet'))).toBe(true);
  });
});
