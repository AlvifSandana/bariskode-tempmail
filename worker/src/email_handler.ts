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
  content: Uint8Array | null;
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

    // Process attachments metadata (basic extraction)
    const parsedAttachments = buildAttachmentMetadata(rawEmail);
    const hasAttachment = parsedAttachments.length > 0;

    // Determine if we should keep raw email
    const maxAttachmentBytes = parsedAttachments.reduce((max, item) => Math.max(max, item.size || 0), 0);
    const shouldKeepRaw = !shouldRemoveRaw(env, rawSize, hasAttachment, maxAttachmentBytes);

    // Build metadata
    const metadata = {
      has_attachment: hasAttachment,
      attachment_count: parsedAttachments.length,
      dropped_attachment_count: 0,
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

    if (hasAttachment) {
      let attachmentIndex = 0;
      const configuredMaxSize = Number(env.MAX_ATTACHMENT_SIZE || '5242880');
      for (const attachment of parsedAttachments) {
        let storageKey: string | null = null;
        const exceedsMaxSize = configuredMaxSize > 0 && attachment.size > configuredMaxSize;

        if (exceedsMaxSize) {
          metadata.dropped_attachment_count += 1;
        }

        if (!exceedsMaxSize && env.R2 && attachment.content && attachment.content.length > 0) {
          const safeAddress = toAddress.replace(/[^a-zA-Z0-9@._-]/g, '_');
          const safeFilename = (attachment.filename || `attachment-${attachmentIndex}`)
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .slice(0, 120);
          storageKey = `attachments/${safeAddress}/${mailId}/${Date.now()}-${attachmentIndex}-${safeFilename}`;

          try {
            await env.R2.put(storageKey, attachment.content, {
              httpMetadata: {
                contentType: attachment.contentType || 'application/octet-stream',
              },
            });
          } catch (error) {
            console.error('[Email] Failed to upload attachment to R2:', error);
            storageKey = null;
          }
        }

        await insertAndGetId(env.DB, 'attachments', {
          mail_id: mailId,
          address: toAddress,
          filename: attachment.filename,
          storage_key: storageKey,
          size: attachment.size,
          content_type: attachment.contentType,
          content_id: attachment.contentId,
          is_inline: attachment.isInline ? 1 : 0,
        });

        attachmentIndex++;
      }
    }

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

function buildAttachmentMetadata(rawEmail: string): ProcessedAttachment[] {
  const normalized = rawEmail.replace(/\r/g, '');
  const boundaryMatch = normalized.match(/boundary="?([^";\n]+)"?/i);
  const defaultAttachment: ProcessedAttachment = {
    filename: 'attachment.bin',
    storageKey: '',
    size: 0,
    contentType: 'application/octet-stream',
    contentId: null,
    isInline: false,
    content: null,
  };

  if (!boundaryMatch) {
    return checkForAttachments(rawEmail) ? [defaultAttachment] : [];
  }

  const boundary = boundaryMatch[1];
  const parts = normalized.split(`--${boundary}`);
  const attachments: ProcessedAttachment[] = [];

  for (const part of parts) {
    const lowered = part.toLowerCase();
    const hasDisposition = lowered.includes('content-disposition: attachment') || lowered.includes('content-disposition: inline');
    const hasName = lowered.includes('filename=');
    if (!hasDisposition && !hasName) continue;

    const filenameMatch = part.match(/filename\*?=(?:UTF-8''|"?)([^";\n]+)/i);
    const contentTypeMatch = part.match(/content-type:\s*([^;\n]+)/i);
    const contentIdMatch = part.match(/content-id:\s*<?([^>\n]+)>?/i);
    const inline = lowered.includes('content-disposition: inline');

    const rawFilename = filenameMatch ? filenameMatch[1].trim().replace(/"/g, '') : 'attachment.bin';
    let safeFilename = rawFilename;
    try {
      safeFilename = decodeURIComponent(rawFilename);
    } catch {
      safeFilename = rawFilename;
    }

    const [headerSection, bodySectionRaw] = part.split('\n\n');
    const bodySection = bodySectionRaw || '';
    const encodingMatch = (headerSection || part).match(/content-transfer-encoding:\s*([^;\n]+)/i);
    const encoding = encodingMatch ? encodingMatch[1].trim().toLowerCase() : '';
    const content = decodeAttachmentBody(bodySection, encoding);

    attachments.push({
      filename: safeFilename,
      storageKey: '',
      size: content?.length || 0,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
      contentId: contentIdMatch ? contentIdMatch[1].trim() : null,
      isInline: inline,
      content,
    });
  }

  if (attachments.length === 0 && checkForAttachments(rawEmail)) {
    return [defaultAttachment];
  }

  return attachments;
}

function decodeAttachmentBody(body: string, encoding: string): Uint8Array | null {
  const normalizedBody = body.trim();
  if (!normalizedBody) return null;

  if (encoding === 'base64') {
    try {
      const sanitized = normalizedBody.replace(/\s+/g, '');
      const binary = atob(sanitized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  if (encoding === 'quoted-printable') {
    const softBreakRemoved = normalizedBody.replace(/=\r?\n/g, '');
    const decoded = softBreakRemoved.replace(/=([A-Fa-f0-9]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    return new TextEncoder().encode(decoded);
  }

  return new TextEncoder().encode(normalizedBody);
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
  hasAttachment: boolean,
  maxAttachmentBytes: number
): boolean {
  if (env.REMOVE_ALL_ATTACHMENT === 'true' && hasAttachment) {
    return true;
  }

  if (env.REMOVE_EXCEED_SIZE_ATTACHMENT === 'true') {
    const maxAttachmentSize = Number(env.MAX_ATTACHMENT_SIZE || '5242880');
    if (maxAttachmentBytes > maxAttachmentSize && hasAttachment) {
      return true;
    }
  }

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
        promises.push(sendForwardMail(env, forwardTo, data));
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

async function sendForwardMail(env: Bindings, recipient: string, data: NotificationData): Promise<void> {
  try {
    if (!env.RESEND_API_KEY) {
      console.log(`[Email] Skip forward to ${recipient}: RESEND_API_KEY not configured`);
      return;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: data.address,
        to: [recipient],
        subject: data.subject || '(No Subject)',
        text: data.text || `Forwarded email from ${data.sender}`,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => 'Unknown forward error');
      console.error(`[Email] Forward failed to ${recipient}:`, detail);
    }
  } catch (error) {
    console.error(`[Email] Forward error to ${recipient}:`, error);
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
