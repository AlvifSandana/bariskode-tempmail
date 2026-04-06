from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from message import mail_to_email_message


@dataclass
class MailSession:
    address: str
    token: str


class MailboxService:
    def __init__(self, backend_client) -> None:
        self.backend = backend_client

    async def list_messages(
        self, session: MailSession, limit: int = 50
    ) -> List[Dict[str, Any]]:
        payload = await self.backend.get_mails(session.token, page=1, limit=limit)
        return payload.get("data", {}).get("mails", [])

    async def validate_session(self, session: MailSession) -> bool:
        try:
            payload = await self.backend.validate_address_token(session.token)
            data = payload.get("data", {})
            return data.get("address") == session.address
        except Exception:
            try:
                payload = await self.backend.authenticate_address_password(
                    session.address, session.token
                )
                data = payload.get("data", {})
                token = data.get("token")
                if data.get("address") == session.address and token:
                    session.token = token
                    return True
            except Exception:
                return False
            return False

    async def get_message(
        self, session: MailSession, mail_id: int
    ) -> Optional[Dict[str, Any]]:
        payload = await self.backend.get_mail(session.token, mail_id)
        return payload.get("data")

    async def fetch_email_message(self, session: MailSession, mail_id: int):
        mail = await self.get_message(session, mail_id)
        if not mail:
            return None
        return mail_to_email_message(session.address, mail)

    async def search_all_ids(self, session: MailSession) -> List[int]:
        mails = await self.list_messages(session)
        return [int(item["id"]) for item in mails if item.get("id") is not None]

    async def count_messages(self, session: MailSession) -> int:
        payload = await self.backend.get_mails(session.token, page=1, limit=1)
        return int(payload.get("data", {}).get("pagination", {}).get("total", 0) or 0)

    async def send_message(
        self, session: MailSession, to_addr: str, subject: str, body: str
    ) -> Dict[str, Any]:
        return await self.backend.send_mail(session.token, to_addr, subject, body)
