import { insertAndGetId, query, queryOne } from './db';
import { generateRandomName, parseDomains } from './email';
import type { AppBindings } from '../types/env';
import type { Address } from '../models/address';

type TelegramState = {
  lang: string;
  currentAddress: string | null;
  addresses: string[];
};

const DEFAULT_STATE: TelegramState = {
  lang: 'en',
  currentAddress: null,
  addresses: [],
};

function escapeTelegramMarkdown(input: string): string {
  return input.replace(/([_\*\[\]\(\)~`>#+\-=|{}.!])/g, '\\$1');
}

function chatStateKey(chatId: string) {
  return `tg:chat:${chatId}:state`;
}

function addressWatchersKey(address: string) {
  return `tg:address:${address}:watchers`;
}

export async function getTelegramState(kv: KVNamespace, chatId: string): Promise<TelegramState> {
  const raw = await kv.get(chatStateKey(chatId));
  if (!raw) return DEFAULT_STATE;

  try {
    const parsed = JSON.parse(raw) as Partial<TelegramState>;
    return {
      lang: parsed.lang || 'en',
      currentAddress: parsed.currentAddress || null,
      addresses: Array.isArray(parsed.addresses) ? parsed.addresses : [],
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export async function saveTelegramState(kv: KVNamespace, chatId: string, state: TelegramState): Promise<void> {
  await kv.put(chatStateKey(chatId), JSON.stringify(state));
}

export async function addWatcherToAddress(kv: KVNamespace, address: string, chatId: string): Promise<void> {
  const raw = await kv.get(addressWatchersKey(address));
  let watchers: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as string[];
      watchers = Array.isArray(parsed) ? parsed : [];
    } catch {
      watchers = [];
    }
  }
  if (!watchers.includes(chatId)) watchers.push(chatId);
  await kv.put(addressWatchersKey(address), JSON.stringify(watchers));
}

export async function getAddressWatchers(kv: KVNamespace, address: string): Promise<string[]> {
  const raw = await kv.get(addressWatchersKey(address));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function createTelegramAddress(env: AppBindings, chatId: string): Promise<{ id: number; address: string }> {
  const domains = parseDomains(env.DOMAINS);
  if (domains.length === 0) {
    throw new Error('DOMAINS configuration is empty');
  }
  const domain = domains[0];
  const prefix = env.PREFIX || 'tmp';

  let fullAddress = '';
  for (let i = 0; i < 10; i++) {
    const local = prefix ? `${prefix}_${generateRandomName(8)}` : generateRandomName(8);
    fullAddress = `${local}@${domain}`;
    const existing = await queryOne<Address>(env.DB, 'SELECT * FROM address WHERE name = ?', [fullAddress]);
    if (!existing) break;
    fullAddress = '';
  }

  if (!fullAddress) {
    throw new Error('Unable to generate unique address');
  }

  const id = await insertAndGetId(env.DB, 'address', {
    name: fullAddress,
    source_ip: `telegram:${chatId}`,
    password: null,
    balance: 0,
  });

  const state = await getTelegramState(env.KV, chatId);
  const nextState: TelegramState = {
    ...state,
    currentAddress: fullAddress,
    addresses: state.addresses.includes(fullAddress) ? state.addresses : [...state.addresses, fullAddress],
  };
  await saveTelegramState(env.KV, chatId, nextState);
  await addWatcherToAddress(env.KV, fullAddress, chatId);

  return { id, address: fullAddress };
}

export async function sendTelegramMessage(env: AppBindings, chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(`Telegram send failed: ${response.status} ${JSON.stringify(payload)}`);
  }
}

export { escapeTelegramMarkdown };

export async function listInboxForAddress(env: AppBindings, address: string, limit = 10) {
  return query<{
    id: number;
    sender: string | null;
    subject: string | null;
    created_at: string;
  }>(
    env.DB,
    `SELECT id, sender, subject, created_at
     FROM mails
     WHERE address = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [address, limit]
  );
}

export async function readInboxMail(env: AppBindings, address: string, mailId: number) {
  return queryOne<{
    id: number;
    sender: string | null;
    subject: string | null;
    raw: string | null;
    created_at: string;
  }>(
    env.DB,
    'SELECT id, sender, subject, raw, created_at FROM mails WHERE id = ? AND address = ?',
    [mailId, address]
  );
}
