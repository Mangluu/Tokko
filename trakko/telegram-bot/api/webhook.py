"""Vercel Function that receives Telegram webhook updates."""

import asyncio
import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

from telegram import Update

from api.prava_return import handler as PravaReturnHandler
from bot import _init_db, build_application


async def _process_update(payload: dict) -> None:
    _init_db()
    app = build_application()
    await app.initialize()
    try:
        update = Update.de_json(payload, app.bot)
        await app.process_update(update)
    finally:
        await app.shutdown()


class handler(BaseHTTPRequestHandler):
    def _json_response(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if urlparse(self.path).path.rstrip("/") == "/api/prava_return":
            PravaReturnHandler.do_GET(self)
            return
        self._json_response(
            200,
            {
                "service": "telegram-hermes-bridge",
                "status": "ready" if os.environ.get("TELEGRAM_BOT_TOKEN") else "needs_configuration",
            },
        )

    def do_POST(self) -> None:
        expected_secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET")
        supplied_secret = self.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if expected_secret and supplied_secret != expected_secret:
            self._json_response(401, {"ok": False, "error": "unauthorized"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            asyncio.run(_process_update(payload))
        except (json.JSONDecodeError, ValueError):
            self._json_response(400, {"ok": False, "error": "invalid_json"})
            return
        except RuntimeError as exc:
            self._json_response(503, {"ok": False, "error": str(exc)})
            return
        except Exception:
            self._json_response(500, {"ok": False, "error": "update_failed"})
            return

        self._json_response(200, {"ok": True})
