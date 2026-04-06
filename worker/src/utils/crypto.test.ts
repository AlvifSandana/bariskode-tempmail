import { describe, expect, it } from 'vitest';
import { generateSalt, generateToken, hashPassword, simpleHash, verifyPassword } from './crypto';

describe('crypto utils', () => {
  it('generates salt and token', () => {
    expect(generateSalt()).toHaveLength(64);
    expect(generateToken(16)).toHaveLength(32);
    expect(generateSalt()).toMatch(/^[a-f0-9]+$/);
    expect(generateToken(16)).toMatch(/^[a-f0-9]+$/);
  });

  it('hashes and verifies password', async () => {
    const hash = await hashPassword('super-secret-password');
    expect(await verifyPassword('super-secret-password', hash)).toBe(true);
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('creates deterministic simple hash', async () => {
    const a = await simpleHash('hello');
    const b = await simpleHash('hello');
    const c = await simpleHash('world');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
