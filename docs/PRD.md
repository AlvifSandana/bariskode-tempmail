# PRD — Temporary Email Service (Self-Hosted on Cloudflare)

## 1. Overview

### 1.1 Product Vision
Membangun layanan temporary email yang sepenuhnya gratis, serverless, dan bisa di-self-host di atas Cloudflare free tier. Pengguna bisa membuat alamat email sementara, menerima dan mengirim email, serta mengelola inbox — semuanya tanpa server tradisional.

### 1.2 Goals
- Zero-cost infrastructure menggunakan Cloudflare Workers, Pages, D1, KV, Email Routing, dan R2
- Fully serverless — tidak ada VPS, tidak ada maintenance server
- Fitur lengkap setara layanan temp mail komersial
- Bisa dioperasikan sebagai layanan publik maupun private (password-protected)
- Mudah di-deploy ulang, dikonfigurasi, dan di-extend

### 1.3 Non-Goals
- Bukan pengganti email permanen / production-grade email server
- Tidak menyediakan SLA atau uptime guarantee
- Tidak ditujukan untuk kegiatan illegal / spam

---

## 2. Target Users

| Persona | Kebutuhan |
|---|---|
| Developer / Tech enthusiast | Self-host temp mail di domain sendiri, gratis |
| Privacy-conscious user | Tidak ingin expose email asli saat registrasi situs |
| QA/Tester | Butuh inbox cepat untuk testing fitur email |
| Admin / Operator | Kelola akun, domain, dan inbox dari panel admin |

---

## 3. Core Features

### 3.1 Email Receiving
- Menerima email masuk melalui Cloudflare Email Routing ke Worker
- Parsing email dengan Rust WASM (support semua format, termasuk yang gagal di parser Node.js)
- Menyimpan metadata + konten email ke Cloudflare D1
- Menampilkan email (plain text & HTML) di frontend
- Menampilkan dan mendownload attachment
- Menyimpan attachment di Cloudflare R2 atau S3 (opsional)
- Auto-detect dan tampilkan attachment gambar inline
- Opsi hapus attachment otomatis (terlalu besar / semua attachment)

### 3.2 Email Sending
- Kirim email dari alamat temp menggunakan SMTP
- Kirim email menggunakan Resend API (HTTP & SMTP)
- DKIM signing untuk email terkirim
- Sent box: melihat riwayat email terkirim

### 3.3 Address Management
- Generate alamat random (lowercase + angka)
- Custom address name (opsional, bisa dinonaktifkan via config)
- Support multi-domain; pilih domain saat buat alamat
- Generate random subdomain dari base domain tertentu
- Address password: proteksi akses inbox per-alamat (diaktifkan via `ENABLE_ADDRESS_PASSWORD`)
- Batas jumlah alamat per user per role (configurable)

### 3.4 User & Authentication
- Buat mailbox tanpa login (anonymous via credential/JWT)
- Re-login ke mailbox sebelumnya menggunakan credential
- Registrasi & login akun penuh (bind multiple alamat ke satu akun)
- Auto-refresh JWT jika expiry < 7 hari
- OAuth2 login (GitHub, Authentik, dll.)
- Passkey / WebAuthn login (passwordless)
- URL JWT parameter untuk auto-login dari link eksternal
- Role-based access: setiap role punya konfigurasi domain & prefix berbeda
- Per-role limit jumlah binding address

### 3.5 Admin Panel
- Dashboard status sistem
- Kelola alamat: create (tanpa prefix), search, delete, bulk delete
- Kelola user: lihat, search by address/keyword, bulk delete/clear inbox/clear sent
- Kelola domain & role (tambah/hapus domain, konfigurasi role)
- IP blacklist untuk rate limiting
- Konfigurasi blacklist & whitelist pengirim
- Konfigurasi pengumuman (ANNOUNCEMENT)
- Maintenance: cleanup email lama, cleanup alamat kosong, cleanup unbound addresses, custom SQL cleanup
- Database migration / upgrade langsung dari panel
- Konfigurasi AI extraction whitelist
- Lihat source IP pengirim (dengan link lookup)

