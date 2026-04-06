import os
from typing import Any, Dict, List, Optional

import httpx


class BackendClient:
    def __init__(self, base_url: Optional[str] = None, timeout: float = 15.0) -> None:
        self.base_url = (
            base_url or os.getenv("BACKEND_URL", "http://127.0.0.1:8787")
        ).rstrip("/")
        self.timeout = timeout

    def _headers(self, token: Optional[str] = None) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def get_mails(
        self, token: str, page: int = 1, limit: int = 50
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{self.base_url}/api/mails",
                params={"page": page, "limit": limit},
                headers=self._headers(token),
            )
            response.raise_for_status()
            return response.json()

    async def validate_address_token(self, token: str) -> Dict[str, Any]:
        return await self.get_mails(token=token, page=1, limit=1)

    async def authenticate_address_password(
        self, address: str, password: str
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}/api/address_auth",
                headers=self._headers(),
                json={"address": address, "password": password},
            )
            response.raise_for_status()
            return response.json()

    async def get_mail(self, token: str, mail_id: int) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{self.base_url}/api/mails/{mail_id}",
                headers=self._headers(token),
            )
            response.raise_for_status()
            return response.json()

    async def send_mail(
        self, token: str, to: str, subject: str, body: str
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}/api/send_mail",
                headers=self._headers(token),
                json={"to": to, "subject": subject, "body": body},
            )
            response.raise_for_status()
            return response.json()

    async def refresh_user(self, token: str) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}/auth/refresh",
                headers=self._headers(token),
            )
            response.raise_for_status()
            return response.json()
