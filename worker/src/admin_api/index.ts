import { Hono } from 'hono';
import {
  count,
  deleteRows,
  getSetting,
  insertAndGetId,
  query,
  queryOne,
  setSetting,
} from '../utils/db';
import { requireAdminAuth } from '../utils/admin_auth';
import {
  blacklistIP,
  checkRateLimit,
  RATE_LIMIT_PRESETS,
  unblacklistIP,
} from '../utils/rate_limit';
import { generateRandomName, parseDomains, validateName } from '../utils/email';
import { hashPassword } from '../utils/crypto';
import type { AppBindings } from '../types/env';
import type { Address } from '../models/address';
import { CLEANUP_DEFAULT_DAYS } from '../constants';

const app = new Hono<{ Bindings: AppBindings }>();

const ALLOWED_SETTINGS_KEYS = new Set([
  'announcement',
  'spam_list',
  'blacklist',
  'whitelist',
  'default_domains',
  'user_roles_config',
  'ai_extract_settings',
  'address_name_blacklist',
  'ip_blacklist',
  'cleanup_rules',
]);

async function deleteAddressRelatedData(env: AppBindings, addresses: string[]) {
  if (addresses.length === 0) return { deletedMails: 0, deletedSendbox: 0, deletedAttachments: 0 };

  const placeholders = addresses.map(() => '?').join(',');
  const attachments = await query<{ storage_key: string | null }>(
    env.DB,
    `SELECT a.storage_key
     FROM attachments a
     JOIN mails m ON m.id = a.mail_id
     WHERE m.address IN (${placeholders}) AND a.storage_key IS NOT NULL`,
    addresses
  );

  if (env.R2) {
    for (const attachment of attachments) {
      if (attachment.storage_key) {
        try {
          await env.R2.delete(attachment.storage_key);
        } catch (error) {
          console.error('[Admin API] R2 delete error:', error);
        }
      }
    }
  }

  const deletedAttachments = await deleteRows(
    env.DB,
    'attachments',
    `mail_id IN (SELECT id FROM mails WHERE address IN (${placeholders}))`,
    addresses
  );
  const deletedMails = await deleteRows(env.DB, 'mails', `address IN (${placeholders})`, addresses);
  const deletedSendbox = await deleteRows(env.DB, 'sendbox', `address IN (${placeholders})`, addresses);

  return { deletedMails, deletedSendbox, deletedAttachments };
}

async function deleteMailIds(env: AppBindings, mailIds: number[]) {
  if (mailIds.length === 0) return { deletedMails: 0, deletedAttachments: 0 };

  const placeholders = mailIds.map(() => '?').join(',');
  const attachments = await query<{ storage_key: string | null }>(
    env.DB,
    `SELECT storage_key FROM attachments WHERE mail_id IN (${placeholders}) AND storage_key IS NOT NULL`,
    mailIds
  );

  if (env.R2) {
    for (const attachment of attachments) {
      if (attachment.storage_key) {
        try {
          await env.R2.delete(attachment.storage_key);
        } catch (error) {
          console.error('[Admin API] R2 delete error:', error);
        }
      }
    }
  }

  const deletedAttachments = await deleteRows(env.DB, 'attachments', `mail_id IN (${placeholders})`, mailIds);
  const deletedMails = await deleteRows(env.DB, 'mails', `id IN (${placeholders})`, mailIds);
  return { deletedMails, deletedAttachments };
}

app.use('*', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const rate = await checkRateLimit(c.env.KV, `admin:${ip}`, RATE_LIMIT_PRESETS.ADMIN_API);
  if (!rate.allowed) {
    return c.json({ success: false, error: 'RATE_LIMITED', message: 'Too many requests', retry_after: rate.retryAfter }, 429);
  }

  const unauthorized = await requireAdminAuth(c as never);
  if (unauthorized) return unauthorized;
  await next();
});

app.get('/stats', async (c) => {
  const [addressCount, userCount, mailCount, sendCount] = await Promise.all([
    count(c.env.DB, 'address'),
    count(c.env.DB, 'users'),
    count(c.env.DB, 'mails'),
    count(c.env.DB, 'sendbox'),
  ]);

  return c.json({
    success: true,
    data: {
      addresses: addressCount,
      users: userCount,
      mails: mailCount,
      sent_mails: sendCount,
    },
  });
});

