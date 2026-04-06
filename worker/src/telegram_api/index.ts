import { Hono } from 'hono';
import type { AppBindings } from '../types/env';
import {
  createTelegramAddress,
  escapeTelegramMarkdown,
  getTelegramState,
  listInboxForAddress,
  readInboxMail,
  saveTelegramState,
  sendTelegramMessage,
} from '../utils/telegram';

const app = new Hono<{ Bindings: AppBindings }>();

function helpText() {
  return [
    'Temp Mail Bot Commands:',
    '/start - show help',
    '/new - create new temporary address',
    '/list - list your addresses',
    '/inbox - list latest emails for current address',
    '/read <id> - read email by id',
    '/lang <en|id> - change language',
  ].join('\n');
}

function extractBodyPreview(raw: string | null): string {
  if (!raw) return 'No content';
  const normalized = raw.replace(/\r/g, '');
  const parts = normalized.split('\n\n');
  const body = parts.slice(1).join('\n\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return body.slice(0, 400) || 'No content';
}

app.post('/bot', async (c) => {
  if (!c.env.TELEGRAM_BOT_WEBHOOK_SECRET) {
    return c.json({ ok: false, error: 'telegram_webhook_secret_not_configured' }, 503);
  }

  const secretHeader = c.req.header('x-telegram-bot-api-secret-token');
  if (secretHeader !== c.env.TELEGRAM_BOT_WEBHOOK_SECRET) {
    return c.json({ ok: false, error: 'invalid_secret' }, 401);
  }

  const update = await c.req.json().catch(() => null);
  const message = update?.message;
  const chatId = message?.chat?.id ? String(message.chat.id) : null;
  const text = String(message?.text || '').trim();

  if (!chatId || !text.startsWith('/')) {
    return c.json({ ok: true });
  }

  const state = await getTelegramState(c.env.KV, chatId);
  const [command, ...args] = text.split(/\s+/);

  const rateKey = `tg:rate:${chatId}:${command}`;
  const currentCount = Number((await c.env.KV.get(rateKey)) || '0');
  if (currentCount >= 20) {
    await sendTelegramMessage(c.env, chatId, 'Too many requests. Please try again later.');
    return c.json({ ok: true });
  }
  await c.env.KV.put(rateKey, String(currentCount + 1), { expirationTtl: 60 });

  try {
    if (command === '/start') {
      await sendTelegramMessage(c.env, chatId, helpText());
      return c.json({ ok: true });
    }

    if (command === '/new') {
      const created = await createTelegramAddress(c.env, chatId);
      await sendTelegramMessage(c.env, chatId, `✅ New address created:\n\`${escapeTelegramMarkdown(created.address)}\``);
      return c.json({ ok: true });
    }

    if (command === '/list') {
      const messageText = state.addresses.length
        ? `Your addresses:\n${state.addresses.map((addr, idx) => `${idx + 1}. \`${escapeTelegramMarkdown(addr)}\`${state.currentAddress === addr ? ' *(current)*' : ''}`).join('\n')}`
        : 'You do not have any addresses yet. Use /new';
      await sendTelegramMessage(c.env, chatId, messageText);
      return c.json({ ok: true });
    }

    if (command === '/inbox') {
      if (!state.currentAddress) {
        await sendTelegramMessage(c.env, chatId, 'No current address. Use /new first.');
        return c.json({ ok: true });
      }

      const mails = await listInboxForAddress(c.env, state.currentAddress, 10);
      const messageText = mails.length
        ? `Inbox for \`${escapeTelegramMarkdown(state.currentAddress)}\`:\n${mails.map((mail) => `#${mail.id} — *${escapeTelegramMarkdown(mail.subject || '(No Subject)')}*\nFrom: ${escapeTelegramMarkdown(mail.sender || 'Unknown')}\nDate: ${escapeTelegramMarkdown(mail.created_at)}`).join('\n\n')}`
        : `Inbox is empty for \`${escapeTelegramMarkdown(state.currentAddress)}\``;
      await sendTelegramMessage(c.env, chatId, messageText);
      return c.json({ ok: true });
    }

    if (command === '/read') {
      if (!state.currentAddress) {
        await sendTelegramMessage(c.env, chatId, 'No current address. Use /new first.');
        return c.json({ ok: true });
      }

      const id = Number(args[0] || 0);
      if (!id) {
        await sendTelegramMessage(c.env, chatId, 'Usage: /read <id>');
        return c.json({ ok: true });
      }

      const mail = await readInboxMail(c.env, state.currentAddress, id);
      if (!mail) {
        await sendTelegramMessage(c.env, chatId, 'Mail not found for current address.');
        return c.json({ ok: true });
      }

      await sendTelegramMessage(
        c.env,
        chatId,
        `*${escapeTelegramMarkdown(mail.subject || '(No Subject)')}*\nFrom: ${escapeTelegramMarkdown(mail.sender || 'Unknown')}\nDate: ${escapeTelegramMarkdown(mail.created_at)}\n\n${escapeTelegramMarkdown(extractBodyPreview(mail.raw))}`
      );
      return c.json({ ok: true });
    }

    if (command === '/lang') {
      const lang = ['en', 'id'].includes(args[0]) ? args[0] : 'en';
      await saveTelegramState(c.env.KV, chatId, { ...state, lang });
      await sendTelegramMessage(c.env, chatId, `Language set to ${lang}`);
      return c.json({ ok: true });
    }

    await sendTelegramMessage(c.env, chatId, helpText());
    return c.json({ ok: true });
  } catch (error) {
    console.error('[Telegram API] bot error:', error);
    await sendTelegramMessage(c.env, chatId, 'An error occurred while processing your command.');
    return c.json({ ok: true });
  }
});

export default app;