### 3.6 AI Email Extraction
- Menggunakan Cloudflare Workers AI untuk ekstrak info penting dari email
- Priority extraction: Verification Code > Auth Link > Service Link > Subscription Link > Other Links
- Admin dapat konfigurasi address whitelist (support wildcard: `*@example.com`)
- Tampil highlight di UI, dark mode friendly

### 3.7 Spam & Security
- Spam detection
- Blacklist/whitelist pengirim (configurable)
- CF Turnstile CAPTCHA (human verification)
- Rate limiting / throttling per IP
- IP blacklist
- Access password (private site mode)
- Shadow DOM untuk prevent style pollution di embedded mode

### 3.8 Notifications & Integrations
- Telegram Bot: create address, baca email, notifikasi masuk
- Telegram Bot Mini App
- Telegram Push notification (forward email ke Telegram)
- Bot multi-language (`/lang` command untuk en/zh)
- Webhook push: kirim notifikasi ke URL eksternal saat email masuk
- Global forward address: forward semua email ke satu alamat

### 3.9 SMTP/IMAP Proxy
- Python-based proxy server
- SMTP: kirim email dari email client standar (Thunderbird, Outlook, dll.)
- IMAP: baca inbox dari email client standar
- STARTTLS support
- Dual login: JWT credential & address+password
- SEARCH command support
- LRU message cache
- Docker support

### 3.10 UI/UX
- Responsive design (desktop & mobile)
- Multi-language frontend & backend (i18n): Indonesia, English, Chinese, dll.
- Dark mode
- Minimal mode (tampilan ringkas)
- Semua emails view (delete/download/attachment di satu halaman)
- Auto-polling inbox (real-time feel)
- Google Ads integration (opsional)

---

## 4. Technical Requirements

### 4.1 Infrastructure
- Cloudflare Workers (backend API)
- Cloudflare Pages (frontend hosting)
- Cloudflare D1 (primary database, SQLite)
- Cloudflare KV (key-value storage: sessions, settings, cache)
- Cloudflare Email Routing (receive email)
- Cloudflare R2 (attachment storage, opsional)
- Cloudflare Workers AI (AI extraction, opsional)
- External S3 (opsional, alternatif R2)
- Resend API (opsional, untuk email sending)

### 4.2 Performance
- Email parsing via Rust WASM — parsing latency < 100ms
- Frontend SSR/SPA via Cloudflare Pages CDN
- D1 index optimization pada field `message_id` dan kolom filter utama
- IMAP proxy menggunakan deferToThread untuk hindari blocking Twisted reactor

### 4.3 Security
- JWT-based authentication (per-address & per-user)
- DKIM untuk email sending
- CSRF protection
- Rate limiting per IP
- Input validation (hanya lowercase + angka untuk address name)
- XSS sanitization pada render HTML email
- Shadow DOM isolation

### 4.4 Deployment
- Deploy via Wrangler CLI
- Deploy via GitHub Actions (CI/CD)
- Konfigurasi via `wrangler.toml` + environment variables
- Docker support untuk SMTP proxy server

---

## 5. Constraints & Assumptions
- Bergantung pada Cloudflare free tier limits (Workers requests, D1 rows, KV reads, R2 storage)
- Email routing hanya tersedia untuk domain yang sudah di-add ke Cloudflare
- Rust WASM di-compile sekali, di-bundle dengan Worker
- SMTP/IMAP proxy memerlukan server dengan IP publik (bisa VPS kecil atau container)
- Tidak ada SLA — sesuai dengan keterbatasan free tier

---

## 6. Success Metrics
- Deploy berhasil di < 30 menit (fresh setup)
- Email masuk dapat dibaca di UI < 5 detik setelah dikirim
- 0 error pada email parsing untuk format email standar
- Admin panel dapat manage 1000+ alamat tanpa degradasi performa
