import { Env } from 'hono';
import {
  queryOne,
  insertAndGetId,
  getSetting,
  query,
  execute,
} from './utils/db';
import {
  extractSenderEmail,
  checkSenderList,
  parseAddress,
  isDomainAllowed,
} from './utils/email';
import { Mail, ParsedMail, Attachment } from './models/mail';
import { Address } from './models/address';
import type { AppBindings } from './types/env';
import { getAddressWatchers, sendTelegramMessage } from './utils/telegram';
import { escapeTelegramMarkdown } from './utils/telegram';

type Bindings = Env & AppBindings & {
  AI?: {
    run: (model: string, input: { prompt: string }) => Promise<{ response?: string; text?: string }>;
  };
};

interface ProcessedAttachment {
  filename: string | null;
  storageKey: string;
  size: number;
  contentType: string;
  contentId: string | null;
  isInline: boolean;
}

interface NotificationData {
  mailId: number;
  address: string;
  subject: string | null;
  sender: string;
  text: string | null;
  html: string | null;
  aiExtraction?: Record<string, unknown> | null;
}

/**
 * Handle incoming email from Cloudflare Email Routing
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  const startTime = Date.now();

  try {
    // Extract recipient address
    const toAddress = message.to;
    const parsedTo = parseAddress(toAddress);

    if (!parsedTo) {
      console.error('[Email] Invalid recipient address:', toAddress);
      message.setReject('Invalid recipient address');
      return;
    }

    // Check if domain is allowed
    if (!isDomainAllowed(parsedTo.domain, env)) {
      console.error('[Email] Domain not allowed:', parsedTo.domain);
      message.setReject('Domain not allowed');
      return;
    }

    // Get raw email content
    const rawEmail = await extractRawEmail(message);
    const rawSize = rawEmail.length;

    console.log(`[Email] Received for: ${toAddress}, size: ${rawSize} bytes`);

    // Extract sender from headers
    const senderEmail = extractSenderEmail(message.from);

    // Check blacklist/whitelist
    const blacklist = await getSetting<string[]>(env.DB, 'blacklist', []);
    const whitelist = await getSetting<string[]>(env.DB, 'whitelist', []);
    const senderCheck = checkSenderList(senderEmail, whitelist, blacklist);

    if (!senderCheck.allowed) {
      console.log(`[Email] Rejected from ${senderEmail}: ${senderCheck.reason}`);
      message.setReject(senderCheck.reason || 'Sender not allowed');
      return;
    }

    // Verify address exists in database
    const address = await queryOne<Address>(
      env.DB,
      'SELECT * FROM address WHERE name = ?',
      [toAddress]
    );

    if (!address) {
      console.log(`[Email] Address not found: ${toAddress}`);
      message.setReject('Address not found');
      return;
    }

    // Parse email (basic parsing - extract subject, message_id)
    const { subject, messageId, sourceIP } = parseBasicEmailHeaders(rawEmail);
    const extractedText = extractBodyText(rawEmail);
    const aiExtraction = await extractImportantInfo(env, toAddress, rawEmail, extractedText);

    // Process attachments (basic - store raw, mark has_attachment)
    const hasAttachment = checkForAttachments(rawEmail);

    // Determine if we should keep raw email
    const shouldKeepRaw = !shouldRemoveRaw(env, rawSize, hasAttachment);

    // Build metadata
    const metadata = {
      has_attachment: hasAttachment,
      attachment_count: hasAttachment ? 1 : 0,
      ai_extraction: aiExtraction,
    };

    // Store email in database
    const mailId = await insertAndGetId(env.DB, 'mails', {
      source: sourceIP,
      address: toAddress,
      raw: shouldKeepRaw ? rawEmail : null,
      subject: subject || '(No Subject)',
      sender: senderEmail,
      message_id: messageId || null,
      is_read: 0,
      metadata: JSON.stringify(metadata),
    });

    console.log(`[Email] Stored mail id: ${mailId} for address: ${toAddress}`);

    await execute(env.DB, 'UPDATE mails SET metadata = ? WHERE id = ?', [JSON.stringify(metadata), mailId]);

    // Trigger webhooks and notifications (async, don't wait)
    ctx.waitUntil(
      triggerNotifications(env, {
        mailId,
        address: toAddress,
        subject,
        sender: senderEmail,
        text: extractedText,
        html: null,
        aiExtraction,
      })
    );

    const duration = Date.now() - startTime;
    console.log(`[Email] Processed in ${duration}ms`);

  } catch (error) {
    console.error('[Email] Handler error:', error);
    message.setReject('Internal error processing email');
  }
}

/**
 * Extract raw email content from ForwardableEmailMessage
 */
