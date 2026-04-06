import { D1Database } from '@cloudflare/workers-types';

/**
 * Execute a query and return all results
 */
export async function query<T = unknown>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const result = await stmt.bind(...params).all<T>();
  return result.results;
}

/**
 * Execute a query and return first result
 */
export async function queryOne<T = unknown>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const stmt = db.prepare(sql);
  const result = await stmt.bind(...params).first<T>();
  return result ?? null;
}

/**
 * Execute an insert/update/delete statement
 */
export async function execute(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<D1Result> {
  const stmt = db.prepare(sql);
  return await stmt.bind(...params).run();
}

/**
 * Insert a row and return the inserted ID
 */
export async function insertAndGetId(
  db: D1Database,
  table: string,
  data: Record<string, unknown>
): Promise<number> {
  const columns = Object.keys(data).join(', ');
  const placeholders = Object.keys(data).map(() => '?').join(', ');
  const values = Object.values(data);
  
  const sql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`;
  const result = await execute(db, sql, values);
  
  return result.meta.last_row_id;
}

/**
 * Update rows and return affected count
 */
export async function update(
  db: D1Database,
  table: string,
  data: Record<string, unknown>,
  where: string,
  whereParams: unknown[] = []
): Promise<number> {
  const setClause = Object.keys(data)
    .map(key => `${key} = ?`)
    .join(', ');
  const values = [...Object.values(data), ...whereParams];
  
  const sql = `UPDATE ${table} SET ${setClause} WHERE ${where}`;
  const result = await execute(db, sql, values);
  
  return result.meta.changes;
}

/**
 * Delete rows and return affected count
 */
export async function deleteRows(
  db: D1Database,
  table: string,
  where: string,
  whereParams: unknown[] = []
): Promise<number> {
  const sql = `DELETE FROM ${table} WHERE ${where}`;
  const result = await execute(db, sql, whereParams);
  
  return result.meta.changes;
}

/**
 * Check if a row exists
 */
export async function exists(
  db: D1Database,
  table: string,
  where: string,
  whereParams: unknown[] = []
): Promise<boolean> {
  const sql = `SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`;
  const result = await queryOne(db, sql, whereParams);
  return result !== null;
}

/**
 * Count rows
 */
export async function count(
  db: D1Database,
  table: string,
  where: string = '1=1',
  whereParams: unknown[] = []
): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM ${table} WHERE ${where}`;
  const result = await queryOne<{ count: number }>(db, sql, whereParams);
  return result?.count ?? 0;
}

/**
 * Get setting value from settings table
 */
export async function getSetting<T = string>(
  db: D1Database,
  key: string,
  defaultValue: T
): Promise<T> {
  const sql = 'SELECT value FROM settings WHERE key = ?';
  const result = await queryOne<{ value: string }>(db, sql, [key]);
  
  if (!result) return defaultValue;
  
  // Try to parse as JSON if defaultValue is object/array
  if (typeof defaultValue === 'object') {
    try {
      return JSON.parse(result.value) as T;
    } catch {
      return defaultValue;
    }
  }
  
  return result.value as T;
}

/**
 * Set setting value in settings table
 */
export async function setSetting(
  db: D1Database,
  key: string,
  value: string | object
): Promise<void> {
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
  
  const sql = `
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `;
  await execute(db, sql, [key, valueStr]);
}

/**
 * Get multiple settings at once
 */
export async function getSettings(
  db: D1Database,
  keys: string[]
): Promise<Record<string, string>> {
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `SELECT key, value FROM settings WHERE key IN (${placeholders})`;
  const results = await query<{ key: string; value: string }>(db, sql, keys);
  
  const settings: Record<string, string> = {};
  for (const row of results) {
    settings[row.key] = row.value;
  }
  
  return settings;
}
