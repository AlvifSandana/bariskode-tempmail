import {
  query,
  deleteRows,
  getSetting,
} from './utils/db';
import { CLEANUP_DEFAULT_DAYS } from './constants';

type Bindings = Env & {
  DB: D1Database;
  KV: KVNamespace;
  DEBUG_MODE: string;
};

interface ScheduledEvent {
  cron: string;
  scheduledTime: Date;
}

/**
 * Handle scheduled tasks (Cron Triggers)
 */
export async function handleScheduled(
  event: ScheduledEvent,
  env: Bindings,
  _ctx: ExecutionContext
): Promise<void> {
  console.log(`[Scheduled] Cron: ${event.cron}, Time: ${event.scheduledTime}`);

  const tasks = [
    () => cleanupOldEmails(env),
    () => cleanupEmptyAddresses(env),
    () => cleanupUnboundAddresses(env),
    () => runCustomSQLCleanup(env),
  ];

  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      console.error('[Scheduled] Task failed:', error);
    }
  }

  console.log('[Scheduled] Cleanup completed');
}

/**
 * Cleanup emails older than configured days
 */
async function cleanupOldEmails(env: Bindings): Promise<void> {
  const cleanupRules = await getSetting(env.DB, 'cleanup_rules', {
    max_age_days: CLEANUP_DEFAULT_DAYS,
    cleanup_empty: true,
    cleanup_unbound: true,
  });

  const maxAgeDays = cleanupRules.max_age_days || CLEANUP_DEFAULT_DAYS;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
  const cutoffStr = cutoffDate.toISOString().replace('T', ' ').substring(0, 19);

  console.log(`[Cleanup] Deleting emails older than ${cutoffStr}`);

  const oldMailRows = await query<{ id: number }>(
    env.DB,
    'SELECT id FROM mails WHERE created_at < ?',
    [cutoffStr]
  );
  const oldMailIds = oldMailRows.map((row) => row.id);

  if (oldMailIds.length === 0) {
    console.log('[Cleanup] No old emails to delete');
    return;
  }

  const placeholders = oldMailIds.map(() => '?').join(',');

  // Get attachments to delete from R2
  const attachments = await query<{ storage_key: string }>(
    env.DB,
    `SELECT storage_key
     FROM attachments
     WHERE mail_id IN (${placeholders}) AND storage_key IS NOT NULL`,
    oldMailIds
  );

  // Delete from R2 if available
  if (env.R2 && attachments.length > 0) {
    for (const attachment of attachments) {
      if (attachment.storage_key) {
        try {
          await env.R2.delete(attachment.storage_key);
        } catch (error) {
          console.error('[Cleanup] R2 delete error:', error);
        }
      }
    }
  }

  await deleteRows(
    env.DB,
    'attachments',
    `mail_id IN (${placeholders})`,
    oldMailIds
  );

  // Delete old emails
  const result = await deleteRows(
    env.DB,
    'mails',
    `id IN (${placeholders})`,
    oldMailIds
  );

  console.log(`[Cleanup] Deleted ${result} old emails`);
}

/**
 * Cleanup addresses with no emails and no user binding
 */
async function cleanupEmptyAddresses(env: Bindings): Promise<void> {
  const cleanupRules = await getSetting(env.DB, 'cleanup_rules', {
    max_age_days: CLEANUP_DEFAULT_DAYS,
    cleanup_empty: true,
    cleanup_unbound: true,
  });

  if (!cleanupRules.cleanup_empty) {
    return;
  }

  // Find addresses with no emails
  const emptyAddresses = await query<{ id: number; name: string }>(
    env.DB,
    `SELECT a.id, a.name 
     FROM address a 
     LEFT JOIN mails m ON a.name = m.address 
     LEFT JOIN user_address ua ON a.id = ua.address_id 
     WHERE m.id IS NULL AND ua.id IS NULL`
  );

  if (emptyAddresses.length === 0) {
    return;
  }

  // Delete empty addresses
  const ids = emptyAddresses.map(a => a.id);
  const placeholders = ids.map(() => '?').join(',');
  
  const result = await deleteRows(
    env.DB,
    'address',
    `id IN (${placeholders})`,
    ids
  );

  console.log(`[Cleanup] Deleted ${result} empty addresses`);
}

/**
 * Cleanup addresses that are not bound to any user (older than 7 days)
 */
async function cleanupUnboundAddresses(env: Bindings): Promise<void> {
  const cleanupRules = await getSetting(env.DB, 'cleanup_rules', {
    max_age_days: CLEANUP_DEFAULT_DAYS,
    cleanup_empty: true,
    cleanup_unbound: true,
  });

  if (!cleanupRules.cleanup_unbound) {
    return;
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7);
  const cutoffStr = cutoffDate.toISOString().replace('T', ' ').substring(0, 19);

  // Find unbound addresses older than 7 days
  const unboundAddresses = await query<{ id: number; name: string }>(
    env.DB,
    `SELECT a.id, a.name 
     FROM address a 
     LEFT JOIN user_address ua ON a.id = ua.address_id 
     WHERE ua.id IS NULL AND a.created_at < ?`,
    [cutoffStr]
  );

  if (unboundAddresses.length === 0) {
    return;
  }

  // For each unbound address, delete its emails first
  for (const addr of unboundAddresses) {
    // Delete attachments from R2
    const attachments = await query<{ storage_key: string }>(
      env.DB,
      `SELECT a.storage_key FROM attachments a 
       JOIN mails m ON a.mail_id = m.id 
       WHERE m.address = ? AND a.storage_key IS NOT NULL`,
      [addr.name]
    );

    if (env.R2 && attachments.length > 0) {
      for (const attachment of attachments) {
        if (attachment.storage_key) {
          try {
            await env.R2.delete(attachment.storage_key);
          } catch (error) {
            console.error('[Cleanup] R2 delete error:', error);
          }
        }
      }
    }

    await deleteRows(env.DB, 'attachments', 'mail_id IN (SELECT id FROM mails WHERE address = ?)', [addr.name]);

    // Delete mails
    await deleteRows(env.DB, 'mails', 'address = ?', [addr.name]);
  }

  // Delete unbound addresses
  const ids = unboundAddresses.map(a => a.id);
  const placeholders = ids.map(() => '?').join(',');
  
  const result = await deleteRows(
    env.DB,
    'address',
    `id IN (${placeholders})`,
    ids
  );

  console.log(`[Cleanup] Deleted ${result} unbound addresses`);
}

/**
 * Run custom SQL cleanup statements from settings
 */
async function runCustomSQLCleanup(env: Bindings): Promise<void> {
  // Disabled for MVP security. Arbitrary SQL execution from settings is not allowed.
  const customSQL = await getSetting(env.DB, 'custom_sql_cleanup', '');
  if (customSQL && customSQL.trim() !== '') {
    console.warn('[Cleanup] custom_sql_cleanup is configured but ignored for security reasons');
  }
}