async function extractRawEmail(message: ForwardableEmailMessage): Promise<string> {
  const reader = message.raw.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Combine chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert to string
  return new TextDecoder().decode(combined);
}

/**
 * Parse basic email headers (subject, message-id, source IP)
 */
function parseBasicEmailHeaders(rawEmail: string): {
  subject: string | null;
  messageId: string | null;
  sourceIP: string | null;
} {
  let subject: string | null = null;
  let messageId: string | null = null;
  let sourceIP: string | null = null;

  const lines = rawEmail.split(/\r?\n/);
  let inHeaders = true;

  for (const line of lines) {
    if (inHeaders && line === '') {
      inHeaders = false;
      continue;
    }

    if (!inHeaders) break;

    // Subject header
    if (line.toLowerCase().startsWith('subject:')) {
      subject = line.substring(8).trim();
      // Handle multi-line subject
      continue;
    }

    // Message-ID header
    if (line.toLowerCase().startsWith('message-id:')) {
      messageId = line.substring(11).trim();
      continue;
    }

    // Source IP (X-Originating-IP or similar)
    if (line.toLowerCase().startsWith('x-originating-ip:') ||
        line.toLowerCase().startsWith('x-source-ip:')) {
      const match = line.match(/\[?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]?/);
      if (match) {
        sourceIP = match[1];
      }
      continue;
    }
  }

  return { subject, messageId, sourceIP };
}

/**
 * Check if email has attachments (basic check)
 */
function checkForAttachments(rawEmail: string): boolean {
  const lower = rawEmail.toLowerCase();
  
  // Check for Content-Disposition: attachment
  if (lower.includes('content-disposition: attachment')) {
    return true;
  }

  // Check for multipart/mixed or multipart/related
  if (lower.includes('content-type: multipart/mixed') ||
      lower.includes('content-type: multipart/related')) {
    // Check if there's an attachment part
    if (lower.includes('content-disposition:') && 
        !lower.includes('content-disposition: inline')) {
      return true;
    }
  }

  return false;
}

