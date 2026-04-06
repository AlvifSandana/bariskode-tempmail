# TODO — Feature Backlog & Improvement Ideas

Dokumen ini berisi daftar fitur, perbaikan, dan ide yang belum diimplementasikan atau perlu di-revisit.
Format: `[ ]` = belum, `[x]` = selesai, `[-]` = skip/tidak relevan.

---

## 🔴 Critical (MVP)

- [ ] Setup Cloudflare D1, KV, R2, Email Routing
- [ ] Implement Worker router dengan Hono
- [ ] Email receiving handler (Email Routing → Worker)
- [ ] Integrate Rust WASM mail parser
- [ ] Simpan email ke D1 (mails table)
- [ ] API: create address (random & custom)
- [ ] API: list & get mails
- [ ] API: delete mail
- [ ] Frontend: create/display inbox
- [ ] Frontend: render email HTML & plain text
- [ ] JWT auth per-address
- [ ] Deploy worker & frontend

---

## 🟠 High Priority (Core Features)

### Email
- [ ] Attachment support (simpan ke D1 atau R2)
- [ ] Download attachment dari frontend
- [ ] Inline image display untuk attachment gambar
- [ ] Opsi hapus semua attachment (`REMOVE_ALL_ATTACHMENT`)
- [ ] Opsi hapus attachment melebihi ukuran tertentu (`REMOVE_EXCEED_SIZE_ATTACHMENT`)
- [ ] Email sending via SMTP
- [ ] Email sending via Resend API
- [ ] DKIM signing untuk email terkirim
- [ ] Sent box (list & delete)

### Address
- [ ] Multi-domain support (pilih domain saat create)
- [ ] Custom address name (bisa di-disable via config)
- [ ] Address password (`ENABLE_ADDRESS_PASSWORD`)
- [ ] Batas panjang & karakter address name (lowercase + angka only)
- [ ] Blacklist nama address (`address_name_blacklist`)

### Auth & User
- [ ] User registration & login (email + password)
- [ ] Bind address ke user account
- [ ] Switch antar bound addresses
- [ ] Auto-refresh JWT (< 7 hari expiry)
- [ ] OAuth2 login: GitHub
- [ ] OAuth2 login: Authentik (generic OIDC)
- [ ] Passkey / WebAuthn register & login
- [ ] URL JWT parameter untuk auto-login
- [ ] User role system (beda domain & prefix per role)
- [ ] Per-role limit binding address count

---

## 🟡 Medium Priority

### Admin Panel
- [ ] Admin auth (password via env var)
- [ ] Dashboard: address count, mail count, system status
- [ ] Address list: paginated, search, delete single/bulk
- [ ] Create address without prefix (admin privilege)
- [ ] User list: search by address/keyword, bulk operations
- [ ] Bulk delete / clear inbox / clear sent per user
- [ ] Domain & role configuration UI
- [ ] Announcement banner configuration
- [ ] Blacklist/whitelist pengirim configuration
- [ ] IP blacklist management
- [ ] Maintenance: cleanup emails > N days
- [ ] Maintenance: cleanup empty addresses
- [ ] Maintenance: cleanup unbound addresses
- [ ] Custom SQL cleanup (admin-defined, scheduled or manual)
- [ ] DB migration / upgrade button di panel
- [ ] Source IP lookup link per address (ip.im integration)

### Security
- [ ] CF Turnstile CAPTCHA integration
- [ ] Rate limiting per IP (KV counter)
- [ ] Access password (private site mode)
- [ ] XSS sanitization pada HTML email render
- [ ] Shadow DOM isolation untuk embed mode

### Spam
- [ ] Spam detection (basic: header check)
- [ ] Blacklist sender domain/address
- [ ] Whitelist sender domain/address

---

## 🟢 Low Priority / Nice-to-Have

### AI Features
- [ ] Integrate Cloudflare Workers AI
- [ ] AI extraction: verification code dari email
- [ ] AI extraction: auth link, service link, subscription link
- [ ] Priority chain: OTP > auth link > service link > other
- [ ] Admin whitelist config untuk AI extraction (support wildcard)
- [ ] UI highlight untuk AI-extracted info
- [ ] Dark mode styling untuk AI info section

### Notifications & Integrations
- [ ] Telegram Bot setup & webhook handler
- [ ] Telegram: create address command
- [ ] Telegram: read inbox command
- [ ] Telegram: push notification saat email masuk
- [ ] Telegram: language switch command (`/lang`)
- [ ] Telegram Mini App
- [ ] Webhook push ke external URL saat email masuk
- [ ] Global forward address (forward semua email ke satu alamat)

### SMTP/IMAP Proxy
- [ ] Python SMTP proxy server (Twisted)
- [ ] Python IMAP proxy server
- [ ] STARTTLS support
- [ ] IMAP SEARCH command
- [ ] LRU message cache
- [ ] Session-local FLAGS management
- [ ] Dual auth: JWT & address+password
- [ ] Stable UID dari backend mail ID
- [ ] Dockerize SMTP proxy
- [ ] Unit tests untuk proxy modules

### UI/UX
- [ ] Dark mode toggle
- [ ] Minimal mode (ringkas, satu halaman semua mail)
- [ ] All mails view (semua inbox dari semua bound addresses)
- [ ] Multi-language: English
- [ ] Multi-language: Chinese (Simplified)
- [ ] Multi-language: Indonesia
- [ ] Backend error messages i18n (en + zh)
- [ ] Auto-polling inbox (interval refresh)
- [ ] Empty state messaging (berbeda berdasarkan mail count)
- [ ] Google Ads integration (opsional)

### Subdomain
- [ ] Support random subdomain dari base domain (e.g. `random.mail.yourdomain.com`)
- [ ] Cocok untuk receive isolation scenario

### Observability
- [ ] Health check endpoint
- [ ] Scheduled cleanup task (Cloudflare Cron Triggers)
- [ ] E2E test: API health, address lifecycle, SMTP send, inbox UI

---

## 🔵 Technical Debt & Improvements

- [ ] ESLint config untuk worker (TypeScript strict mode)
- [ ] Proper error handling & typed API errors
- [ ] D1 index audit (semua kolom yang sering di-filter/join)
- [ ] Pagination konsisten di semua list endpoints
- [ ] Logging strategy (debug mode via `DEBUG_MODE` env)
- [ ] Docker Compose untuk local development
- [ ] Conventional Commits enforcement (commitlint)
- [ ] Bump Hono ke versi terbaru secara berkala
- [ ] Bump wasm-pack dan Rust edition secara berkala
- [ ] Audit attachment size limits di R2 vs D1 raw storage

---

## 💡 Future Ideas (Belum Diputuskan)

- [ ] Email alias/forwarding antar temp address
- [ ] Public API key untuk integrasi third-party
- [ ] Plugin/extension Chrome untuk auto-fill temp email
- [ ] Mobile app (PWA atau React Native)
- [ ] Rate limiting per address (bukan hanya per IP)
- [ ] Email template builder untuk sent mail
- [ ] Export/import inbox (mbox format)
- [ ] Multi-user shared inbox
- [ ] Email thread grouping
- [ ] Push notification via Web Push API
- [ ] Dashboard statistik penggunaan (admin)
