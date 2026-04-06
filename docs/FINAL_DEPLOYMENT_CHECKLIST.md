# FINAL DEPLOYMENT CHECKLIST

Checklist operasional final untuk deploy Temp Email Service dari nol sampai siap dipakai.

---

## 1. Persiapan Lokal

- [ ] Node.js 18+ tersedia
- [ ] `pnpm` terpasang
- [ ] `wrangler` terpasang dan sudah login
- [ ] Python 3.11+ tersedia jika ingin menjalankan SMTP/IMAP proxy
- [ ] `wasm-pack` tersedia jika ingin build parser WASM ulang

```bash
npm install -g pnpm wrangler
wrangler login
```

---

## 2. Resource Cloudflare

### D1
- [ ] Buat database D1

```bash
wrangler d1 create temp-email-db
```

### KV
- [ ] Buat namespace KV

```bash
wrangler kv:namespace create KV
```

### R2 (opsional)
- [ ] Buat bucket untuk attachment jika ingin digunakan

```bash
wrangler r2 bucket create temp-email-attachments
```

### Workers AI (opsional)
- [ ] Aktifkan binding AI jika AI extraction ingin dipakai

---

## 3. Konfigurasi Worker

- [ ] Isi binding dan non-secret config di `worker/wrangler.toml`
- [ ] Ganti semua placeholder
- [ ] Pastikan `APP_ORIGINS` berisi origin frontend sebenarnya
- [ ] Pastikan `WEBHOOK_SECRET` diisi jika `WEBHOOK_URL` aktif
- [ ] Pastikan `TELEGRAM_BOT_WEBHOOK_SECRET` diisi jika Telegram aktif

### Minimal vars wajib
- [ ] `DOMAINS`
- [ ] `ADMIN_PASSWORDS`
- [ ] `JWT_SECRET`

### Direkomendasikan
- [ ] `PREFIX`

### Rekomendasi secret via Wrangler

```bash
wrangler secret put JWT_SECRET
wrangler secret put ADMIN_PASSWORDS
wrangler secret put RESEND_API_KEY
wrangler secret put WEBHOOK_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_BOT_WEBHOOK_SECRET
```

---

## 4. Database Setup

- [ ] Jalankan schema awal

```bash
wrangler d1 execute temp-email-db --file=db/schema.sql
```

- [ ] Verifikasi tabel minimum/utama ada:
  - `address`
  - `mails`
  - `sendbox`
  - `users`
  - `user_address`
  - `user_roles`
  - `settings`
  - `attachments`
  - `webauthn_credentials`
  - `oauth_connections`

---

## 5. Build Project

### Install dependencies

```bash
pnpm install
```

### Build worker

```bash
pnpm build:worker
```

### Build frontend

```bash
pnpm build:frontend
```

### Build WASM parser (opsional/foundation)

```bash
cd mail-parser-wasm
wasm-pack build --release --target bundler
cd ..
```

---

## 6. Deploy Worker & Frontend

### Worker

```bash
pnpm deploy:worker
```

### Frontend

```bash
pnpm deploy:frontend
```

---

## 7. Post-Deploy Verification

### API checks
- [ ] `GET /`
- [ ] `GET /api/health`
- [ ] `GET /api/settings`

### Runtime safety
- [ ] root endpoint menunjukkan `runtime.valid = true`
- [ ] tidak ada warning kritikal yang tertinggal

### UI checks
- [ ] frontend load normal
- [ ] create address berhasil
- [ ] inbox dapat dibuka

---

## 8. Email Routing Setup

- [ ] Tambahkan domain ke Cloudflare
- [ ] Aktifkan Email Routing
- [ ] Buat catch-all rule ke Worker

Contoh:
- `*@yourdomain.com` → Worker

- [ ] Kirim email uji ke address temp
- [ ] Pastikan email muncul di UI

---

## 9. Integrations Verification

### Telegram
- [ ] Set webhook Telegram dengan secret token
- [ ] Pastikan `TELEGRAM_BOT_WEBHOOK_SECRET` cocok; request tanpa secret valid akan ditolak

```bash
curl "https://api.telegram.org/bot{YOUR_TOKEN}/setWebhook?url=https://your-worker.workers.dev/telegram_api/bot&secret_token=your-telegram-webhook-secret"
```

- [ ] Test `/start`
- [ ] Test `/new`
- [ ] Test notifikasi email masuk

### Webhook
- [ ] Pastikan receiver menerima:
  - `X-Webhook-Timestamp`
  - `X-Webhook-Signature`
- [ ] Receiver memverifikasi HMAC-SHA256
- [ ] Receiver menolak timestamp stale/replay

### Resend
- [ ] Isi `RESEND_API_KEY`
- [ ] Test `POST /api/send_mail`
- [ ] Verifikasi sentbox tersimpan

---

## 10. Security Checks Sebelum Go-Live

- [ ] `DEBUG_MODE=false`
- [ ] `JWT_SECRET` aman dan bukan placeholder
- [ ] `ADMIN_PASSWORDS` aman dan bukan placeholder
- [ ] `APP_ORIGINS` tidak wildcard
- [ ] endpoint admin dilindungi tambahan jika memungkinkan (Cloudflare Access / firewall)
- [ ] webhook receiver memverifikasi signature + timestamp
- [ ] operator memahami known MVP limitations

---

## 11. Optional SMTP/IMAP Proxy

Gunakan **hanya** untuk private-network / TLS-terminated deployment.

```bash
cd smtp_proxy_server
pip install -r requirements.txt
BACKEND_URL=https://your-worker.workers.dev SMTP_PORT=1587 IMAP_PORT=1143 python main.py
```

- [ ] Jangan expose langsung ke internet tanpa TLS layer
- [ ] Test login IMAP
- [ ] Test SMTP AUTH PLAIN
- [ ] Test baca inbox
- [ ] Test send mail

---

## 12. Operational Handoff

- [ ] simpan URL worker dan frontend
- [ ] simpan D1/KV/R2 IDs
- [ ] simpan prosedur rotasi secret
- [ ] dokumentasikan backup D1
- [ ] dokumentasikan known limitations untuk operator
