# 📧 Temp Email — Self-Hosted Temporary Email Service

Layanan temporary email gratis yang bisa kamu host sendiri di atas Cloudflare. Tidak butuh server, tidak ada biaya infrastruktur — semua berjalan di atas Cloudflare free tier.

---

## ✨ Fitur

### 📨 Email
- Terima email di alamat sementara di domain kamu sendiri
- Parsing email saat ini masih MVP/heuristik; fondasi Rust WASM sudah disiapkan
- Kirim email saat ini mendukung mode store-only dan Resend API (jika dikonfigurasi)
- Attachment/inline image masih parsial di MVP
- Sent box untuk riwayat email terkirim

### 👤 User & Auth
- Buat inbox tanpa login (anonymous + JWT credential)
- Registrasi akun penuh, bind multiple alamat ke satu akun
- OAuth2 masih planned
- Passkey/WebAuthn masih planned
- Role-based access: tiap role punya domain & prefix berbeda

### 🤖 AI Extraction
- Ekstrak otomatis OTP, auth link, dan service link dari email
- Didukung Cloudflare Workers AI
- Tampil highlight di inbox

### 🛡️ Keamanan & Anti-Spam
- Address password per-inbox
- CF Turnstile CAPTCHA
- Rate limiting & IP blacklist
- Spam detection & blacklist/whitelist pengirim
- XSS sanitization untuk HTML email
- Access password (private site mode)

### ⚙️ Admin Panel
- Kelola address, user, domain, dan role
- Maintenance: cleanup otomatis (custom SQL dinonaktifkan demi keamanan MVP)
- IP blacklist, announcement, konfigurasi AI

### 🔗 Integrasi
- Telegram Bot (baca inbox, notifikasi real-time)
- Webhook push ke URL eksternal
- Global forward address
- SMTP/IMAP Proxy foundation (private-network / TLS-terminated only)

---

## 🏗️ Tech Stack

| Layer | Teknologi |
|---|---|
| Backend | TypeScript + Hono + Cloudflare Workers |
| Frontend | Vue 3 + Vite + TypeScript + Cloudflare Pages |
| Database | Cloudflare D1 (SQLite) |
| KV Storage | Cloudflare KV |
| Attachment Storage | Cloudflare R2 / S3 (opsional) |
| Mail Parser | Rust + WebAssembly (`wasm-pack`) |
| Email Receive | Cloudflare Email Routing |
| AI | Cloudflare Workers AI (opsional) |
| SMTP/IMAP Proxy | Python + Twisted (opsional) |

---

## 🚀 Quick Start

### Prerequisites
- Cloudflare account dengan domain yang sudah aktif
- Cloudflare Email Routing aktif untuk domain kamu
- Node.js >= 18, pnpm, Wrangler CLI

```bash
npm install -g wrangler pnpm
wrangler login
```

### 1. Clone & Install

```bash
git clone https://github.com/yourusername/temp-email.git
cd temp-email
```

### 2. Buat Cloudflare Resources

```bash
# D1 Database
wrangler d1 create temp-email-db

# KV Namespace
wrangler kv:namespace create KV

# R2 Bucket (opsional, untuk attachment)
wrangler r2 bucket create temp-email-attachments
```

Catat ID dari masing-masing output, masukkan ke `worker/wrangler.toml`.

### 3. Konfigurasi

Edit `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "temp-email-db"
database_id = "YOUR_D1_ID"

[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_ID"

[vars]
DOMAINS = "mail.yourdomain.com"
PREFIX = "tmp"
ADMIN_PASSWORDS = "your-secure-admin-password"
JWT_SECRET = "random-long-secret-string"
```

### 4. Database Migration

```bash
wrangler d1 execute temp-email-db --file=db/schema.sql
```

### 5. Build Mail Parser (Rust WASM)

```bash
cd mail-parser-wasm
wasm-pack build --release --target bundler
cd ..
```

### 6. Deploy Worker

```bash
cd worker
pnpm install
pnpm build
wrangler deploy
```

### 7. Deploy Frontend

```bash
cd frontend
pnpm install
pnpm build
wrangler pages deploy dist
```

### 8. Setup Email Routing

Di Cloudflare Dashboard → Email → Email Routing → Routing Rules:

- Buat **Catch-all** rule: `*@yourdomain.com` → **Send to Worker** → pilih worker kamu

---

## 📁 Project Structure

