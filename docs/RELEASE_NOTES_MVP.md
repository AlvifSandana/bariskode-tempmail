# RELEASE NOTES — MVP

## Included in MVP

- Cloudflare Worker backend for temp address creation and inbox access
- User auth: register, login, refresh
- Admin API for address/user/settings/cleanup operations
- Telegram bot webhook and inbox notifications
- Webhook notifications with HMAC signing
- AI extraction gating with whitelist support
- Frontend inbox MVP
- Worker unit/auth baseline tests
- Runtime validation tests
- Common API coverage for address auth and send_mail
- Production readiness hardening (runtime validation, CORS allowlist)
- SMTP/IMAP proxy limited foundation for private-network use
- Send-mail backend with Resend API integration fallback

## Not fully complete / planned next

- OAuth2 login
- Passkey/WebAuthn auth
- Full MIME/WASM parser integration in runtime path
- Full outbound SMTP delivery path beyond Resend/store-only mode
- Full RFC-compliant SMTP/IMAP proxy
- More route/integration/E2E coverage

## Recommended commit plan

1. `chore: initialize tempmail monorepo structure and infra configs`
2. `feat: add worker core APIs and email receiving pipeline`
3. `feat: implement user auth and admin management APIs`
4. `feat: add frontend inbox MVP and Telegram/webhook integrations`
5. `test: add worker auth and utility baseline coverage`
6. `chore: harden production runtime config and docs`
7. `feat: add limited SMTP/IMAP proxy foundation`
