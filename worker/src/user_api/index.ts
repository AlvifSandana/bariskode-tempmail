import { Hono } from 'hono';
import { deleteRows, execute, query, queryOne } from '../utils/db';
import { checkRateLimit, RATE_LIMIT_PRESETS } from '../utils/rate_limit';
import { verifyJWT } from '../utils/jwt';
import { requireUserAuth } from '../utils/user_auth';
import { validateCookieCsrf } from '../utils/csrf';
import { getAllowedDomainsForRolePolicy, resolveEffectiveRolePolicy } from '../utils/role_policy';
import type { AppBindings } from '../types/env';
import type { Address, AddressJWT } from '../models/address';
import type { UserJWT } from '../models/user';
import type { Mail } from '../models/mail';
import { ERROR_CODES } from '../constants';
import { parseDomains } from '../utils/email';

type Variables = {
  user: UserJWT;
};

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

app.use('*', async (c, next) => {
  const csrf = validateCookieCsrf({
    method: c.req.method,
    url: c.req.url,
    headers: c.req,
    allowedOriginsRaw: c.env.APP_ORIGINS,
  });
  if (!csrf.ok) {
    return c.json(csrf.body, csrf.status);
  }

  const unauthorized = await requireUserAuth(c as never);
  if (unauthorized) return unauthorized;
  await next();
});

app.get('/profile', async (c) => {
  const user = c.get('user');
  const roleRows = await query<{ role_text: string }>(
    c.env.DB,
    'SELECT role_text FROM user_roles WHERE user_id = ? ORDER BY role_text ASC',
    [user.user_id]
  );

  const dbUser = await queryOne<{ id: number; user_email: string | null; created_at: string; updated_at: string }>(
    c.env.DB,
    'SELECT id, user_email, created_at, updated_at FROM users WHERE id = ?',
    [user.user_id]
  );

  if (!dbUser) {
    return c.json({ success: false, error: 'NOT_FOUND', message: 'User not found' }, 404);
  }

  return c.json({
    success: true,
    data: {
      ...dbUser,
      roles: roleRows.map((row) => row.role_text),
    },
  });
});

app.get('/addresses', async (c) => {
  const user = c.get('user');
  const addresses = await query<Address & { bound_at: string }>(
    c.env.DB,
    `SELECT a.*, ua.created_at AS bound_at
     FROM user_address ua
     JOIN address a ON a.id = ua.address_id
     WHERE ua.user_id = ?
     ORDER BY ua.created_at DESC`,
    [user.user_id]
  );

  return c.json({ success: true, data: { addresses } });
});

