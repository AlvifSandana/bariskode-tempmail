import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import commonApi from './common_api';
import authApi from './auth';
import userApi from './user_api';
import adminApi from './admin_api';
import telegramApi from './telegram_api';
import type { AppBindings } from './types/env';
import { parseAllowedOrigins, validateRuntimeConfig } from './utils/runtime';

// Create main Hono app
const app = new Hono<{ Bindings: AppBindings }>();

function getCorsOrigin(origin: string | undefined, env: AppBindings): string | null {
  const allowedOrigins = parseAllowedOrigins(env.APP_ORIGINS);
  if (!origin || allowedOrigins.length === 0) return null;
  return allowedOrigins.includes(origin) ? origin : null;
}

// Global middleware
app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', async (c, next) => {
  const result = validateRuntimeConfig(c.env);

  if (!result.valid) {
    return c.json(
      {
        success: false,
        error: 'MISCONFIGURED_ENV',
        message: 'Runtime configuration is invalid',
        details: c.env.DEBUG_MODE === 'true' ? result.errors : undefined,
      },
      500
    );
  }

  const origin = c.req.header('Origin');
  const allowedOrigin = getCorsOrigin(origin, c.env);

  return cors({
    origin: allowedOrigin ?? undefined,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })(c, next);
});

// Mount API routes
app.route('/api', commonApi);
app.route('/auth', authApi);
app.route('/user_api', userApi);
app.route('/admin_api', adminApi);
app.route('/telegram_api', telegramApi);

// Root endpoint
app.get('/', (c) => {
  const runtime = validateRuntimeConfig(c.env);
  return c.json({
    name: 'Temp Email API',
    version: '1.0.0',
    description: 'Self-hosted temporary email service on Cloudflare',
    runtime: {
      valid: runtime.valid,
      warnings: runtime.warnings,
    },
    endpoints: {
      api: '/api',
      health: '/api/health',
      settings: '/api/settings',
      new_address: 'POST /api/new_address',
      mails: 'GET /api/mails (requires Authorization: Bearer <token>)',
      auth_register: 'POST /auth/register',
      auth_login: 'POST /auth/login',
      auth_refresh: 'POST /auth/refresh',
      user_profile: 'GET /user_api/profile',
      admin_stats: 'GET /admin_api/stats',
      telegram_bot: 'POST /telegram_api/bot',
    },
  });
});

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: 'NOT_FOUND',
      message: 'Endpoint not found',
    },
    404
  );
});

// Error handler
app.onError((err, c) => {
  console.error('Server error:', err);
  
  return c.json(
    {
      success: false,
      error: 'INTERNAL_ERROR',
      message: c.env.DEBUG_MODE === 'true' ? err.message : 'Internal server error',
    },
    500
  );
});

// Export for Cloudflare Workers
export default {
  // HTTP handler
  fetch: app.fetch,

  // Email handler (for Cloudflare Email Routing)
  async email(message: ForwardableEmailMessage, env: AppBindings, ctx: ExecutionContext) {
    try {
      console.log(`[Email] Received email for: ${message.to}`);
      const runtime = validateRuntimeConfig(env);
      if (!runtime.valid) {
        console.error('[Email] Invalid runtime config:', runtime.errors);
        message.setReject('Runtime configuration invalid');
        return;
      }
      
      // Import email handler dynamically to avoid circular dependencies
      const { handleEmail } = await import('./email_handler');
      await handleEmail(message, env, ctx);
    } catch (error) {
      console.error('[Email] Handler error:', error);
      // Reject the email if processing fails
      message.setReject('Internal error processing email');
    }
  },

  // Scheduled handler (for Cloudflare Cron Triggers)
  async scheduled(event: ScheduledEvent, env: AppBindings, ctx: ExecutionContext) {
    console.log('[Scheduled] Running scheduled task...');
    
    try {
      const runtime = validateRuntimeConfig(env);
      if (!runtime.valid) {
        console.error('[Scheduled] Invalid runtime config:', runtime.errors);
        return;
      }
      // Import scheduled handler dynamically
      const { handleScheduled } = await import('./scheduled_handler');
      await handleScheduled(event, env, ctx);
    } catch (error) {
      console.error('[Scheduled] Handler error:', error);
    }
  },
};
