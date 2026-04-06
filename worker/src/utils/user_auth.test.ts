import { describe, expect, it, vi } from 'vitest';
import { createBaseEnv, createMockDB } from '../test/helpers';
import { requireUserAuth } from './user_auth';
import { signUserJWT } from './jwt';

function createMockContext(envOverrides = {}) {
  const responseSpy = vi.fn((body: unknown, status = 200) => ({ body, status } as unknown as Response));
  const setSpy = vi.fn();

  return {
    env: createBaseEnv(envOverrides),
    req: {
      header: vi.fn(),
    },
    json: responseSpy,
    set: setSpy,
    responseSpy,
    setSpy,
  };
}

describe('requireUserAuth', () => {
  it('rejects missing token', async () => {
    const c = createMockContext();
    c.req.header.mockReturnValue(undefined);

    const result = await requireUserAuth(c as never);
    expect(result).toBeTruthy();
    expect(c.responseSpy).toHaveBeenCalledWith(
      { success: false, error: 'UNAUTHORIZED', message: 'Authorization required' },
      401
    );
  });

  it('rejects invalid token type', async () => {
    const env = createBaseEnv();
    const token = await signUserJWT(1, 'user@example.com', ['default'], env);
    const c = createMockContext({
      JWT_SECRET: 'different-secret',
    });
    c.req.header.mockReturnValue(`Bearer ${token}`);

    const result = await requireUserAuth(c as never);
    expect(result).toBeTruthy();
    expect(c.responseSpy).toHaveBeenCalledWith(
      { success: false, error: 'UNAUTHORIZED', message: 'Invalid user token' },
      401
    );
  });

  it('hydrates current user and roles from database', async () => {
    const env = createBaseEnv({
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT id, user_email FROM users')) {
            return { id: params[0], user_email: 'current@example.com' };
          }
          return null;
        },
        all: (sql) => {
          if (sql.includes('SELECT role_text FROM user_roles')) {
            return [{ role_text: 'admin' }, { role_text: 'default' }];
          }
          return [];
        },
      }),
    });
    const token = await signUserJWT(7, 'stale@example.com', ['default'], env);
    const c = createMockContext({ DB: env.DB, JWT_SECRET: env.JWT_SECRET });
    c.req.header.mockReturnValue(`Bearer ${token}`);

    const result = await requireUserAuth(c as never);
    expect(result).toBeNull();
    expect(c.setSpy).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({
        user_id: 7,
        user_email: 'current@example.com',
        roles: ['admin', 'default'],
      })
    );
  });
});
