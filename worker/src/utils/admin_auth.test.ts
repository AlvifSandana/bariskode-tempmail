import { describe, expect, it } from 'vitest';
import { requireAdminAuth } from './admin_auth';
import { createBaseEnv, createMockDB } from '../test/helpers';
import { signUserJWT } from './jwt';

function createMockContext(input: {
  env: ReturnType<typeof createBaseEnv>;
  headers?: Record<string, string>;
}) {
  return {
    env: input.env,
    req: {
      header(name: string) {
        const key = Object.keys(input.headers || {}).find((h) => h.toLowerCase() === name.toLowerCase());
        return key ? input.headers?.[key] : undefined;
      },
    },
    json(body: unknown, status?: number) {
      return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

describe('requireAdminAuth', () => {
  it('authorizes legacy admin password bearer', async () => {
    const env = createBaseEnv({
      ADMIN_PASSWORDS: 'admin-secret',
    });
    const c = createMockContext({
      env,
      headers: {
        Authorization: 'Bearer admin-secret',
      },
    });

    const res = await requireAdminAuth(c as never);
    expect(res).toBeNull();
  });

  it('authorizes user session token when user has admin role', async () => {
    const env = createBaseEnv({
      DB: createMockDB({
        first: (sql, params) => {
          if (sql.includes('SELECT 1 as ok FROM user_roles')) {
            return Number(params[0]) === 9 && params[1] === 'admin' ? { ok: 1 } : null;
          }
          return null;
        },
      }),
    });
    const userToken = await signUserJWT(9, 'admin@example.com', ['admin'], env);
    const c = createMockContext({
      env,
      headers: {
        Cookie: `tm_user_session=${encodeURIComponent(userToken)}`,
      },
    });

    const res = await requireAdminAuth(c as never);
    expect(res).toBeNull();
  });

  it('rejects user session token when user is not admin', async () => {
    const env = createBaseEnv({
      DB: createMockDB({
        first: () => null,
      }),
    });
    const userToken = await signUserJWT(10, 'user@example.com', ['default'], env);
    const c = createMockContext({
      env,
      headers: {
        Cookie: `tm_user_session=${encodeURIComponent(userToken)}`,
      },
    });

    const res = await requireAdminAuth(c as never);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it('rejects bearer user jwt when user is not admin', async () => {
    const env = createBaseEnv({
      DB: createMockDB({
        first: () => null,
      }),
    });
    const userToken = await signUserJWT(11, 'user2@example.com', ['default'], env);
    const c = createMockContext({
      env,
      headers: {
        Authorization: `Bearer ${userToken}`,
      },
    });

    const res = await requireAdminAuth(c as never);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });
});