app.post('/bind_address', async (c) => {
  try {
    const user = c.get('user');
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, `${user.user_id}:${ip}`, RATE_LIMIT_PRESETS.AUTH);
    if (!rate.allowed) {
      return c.json({ success: false, error: 'RATE_LIMITED', message: 'Too many requests' }, 429);
    }

    const body = await c.req.json().catch(() => ({}));
    const addressToken = String(body.address_token || '');

    if (!addressToken) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'address_token is required' }, 400);
    }

    const addressPayload = await verifyJWT<AddressJWT>(addressToken, c.env);
    if (!addressPayload || addressPayload.type !== 'address') {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid address token' }, 401);
    }

    const addressId = Number(addressPayload.address_id || 0);
    if (!addressId) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid address token' }, 401);
    }

    const address = await queryOne<Address>(c.env.DB, 'SELECT * FROM address WHERE id = ?', [addressId]);
    if (!address) {
      return c.json({ success: false, error: 'NOT_FOUND', message: 'Address not found' }, 404);
    }

    const boundToAnotherUser = await queryOne<{ user_id: number }>(
      c.env.DB,
      'SELECT user_id FROM user_address WHERE address_id = ? LIMIT 1',
      [addressId]
    );
    if (boundToAnotherUser && boundToAnotherUser.user_id !== user.user_id) {
      return c.json({ success: false, error: 'FORBIDDEN', message: 'Address already bound to another user' }, 403);
    }

    const alreadyBound = await queryOne<{ id: number }>(
      c.env.DB,
      'SELECT id FROM user_address WHERE user_id = ? AND address_id = ?',
      [user.user_id, addressId]
    );
    if (alreadyBound) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Address already bound' }, 400);
    }

    const policy = await resolveEffectiveRolePolicy(c.env, user.roles || []);
    if (!policy) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.FORBIDDEN,
          message: 'Role policy is not configured',
        },
        403
      );
    }

    const addressLower = String(address.name || '').trim().toLowerCase();
    const atIndex = addressLower.lastIndexOf('@');
    const localPart = atIndex > 0 ? addressLower.slice(0, atIndex) : '';
    const domainPart = atIndex > 0 ? addressLower.slice(atIndex + 1) : '';
    const allowedDomains = getAllowedDomainsForRolePolicy(policy, parseDomains(c.env.DOMAINS));
    if (!domainPart || !allowedDomains.includes(domainPart)) {
      return c.json({ success: false, error: ERROR_CODES.FORBIDDEN, message: 'Address domain is not allowed for your role' }, 403);
    }
    if (policy.prefix && !localPart.startsWith(`${policy.prefix.toLowerCase()}_`)) {
      return c.json({ success: false, error: ERROR_CODES.FORBIDDEN, message: 'Address prefix is not allowed for your role' }, 403);
    }

    const insertResult = await execute(
      c.env.DB,
      `INSERT INTO user_address (user_id, address_id)
       SELECT ?, ?
       WHERE (
         SELECT COUNT(*) FROM user_address WHERE user_id = ?
       ) < ?
       AND NOT EXISTS (
         SELECT 1 FROM user_address WHERE address_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_address WHERE user_id = ? AND address_id = ?
       )`,
      [user.user_id, addressId, user.user_id, policy.max_address, addressId, user.user_id, addressId]
    );

    if ((insertResult.meta?.changes ?? 0) < 1) {
      const ownerRow = await queryOne<{ user_id: number }>(
        c.env.DB,
        'SELECT user_id FROM user_address WHERE address_id = ? LIMIT 1',
        [addressId]
      );
      if (ownerRow && ownerRow.user_id !== user.user_id) {
        return c.json({ success: false, error: 'FORBIDDEN', message: 'Address already bound to another user' }, 403);
      }

      const ownBind = await queryOne<{ id: number }>(
        c.env.DB,
        'SELECT id FROM user_address WHERE user_id = ? AND address_id = ?',
        [user.user_id, addressId]
      );
      if (ownBind) {
        return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Address already bound' }, 400);
      }

      const boundCountRow = await queryOne<{ count: number }>(
        c.env.DB,
        'SELECT COUNT(*) as count FROM user_address WHERE user_id = ?',
        [user.user_id]
      );
      const boundCount = Number(boundCountRow?.count ?? 0);
      if (boundCount >= policy.max_address) {
        return c.json(
          {
            success: false,
            error: ERROR_CODES.ROLE_LIMIT_REACHED,
            message: `Role limit reached: maximum ${policy.max_address} addresses`,
          },
          403
        );
      }

      return c.json({ success: false, error: 'FORBIDDEN', message: 'Address binding denied' }, 403);
    }

    return c.json({ success: true, data: { address_id: addressId, address: address.name } });
  } catch (error) {
    console.error('[User API] bind_address error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to bind address' }, 500);
  }
});

app.delete('/unbind_address', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const addressId = Number(body.address_id || 0);

    if (!addressId) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'address_id is required' }, 400);
    }

    const deleted = await deleteRows(
      c.env.DB,
      'user_address',
      'user_id = ? AND address_id = ?',
      [user.user_id, addressId]
    );

    return c.json({ success: true, data: { deleted } });
  } catch (error) {
    console.error('[User API] unbind_address error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to unbind address' }, 500);
  }
});

app.get('/mails', async (c) => {
  try {
    const user = c.get('user');
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rate = await checkRateLimit(c.env.KV, `${user.user_id}:${ip}`, RATE_LIMIT_PRESETS.GET_MAILS);
    if (!rate.allowed) {
      return c.json({ success: false, error: 'RATE_LIMITED', message: 'Too many requests' }, 429);
    }

    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100));
    const offset = (page - 1) * limit;
    const addressFilter = String(c.req.query('address') || '').trim();
    const keyword = String(c.req.query('keyword') || '').trim();

    const whereParts = ['ua.user_id = ?'];
    const params: unknown[] = [user.user_id];

    if (addressFilter) {
      whereParts.push('m.address = ?');
      params.push(addressFilter);
    }

    if (keyword) {
      whereParts.push('(m.subject LIKE ? OR m.sender LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    const whereClause = whereParts.join(' AND ');
    const totalRow = await queryOne<{ count: number }>(
      c.env.DB,
      `SELECT COUNT(*) as count
       FROM mails m
       JOIN address a ON a.name = m.address
       JOIN user_address ua ON ua.address_id = a.id
       WHERE ${whereClause}`,
      params
    );

    const mails = await query<Mail>(
      c.env.DB,
      `SELECT m.*
       FROM mails m
       JOIN address a ON a.name = m.address
       JOIN user_address ua ON ua.address_id = a.id
       WHERE ${whereClause}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return c.json({
      success: true,
      data: {
        mails,
        pagination: {
          page,
          limit,
          total: totalRow?.count ?? 0,
          total_pages: Math.ceil((totalRow?.count ?? 0) / limit),
        },
      },
    });
  } catch (error) {
    console.error('[User API] mails error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to fetch user mails' }, 500);
  }
});

export default app;
