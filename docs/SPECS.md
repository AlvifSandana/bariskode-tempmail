# SPECS — Technical Specifications

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                         │
│  Browser (Vue 3 SPA)  │  Email Client  │  Telegram Bot App  │
└────────────┬──────────┴───────┬────────┴────────────────────┘
             │                  │
             ▼                  ▼
┌─────────────────────┐  ┌──────────────────────────────────┐
│  Cloudflare Pages   │  │  SMTP/IMAP Proxy (Python/Docker) │
│  (Frontend Hosting) │  │  port 25/587 (SMTP), 143 (IMAP)  │
└────────────┬────────┘  └────────────────┬─────────────────┘
             │                            │
             ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cloudflare Workers (Backend)               │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────────────┐│
│  │  /api/*      │  │ /user_api/*│  │ /admin_api/*         ││
│  │  /auth/*     │  │ /health    │  │ /telegram_api/*      ││
│  └──────────────┘  └────────────┘  └──────────────────────┘│
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Email Handler (Email Routing → Worker)              │   │
│  │  Rust WASM Mail Parser                               │   │
│  │  Workers AI (AI Extraction)                          │   │
│  └──────────────────────────────────────────────────────┘   │
└───────┬──────────────┬──────────────┬──────────────┬────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
   ┌─────────┐   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  D1 DB  │   │    KV    │  │    R2    │  │  Resend  │
   │(SQLite) │   │(Sessions)│  │(Attach.) │  │  / SMTP  │
   └─────────┘   └──────────┘  └──────────┘  └──────────┘
```

---

## 2. Directory Structure

```
project-root/
├── worker/                    # Backend — Cloudflare Workers
│   ├── src/
│   │   ├── worker.ts          # Entry point, router setup (Hono)
│   │   ├── common_api/        # Public unauthenticated endpoints
│   │   ├── /open_api alias -> common_api (implemented)
│   │   ├── user_api/          # Authenticated user endpoints
│   │   ├── admin_api/         # Admin-only endpoints
│   │   ├── telegram_api/      # Telegram Bot webhook handler
│   │   ├── models/            # TypeScript type definitions
│   │   ├── utils/             # Shared utilities
│   │   └── constants.ts       # App-wide constants
│   ├── wrangler.toml          # Cloudflare Worker config
│   └── package.json
│
├── frontend/                  # Frontend — Vue 3 SPA
│   ├── src/
│   │   ├── main.ts
│   │   ├── App.vue
│   │   ├── router/            # Vue Router config
│   │   ├── views/             # Page-level components
│   │   │   ├── IndexView.vue
│   │   │   ├── AdminView.vue
│   │   │   └── UserView.vue
│   │   ├── components/        # Reusable components
│   │   ├── store/             # Pinia state management
│   │   ├── api/               # API client modules
│   │   ├── i18n/              # Locale files (en, zh, id, ...)
│   │   └── utils/
│   ├── vite.config.ts
│   └── package.json
│
├── pages/                     # Cloudflare Pages Functions (middleware)
│   └── functions/
│       └── [[path]].ts        # Proxy/middleware layer
│
├── mail-parser-wasm/          # Rust WASM mail parser
│   ├── src/
│   │   └── lib.rs
│   ├── Cargo.toml
│   └── pkg/                   # Built output (wasm-pack)
│
├── smtp_proxy_server/         # Python SMTP/IMAP Proxy
│   ├── main.py
│   ├── http_client.py         # Backend API client
│   ├── mailbox.py             # IMAP mailbox handler
│   ├── message.py             # Message handling
│   ├── requirements.txt
│   └── Dockerfile
│
├── db/                        # Database migrations (SQL)
│   ├── schema.sql             # Initial schema
│   ├── 2024-*.sql             # Incremental migrations
│   └── 2025-*.sql
│
├── e2e/                       # End-to-end tests
│
├── vitepress-docs/            # Documentation site (VitePress)
│
└── scripts/                   # Helper scripts
```

---

## 3. Database Schema (Cloudflare D1 / SQLite)

### 3.1 Core Tables

```sql
-- Email addresses
CREATE TABLE address (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,           -- full email address
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    password    TEXT,                           -- optional address password
    source_ip   TEXT,
    balance     INTEGER DEFAULT 0
);

-- Incoming mails
CREATE TABLE mails (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT,
    address     TEXT NOT NULL,
    raw         TEXT,                           -- raw email (may be null if stripped)
    subject     TEXT,
    sender      TEXT,
    message_id  TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_read     INTEGER DEFAULT 0,
    metadata    TEXT                            -- JSON: AI extraction, attachment refs
);
CREATE INDEX idx_mails_message_id ON mails(message_id);
CREATE INDEX idx_mails_address ON mails(address);

-- Sent mails
CREATE TABLE sendbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    address     TEXT NOT NULL,
    raw         TEXT,
    subject     TEXT,
    sender      TEXT,
    recipient   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User accounts
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email  TEXT UNIQUE,
    password    TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User <-> Address binding
CREATE TABLE user_address (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    address_id  INTEGER NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (address_id) REFERENCES address(id)
);

-- User roles
CREATE TABLE user_roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    role_text   TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Settings (key-value)
CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT
);
-- Keys: announcement, spam_list, blacklist, whitelist,
--       default_domains, user_roles_config, ai_extract_settings,
--       address_name_blacklist, ip_blacklist, cleanup_rules, custom_sql_cleanup

-- Attachments metadata
CREATE TABLE attachments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mail_id         INTEGER NOT NULL,
    address         TEXT NOT NULL,
    filename        TEXT,
    storage_key     TEXT,                       -- R2/S3 key
    size            INTEGER,
    content_type    TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (mail_id) REFERENCES mails(id)
);
```

### 3.2 KV Namespaces

| Namespace | Purpose |
|---|---|
| `KV` | General key-value (sessions, JWT cache, rate limit counters) |

---

## 4. Worker API Endpoints

### 4.1 Common API (`/api`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get public settings (domains, announcements) |
| POST | `/api/new_address` | Create address (random/custom) |
| POST | `/api/address_auth` | Authenticate address + password |
| GET | `/api/mails` | List mails for address (JWT auth) |
| GET | `/api/mails/:id` | Get mail detail |
| DELETE | `/api/mails/:id` | Delete mail |
| GET | `/api/mails/:id/attachment/:attachId` | Download attachment |
| POST | `/api/send_mail` | Send email from address |
| GET | `/api/sendbox` | List sent mails |
| DELETE | `/api/sendbox/:id` | Delete sent mail |
| GET | `/api/health` | Health check |

### 4.2 Auth (`/auth`)

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Register new user account, set `tm_user_session` cookie |
| POST | `/auth/login` | Login with email+password, set `tm_user_session` cookie |
| GET | `/auth/oauth2/providers` | List configured OAuth2 providers |
| GET | `/auth/oauth2/:provider/start` | Start OAuth2 flow (returns auth URL + state; PKCE S256 + nonce cookie) |
| GET/POST | `/auth/oauth2/:provider/callback` | OAuth2 callback exchange, validate state/nonce/verifier, set session cookie |
| POST | `/auth/passkey/register/challenge` | Generate passkey registration challenge (requires user session) |
| POST | `/auth/passkey/register/complete` | Verify registration signature and store credential |
| POST | `/auth/passkey/login/challenge` | Generate passkey login challenge |
| POST | `/auth/passkey/login/complete` | Verify passkey assertion and set session cookie |
| POST | `/auth/refresh` | Refresh user session token (cookie-based; bearer fallback supported) |
| POST | `/auth/logout` | Clear `tm_user_session` cookie |

### 4.3 User API (`/user_api`)

| Method | Path | Description |
|---|---|---|
| GET | `/user_api/profile` | Get user profile |
| GET | `/user_api/addresses` | List bound addresses |
| POST | `/user_api/bind_address` | Bind address to account via `address_token` (derive `address_id` from token) |
| DELETE | `/user_api/unbind_address` | Unbind address |
| GET | `/user_api/mails` | All mails across bound addresses |

### 4.4 Admin API (`/admin_api`)

| Method | Path | Description |
|---|---|---|
| GET | `/admin_api/address` | List all addresses (paginated, filterable) |
| POST | `/admin_api/new_address` | Create address without prefix restriction |
| DELETE | `/admin_api/address/:id` | Delete address |
| GET | `/admin_api/users` | List all users |
| DELETE | `/admin_api/users/:id` | Delete user |
| GET | `/admin_api/mails` | List all mails (across all addresses) |
| POST | `/admin_api/settings` | Update settings |
| POST | `/admin_api/cleanup` | Trigger manual cleanup |
| POST | `/admin_api/db_init` | DB schema status check (manual migration hint) |
| GET | `/admin_api/ip_blacklist` | Get IP blacklist |
| POST | `/admin_api/ip_blacklist` | Update IP blacklist |

### 4.5 Telegram API (`/telegram_api`)

| Method | Path | Description |
|---|---|---|
| POST | `/telegram_api/bot` | Telegram Bot webhook receiver |

---

## 5. Worker Configuration (`wrangler.toml`)

```toml
name = "temp-email-worker"
main = "src/worker.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "temp-email-db"
database_id = "<your-d1-id>"

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-id>"

[[r2_buckets]]
binding = "R2"
bucket_name = "temp-email-attachments"

[ai]
binding = "AI"

[vars]
# Required
DOMAINS = "mail.yourdomain.com"          # comma-separated
PREFIX = "tmp"                            # email prefix (e.g. tmp_xxxxx@domain)
ADMIN_PASSWORDS = "your-admin-password"  # comma-separated
JWT_SECRET = "random-secret-string"

# Optional
ENABLE_ADDRESS_PASSWORD = "true"
DISABLE_CUSTOM_ADDRESS_NAME = "false"
CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST = "true"
DEFAULT_DOMAINS = "domain1.com,domain2.com"
USER_ROLES = '[{"name":"vip","domains":["vip.domain.com"],"prefix":"","max_address":10}]'
USER_DEFAULT_ROLE = "default"
ANNOUNCEMENT = ""
TURNSTILE_SECRET = ""
DKIM_PRIVATE_KEY = ""
RESEND_API_KEY = ""
SMTP_HOST = ""
SMTP_PORT = "587"
SMTP_USERNAME = ""
SMTP_PASSWORD = ""
TELEGRAM_BOT_TOKEN = ""
TELEGRAM_BOT_WEBHOOK_SECRET = ""
WEBHOOK_URL = ""
FORWARD_ADDRESS_LIST = ""
S3_REGION = ""
S3_ENDPOINT = ""
S3_ACCESS_KEY_ID = ""
S3_SECRET_ACCESS_KEY = ""
S3_BUCKET = ""
REMOVE_ALL_ATTACHMENT = "false"
REMOVE_EXCEED_SIZE_ATTACHMENT = "false"
MAX_ATTACHMENT_SIZE = "5242880"          # 5MB default
DEBUG_MODE = "false"
ALWAYS_SHOW_ANNOUNCEMENT = "false"
OAUTH2_PROVIDERS = '[]'
```

---

## 6. Frontend Architecture

### 6.1 Tech Stack
- Vue 3 (Composition API)
- Vite (build tool)
- TypeScript
- Vue Router 4
- Pinia (state management)
- Naive UI / Element Plus (UI components)
- vue-i18n (internationalization)

### 6.2 Routes

| Path | Component | Description |
|---|---|---|
| `/` | `IndexView` | Main inbox page |
| `/admin` | `AdminView` | Admin panel (requires admin auth) |
| `/user` | `UserView` | User account management |
| `/login` | `LoginView` | Login/Register page |

### 6.3 State (Pinia Stores)

- `useMailStore` — current address, inbox list, pagination
- `useUserStore` — user profile, bound addresses, session restored via `/auth/refresh` probe
- `useSettingsStore` — domains, announcement, feature flags
- `useAdminStore` — admin session, address/user lists

Frontend auth client behavior:
- `fetch` for auth/user endpoints uses `credentials: 'include'`
- User JWT is not persisted in localStorage (only optional user email metadata)
- Address JWT (temporary inbox credential) remains localStorage-based for `/api/*` address flow
- Base URLs configurable via `VITE_API_BASE` and `VITE_AUTH_BASE`

### 6.4 i18n Keys (minimum)
- `en`, `zh-CN`, `id` (Indonesia) locale files
- Frontend strings: UI labels, error messages
- Backend error messages: also i18n-aware (returned as locale key)

---

## 7. Mail Parser (Rust WASM)

### 7.1 Interface

```typescript
// Exported from mail-parser-wasm pkg
interface ParsedMail {
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  text: string;
  html: string;
  attachments: Attachment[];
  headers: Record<string, string>;
  message_id: string;
}

function parse_mail(raw: Uint8Array): ParsedMail;
```

### 7.2 Build
```bash
cd mail-parser-wasm
wasm-pack build --release --target bundler
# Output: mail-parser-wasm/pkg/
```

---

## 8. SMTP/IMAP Proxy Server

### 8.1 Tech Stack
- Python 3.10+
- Twisted (async network framework)
- `twisted.mail` for SMTP server
- Custom IMAP4 server implementation
- `requests` / `httpx` untuk HTTP calls ke Worker API

### 8.2 Config (environment variables)

```env
BACKEND_URL=https://your-worker.your-account.workers.dev
API_PREFIX=/api
SMTP_PORT=25
IMAP_PORT=143
ENABLE_STARTTLS=true
TLS_CERT_FILE=/certs/cert.pem
TLS_KEY_FILE=/certs/key.pem
```

### 8.3 IMAP Features
- Folder: INBOX (receive), SENT (sendbox)
- SEARCH support
- STARTTLS
- LRU message cache (avoid repeated API calls)
- Session-local FLAGS management
- Stable UID dari backend mail ID
- Dual auth: JWT token atau `address:password`

---

## 9. Security Specifications

### 9.1 JWT
- Algorithm: HS256
- Payload: `{ address, type: "address"|"user", exp, iat }`
- Secret: `JWT_SECRET` env var
- Expiry: configurable, auto-refresh jika < 7 hari

### 9.2 User Session Transport
- Browser flow uses secure HttpOnly cookie `tm_user_session` (`Secure`, `SameSite=Lax`, `Path=/`)
- User auth middleware accepts cookie token and still accepts `Authorization: Bearer` fallback
- Auth endpoints that issue/refresh/login also set cookie; logout clears cookie
- User auth responses tidak lagi mengembalikan `token` di JSON (browser flow cookie-only)

### 9.3 Admin Auth
- `ADMIN_PASSWORDS` env var (comma-separated)
- Dikirim via `Authorization: Bearer <password>` header
- Tidak ada session — stateless check setiap request

### 9.4 Address Password
- Hash dengan bcrypt sebelum disimpan di D1
- Enabled via `ENABLE_ADDRESS_PASSWORD=true`
- Digunakan juga sebagai IMAP/SMTP proxy credential

### 9.5 OAuth2 Security
- OAuth start menyimpan state + code verifier di KV (TTL)
- PKCE method: `S256`
- Nonce browser session di-cookie-kan (`tm_oauth_nonce`) dan divalidasi saat callback
- State key dihapus setelah dipakai (one-time)

### 9.6 WebAuthn / Passkey
- Registration dan assertion mewajibkan UV (user verification)
- Verifikasi RP ID hash, origin allowlist (`APP_ORIGINS`), challenge binding, signature, dan sign counter replay

### 9.7 Rate Limiting
- Per-IP counter di KV
- Configurable threshold per endpoint group
- IP blacklist di settings table

### 9.8 XSS Protection
- HTML email dirender di dalam `<iframe>` sandbox atau shadow DOM
- DOMPurify sanitization sebelum render

### 9.9 Cookie Header Handling
- Multi `Set-Cookie` pada auth flow dikirim dengan append behavior agar cookie tidak saling overwrite

---

## 10. Deployment Flow

### 10.1 Manual (Wrangler CLI)
```bash
# 1. Install deps
npm install -g wrangler
pnpm install

# 2. Create D1
wrangler d1 create temp-email-db

# 3. Create KV
wrangler kv:namespace create KV

# 4. Create R2 (optional)
wrangler r2 bucket create temp-email-attachments

# 5. Edit wrangler.toml with IDs above

# 6. Run DB migration
wrangler d1 execute temp-email-db --file=db/schema.sql

# 7. Deploy worker
cd worker && pnpm build && wrangler deploy

# 8. Build & deploy frontend
cd frontend && pnpm build
wrangler pages deploy dist

# 9. (Optional) Run SMTP proxy
cd smtp_proxy_server
pip install -r requirements.txt
python main.py
```

### 10.2 GitHub Actions CI/CD
- `.github/workflows/backend_deploy.yaml` — deploy worker on push to main
- `.github/workflows/frontend_deploy.yaml` — deploy frontend on push to main
- Secrets: `CF_API_TOKEN`, `CF_ACCOUNT_ID`, semua env vars

---

## 11. Cloudflare Email Routing Config
1. Enable Email Routing di Cloudflare dashboard untuk domain kamu
2. Tambah catch-all rule: `*@yourdomain.com` → **Send to Worker** → pilih worker kamu
3. Verify domain DNS (MX records otomatis diset oleh CF Email Routing)
