import { verifyAdminPassword } from './jwt';
import type { AppBindings } from '../types/env';

export async function requireAdminAuth(c: {
  req: { header(name: string): string | undefined };
  env: AppBindings;
  json: (body: unknown, status?: number) => Response;
}) {
  const authHeader = c.req.header('Authorization') ?? null;

  if (!verifyAdminPassword(authHeader, c.env.ADMIN_PASSWORDS)) {
    return c.json(
      { success: false, error: 'UNAUTHORIZED', message: 'Invalid admin credentials' },
      401
    );
  }

  return null;
}
