# PROJECT STATUS

Status implementasi terkini untuk Temp Email Service.

---

## Completed Phases

- Phase 0 — Project setup
- Phase 1 — Database & infrastructure
- Phase 2 — Rust WASM parser foundation
- Phase 3 — Worker backend core
- Phase 4 — Auth & user backend
- Phase 5 — Admin backend
- Phase 6 — Frontend MVP
- Phase 7 — Telegram / Webhook / AI integrations
- Phase 9 — Testing & QA baseline
- Phase 10 — Production readiness hardening

## Completed Components

### Backend (Worker)
- Public API: settings, address creation, address password auth, inbox listing/detail/delete, health, send-mail
- Auth API: register, login, refresh
- User API: profile, bound addresses, bind/unbind, cross-address mail listing
- Admin API: stats, address/user management, settings, cleanup, IP blacklist
- Telegram webhook API
- Email receive pipeline with notification fanout
- Scheduled cleanup handler

### Frontend
- Main inbox view
- Admin panel with stats/address/user/settings/maintenance tabs
- User panel with login/register, OAuth2 callback handling, passkey register/login, bind/unbind and cross-address mailbox
- API/store foundation

### Security/Operations
- Runtime env validation
- JWT + password hashing
- KV-based rate limiting
- CORS allowlist via `APP_ORIGINS`
- HMAC-signed outbound webhook delivery
- User browser session via secure HttpOnly cookie `tm_user_session`
- User auth middleware supports cookie session and `Authorization: Bearer` fallback
- OAuth callback hardening: PKCE S256 + state + nonce binding (KV + cookie validation)
- WebAuthn policy enforces UV (user verification) for registration and login assertion
- Multiple `Set-Cookie` handling fixed with append behavior on auth flows
- Production readiness documentation

### Testing
- Worker Vitest config
- Utility tests for email/jwt/crypto
- Auth route and user-auth middleware baseline tests
- Runtime hardening tests
- Common API tests for address auth and send_mail

### Recent Operational Fixes
- `open_api` path alias now mounted and consistent with `/api`
- `/admin_api/db_init` clarified as status-only with required/missing table output
- `wrangler.toml` compatibility conflict resolved by keeping only `compatibility_flags = ["nodejs_compat"]`
- Attachment flow now stores metadata + optional R2 object and applies size guard controls

---

## Remaining / Partial Areas

### Phase 8 — SMTP/IMAP Proxy
- MVP proxy foundation available
- Core login/read/send foundation tersedia untuk private-network use
- Not equivalent to a full RFC-complete mail server
- Depends on backend address JWT/password auth and limited send-mail capability

### Frontend Completeness
- Admin panel now includes stats, address/user management, settings, and maintenance workflows
- User panel now includes login/register, OAuth callback handling, passkey workflows, bind/unbind, and cross-address mail listing

### Advanced Auth
- OAuth2 (Google) backend endpoints implemented with PKCE/state/nonce validation
- Passkey backend endpoints implemented (user-account flow, UV required)

### Frontend Auth Session
- Auth/user requests use `credentials: 'include'`
- User JWT no longer persisted in localStorage (email metadata optional only)
- Session restore on page load via `/auth/refresh` probe
- API/Auth base URL configurable via `VITE_API_BASE` and `VITE_AUTH_BASE`
- `bind_address` now derives `address_id` from verified `address_token` (client no longer needs to send `address_id`)

### Security Follow-up (Remaining)
- CSRF defense-in-depth telah diterapkan untuk cookie-based auth (origin/referer allowlist + double-submit token)
- Auth responses user tidak lagi mengembalikan `token` di JSON; browser flow mengandalkan HttpOnly cookie session
- Dependency security audit cadence and remediation tracking still pending

---

## Important Key Files

### Core Worker
- `worker/src/worker.ts`
- `worker/src/common_api/index.ts`
- `worker/src/auth/index.ts`
- `worker/src/user_api/index.ts`
- `worker/src/admin_api/index.ts`
- `worker/src/telegram_api/index.ts`
- `worker/src/email_handler.ts`
- `worker/src/scheduled_handler.ts`

### Shared Utilities
- `worker/src/utils/db.ts`
- `worker/src/utils/jwt.ts`
- `worker/src/utils/crypto.ts`
- `worker/src/utils/email.ts`
- `worker/src/utils/rate_limit.ts`
- `worker/src/utils/runtime.ts`
- `worker/src/utils/telegram.ts`

### Data / Config
- `db/schema.sql`
- `worker/wrangler.toml`

### Frontend
- `frontend/src/views/IndexView.vue`
- `frontend/src/api/index.ts`
- `frontend/src/store/mail.ts`
- `frontend/src/store/settings.ts`

### Docs
- `docs/README.md`
- `docs/PRODUCTION_READINESS.md`
- `docs/IMPLEMENTATION_CHECKLIST.md`
- `docs/PROJECT_STATUS.md`
- `docs/GO_LIVE_CHECKLIST.md`
- `docs/RELEASE_NOTES_MVP.md`

### SMTP/IMAP Proxy
- `smtp_proxy_server/main.py`
- `smtp_proxy_server/http_client.py`
- `smtp_proxy_server/mailbox.py`
- `smtp_proxy_server/message.py`
- `smtp_proxy_server/requirements.txt`
- `smtp_proxy_server/Dockerfile`