app.get('/address', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100));
  const offset = (page - 1) * limit;
  const keyword = String(c.req.query('keyword') || '').trim();

  const whereClause = keyword ? 'WHERE name LIKE ?' : '';
  const params: unknown[] = keyword ? [`%${keyword}%`] : [];

  const totalRow = await queryOne<{ count: number }>(
    c.env.DB,
    `SELECT COUNT(*) as count FROM address ${whereClause}`,
    params
  );

  const addresses = await query<Address & { mail_count: number; user_id: number | null }>(
    c.env.DB,
    `SELECT a.*, 
        COUNT(DISTINCT m.id) AS mail_count,
        ua.user_id AS user_id
     FROM address a
     LEFT JOIN mails m ON m.address = a.name
     LEFT JOIN user_address ua ON ua.address_id = a.id
     ${whereClause}
     GROUP BY a.id, ua.user_id
     ORDER BY a.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return c.json({
    success: true,
    data: {
      addresses,
      pagination: {
        page,
        limit,
        total: totalRow?.count ?? 0,
        total_pages: Math.ceil((totalRow?.count ?? 0) / limit),
      },
    },
  });
});

app.post('/new_address', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const requestedName = String(body.name || '').trim().toLowerCase();
    const requestedDomain = String(body.domain || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!requestedDomain || !parseDomains(c.env.DOMAINS).includes(requestedDomain)) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Valid domain is required' }, 400);
    }

    const localName = requestedName || generateRandomName(10);
    const validation = validateName(localName);
    if (!validation.valid) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: validation.error || 'Invalid address name' }, 400);
    }

    const fullAddress = `${localName}@${requestedDomain}`;
    const existing = await queryOne<{ id: number }>(c.env.DB, 'SELECT id FROM address WHERE name = ?', [fullAddress]);
    if (existing) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Address already exists' }, 400);
    }

    const addressId = await insertAndGetId(c.env.DB, 'address', {
      name: fullAddress,
      source_ip: 'admin',
      password: password ? await hashPassword(password) : null,
      balance: 0,
    });

    return c.json({ success: true, data: { id: addressId, address: fullAddress } });
  } catch (error) {
    console.error('[Admin API] new_address error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to create address' }, 500);
  }
});

app.delete('/address/:id', async (c) => {
  try {
    const addressId = Number(c.req.param('id'));
    if (!addressId) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Invalid address id' }, 400);
    }

    const address = await queryOne<Address>(c.env.DB, 'SELECT * FROM address WHERE id = ?', [addressId]);
    if (!address) {
      return c.json({ success: false, error: 'NOT_FOUND', message: 'Address not found' }, 404);
    }

    await deleteAddressRelatedData(c.env, [address.name]);
    await deleteRows(c.env.DB, 'user_address', 'address_id = ?', [addressId]);
    const deleted = await deleteRows(c.env.DB, 'address', 'id = ?', [addressId]);

    return c.json({ success: true, data: { deleted } });
  } catch (error) {
    console.error('[Admin API] delete address error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to delete address' }, 500);
  }
});

app.post('/address/bulk_delete', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.map((id: unknown) => Number(id)).filter(Boolean) : [];
    if (ids.length === 0) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'ids is required' }, 400);
    }

    const addresses = await query<{ id: number; name: string }>(
      c.env.DB,
      `SELECT id, name FROM address WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );

    await deleteAddressRelatedData(c.env, addresses.map((address) => address.name));

    await deleteRows(c.env.DB, 'user_address', `address_id IN (${ids.map(() => '?').join(',')})`, ids);
    const deleted = await deleteRows(c.env.DB, 'address', `id IN (${ids.map(() => '?').join(',')})`, ids);

    return c.json({ success: true, data: { deleted } });
  } catch (error) {
    console.error('[Admin API] bulk delete error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to bulk delete addresses' }, 500);
  }
});

