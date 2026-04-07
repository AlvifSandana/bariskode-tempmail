import { Hono } from 'hono';
import {
  query,
  queryOne,
  insertAndGetId,
  execute,
  deleteRows,
  getSetting,
  count,
} from '../utils/db';
import {
  signAddressJWT,
  verifyJWT,
  extractBearerToken,
} from '../utils/jwt';
import {
  generateRandomName,
  validateName,
  validateAddress,
  parseDomains,
  isCustomNameAllowed,
  isNameBlacklisted,
  isDomainAllowed,
} from '../utils/email';
import { hashPassword, verifyPassword } from '../utils/crypto';
import {
  checkRateLimit,
  isIPBlacklisted,
  RATE_LIMIT_PRESETS,
} from '../utils/rate_limit';
import { Address, AddressJWT } from '../models/address';
import { Mail, AttachmentMeta } from '../models/mail';
import { PublicSettings } from '../models/settings';
import {
  ERROR_CODES,
  HTTP_STATUS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ADDRESS_PASSWORD_MIN_LENGTH,
} from '../constants';
import type { AppBindings } from '../types/env';
import { extractTurnstileToken, verifyTurnstileToken } from '../utils/turnstile';

const app = new Hono<{ Bindings: AppBindings }>();
const DUMMY_PASSWORD_HASH =
  '70f6bfd56651d62b5f461ef8d93f2eefab0b8e027fac636f69ca6af89ee15f98:5f420f67f25f84f1f3dbaa07a6deaf770915065658c42272615d08e1ebf31f0d4f63ecf274c6fd44f10e9fd77ef696d7edce6ea9786806d83a7bfd7f0f37e659';

interface SendboxMail {
  id: number;
  address: string;
  subject: string | null;
  sender: string | null;
  recipient: string;
  created_at: string;
}

// ==================== GET /api/settings ====================
app.get('/settings', async (c) => {
  const domains = parseDomains(c.env.DOMAINS);
  const announcement = c.env.ANNOUNCEMENT || '';
  const enableAddressPassword = c.env.ENABLE_ADDRESS_PASSWORD === 'true';
  const disableCustomAddressName = c.env.DISABLE_CUSTOM_ADDRESS_NAME === 'true';
  const alwaysShowAnnouncement = c.env.ALWAYS_SHOW_ANNOUNCEMENT === 'true';
  const prefix = c.env.PREFIX || '';

  const settings: PublicSettings = {
    domains,
    announcement,
    enable_address_password: enableAddressPassword,
    disable_custom_address_name: disableCustomAddressName,
    always_show_announcement: alwaysShowAnnouncement,
    prefix,
  };

  return c.json({
    success: true,
    data: settings,
  });
});

