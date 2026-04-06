import asyncio
import base64
import os
from email import policy
from email.parser import BytesParser
from typing import List, Optional

from twisted.internet import asyncioreactor

try:
    asyncioreactor.install(asyncio.get_event_loop())
except Exception:
    pass

from twisted.internet import defer, reactor
from twisted.internet.protocol import Factory
from twisted.protocols.basic import LineOnlyReceiver

from http_client import BackendClient
from mailbox import MailSession, MailboxService


BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8787")
SMTP_PORT = int(os.getenv("SMTP_PORT", "1587"))
IMAP_PORT = int(os.getenv("IMAP_PORT", "1143"))

backend = BackendClient(BACKEND_URL)
mailbox_service = MailboxService(backend)


def parse_auth_plain(value: str) -> MailSession:
    decoded = base64.b64decode(value).decode("utf-8", errors="ignore")
    parts = decoded.split("\x00")
    if len(parts) < 3:
        raise ValueError("Invalid AUTH PLAIN payload")

    username = parts[-2].strip()
    password = parts[-1].strip()
    if not username or not password:
        raise ValueError("Missing username or password")

    return MailSession(address=username, token=password)


class SimpleSMTPProtocol(LineOnlyReceiver):
    delimiter = b"\r\n"

    def __init__(self):
        self.session: Optional[MailSession] = None
        self.mail_from: Optional[str] = None
        self.recipients: List[str] = []
        self.in_data = False
        self.data_lines: List[bytes] = []

    def connectionMade(self):
        self.sendLine(b"220 tempmail-proxy ESMTP ready")

    def reset_state(self):
        self.mail_from = None
        self.recipients = []
        self.in_data = False
        self.data_lines = []

    def lineReceived(self, line: bytes):
        if self.in_data:
            if line == b".":
                defer.ensureDeferred(self.finish_data())
                return
            self.data_lines.append(line)
            return

        decoded = line.decode("utf-8", errors="ignore").strip()
        if not decoded:
            self.sendLine(b"500 Empty command")
            return

        parts = decoded.split(" ", 1)
        command = parts[0].upper()
        arg = parts[1] if len(parts) > 1 else ""

        if command in {"EHLO", "HELO"}:
            self.sendLine(b"250-tempmail-proxy")
            self.sendLine(b"250-AUTH PLAIN")
            self.sendLine(b"250 SIZE 5242880")
            return

        if command == "AUTH":
            auth_parts = arg.split(" ", 1)
            if len(auth_parts) != 2 or auth_parts[0].upper() != "PLAIN":
                self.sendLine(b"504 Only AUTH PLAIN is supported")
                return

            async def _auth():
                try:
                    session = parse_auth_plain(auth_parts[1])
                    if not await mailbox_service.validate_session(session):
                        self.sendLine(b"535 Authentication failed")
                        return
                    self.session = session
                    self.sendLine(b"235 Authentication successful")
                except Exception:
                    self.sendLine(b"535 Authentication failed")

            defer.ensureDeferred(_auth())
            return

        if command == "QUIT":
            self.sendLine(b"221 Bye")
            self.transport.loseConnection()
            return

        if not self.session:
            self.sendLine(b"530 Authentication required")
            return

        if command == "MAIL":
            if not arg.upper().startswith("FROM:"):
                self.sendLine(b"501 MAIL FROM syntax error")
                return
            self.mail_from = arg[5:].strip().strip("<>")
            if (
                not self.mail_from
                or self.mail_from.lower() != self.session.address.lower()
            ):
                self.sendLine(b"553 sender address rejected")
                self.mail_from = None
                return
            self.recipients = []
            self.sendLine(b"250 OK")
            return

        if command == "RCPT":
            if not arg.upper().startswith("TO:"):
                self.sendLine(b"501 RCPT TO syntax error")
                return
            recipient = arg[3:].strip().strip("<>")
            if not recipient:
                self.sendLine(b"501 Recipient required")
                return
            self.recipients.append(recipient)
            self.sendLine(b"250 OK")
            return

        if command == "DATA":
            if not self.mail_from or not self.recipients:
                self.sendLine(b"503 MAIL FROM and RCPT TO required first")
                return
            self.in_data = True
            self.data_lines = []
            self.sendLine(b"354 End data with <CR><LF>.<CR><LF>")
            return

        if command == "RSET":
            self.reset_state()
            self.sendLine(b"250 OK")
            return

        self.sendLine(b"502 Command not implemented")

    async def finish_data(self):
        self.in_data = False
        try:
            raw_message = b"\r\n".join(self.data_lines)
            parsed = BytesParser(policy=policy.default).parsebytes(raw_message)
            subject = str(parsed.get("Subject") or "(No Subject)")
            body = ""
            if parsed.is_multipart():
                for part in parsed.walk():
                    if part.get_content_type() == "text/plain":
                        body = part.get_content()
                        break
            else:
                try:
                    body = parsed.get_content()
                except Exception:
                    body = raw_message.decode("utf-8", errors="ignore")

            if len(body.encode("utf-8", errors="ignore")) > 5 * 1024 * 1024:
                self.sendLine(b"552 Message too large")
                self.reset_state()
                return

            await mailbox_service.send_message(
                self.session, self.recipients[0], subject, str(body)
            )
            self.sendLine(b"250 Message accepted for delivery")
        except Exception:
            self.sendLine(b"554 Transaction failed")
        finally:
            self.reset_state()


