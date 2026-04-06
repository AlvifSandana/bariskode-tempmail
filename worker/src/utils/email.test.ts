import { describe, expect, it } from 'vitest';
import {
  checkSenderList,
  extractSenderEmail,
  isDomainAllowed,
  isNameBlacklisted,
  parseAddress,
  parseDomains,
  sanitizeName,
  validateName,
} from './email';

describe('email utils', () => {
  it('parses domains correctly', () => {
    expect(parseDomains('a.com, b.com ,, c.com')).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('validates names correctly', () => {
    expect(validateName('abc_123').valid).toBe(true);
    expect(validateName('1abc').valid).toBe(false);
    expect(validateName('ab').valid).toBe(false);
    expect(validateName('ABC').valid).toBe(false);
  });

  it('sanitizes names', () => {
    expect(sanitizeName('Abc-123$TEST')).toBe('abc123test');
  });

  it('parses address', () => {
    expect(parseAddress('User@Test.com')).toEqual({ local: 'user', domain: 'test.com' });
    expect(parseAddress('invalid')).toBeNull();
  });

  it('checks allowed domain', () => {
    expect(isDomainAllowed('example.com', { DOMAINS: 'example.com,temp.com', PREFIX: '', DISABLE_CUSTOM_ADDRESS_NAME: 'false', DEFAULT_DOMAINS: '', CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST: 'true' })).toBe(true);
    expect(isDomainAllowed('evil.com', { DOMAINS: 'example.com,temp.com', PREFIX: '', DISABLE_CUSTOM_ADDRESS_NAME: 'false', DEFAULT_DOMAINS: '', CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST: 'true' })).toBe(false);
  });

  it('matches blacklist wildcard', () => {
    expect(isNameBlacklisted('tmp_test', ['tmp_*'])).toBe(true);
    expect(isNameBlacklisted('realname', ['tmp_*'])).toBe(false);
  });

  it('extracts sender email', () => {
    expect(extractSenderEmail('John Doe <John@example.com>')).toBe('john@example.com');
    expect(extractSenderEmail('plain@example.com')).toBe('plain@example.com');
  });

  it('checks whitelist and blacklist', () => {
    expect(checkSenderList('user@example.com', ['*@example.com'], []).allowed).toBe(true);
    expect(checkSenderList('user@blocked.com', [], ['*@blocked.com']).allowed).toBe(false);
  });
});