function extractBodyText(rawEmail: string): string | null {
  const normalized = rawEmail.replace(/\r/g, '');
  const parts = normalized.split('\n\n');
  if (parts.length < 2) return null;
  const body = parts.slice(1).join('\n\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return body || null;
}

function regexExtraction(content: string): Record<string, unknown> | null {
  const otp = content.match(/\b(\d{4,8})\b/);
  const links = Array.from(content.matchAll(/https?:\/\/[^\s<>"]+/gi)).map((match) => match[0]);
  const authLink = links.find((link) => /verify|login|auth|signin|reset/i.test(link)) || null;
  const serviceLink = links[0] || null;

  if (!otp && !authLink && !serviceLink) return null;

  return {
    otp: otp?.[1] || null,
    auth_link: authLink,
    service_link: serviceLink,
    links: links.slice(0, 5),
    source: 'regex',
  };
}

function addressMatchesPattern(address: string, pattern: string): boolean {
  const safePattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${safePattern}$`, 'i').test(address);
}

async function extractImportantInfo(env: Bindings, address: string, rawEmail: string, text: string | null): Promise<Record<string, unknown> | null> {
  const combined = `${text || ''}\n${rawEmail}`;
  const fallback = regexExtraction(combined);

  const aiSettings = await getSetting<{ enabled?: boolean; address_whitelist?: string[] }>(
    env.DB,
    'ai_extract_settings',
    { enabled: false, address_whitelist: [] }
  );

  const enabled = aiSettings?.enabled === true;
  const whitelist = Array.isArray(aiSettings?.address_whitelist) ? aiSettings.address_whitelist : [];
  const whitelisted = whitelist.length === 0 ? false : whitelist.some((pattern) => addressMatchesPattern(address, pattern));

  if (!env.AI || !enabled || !whitelisted) return fallback;

  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt: `Extract JSON with keys otp, auth_link, service_link, summary from this email. Return JSON only. Email:\n${String(text || rawEmail).slice(0, 2500)}`,
    });
    const raw = result?.response || result?.text;
    if (!raw) return fallback;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return { ...fallback, ...parsed, source: 'ai' };
  } catch {
    return fallback;
  }
}

/**
 * Check if raw email should be removed
 */
function shouldRemoveRaw(
  env: Bindings,
  emailSize: number,
  hasAttachment: boolean
): boolean {
  // Remove if too large and has attachments
  const maxRawSize = 500000; // 500KB
  return emailSize > maxRawSize && hasAttachment;
}

/**
 * Trigger notifications (webhook, telegram, forward)
 */
async function triggerNotifications(
  env: Bindings,
  data: NotificationData
): Promise<void> {
  const promises: Promise<void>[] = [];

  // Webhook notification
  if (env.WEBHOOK_URL) {
    promises.push(sendWebhook(env, env.WEBHOOK_URL, data));
  }

  // Forward to addresses
  if (env.FORWARD_ADDRESS_LIST) {
    const forwardAddresses = env.FORWARD_ADDRESS_LIST.split(',').map(a => a.trim());
    for (const forwardTo of forwardAddresses) {
      if (forwardTo) {
        // Forwarding requires email sending capability
        console.log(`[Email] Would forward to: ${forwardTo}`);
      }
    }
  }

  // Telegram notification
  if (env.TELEGRAM_BOT_TOKEN) {
    promises.push(sendTelegramNotification(env, data));
  }

  // Wait for all notifications (or timeout)
  await Promise.allSettled(promises);
}

/**
 * Send webhook notification
 */
async function sendWebhook(env: Bindings, webhookUrl: string, data: NotificationData): Promise<void> {
  try {
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify({
      mail_id: data.mailId,
      address: data.address,
      subject: data.subject,
      sender: data.sender,
      text: data.text,
      html: data.html,
      ai_extraction: data.aiExtraction,
      timestamp,
    });

    const signature = env.WEBHOOK_SECRET
      ? await signWebhookPayload(`${timestamp}.${payload}`, env.WEBHOOK_SECRET)
      : null;

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': signature } : {}),
      },
      body: payload,
    });

    if (!response.ok) {
      console.error('[Webhook] Failed:', response.status);
    }
  } catch (error) {
    console.error('[Webhook] Error:', error);
  }
}

async function signWebhookPayload(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Send Telegram notification
 */
async function sendTelegramNotification(
  env: Bindings,
  data: NotificationData
): Promise<void> {
  try {
    const watchers = await getAddressWatchers(env.KV, data.address);
    if (watchers.length === 0) return;

    const text = `📧 *New Email Received*\n\n*To:* \`${escapeTelegramMarkdown(data.address)}\`\n*From:* ${escapeTelegramMarkdown(data.sender)}\n*Subject:* ${escapeTelegramMarkdown(data.subject || '(No Subject)')}${data.aiExtraction?.['otp'] ? `\n*OTP:* ${escapeTelegramMarkdown(String(data.aiExtraction['otp']))}` : ''}${data.text ? `\n\n${escapeTelegramMarkdown(String(data.text).slice(0, 160))}` : ''}`;

    await Promise.allSettled(watchers.map((chatId) => sendTelegramMessage(env, chatId, text)));
  } catch (error) {
    console.error('[Telegram] Error:', error);
  }
}