// ==================== POST /api/new_address ====================
app.post('/new_address', async (c) => {
  try {
    // Get client IP
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';

    // Check if IP is blacklisted
    if (await isIPBlacklisted(c.env.KV, ip)) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.FORBIDDEN,
          message: 'Your IP has been blocked',
        },
        HTTP_STATUS.FORBIDDEN
      );
    }

    // Check rate limit
    const rateLimitResult = await checkRateLimit(
      c.env.KV,
      ip,
      RATE_LIMIT_PRESETS.NEW_ADDRESS
    );

    if (!rateLimitResult.allowed) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.RATE_LIMITED,
          message: 'Too many requests. Please try again later.',
          retry_after: rateLimitResult.retryAfter,
        },
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    }

    // Parse request body
    const body = await c.req.json().catch(() => ({}));
    const { name, password, domain } = body;

    if (String(c.env.TURNSTILE_SECRET || '').trim() !== '') {
      const turnstileToken = extractTurnstileToken(body);
      if (!turnstileToken) {
        return c.json(
          {
            success: false,
            error: ERROR_CODES.CAPTCHA_FAILED,
            message: 'Captcha verification required',
          },
          HTTP_STATUS.BAD_REQUEST
        );
      }

      const turnstile = await verifyTurnstileToken({
        secret: c.env.TURNSTILE_SECRET,
        token: turnstileToken,
        remoteIp: ip,
      });

      if (!turnstile.success) {
        return c.json(
          {
            success: false,
            error: ERROR_CODES.CAPTCHA_FAILED,
            message: 'Captcha verification failed',
          },
          HTTP_STATUS.FORBIDDEN
        );
      }
    }

    // Determine address name
    let addressName: string;

    if (name) {
      // Check if custom names are allowed
      if (!isCustomNameAllowed(c.env)) {
        return c.json(
          {
            success: false,
            error: ERROR_CODES.FORBIDDEN,
            message: 'Custom address names are disabled',
          },
          HTTP_STATUS.FORBIDDEN
        );
      }

      // Validate custom name
      const validation = validateName(name);
      if (!validation.valid) {
        return c.json(
          {
            success: false,
            error: ERROR_CODES.INVALID_ADDRESS_NAME,
            message: validation.error,
          },
          HTTP_STATUS.BAD_REQUEST
        );
      }

      // Check name blacklist
      const nameBlacklist = await getSetting<string[]>(c.env.DB, 'address_name_blacklist', []);
      if (isNameBlacklisted(name, nameBlacklist)) {
        return c.json(
          {
            success: false,
            error: ERROR_CODES.FORBIDDEN,
            message: 'This address name is not allowed',
          },
          HTTP_STATUS.FORBIDDEN
        );
      }

      addressName = name;
    } else {
      // Generate random name
      addressName = generateRandomName(8);
    }

    // Determine domain
    let selectedDomain: string;
    const allowedDomains = parseDomains(c.env.DOMAINS);

    if (domain) {
      // Validate requested domain
      if (!isDomainAllowed(domain, c.env)) {
        return c.json(
          {
            success: false,
            error: ERROR_CODES.FORBIDDEN,
            message: 'Domain not allowed',
          },
          HTTP_STATUS.FORBIDDEN
        );
      }
      selectedDomain = domain;
    } else {
      // Use first domain or default domain
      const defaultDomains = c.env.DEFAULT_DOMAINS
        ? parseDomains(c.env.DEFAULT_DOMAINS)
        : allowedDomains;
      
      const useFirst = c.env.CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST === 'true';
      selectedDomain = useFirst ? allowedDomains[0] : defaultDomains[0] || allowedDomains[0];
    }

    // Build full address
    const prefix = c.env.PREFIX || '';
    const fullAddress = prefix
      ? `${prefix}_${addressName}@${selectedDomain}`
      : `${addressName}@${selectedDomain}`;

    // Check if address already exists
    const existing = await queryOne<Address>(
      c.env.DB,
      'SELECT id FROM address WHERE name = ?',
      [fullAddress]
    );

    if (existing) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.ADDRESS_EXISTS,
          message: 'Address already exists. Try a different name.',
        },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Handle password if address password is enabled
    let hashedPassword: string | null = null;
    if (c.env.ENABLE_ADDRESS_PASSWORD === 'true' && password) {
      if (password.length < ADDRESS_PASSWORD_MIN_LENGTH) {
        return c.json(
          {
            success: false,
            error: ERROR_CODES.INVALID_REQUEST,
            message: `Password must be at least ${ADDRESS_PASSWORD_MIN_LENGTH} characters`,
          },
          HTTP_STATUS.BAD_REQUEST
        );
      }
      hashedPassword = await hashPassword(password);
    }

    // Insert address into database
    const addressId = await insertAndGetId(c.env.DB, 'address', {
      name: fullAddress,
      source_ip: ip,
      password: hashedPassword,
      balance: 0,
    });

    // Generate JWT
    const token = await signAddressJWT(addressId, fullAddress, c.env);

    console.log(`[API] Created address: ${fullAddress} from IP: ${ip}`);

    return c.json({
      success: true,
      data: {
        id: addressId,
        address: fullAddress,
        token,
      },
    });
  } catch (error) {
    console.error('[API] new_address error:', error);
    return c.json(
      {
        success: false,
        error: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to create address',
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== POST /api/address_auth ====================
app.post('/address_auth', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';

    const body = await c.req.json().catch(() => ({}));
    const address = String(body.address || '').trim().toLowerCase();
    const password = String(body.password || '');

    const rateLimitResult = await checkRateLimit(
      c.env.KV,
      `${ip}:${address || 'unknown'}`,
      RATE_LIMIT_PRESETS.ADDRESS_AUTH
    );
    if (!rateLimitResult.allowed) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.RATE_LIMITED,
          message: 'Too many authentication attempts. Please try again later.',
          retry_after: rateLimitResult.retryAfter,
        },
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    }

    if (!address || !password) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.INVALID_REQUEST,
          message: 'address and password are required',
        },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const addressValidation = validateAddress(address);
    if (!addressValidation.valid) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid address format',
        },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const existingAddress = await queryOne<Address>(
      c.env.DB,
      'SELECT * FROM address WHERE name = ?',
      [address]
    );

    if (!existingAddress || !existingAddress.password) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid credentials',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const validPassword = await verifyPassword(password, existingAddress.password);
    if (!validPassword) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid credentials',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const token = await signAddressJWT(existingAddress.id, existingAddress.name, c.env);

    return c.json({
      success: true,
      data: {
        id: existingAddress.id,
        address: existingAddress.name,
        token,
      },
    });
  } catch (error) {
    console.error('[API] address_auth error:', error);
    return c.json(
      {
        success: false,
        error: ERROR_CODES.INTERNAL_ERROR,
        message: 'Address authentication failed',
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== GET /api/mails ====================
app.get('/mails', async (c) => {
  try {
    // Get client IP for rate limiting
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    
    // Check rate limit
    const rateLimitResult = await checkRateLimit(
      c.env.KV,
      ip,
      RATE_LIMIT_PRESETS.GET_MAILS
    );

    if (!rateLimitResult.allowed) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.RATE_LIMITED,
          message: 'Too many requests. Please try again later.',
          retry_after: rateLimitResult.retryAfter,
        },
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    }

    // Get JWT from Authorization header
    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Authorization required',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    // Verify JWT
    const payload = await verifyJWT<AddressJWT>(token, c.env);
    if (!payload || payload.type !== 'address') {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid token',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    // Get pagination params with validation
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
    const limit = Math.max(1, Math.min(
      parseInt(c.req.query('limit') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE
    ));
    const offset = (page - 1) * limit;

    // Get total count
    const total = await count(
      c.env.DB,
      'mails',
      'address = ?',
      [payload.address]
    );

    // Get mails
    const mails = await query<Mail>(
      c.env.DB,
      `SELECT id, source, address, subject, sender, message_id, created_at, is_read, metadata
       FROM mails 
       WHERE address = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [payload.address, limit, offset]
    );

    // Check if address password is required
    const needsPassword = c.env.ENABLE_ADDRESS_PASSWORD === 'true';

    return c.json({
      success: true,
      data: {
        mails,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
        address: payload.address,
        needs_password: needsPassword,
      },
    });
  } catch (error) {
    console.error('[API] mails error:', error);
    return c.json(
      {
        success: false,
        error: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to fetch mails',
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== GET /api/mails/:id ====================
app.get('/mails/:id', async (c) => {
  try {
    const mailId = parseInt(c.req.param('id'), 10);
    if (isNaN(mailId)) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid mail ID',
        },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Get JWT from Authorization header
    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Authorization required',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    // Verify JWT
    const payload = await verifyJWT<AddressJWT>(token, c.env);
    if (!payload || payload.type !== 'address') {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid token',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    // Get mail
    const mail = await queryOne<Mail>(
      c.env.DB,
      'SELECT * FROM mails WHERE id = ? AND address = ?',
      [mailId, payload.address]
    );

    if (!mail) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.MAIL_NOT_FOUND,
          message: 'Mail not found',
        },
        HTTP_STATUS.NOT_FOUND
      );
    }

    // Get attachments
    const attachments = await query<AttachmentMeta>(
      c.env.DB,
      'SELECT id, filename, storage_key, size, content_type, content_id, is_inline FROM attachments WHERE mail_id = ?',
      [mailId]
    );

    // Parse email content from raw (basic implementation - for WASM parsing, we'll handle separately)
    let parsedContent: { text?: string; html?: string } = {};
    
    if (mail.raw) {
      // Basic extraction - look for text/plain and text/html parts
      const rawLower = mail.raw.toLowerCase();
      const textMatch = mail.raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i);
      const htmlMatch = mail.raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i);
      
      if (textMatch) parsedContent.text = textMatch[1].trim();
      if (htmlMatch) parsedContent.html = htmlMatch[1].trim();
    }

    // Mark as read
    if (!mail.is_read) {
      await execute(
        c.env.DB,
        'UPDATE mails SET is_read = 1 WHERE id = ?',
        [mailId]
      );
    }

    return c.json({
      success: true,
      data: {
        ...mail,
        is_read: 1,
        text: parsedContent.text,
        html: parsedContent.html,
        attachments,
      },
    });
  } catch (error) {
    console.error('[API] mail detail error:', error);
    return c.json(
      {
        success: false,
        error: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to fetch mail',
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== GET /api/mails/:id/attachment/:attachId ====================
app.get('/mails/:id/attachment/:attachId', async (c) => {
  try {
    const mailId = parseInt(c.req.param('id'), 10);
    const attachId = parseInt(c.req.param('attachId'), 10);
    if (isNaN(mailId) || isNaN(attachId)) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid mail or attachment ID',
        },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Authorization required',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const payload = await verifyJWT<AddressJWT>(token, c.env);
    if (!payload || payload.type !== 'address') {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid token',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const attachment = await queryOne<AttachmentMeta & { storage_key: string | null }>(
      c.env.DB,
      `SELECT a.id, a.mail_id, a.filename, a.storage_key, a.size, a.content_type, a.content_id, a.is_inline
       FROM attachments a
       JOIN mails m ON m.id = a.mail_id
       WHERE a.mail_id = ? AND a.id = ? AND m.address = ?`,
      [mailId, attachId, payload.address]
    );

    if (!attachment) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.NOT_FOUND,
          message: 'Attachment not found',
        },
        HTTP_STATUS.NOT_FOUND
      );
    }

    if (!attachment.storage_key || !c.env.R2) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.NOT_FOUND,
          message: 'Attachment content is unavailable',
        },
        HTTP_STATUS.NOT_FOUND
      );
    }

    const object = await c.env.R2.get(attachment.storage_key);
    if (!object) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.NOT_FOUND,
          message: 'Attachment file not found',
        },
        HTTP_STATUS.NOT_FOUND
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', attachment.content_type || 'application/octet-stream');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Pragma', 'no-cache');

    const safeFileName = (attachment.filename || `attachment-${attachment.id}`)
      .replace(/[\r\n\x00-\x1F\x7F]/g, '')
      .replace(/"/g, '')
      .slice(0, 255) || `attachment-${attachment.id}`;
    headers.set(
      'Content-Disposition',
      `attachment; filename="${safeFileName}"`
    );

    return new Response(object.body, { headers });
  } catch (error) {
    console.error('[API] attachment download error:', error);
    return c.json(
      {
        success: false,
        error: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to download attachment',
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== DELETE /api/mails/:id ====================
app.delete('/mails/:id', async (c) => {
  try {
    const mailId = parseInt(c.req.param('id'), 10);
    if (isNaN(mailId)) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid mail ID',
        },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Get JWT from Authorization header
    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Authorization required',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    // Verify JWT
    const payload = await verifyJWT<AddressJWT>(token, c.env);
    if (!payload || payload.type !== 'address') {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid token',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    // Get mail to check ownership
    const mail = await queryOne<Mail>(
      c.env.DB,
      'SELECT id, address FROM mails WHERE id = ?',
      [mailId]
    );

    if (!mail) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.MAIL_NOT_FOUND,
          message: 'Mail not found',
        },
        HTTP_STATUS.NOT_FOUND
      );
    }

    if (mail.address !== payload.address) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.FORBIDDEN,
          message: 'Access denied',
        },
        HTTP_STATUS.FORBIDDEN
      );
    }

    // Get attachments to delete from R2
    const attachments = await query<{ storage_key: string }>(
      c.env.DB,
      'SELECT storage_key FROM attachments WHERE mail_id = ?',
      [mailId]
    );

    // Delete attachments from R2
    if (c.env.R2 && attachments.length > 0) {
      for (const attachment of attachments) {
        if (attachment.storage_key) {
          try {
            await c.env.R2.delete(attachment.storage_key);
          } catch (r2Error) {
            console.error('[API] R2 delete error:', r2Error);
          }
        }
      }
    }

    // Delete mail (attachments will be deleted via CASCADE)
    const deleted = await deleteRows(
      c.env.DB,
      'mails',
      'id = ? AND address = ?',
      [mailId, payload.address]
    );

    return c.json({
      success: true,
      data: { deleted },
    });
  } catch (error) {
    console.error('[API] delete mail error:', error);
    return c.json(
      {
        success: false,
        error: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to delete mail',
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== POST /api/send_mail ====================
app.post('/send_mail', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const rateLimitResult = await checkRateLimit(c.env.KV, ip, RATE_LIMIT_PRESETS.SEND_MAIL);

    if (!rateLimitResult.allowed) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.RATE_LIMITED,
          message: 'Too many requests. Please try again later.',
          retry_after: rateLimitResult.retryAfter,
        },
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    }

    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);
    if (!token) {
      return c.json(
        { success: false, error: ERROR_CODES.UNAUTHORIZED, message: 'Authorization required' },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const payload = await verifyJWT<AddressJWT>(token, c.env);
    if (!payload || payload.type !== 'address') {
      return c.json(
        { success: false, error: ERROR_CODES.UNAUTHORIZED, message: 'Invalid token' },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const to = String(body.to || '').trim().toLowerCase();
    const subject = String(body.subject || '(No Subject)').trim();
    const messageBody = String(body.body || '').trim();

    if (!to || !messageBody) {
      return c.json(
        { success: false, error: ERROR_CODES.INVALID_REQUEST, message: 'to and body are required' },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const recipientValidation = validateAddress(to);
    if (!recipientValidation.valid) {
      return c.json(
        { success: false, error: ERROR_CODES.INVALID_REQUEST, message: recipientValidation.error || 'Invalid recipient address' },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    if (subject.length > 998 || messageBody.length > 100000) {
      return c.json(
        { success: false, error: ERROR_CODES.INVALID_REQUEST, message: 'Subject or body too long' },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    if (/[\r\n]/.test(subject)) {
      return c.json(
        { success: false, error: ERROR_CODES.INVALID_REQUEST, message: 'Invalid subject header' },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const raw = `From: ${payload.address}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${messageBody}`;
    let mode: 'mvp_store_only' | 'resend_api' = 'mvp_store_only';

    if (c.env.RESEND_API_KEY) {
      const resendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: payload.address,
          to: [to],
          subject,
          text: messageBody,
        }),
      });

      if (!resendResponse.ok) {
        const resendError = await resendResponse.text().catch(() => 'Unknown Resend error');
        console.error('[API] Resend delivery failed:', resendError);
        return c.json(
          {
            success: false,
            error: ERROR_CODES.INTERNAL_ERROR,
            message: 'Outbound delivery failed',
          },
          HTTP_STATUS.INTERNAL_ERROR
        );
      }

      mode = 'resend_api';
    }

    const sendId = await insertAndGetId(c.env.DB, 'sendbox', {
      address: payload.address,
      raw,
      subject,
      sender: payload.address,
      recipient: to,
    });

    return c.json({
      success: true,
      data: {
        id: sendId,
        accepted: [to],
        mode,
      },
    });
  } catch (error) {
    console.error('[API] send_mail error:', error);
    return c.json(
      { success: false, error: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to send mail' },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== GET /api/sendbox ====================
app.get('/sendbox', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Authorization required',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const payload = await verifyJWT<AddressJWT>(token, c.env);
    if (!payload || payload.type !== 'address') {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid token',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
    const offset = (page - 1) * limit;

    const total = await count(c.env.DB, 'sendbox', 'address = ?', [payload.address]);
    const sendbox = await query<SendboxMail>(
      c.env.DB,
      `SELECT id, address, subject, sender, recipient, created_at
       FROM sendbox
       WHERE address = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [payload.address, limit, offset]
    );

    return c.json({
      success: true,
      data: {
        sendbox,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[API] sendbox error:', error);
    return c.json(
      {
        success: false,
        error: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to fetch sendbox',
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== DELETE /api/sendbox/:id ====================
app.delete('/sendbox/:id', async (c) => {
  try {
    const sendId = parseInt(c.req.param('id'), 10);
    if (isNaN(sendId)) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid sendbox ID',
        },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Authorization required',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const payload = await verifyJWT<AddressJWT>(token, c.env);
    if (!payload || payload.type !== 'address') {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid token',
        },
        HTTP_STATUS.UNAUTHORIZED
      );
    }

    const deleted = await deleteRows(c.env.DB, 'sendbox', 'id = ? AND address = ?', [sendId, payload.address]);

    if (!deleted) {
      return c.json(
        {
          success: false,
          error: ERROR_CODES.NOT_FOUND,
          message: 'Sendbox mail not found',
        },
        HTTP_STATUS.NOT_FOUND
      );
    }

    return c.json({ success: true, data: { deleted } });
  } catch (error) {
    console.error('[API] delete sendbox error:', error);
    return c.json(
      {
        success: false,
        error: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to delete sendbox mail',
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

// ==================== GET /api/health ====================
app.get('/health', async (c) => {
  try {
    // Test database connection
    await queryOne(c.env.DB, 'SELECT 1 as test');
    
    return c.json({
      success: true,
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        data: {
          status: 'unhealthy',
          error: 'Database connection failed',
        },
      },
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
});

export default app;
