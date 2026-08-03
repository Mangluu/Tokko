"""Relay signed Prava checkout returns into the existing Telegram chat."""

import asyncio
import json
import os
import re
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, urlparse

import httpx


def _required_env(name: str) -> str:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _telegram_chat_url(bot_username: str) -> str:
    normalized = str(bot_username or "").strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]", normalized):
        raise RuntimeError("Tokko returned an invalid Telegram bot username")
    return f"https://t.me/{quote(normalized, safe='')}"


async def _deliver_prava_return(
    state: str,
    client: httpx.AsyncClient | None = None,
) -> str:
    token = _required_env("TELEGRAM_BOT_TOKEN")
    base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
    api_key = _required_env("HERMES_API_KEY")
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=45)
    try:
        response = await client.post(
            f"{base_url}/api/integrations/telegram/prava-return",
            headers={
                "X-API-Key": api_key,
                "Content-Type": "application/json",
            },
            json={"state": state},
        )
        response.raise_for_status()
        result = response.json()
        chat_id = str(result.get("chatId") or "").strip()
        if not re.fullmatch(r"-?\d{1,20}", chat_id):
            raise RuntimeError("Tokko returned an invalid Telegram chat id")
        next_action = result.get("nextAction") or {}
        action_url = str(next_action.get("url") or "")
        action_label = str(
            next_action.get("label") or "Continue securely with Prava"
        )[:100]
        messages = [
            str(result.get("message") or "").strip(),
            str(result.get("followupMessage") or "").strip(),
        ]
        for index, message in enumerate(value for value in messages if value):
            payload: dict = {"chat_id": chat_id, "text": message[:4000]}
            if (
                index == 0
                and action_url.startswith("https://")
                and len(action_url) <= 2048
            ):
                payload["reply_markup"] = {
                    "inline_keyboard": [[{
                        "text": action_label,
                        "url": action_url,
                    }]],
                }
            sent = await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json=payload,
            )
            sent.raise_for_status()
            telegram_result = sent.json()
            if telegram_result.get("ok") is not True:
                raise RuntimeError("Telegram did not accept the checkout message")
        return _telegram_chat_url(result.get("botUsername"))
    finally:
        if owns_client:
            await client.aclose()


class handler(BaseHTTPRequestHandler):
    def _json_response(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        state = str(
            parse_qs(urlparse(self.path).query).get("state", [""])[0]
        ).strip()
        if not state or len(state) > 4096:
            self._json_response(400, {"error": "invalid_return_state"})
            return
        try:
            chat_url = asyncio.run(_deliver_prava_return(state))
        except Exception:
            self._json_response(502, {"error": "checkout_return_failed"})
            return
        self.send_response(303)
        self.send_header("Location", chat_url)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", "0")
        self.end_headers()
