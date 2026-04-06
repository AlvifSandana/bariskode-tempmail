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

const app = new Hono<{ Bindings: AppBindings }>();

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
      'SELECT id, filename, size, content_type, content_id, is_inline FROM attachments WHERE mail_id = ?',
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
