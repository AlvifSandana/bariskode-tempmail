# IMPLEMENTATION CHECKLIST

Panduan step-by-step untuk membangun ulang proyek dari nol.
Ikuti urutan phase ini agar setiap layer bisa di-test secara independen.

---

## PHASE 0 — Prerequisites & Setup

### Cloudflare Account
- [ ] Daftar / login ke [Cloudflare Dashboard](https://dash.cloudflare.com)
- [ ] Add domain ke Cloudflare (NS records sudah pointing ke CF)
- [ ] Enable **Email Routing** untuk domain di Cloudflare dashboard
- [ ] Pastikan MX records sudah otomatis di-set oleh Email Routing
- [ ] Install **Wrangler CLI**: `npm install -g wrangler`
- [ ] Login Wrangler: `wrangler login`

### Local Dev Tools
- [ ] Node.js >= 18 terinstall
- [ ] pnpm terinstall: `npm install -g pnpm`
- [ ] Rust + wasm-pack (untuk build mail parser): `curl https://sh.rustup.rs -sSf | sh && cargo install wasm-pack`
- [ ] Python 3.10+ (untuk SMTP proxy, opsional)
- [ ] Git repo initialized

### Project Structure Init
- [ ] Buat folder structure: `worker/`, `frontend/`, `mail-parser-wasm/`, `smtp_proxy_server/`, `db/`, `pages/`
- [ ] Init `worker/package.json` dengan dependency: `hono`, `@cloudflare/workers-types`, `wrangler`, TypeScript
- [ ] Init `frontend/package.json` dengan dependency: `vue`, `vite`, `@vitejs/plugin-vue`, `pinia`, `vue-router`, `vue-i18n`, TypeScript
- [ ] Setup `.gitignore`

---

## PHASE 1 — Database & Infrastructure

### D1 Database
- [ ] Buat D1 database: `wrangler d1 create temp-email-db`
- [ ] Catat `database_id` dari output
- [ ] Tulis `db/schema.sql` dengan semua tabel: `address`, `mails`, `sendbox`, `users`, `user_address`, `user_roles`, `settings`, `attachments`
- [ ] Tambahkan index: `idx_mails_message_id`, `idx_mails_address`
- [ ] Jalankan migration: `wrangler d1 execute temp-email-db --file=db/schema.sql`
- [ ] Verifikasi tabel via `wrangler d1 execute temp-email-db --command="SELECT name FROM sqlite_master WHERE type='table'"`

### KV Namespace
- [ ] Buat KV namespace: `wrangler kv:namespace create KV`
- [ ] Catat `id` dari output

### R2 Bucket (opsional, untuk attachment)
- [ ] Buat R2 bucket: `wrangler r2 bucket create temp-email-attachments`

### wrangler.toml
- [ ] Tulis `worker/wrangler.toml` dengan:
  - [ ] D1 binding (`DB`)
  - [ ] KV binding (`KV`)
  - [ ] R2 binding (`R2`) — opsional
  - [ ] AI binding — opsional
  - [ ] Semua environment variables (lihat SPECS.md section 5)
- [ ] Test koneksi: `cd worker && wrangler dev`

---

## PHASE 2 — Rust WASM Mail Parser

- [ ] Init Rust project: `cd mail-parser-wasm && cargo init --lib`
- [ ] Edit `Cargo.toml`: tambahkan `mail-parser`, `wasm-bindgen`, `serde`, `serde_json` sebagai dependency
- [ ] Set `crate-type = ["cdylib"]` di `Cargo.toml`
- [ ] Tulis `src/lib.rs`:
  - [ ] Struct `ParsedMail` dengan `wasm_bindgen`
  - [ ] Struct `Attachment` dan `EmailAddress`
  - [ ] Function `parse_mail(raw: &[u8]) -> JsValue` yang return parsed mail as JSON
  - [ ] Handle multipart, plain text, HTML, attachments
- [ ] Build: `wasm-pack build --release --target bundler`
- [ ] Verifikasi output di `pkg/` folder
- [ ] Copy `pkg/` ke `worker/src/` atau set path di worker

---

## PHASE 3 — Worker Backend (Core)

### Setup
- [ ] `cd worker && pnpm install`
- [ ] Setup TypeScript config (`tsconfig.json`) untuk Cloudflare Workers
- [ ] Setup ESLint config

### Entry Point & Router
- [ ] Tulis `worker/src/worker.ts`:
  - [ ] Init Hono app
  - [ ] Setup CORS middleware
  - [ ] Setup auth middleware (JWT validation)
  - [ ] Mount route groups: `/api`, `/open_api`, `/user_api`, `/admin_api`, `/telegram_api`
  - [ ] Register email handler (`email` export untuk Email Routing)
  - [ ] Register scheduled handler (Cron Triggers)

### Models & Types
- [ ] `models/address.ts` — Address type
- [ ] `models/mail.ts` — Mail type, SendMail type
- [ ] `models/user.ts` — User type, UserRole type
- [ ] `models/settings.ts` — Settings keys & values

### Utils
- [ ] `utils/jwt.ts` — sign/verify JWT (HS256)
- [ ] `utils/db.ts` — D1 query helpers
- [ ] `utils/email.ts` — email validation, address generation
- [ ] `utils/crypto.ts` — bcrypt-like hash untuk address password
- [ ] `utils/rate_limit.ts` — KV-based rate limiter

### Email Receive Pipeline
- [ ] `email` export di `worker.ts` yang menerima `EmailMessage`
- [ ] Panggil `parse_mail(rawEmail)` dari WASM
- [ ] Extract: subject, sender, message_id, text, html, attachments
- [ ] Cek blacklist/whitelist pengirim (query settings table)
- [ ] Cek spam
- [ ] Simpan ke `mails` table
- [ ] Jika attachment → upload ke R2, simpan metadata ke `attachments` table
- [ ] Trigger: Telegram notification (jika dikonfigurasi)
- [ ] Trigger: Webhook push (jika dikonfigurasi)
- [ ] Trigger: Forward ke global forward address (jika dikonfigurasi)
- [ ] Trigger: AI extraction (jika dikonfigurasi & address di whitelist)

### Common API (`common_api/`)
- [ ] `GET /api/settings` — return domains, announcement, feature flags
- [ ] `POST /api/new_address` — create address (random atau custom)
  - [ ] Validasi nama: lowercase + angka only
  - [ ] Cek blacklist nama
  - [ ] Cek CAPTCHA (jika Turnstile dikonfigurasi)
  - [ ] Cek rate limit per IP
  - [ ] Insert ke `address` table
  - [ ] Return JWT
- [ ] `GET /api/mails` — list mails (auth: address JWT), paginated
- [ ] `GET /api/mails/:id` — get mail detail
- [ ] `DELETE /api/mails/:id` — delete mail
- [ ] `GET /api/mails/:id/attachment/:attachId` — download attachment dari R2/S3
- [ ] `GET /api/sendbox` — list sent mails
- [ ] `DELETE /api/sendbox/:id` — delete sent mail
- [ ] `GET /api/health` — health check

### Mail Sending
- [ ] `POST /api/send_mail`:
  - [ ] Validasi auth (address JWT)
  - [ ] Build email (from, to, subject, body)
  - [ ] DKIM signing
  - [ ] Send via SMTP atau Resend API (berdasarkan config)
  - [ ] Simpan ke `sendbox` table

---

## PHASE 4 — Worker Backend (Auth & User)

### Auth Routes (`auth/`)
- [ ] `POST /auth/register` — hash password, insert ke `users`, return JWT
- [ ] `POST /auth/login` — verify password, return JWT user
- [ ] `POST /auth/refresh` — refresh JWT jika valid & < 7 hari
- [ ] `POST /auth/oauth2/github` — exchange code → get user info → upsert user → JWT
- [ ] `POST /auth/oauth2/:provider` — generic OIDC/OAuth2 flow
- [ ] `POST /auth/passkey/register/begin` — generate WebAuthn challenge
- [ ] `POST /auth/passkey/register/complete` — verify & store credential
- [ ] `POST /auth/passkey/login/begin` — generate assertion challenge
- [ ] `POST /auth/passkey/login/complete` — verify assertion → JWT

### User API (`user_api/`)
- [ ] `GET /user_api/profile` — return user info + roles
- [ ] `GET /user_api/addresses` — list bound addresses
- [ ] `POST /user_api/bind_address` — bind address ke user (cek limit per role)
- [ ] `DELETE /user_api/unbind_address` — unbind address
- [ ] `GET /user_api/mails` — list semua mail dari bound addresses (filter by address & keyword)

### Address Password
- [ ] Jika `ENABLE_ADDRESS_PASSWORD=true`: expose endpoint untuk set/verify password
- [ ] IMAP/SMTP proxy bisa login dengan `address:password` sebagai alternatif JWT

---

## PHASE 5 — Worker Backend (Admin)

### Admin API (`admin_api/`)
- [ ] Middleware: verify admin password dari `Authorization` header
- [ ] `GET /admin_api/address` — list addresses (paginated, search)
- [ ] `POST /admin_api/new_address` — create address tanpa prefix restriction
- [ ] `DELETE /admin_api/address/:id` — delete address + mails
- [ ] `POST /admin_api/address/bulk_delete` — bulk delete
- [ ] `GET /admin_api/users` — list users
- [ ] `DELETE /admin_api/users/:id` — delete user
- [ ] `POST /admin_api/users/bulk` — bulk operations
- [ ] `GET /admin_api/settings` — get all settings
- [ ] `POST /admin_api/settings` — update settings (announcement, blacklist, whitelist, roles, domains, etc.)
- [ ] `POST /admin_api/ip_blacklist` — update IP blacklist
- [ ] `POST /admin_api/cleanup` — trigger cleanup (by age, empty, unbound, custom SQL)
- [ ] `POST /admin_api/db_init` — run pending DB migrations
- [ ] `GET /admin_api/stats` — basic stats (address count, mail count)

### Scheduled Tasks (Cron Triggers)
- [ ] Tambahkan `[triggers] crons = ["0 0 * * *"]` di wrangler.toml
- [ ] Implement `scheduled` handler:
  - [ ] Cleanup emails lebih dari N hari
  - [ ] Cleanup empty addresses
  - [ ] Run custom SQL cleanup statements dari settings

---

## PHASE 6 — Frontend

### Base Setup
- [ ] `cd frontend && pnpm install`
- [ ] Setup Vite config (`vite.config.ts`) dengan proxy ke worker dev server
- [ ] Setup Vue Router (routes: `/`, `/admin`, `/user`, `/login`)
- [ ] Setup Pinia stores
- [ ] Setup vue-i18n dengan locale files (en, id)
- [ ] Setup dark mode (CSS variables atau Naive UI theming)

### API Client Layer
- [ ] `api/common.ts` — fetch wrapper dengan auto-attach JWT header
- [ ] `api/mail.ts` — createAddress, getMails, getMail, deleteMail, sendMail
- [ ] `api/auth.ts` — register, login, refresh, oauth2, passkey
- [ ] `api/user.ts` — profile, addresses, bindAddress, allMails
- [ ] `api/admin.ts` — admin CRUD operations

### Main Inbox (`/`)
- [ ] `IndexView.vue`:
  - [ ] Form create address (random / custom)
  - [ ] Display current address + credential
  - [ ] Inbox list (sender, subject, date, preview)
  - [ ] Auto-polling setiap 15 detik
  - [ ] Empty state messaging
- [ ] `MailDetail.vue`:
  - [ ] Render HTML email (sandboxed iframe / shadow DOM)
  - [ ] Render plain text fallback
  - [ ] Attachment list + download
  - [ ] Inline image display
  - [ ] AI extraction highlight (OTP, auth link, dll.)
  - [ ] Mark as read
  - [ ] Delete button
- [ ] `SendMailForm.vue`:
  - [ ] Form: to, subject, body
  - [ ] Submit via `/api/send_mail`

### User Panel (`/user`)
- [ ] Login / Register form
- [ ] OAuth2 login buttons (GitHub, dll.)
- [ ] Passkey login button
- [ ] Profile display
- [ ] Bound addresses list
- [ ] Bind / unbind address
- [ ] Switch active address (fetch JWT per address)
- [ ] All mails view (across all bound addresses)

### Admin Panel (`/admin`)
- [ ] Admin login form
- [ ] Dashboard: stats cards
- [ ] Address management table (search, delete, bulk ops, create)
- [ ] User management table (search, delete, bulk ops)
- [ ] Settings form:
  - [ ] Announcement
  - [ ] Blacklist / whitelist
  - [ ] Domain & role config
  - [ ] AI extraction whitelist
  - [ ] IP blacklist
- [ ] Maintenance panel:
  - [ ] Cleanup buttons (email age, empty, unbound)
  - [ ] Custom SQL cleanup input
  - [ ] DB upgrade button

### UI Polish
- [ ] Responsive layout (mobile-friendly)
- [ ] Dark mode toggle
- [ ] Minimal mode toggle
- [ ] Language switcher
- [ ] Toast notifications (success/error)
- [ ] Loading states & skeletons
- [ ] XSS sanitization (DOMPurify) sebelum render HTML email
- [ ] Announcement banner (dari settings)

---

## PHASE 7 — Integrations (Optional)

### Telegram Bot
- [ ] Buat bot via @BotFather, dapatkan `TELEGRAM_BOT_TOKEN`
- [ ] Set webhook: `POST https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://your-worker.dev/telegram_api/bot`
- [ ] Implement command handlers di `telegram_api/`:
  - [ ] `/start` — intro & help
  - [ ] `/new` — create new address
  - [ ] `/list` — list addresses
  - [ ] `/inbox` — list mails for current address
  - [ ] `/read <id>` — read mail
  - [ ] `/lang` — switch language (en/zh)
- [ ] Push notification: saat email masuk, kirim ke Telegram chat terkait
- [ ] Telegram Mini App (web app inside Telegram)

### Webhook
- [ ] Saat email masuk, POST ke `WEBHOOK_URL` dengan payload: `{ address, from, subject, text, html }`

### AI Extraction
- [ ] Set `AI` binding di wrangler.toml
- [ ] Implement extraction pipeline:
  - [ ] Input: email text/html
  - [ ] Prompt Workers AI untuk extract OTP, auth link, dll.
  - [ ] Store hasil di `metadata` field di `mails` table
  - [ ] Expose via API dan tampilkan di frontend

### S3 Attachment Storage
- [ ] Tambahkan S3 credentials ke env vars
- [ ] Implement S3 upload di attachment handler (alternatif R2)
- [ ] Implement S3 delete saat mail dihapus

---

## PHASE 8 — SMTP/IMAP Proxy (Optional)

- [ ] `smtp_proxy_server/requirements.txt`: twisted, pyopenssl, requests/httpx
- [ ] Implement `http_client.py`: wrapper untuk call worker API (get mails, send mail)
- [ ] Implement `mailbox.py`: IMAP mailbox abstraction (INBOX, SENT)
- [ ] Implement `message.py`: message fetching & caching (LRU cache)
- [ ] Implement SMTP server (`twisted.mail.smtp`):
  - [ ] Auth: JWT credential atau address:password
  - [ ] OnMessageDelivered: call worker `/api/send_mail`
- [ ] Implement IMAP server:
  - [ ] Auth: dual method
  - [ ] SELECT, FETCH, SEARCH, STORE, EXPUNGE
  - [ ] STARTTLS support
  - [ ] Stable UID = backend mail ID
  - [ ] Session-local FLAGS
- [ ] Tulis `Dockerfile` untuk SMTP proxy
- [ ] Test dengan Thunderbird / email client lain
- [ ] Unit tests untuk semua modul proxy

---

## PHASE 9 — Testing & QA

### Manual Testing
- [ ] Create address → receive test email → baca di UI
- [ ] Send email dari UI → cek di recipient inbox
- [ ] Attachment upload → download
- [ ] Login/register → bind address → switch address
- [ ] OAuth2 login flow
- [ ] Passkey register & login
- [ ] Admin panel: create/delete address, manage users
- [ ] Telegram bot: create address, read mail
- [ ] IMAP/SMTP via Thunderbird

### E2E Tests
- [ ] API health check
- [ ] Address lifecycle (create → receive → delete)
- [ ] SMTP send test
- [ ] Inbox UI test
- [ ] HTML reply & XSS sanitization test

### Security Checks
- [ ] Pastikan admin endpoint tidak bisa diakses tanpa password
- [ ] Pastikan address JWT tidak bisa akses address lain
- [ ] XSS test: kirim email dengan `<script>` tag
- [ ] Rate limit test: hit endpoint berulang kali cepat
- [ ] CAPTCHA validation test (jika Turnstile dikonfigurasi)

---

## PHASE 10 — Production Readiness

- [ ] Setup GitHub Actions untuk auto-deploy worker
- [ ] Setup GitHub Actions untuk auto-deploy frontend
- [ ] Semua secrets tersimpan di GitHub Secrets / Cloudflare Secrets
- [ ] Custom domain untuk Pages (`mail.yourdomain.com`)
- [ ] Custom domain untuk Worker API (`api.yourdomain.com` opsional)
- [ ] Cloudflare Email Routing catch-all rule aktif
- [ ] DKIM DNS TXT record ditambahkan
- [ ] Test end-to-end di production environment
- [ ] Set `DEBUG_MODE=false` di production
- [ ] Review dan set rate limit yang sesuai
- [ ] Tulis dokumentasi deployment di README
