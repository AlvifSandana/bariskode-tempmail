import type { AppBindings } from '../types/env';

type MockKVStore = Map<string, string>;

export function createMockKV(initial?: Record<string, string>): KVNamespace {
  const store: MockKVStore = new Map(Object.entries(initial || {}));

  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

export function createMockDB(handlers: {
  first?: (sql: string, params: unknown[]) => unknown;
  all?: (sql: string, params: unknown[]) => unknown[];
  run?: (sql: string, params: unknown[]) => { meta?: { last_row_id?: number; changes?: number } };
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first() {
              return (handlers.first ? handlers.first(sql, params) : null) as never;
            },
            async all() {
              return { results: (handlers.all ? handlers.all(sql, params) : []) as never[] };
            },
            async run() {
              return (handlers.run ? handlers.run(sql, params) : { meta: { last_row_id: 1, changes: 1 } }) as never;
            },
          };
        },
      } as never;
    },
  } as D1Database;
}

export function getCurrentRateLimitWindow(windowMs: number): number {
  const now = Date.now();
  return now - (now % windowMs);
}

export function createBaseEnv(overrides: Partial<AppBindings> = {}): AppBindings {
  return {
    DB: createMockDB({}),
    KV: createMockKV(),
    R2: {} as R2Bucket,
    DOMAINS: 'example.com,temp.example.com',
    PREFIX: 'tmp',
    JWT_SECRET: 'test-secret-123456789012345678901234567890',
    ADMIN_PASSWORDS: 'admin-secret',
    ENABLE_ADDRESS_PASSWORD: 'true',
    DISABLE_CUSTOM_ADDRESS_NAME: 'false',
    CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST: 'true',
    DEFAULT_DOMAINS: '',
    ANNOUNCEMENT: '',
    ALWAYS_SHOW_ANNOUNCEMENT: 'false',
    TURNSTILE_SECRET: '',
    DEBUG_MODE: 'false',
    MAX_ATTACHMENT_SIZE: '5242880',
    REMOVE_ALL_ATTACHMENT: 'false',
    REMOVE_EXCEED_SIZE_ATTACHMENT: 'false',
    FORWARD_ADDRESS_LIST: '',
    WEBHOOK_URL: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_WEBHOOK_SECRET: 'secret',
    DKIM_PRIVATE_KEY: '',
    RESEND_API_KEY: '',
    SMTP_HOST: '',
    SMTP_PORT: '587',
    SMTP_USERNAME: '',
    SMTP_PASSWORD: '',
    S3_REGION: '',
    S3_ENDPOINT: '',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
    S3_BUCKET: '',
    OAUTH2_PROVIDERS: '[]',
    USER_ROLES: '[{"name":"default"}]',
    USER_DEFAULT_ROLE: 'default',
    ...overrides,
  };
}
