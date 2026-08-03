import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx

from api import prava_return
from api import webhook


class PravaReturnRelayTests(unittest.TestCase):
    def test_webhook_entrypoint_dispatches_the_prava_return_path(self):
        request = SimpleNamespace(
            path="/api/prava_return?state=signed",
            _json_response=Mock(),
        )
        with patch.object(prava_return.handler, "do_GET") as relay:
            webhook.handler.do_GET(request)
        relay.assert_called_once_with(request)

    def test_relay_posts_two_messages_and_opens_plain_telegram_chat(self):
        requests = []

        def respond(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "tokko-shopper.vercel.app":
                self.assertEqual(request.headers["X-API-Key"], "service-key")
                self.assertEqual(
                    json.loads(request.content),
                    {"state": "signed-return-state"},
                )
                return httpx.Response(200, json={
                    "chatId": "7783253227",
                    "botUsername": "TokkoShopperBot",
                    "message": (
                        "Prava checkout was successful, but the order still "
                        "awaits merchant approval. This cart was cleared."
                    ),
                    "followupMessage": (
                        "Order creation failed at the merchant end."
                    ),
                })
            self.assertEqual(request.url.host, "api.telegram.org")
            self.assertEqual(
                request.url.path,
                "/bottelegram-test-token/sendMessage",
            )
            return httpx.Response(200, json={"ok": True, "result": {}})

        async def run() -> str:
            transport = httpx.MockTransport(respond)
            async with httpx.AsyncClient(transport=transport) as client:
                return await prava_return._deliver_prava_return(
                    "signed-return-state",
                    client,
                )

        with patch.dict(os.environ, {
            "TELEGRAM_BOT_TOKEN": "telegram-test-token",
            "TOKKO_API_BASE_URL": "https://tokko-shopper.vercel.app",
            "HERMES_API_KEY": "service-key",
        }):
            chat_url = asyncio.run(run())

        self.assertEqual(chat_url, "https://t.me/TokkoShopperBot")
        self.assertNotIn("start", chat_url.lower())
        telegram_payloads = [
            json.loads(request.content)
            for request in requests
            if request.url.host == "api.telegram.org"
        ]
        self.assertEqual(len(telegram_payloads), 2)
        self.assertIn("Prava checkout was successful", telegram_payloads[0]["text"])
        self.assertEqual(
            telegram_payloads[1]["text"],
            "Order creation failed at the merchant end.",
        )
        self.assertNotIn("/start", json.dumps(telegram_payloads))

    def test_relay_attaches_a_secure_continuation_without_start_payload(self):
        telegram_payloads = []

        def respond(request: httpx.Request) -> httpx.Response:
            if request.url.host == "tokko-shopper.vercel.app":
                return httpx.Response(200, json={
                    "chatId": "7783253227",
                    "botUsername": "TokkoShopperBot",
                    "message": "Your Prava mandate session is ready.",
                    "nextAction": {
                        "label": "Approve mandate with Prava",
                        "url": "https://checkout.prava.space/session/mandate",
                    },
                })
            telegram_payloads.append(json.loads(request.content))
            return httpx.Response(200, json={"ok": True, "result": {}})

        async def run() -> str:
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(respond)
            ) as client:
                return await prava_return._deliver_prava_return("signed", client)

        with patch.dict(os.environ, {
            "TELEGRAM_BOT_TOKEN": "telegram-test-token",
            "TOKKO_API_BASE_URL": "https://tokko-shopper.vercel.app",
            "HERMES_API_KEY": "service-key",
        }):
            chat_url = asyncio.run(run())

        self.assertEqual(chat_url, "https://t.me/TokkoShopperBot")
        button = telegram_payloads[0]["reply_markup"]["inline_keyboard"][0][0]
        self.assertEqual(button["text"], "Approve mandate with Prava")
        self.assertTrue(button["url"].startswith("https://"))


if __name__ == "__main__":
    unittest.main()