class SimpleIMAPProtocol(LineOnlyReceiver):
    delimiter = b"\r\n"

    def __init__(self):
        self.session: Optional[MailSession] = None

    def connectionMade(self):
        self.sendLine(b"* OK Temp Mail IMAP Proxy Ready")

    def lineReceived(self, line: bytes):
        parts = line.decode("utf-8", errors="ignore").strip().split()
        if len(parts) < 2:
            self.sendLine(b"* BAD Invalid command")
            return

        tag = parts[0]
        command = parts[1].upper()
        args = parts[2:]

        if command == "CAPABILITY":
            self.sendLine(b"* CAPABILITY IMAP4rev1")
            self.sendLine(f"{tag} OK CAPABILITY completed".encode())
            return

        if command == "LOGIN":
            if len(args) < 2:
                self.sendLine(
                    f"{tag} BAD LOGIN requires username and password".encode()
                )
                return

            async def _login():
                address = args[0].strip('"')
                password = args[1].strip('"')
                candidate = MailSession(address=address, token=password)
                if await mailbox_service.validate_session(candidate):
                    self.session = candidate
                    self.sendLine(f"{tag} OK LOGIN completed".encode())
                else:
                    self.sendLine(f"{tag} NO LOGIN failed".encode())

            defer.ensureDeferred(_login())
            return

        if command == "LIST":
            self.sendLine(b'* LIST (\\HasNoChildren) "/" "INBOX"')
            self.sendLine(f"{tag} OK LIST completed".encode())
            return

        if not self.session:
            self.sendLine(f"{tag} NO Authenticate first".encode())
            return

        if command == "SELECT":

            async def _select():
                try:
                    count = await mailbox_service.count_messages(self.session)
                    self.sendLine(f"* {count} EXISTS".encode())
                    self.sendLine(b"* FLAGS (\\Seen)")
                    self.sendLine(f"{tag} OK [READ-WRITE] SELECT completed".encode())
                except Exception:
                    self.sendLine(f"{tag} NO SELECT failed".encode())

            defer.ensureDeferred(_select())
            return

        if command == "SEARCH":
            if args and "ALL" not in [arg.upper() for arg in args]:
                self.sendLine(f"{tag} BAD Only SEARCH ALL is supported".encode())
                return

            async def _search():
                ids = await mailbox_service.search_all_ids(self.session)
                payload = " ".join(str(i) for i in ids)
                self.sendLine(f"* SEARCH {payload}".encode())
                self.sendLine(f"{tag} OK SEARCH completed".encode())

            defer.ensureDeferred(_search())
            return

        if command == "FETCH":
            if not args:
                self.sendLine(f"{tag} BAD FETCH requires mail id".encode())
                return

            async def _fetch():
                try:
                    mail_id = int(args[0])
                    msg = await mailbox_service.fetch_email_message(
                        self.session, mail_id
                    )
                    if msg is None:
                        self.sendLine(f"{tag} NO Message not found".encode())
                        return
                    raw = msg.as_bytes()
                    self.sendLine(f"* {mail_id} FETCH (RFC822 {{{len(raw)}}}".encode())
                    self.transport.write(raw + b"\r\n")
                    self.sendLine(b")")
                    self.sendLine(f"{tag} OK FETCH completed".encode())
                except Exception:
                    self.sendLine(f"{tag} NO FETCH failed".encode())

            defer.ensureDeferred(_fetch())
            return

        if command == "LOGOUT":
            self.sendLine(b"* BYE Logging out")
            self.sendLine(f"{tag} OK LOGOUT completed".encode())
            self.transport.loseConnection()
            return

        self.sendLine(f"{tag} BAD Unsupported command".encode())


class SimpleIMAPFactory(Factory):
    def buildProtocol(self, addr):
        return SimpleIMAPProtocol()


class SimpleSMTPFactory(Factory):
    def buildProtocol(self, addr):
        return SimpleSMTPProtocol()


def main():
    print(f"Starting SMTP proxy on {SMTP_PORT}")
    print(f"Starting IMAP proxy on {IMAP_PORT}")
    print(f"Backend URL: {BACKEND_URL}")
    print("WARNING: Use only in private-network or TLS-terminated deployments")

    reactor.listenTCP(IMAP_PORT, SimpleIMAPFactory())
    reactor.listenTCP(SMTP_PORT, SimpleSMTPFactory())
    reactor.run()


if __name__ == "__main__":
    main()
