# PRODUCTION READINESS

Checklist operasional untuk menjalankan Temp Email Service di production.

---

## 1. Required Environment Hardening

Pastikan nilai berikut **sudah diganti** sebelum deploy:

- `JWT_SECRET` minimal 32 karakter acak
- `ADMIN_PASSWORDS` tidak boleh memakai placeholder
- `DOMAINS` harus valid dan aktif di Cloudflare Email Routing
- `APP_ORIGINS` harus diisi dengan daftar origin frontend yang diizinkan, contoh:

```toml
APP_ORIGINS = "https://mail.example.com,https://admin.example.com"
```

- Jika `WEBHOOK_URL` digunakan, isi juga:

```toml
WEBHOOK_SECRET = "super-long-random-string"
```

- Jika `TELEGRAM_BOT_TOKEN` digunakan, isi juga:

```toml
TELEGRAM_BOT_WEBHOOK_SECRET = "telegram-webhook-secret"
```

---

## 2. Deployment Checklist

- [ ] D1 database sudah dibuat dan schema sudah dijalankan
- [ ] KV namespace sudah dibuat dan terhubung
- [ ] R2 bucket terhubung jika attachment ingin disimpan
- [ ] Workers AI binding aktif jika AI extraction dipakai
- [ ] `APP_ORIGINS` sudah diisi
- [ ] `JWT_SECRET` dan `ADMIN_PASSWORDS` sudah aman
- [ ] `WEBHOOK_SECRET` diisi jika webhook digunakan
- [ ] `TELEGRAM_BOT_WEBHOOK_SECRET` diisi jika Telegram bot digunakan
- [ ] `DEBUG_MODE=false`

---

## 3. Webhook Signature Verification

Jika `WEBHOOK_SECRET` diisi, worker akan mengirim header berikut:

- `X-Webhook-Timestamp`
- `X-Webhook-Signature`

Formula signature:

```text
HMAC-SHA256("<timestamp>.<raw-json-payload>", WEBHOOK_SECRET)
```

Verifikasi payload di receiver sebelum diproses.

---

## 4. Operational Recommendations

- aktifkan Cloudflare access / firewall rule untuk route admin jika memungkinkan
- rotasi `ADMIN_PASSWORDS` secara berkala
- rotasi `JWT_SECRET` jika ada indikasi compromise
- monitor error rate Telegram/webhook
- audit settings `ai_extract_settings` sebelum mengaktifkan AI extraction
- backup D1 secara berkala

---

## 5. Known MVP Limitations

- JWT belum punya revocation/session invalidation
- admin auth masih shared bearer password
- KV rate limiting belum atomic
- MIME parsing notifikasi masih heuristik
- receiver webhook harus memverifikasi freshness dari `X-Webhook-Timestamp` untuk mencegah replay