```
├── worker/              # Backend — Cloudflare Workers (TypeScript + Hono)
│   ├── src/
│   │   ├── worker.ts        # Entry point
│   │   ├── common_api/      # Public endpoints
│   │   ├── user_api/        # Authenticated user endpoints
│   │   ├── admin_api/       # Admin endpoints
│   │   ├── telegram_api/    # Telegram Bot handler
│   │   ├── models/          # TypeScript types
│   │   └── utils/           # Helpers
│   └── wrangler.toml
│
├── frontend/            # Frontend — Vue 3 SPA
│   ├── src/
│   │   ├── views/           # Pages
│   │   ├── components/      # Components
│   │   ├── store/           # Pinia stores
│   │   ├── api/             # API client
│   │   └── i18n/            # Locale files
│   └── vite.config.ts
│
├── mail-parser-wasm/    # Rust WASM mail parser
├── smtp_proxy_server/   # Python SMTP/IMAP proxy (opsional)
├── db/                  # Database schema & migrations
├── pages/               # Cloudflare Pages Functions
└── vitepress-docs/      # Dokumentasi
```

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DOMAINS` | ✅ | Comma-separated list domain email |
| `PREFIX` | ✅ | Prefix untuk random address |
| `ADMIN_PASSWORDS` | ✅ | Comma-separated admin passwords |
| `JWT_SECRET` | ✅ | Secret untuk signing JWT |
| `ENABLE_ADDRESS_PASSWORD` | ❌ | Enable password per inbox (`true`/`false`) |
| `DISABLE_CUSTOM_ADDRESS_NAME` | ❌ | Disable custom address name |
| `ANNOUNCEMENT` | ❌ | Teks pengumuman di header |
| `TURNSTILE_SECRET` | ❌ | Cloudflare Turnstile secret key |
| `DKIM_PRIVATE_KEY` | ❌ | DKIM private key untuk signing |
| `RESEND_API_KEY` | ❌ | Resend API key untuk sending email |
| `SMTP_HOST` | ❌ | SMTP server host |
| `SMTP_PORT` | ❌ | SMTP server port (default: 587) |
| `SMTP_USERNAME` | ❌ | SMTP username |
| `SMTP_PASSWORD` | ❌ | SMTP password |
| `TELEGRAM_BOT_TOKEN` | ❌ | Telegram Bot token |
| `WEBHOOK_URL` | ❌ | Webhook URL untuk notifikasi |
| `FORWARD_ADDRESS_LIST` | ❌ | Comma-separated forward addresses |
| `S3_ENDPOINT` | ❌ | S3-compatible endpoint (jika tidak pakai R2) |
| `S3_ACCESS_KEY_ID` | ❌ | S3 access key |
| `S3_SECRET_ACCESS_KEY` | ❌ | S3 secret key |
| `DEBUG_MODE` | ❌ | Enable verbose logging (`true`/`false`) |

---

## 🤖 Telegram Bot Setup

1. Buat bot baru via [@BotFather](https://t.me/BotFather), dapatkan token
2. Tambahkan `TELEGRAM_BOT_TOKEN` ke env vars
3. Set webhook secret di `worker/wrangler.toml`:

```toml
TELEGRAM_BOT_WEBHOOK_SECRET = "your-telegram-webhook-secret"
```

4. Set webhook:

```bash
curl "https://api.telegram.org/bot{YOUR_TOKEN}/setWebhook?url=https://your-worker.workers.dev/telegram_api/bot&secret_token=your-telegram-webhook-secret"
```

Commands yang tersedia: `/start`, `/new`, `/list`, `/inbox`, `/read <id>`, `/lang`

---

## 🚀 Production Readiness

Lihat panduan operasional dan hardening di:

- `docs/PRODUCTION_READINESS.md`

---

## 📬 SMTP/IMAP Proxy (Opsional)

Fondasi akses inbox via email client standar untuk environment private-network / TLS-terminated.

```bash
cd smtp_proxy_server
pip install -r requirements.txt

# Konfigurasi
export BACKEND_URL="https://your-worker.workers.dev"
export SMTP_PORT=1587
export IMAP_PORT=1143

python main.py
```

Atau gunakan Docker:

```bash
docker build -t temp-email-proxy .
docker run -p 1587:1587 -p 1143:1143 \
  -e BACKEND_URL=https://your-worker.workers.dev \
  temp-email-proxy
```

**Login di email client:** gunakan alamat email sebagai username dan JWT credential atau address password sebagai password.

**Catatan:** proxy ini belum RFC-complete dan belum cocok untuk internet-public exposure langsung.

---

## 🔄 GitHub Actions CI/CD

Tambahkan secrets berikut di GitHub repository settings:

- `CF_API_TOKEN` — Cloudflare API token
- `CF_ACCOUNT_ID` — Cloudflare account ID
- `JWT_SECRET`, `ADMIN_PASSWORDS`, dan semua env vars lainnya

Push ke branch `main` akan otomatis trigger deploy.

---

## 🗄️ Database Migrations

Semua SQL migration files ada di folder `db/`. Untuk apply migration baru:

```bash
wrangler d1 execute temp-email-db --file=db/YYYY-MM-DD-description.sql
```

Atau gunakan tombol **"DB Upgrade"** di Admin Panel → Maintenance.

---

## 📚 Dokumentasi Tambahan

- `PRD.md` — Product Requirements Document
- `SPECS.md` — Technical Specifications
- `TODO.md` — Feature backlog
- `IMPLEMENTATION_CHECKLIST.md` — Step-by-step build guide

---

## 📄 Lisensi

MIT License — bebas digunakan, dimodifikasi, dan didistribusikan untuk keperluan personal maupun komersial.

---

## ⚠️ Disclaimer

Proyek ini dibuat untuk keperluan belajar dan penggunaan pribadi. Pastikan penggunaan sesuai dengan hukum yang berlaku dan Terms of Service dari provider yang digunakan (Cloudflare, Resend, dll.). Pengguna bertanggung jawab penuh atas penggunaan layanan ini.