app.get('/users', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100));
  const offset = (page - 1) * limit;
  const keyword = String(c.req.query('keyword') || '').trim();

  const whereClause = keyword ? 'WHERE u.user_email LIKE ? OR a.name LIKE ?' : '';
  const params: unknown[] = keyword ? [`%${keyword}%`, `%${keyword}%`] : [];

  const totalRow = await queryOne<{ count: number }>(
    c.env.DB,
    `SELECT COUNT(DISTINCT u.id) as count
     FROM users u
     LEFT JOIN user_address ua ON ua.user_id = u.id
     LEFT JOIN address a ON a.id = ua.address_id
     ${whereClause}`,
    params
  );

  const users = await query<{
    id: number;
    user_email: string | null;
    created_at: string;
    updated_at: string;
    address_count: number;
  }>(
    c.env.DB,
    `SELECT u.id, u.user_email, u.created_at, u.updated_at,
        COUNT(DISTINCT ua.address_id) AS address_count
     FROM users u
     LEFT JOIN user_address ua ON ua.user_id = u.id
     LEFT JOIN address a ON a.id = ua.address_id
     ${whereClause}
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return c.json({
    success: true,
    data: {
      users,
      pagination: {
        page,
        limit,
        total: totalRow?.count ?? 0,
        total_pages: Math.ceil((totalRow?.count ?? 0) / limit),
      },
    },
  });
});

app.delete('/users/:id', async (c) => {
  try {
    const userId = Number(c.req.param('id'));
    if (!userId) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Invalid user id' }, 400);
    }

    const existing = await queryOne<{ id: number }>(c.env.DB, 'SELECT id FROM users WHERE id = ?', [userId]);
    if (!existing) {
      return c.json({ success: false, error: 'NOT_FOUND', message: 'User not found' }, 404);
    }

    await deleteRows(c.env.DB, 'user_roles', 'user_id = ?', [userId]);
    await deleteRows(c.env.DB, 'user_address', 'user_id = ?', [userId]);
    const deleted = await deleteRows(c.env.DB, 'users', 'id = ?', [userId]);

    return c.json({ success: true, data: { deleted } });
  } catch (error) {
    console.error('[Admin API] delete user error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to delete user' }, 500);
  }
});

app.post('/users/bulk', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const userIds = Array.isArray(body.user_ids) ? body.user_ids.map((id: unknown) => Number(id)).filter(Boolean) : [];
    const action = String(body.action || '');

    if (userIds.length === 0 || !action) {
      return c.json({ success: false, error: 'INVALID_REQUEST', message: 'user_ids and action are required' }, 400);
    }

    const placeholders = userIds.map(() => '?').join(',');

    if (action === 'delete') {
      await deleteRows(c.env.DB, 'user_roles', `user_id IN (${placeholders})`, userIds);
      await deleteRows(c.env.DB, 'user_address', `user_id IN (${placeholders})`, userIds);
      const deleted = await deleteRows(c.env.DB, 'users', `id IN (${placeholders})`, userIds);
      return c.json({ success: true, data: { deleted } });
    }

    if (action === 'clear_inbox') {
      const addresses = await query<{ name: string }>(
        c.env.DB,
        `SELECT a.name
         FROM user_address ua
         JOIN address a ON a.id = ua.address_id
         WHERE ua.user_id IN (${placeholders})`,
        userIds
      );

      let deleted = 0;
      for (const address of addresses) {
        deleted += await deleteRows(c.env.DB, 'mails', 'address = ?', [address.name]);
      }
      return c.json({ success: true, data: { deleted } });
    }

    if (action === 'clear_sent') {
      const addresses = await query<{ name: string }>(
        c.env.DB,
        `SELECT a.name
         FROM user_address ua
         JOIN address a ON a.id = ua.address_id
         WHERE ua.user_id IN (${placeholders})`,
        userIds
      );

      let deleted = 0;
      for (const address of addresses) {
        deleted += await deleteRows(c.env.DB, 'sendbox', 'address = ?', [address.name]);
      }
      return c.json({ success: true, data: { deleted } });
    }

    return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Unsupported action' }, 400);
  } catch (error) {
    console.error('[Admin API] users bulk error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Bulk user operation failed' }, 500);
  }
});

app.get('/settings', async (c) => {
  const rows = await query<{ key: string; value: string }>(c.env.DB, 'SELECT key, value FROM settings ORDER BY key ASC');
  return c.json({ success: true, data: { settings: rows } });
});

app.post('/settings', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const settings = body.settings && typeof body.settings === 'object' ? body.settings : body;
    const previousIpBlacklist = await getSetting<string[]>(c.env.DB, 'ip_blacklist', []);

    const incomingKeys = Object.keys(settings);
    const disallowedKeys = incomingKeys.filter((key) => !ALLOWED_SETTINGS_KEYS.has(key));
    if (disallowedKeys.length > 0) {
      return c.json(
        {
          success: false,
          error: 'FORBIDDEN',
          message: `Unsupported settings keys: ${disallowedKeys.join(', ')}`,
        },
        403
      );
    }

    for (const [key, value] of Object.entries(settings)) {
      await setSetting(c.env.DB, key, value as string | object);
    }

    if ('ip_blacklist' in settings) {
      const incoming = Array.isArray(settings.ip_blacklist)
        ? settings.ip_blacklist.map((item: unknown) => String(item))
        : [];
      const previousSet = new Set(previousIpBlacklist.map((ip) => String(ip).trim()).filter(Boolean));
      const incomingSet = new Set(incoming.map((ip) => ip.trim()).filter(Boolean));

      for (const ip of incomingSet) {
        if (!previousSet.has(ip)) {
          await blacklistIP(c.env.KV, ip, 365 * 24 * 60 * 60);
        }
      }

      for (const ip of previousSet) {
        if (!incomingSet.has(ip)) {
          await unblacklistIP(c.env.KV, ip);
        }
      }
    }

    return c.json({ success: true, data: { updated_keys: Object.keys(settings) } });
  } catch (error) {
    console.error('[Admin API] settings update error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to update settings' }, 500);
  }
});

app.get('/ip_blacklist', async (c) => {
  const blacklist = await getSetting<string[]>(c.env.DB, 'ip_blacklist', []);
  return c.json({ success: true, data: { blacklist } });
});

app.post('/ip_blacklist', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const blacklist = Array.isArray(body.blacklist) ? body.blacklist.map((item: unknown) => String(item)) : [];
    const previous = await getSetting<string[]>(c.env.DB, 'ip_blacklist', []);

    const previousSet = new Set(previous.map((ip) => String(ip).trim()).filter(Boolean));
    const nextSet = new Set(blacklist.map((ip) => ip.trim()).filter(Boolean));

    for (const ip of nextSet) {
      if (!previousSet.has(ip)) {
        await blacklistIP(c.env.KV, ip, 365 * 24 * 60 * 60);
      }
    }

    for (const ip of previousSet) {
      if (!nextSet.has(ip)) {
        await unblacklistIP(c.env.KV, ip);
      }
    }

    await setSetting(c.env.DB, 'ip_blacklist', blacklist);
    return c.json({ success: true, data: { blacklist } });
  } catch (error) {
    console.error('[Admin API] ip blacklist error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to update ip blacklist' }, 500);
  }
});

app.post('/cleanup', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const mode = String(body.mode || 'old_emails');
    const days = Math.max(1, Number(body.days || CLEANUP_DEFAULT_DAYS));

    if (mode === 'old_emails') {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      const cutoffStr = cutoffDate.toISOString().replace('T', ' ').substring(0, 19);
      const rows = await query<{ id: number }>(
        c.env.DB,
        'SELECT id FROM mails WHERE created_at < ?',
        [cutoffStr]
      );
      const result = await deleteMailIds(c.env, rows.map((row) => row.id));
      const deleted = result.deletedMails;
      return c.json({ success: true, data: { deleted, mode } });
    }

    if (mode === 'empty_addresses') {
      const empty = await query<{ id: number }>(
        c.env.DB,
        `SELECT a.id
         FROM address a
         LEFT JOIN mails m ON m.address = a.name
         LEFT JOIN user_address ua ON ua.address_id = a.id
         WHERE m.id IS NULL AND ua.id IS NULL`
      );
      if (empty.length === 0) return c.json({ success: true, data: { deleted: 0, mode } });
      const ids = empty.map((row) => row.id);
      const addresses = await query<{ name: string }>(
        c.env.DB,
        `SELECT name FROM address WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      await deleteAddressRelatedData(c.env, addresses.map((row) => row.name));
      const deleted = await deleteRows(c.env.DB, 'address', `id IN (${ids.map(() => '?').join(',')})`, ids);
      return c.json({ success: true, data: { deleted, mode } });
    }

    if (mode === 'unbound_addresses') {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 7);
      const cutoffStr = oldDate.toISOString().replace('T', ' ').substring(0, 19);
      const unbound = await query<{ id: number; name: string }>(
        c.env.DB,
        `SELECT a.id, a.name
         FROM address a
         LEFT JOIN user_address ua ON ua.address_id = a.id
         WHERE ua.id IS NULL AND a.created_at < ?`,
        [cutoffStr]
      );
      await deleteAddressRelatedData(c.env, unbound.map((row) => row.name));
      const ids = unbound.map((row) => row.id);
      const deleted = ids.length
        ? await deleteRows(c.env.DB, 'address', `id IN (${ids.map(() => '?').join(',')})`, ids)
        : 0;
      return c.json({ success: true, data: { deleted, mode } });
    }

    return c.json({ success: false, error: 'INVALID_REQUEST', message: 'Unsupported cleanup mode' }, 400);
  } catch (error) {
    console.error('[Admin API] cleanup error:', error);
    return c.json({ success: false, error: 'INTERNAL_ERROR', message: 'Cleanup failed' }, 500);
  }
});

app.post('/db_init', async (c) => {
  const tables = await query<{ name: string }>(
    c.env.DB,
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC`
  );

  const requiredTables = [
    'address',
    'mails',
    'sendbox',
    'users',
    'user_address',
    'user_roles',
    'settings',
    'attachments',
    'webauthn_credentials',
    'oauth_connections',
  ];
  const existingTables = new Set(tables.map((row) => row.name));
  const missingCoreTables = requiredTables.filter((table) => !existingTables.has(table));

  return c.json({
    success: true,
    data: {
      mode: 'status_only',
      initialized: missingCoreTables.length === 0,
      message: 'Schema initialization/migration is manual in MVP',
      tables,
      required_tables: requiredTables,
      missing_core_tables: missingCoreTables,
      migration_hint_commands: [
        'wrangler d1 execute temp-email-db --file=db/schema.sql',
      ],
      next_action:
        missingCoreTables.length === 0
          ? 'No action required'
          : 'Run migration command above then re-check /admin_api/db_init',
    },
  });
});

export default app;
