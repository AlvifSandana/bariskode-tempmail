# GO-LIVE CHECKLIST

Checklist praktis sebelum benar-benar go-live.

---

## 1. Cloudflare Resources

- [ ] D1 database dibuat
- [ ] KV namespace dibuat
- [ ] R2 bucket dibuat bila attachment dipakai
- [ ] Workers AI binding dibuat bila AI extraction dipakai
- [ ] Email Routing aktif untuk domain tujuan
- [ ] Catch-all rule diarahkan ke Worker

## 2. Secrets & Config

- [ ] `JWT_SECRET` diisi secret aman (bukan placeholder)
- [ ] `ADMIN_PASSWORDS` diisi secret aman
- [ ] `APP_ORIGINS` diisi origin frontend sebenarnya
- [ ] `WEBHOOK_SECRET` diisi jika `WEBHOOK_URL` dipakai
- [ ] `TELEGRAM_BOT_WEBHOOK_SECRET` diisi jika Telegram bot aktif
- [ ] `DEBUG_MODE=false`
- [ ] Gunakan `wrangler secret put` untuk credential sensitif

## 3. Database

- [ ] Jalankan `wrangler d1 execute ... --file=db/schema.sql`
- [ ] Verifikasi semua tabel tersedia
- [ ] Verifikasi setting default sudah masuk

## 4. Deploy Backend

- [ ] `pnpm --filter worker install`
- [ ] `pnpm --filter worker build`
- [ ] `wrangler deploy`
- [ ] Cek `GET /`
- [ ] Cek `GET /api/health`

## 5. Deploy Frontend

- [ ] `pnpm --filter frontend install`
- [ ] `pnpm --filter frontend build`
- [ ] Deploy ke Cloudflare Pages
- [ ] Pastikan frontend origin masuk ke `APP_ORIGINS`

## 6. Integrations

### Telegram
- [ ] Bot token valid
- [ ] Telegram webhook di-set dengan secret token
- [ ] Test `/start`
- [ ] Test `/new`
- [ ] Test notifikasi email masuk

### Webhook
- [ ] `WEBHOOK_URL` aktif
- [ ] Receiver memverifikasi:
  - [ ] `X-Webhook-Timestamp`
  - [ ] `X-Webhook-Signature`
  - [ ] freshness timestamp

### AI
- [ ] Workers AI binding aktif jika dipakai
- [ ] `ai_extract_settings.enabled=true` hanya bila siap
- [ ] whitelist address sudah ditentukan

## 7. Manual Smoke Test

- [ ] Buat address baru via UI
- [ ] Buat address baru via Telegram `/new`
- [ ] Kirim email ke address tersebut
- [ ] Email muncul di UI
- [ ] Email detail bisa dibuka
- [ ] User register/login berhasil
- [ ] Bind address ke user berhasil
- [ ] Admin endpoint auth bekerja
- [ ] Cleanup admin route berjalan aman

## 8. Monitoring & Ops

- [ ] Rotasi admin password dijadwalkan
- [ ] Backup D1 strategy ditetapkan
- [ ] Receiver webhook logging aktif
- [ ] Error monitoring/log review disiapkan
- [ ] Known MVP limitations diterima oleh operator
