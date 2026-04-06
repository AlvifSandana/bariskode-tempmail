from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Any, Dict


def mail_to_email_message(address: str, mail: Dict[str, Any]) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = mail.get("sender") or "unknown@example.invalid"
    msg["To"] = address
    msg["Subject"] = mail.get("subject") or "(No Subject)"
    msg["Date"] = formatdate()
    msg["Message-ID"] = make_msgid()

    body = mail.get("text") or mail.get("html") or mail.get("raw") or ""
    msg.set_content(str(body))
    return msg


def build_raw_message(from_addr: str, to_addr: str, subject: str, body: str) -> str:
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = formatdate()
    msg.set_content(body)
    return msg.as_string()
