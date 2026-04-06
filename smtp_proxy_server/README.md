# SMTP / IMAP Proxy Server

MVP proxy server untuk mengakses Temp Mail lewat email client, **khusus private-network / TLS-terminated deployment**.

## Scope MVP

- IMAP subset:
  - `CAPABILITY`
  - `LOGIN`
  - `LIST`
  - `SELECT`
  - `SEARCH ALL`
  - `FETCH <id>`
  - `LOGOUT`
- SMTP submission subset:
  - `EHLO/HELO`
  - `AUTH PLAIN`
  - `MAIL FROM`
  - `RCPT TO`
  - `DATA`
  - `QUIT`

## Env

- `BACKEND_URL` — URL worker backend
- `SMTP_PORT` — default `1587`
- `IMAP_PORT` — default `1143`

## Login Convention

Untuk IMAP dan SMTP MVP:

- Username: alamat email temp
- Password: JWT token address atau password address (sesuai backend setup)

## Run

```bash
pip install -r requirements.txt
python main.py
```

## Docker

```bash
docker build -t tempmail-proxy .
docker run -p 1587:1587 -p 1143:1143 -e BACKEND_URL=https://your-worker.workers.dev tempmail-proxy
```

## Notes

- Ini bukan implementasi IMAP/SMTP RFC-complete
- Gunakan hanya di private network, VPN, atau di belakang reverse proxy/TLS terminator
- Belum ada STARTTLS/native TLS penuh
- IMAP command support terbatas
- SMTP submission bergantung pada endpoint backend `/api/send_mail`
- Ditujukan sebagai foundation MVP dan integrasi awal
