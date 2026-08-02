"""Telegram bridge for Tokko's family-scoped Hermes shopper.

The bot resolves a Telegram user's own phone number to an existing Tokko
family. When the phone is unknown, it collects the same core family profile
used by Tokko's website and service APIs, records explicit Zepto-auth consent,
creates the family through Tokko's service API, and immediately enables the
normal Hermes shopping conversation.

Configuration is provided through environment variables; see .env.example.
"""

import asyncio
import base64
import json
import logging
import os
import re
import sqlite3
from urllib.parse import quote

from dotenv import load_dotenv

load_dotenv()

import httpx
from telegram import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaPhoto,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    Update,
)
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters,
)

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
# Telegram places the bot credential in its request URL. httpx INFO logs the
# complete URL, so keep transport logging above INFO to prevent token leakage.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
log = logging.getLogger("telegram-hermes-bridge")


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


REQUEST_TIMEOUT_SECONDS = float(os.environ.get("HERMES_TIMEOUT_SECONDS", "180"))
HERMES_TIMEOUT = httpx.Timeout(
    connect=10.0, read=REQUEST_TIMEOUT_SECONDS, write=10.0, pool=10.0
)
DB_PATH = os.environ.get("DB_PATH") or (
    "/tmp/bridge_state.db" if os.environ.get("VERCEL") else "bridge_state.db"
)
ONBOARDING_URL = "https://tokko-drab.vercel.app"

(
    WAIT_CONTACT,
    ONBOARD_NAME,
    ONBOARD_EMAIL,
    ONBOARD_AGE,
    ONBOARD_GENDER,
    ONBOARD_GENDER_DESCRIPTION,
    ADD_FIRST_DEPENDENT,
    DEPENDENT_NAME,
    DEPENDENT_PHONE,
    DEPENDENT_RELATIONSHIP,
    DEPENDENT_OTHER_RELATIONSHIP,
    DEPENDENT_AGE,
    DEPENDENT_GENDER,
    DEPENDENT_GENDER_DESCRIPTION,
    ADD_ANOTHER_DEPENDENT,
    SELECT_MERCHANT_PHONE,
    CONFIRM_MERCHANT_CONSENT,
) = range(17)

(
    PAYMENT_MENU_STATE,
    MANDATE_CARD_STATE,
    MANDATE_AMOUNT_STATE,
    MANDATE_CUSTOM_AMOUNT_STATE,
    MANDATE_FREQUENCY_STATE,
) = range(20, 25)

CONTACT_KEYBOARD = ReplyKeyboardMarkup(
    [[KeyboardButton("Share My Phone Number", request_contact=True)]],
    resize_keyboard=True,
    one_time_keyboard=True,
)
NEW_ONBOARDING_KEYBOARD = InlineKeyboardMarkup(
    [[InlineKeyboardButton("Complete Tokko onboarding", url=ONBOARDING_URL)]]
)
RELATIONSHIP_KEYBOARD = ReplyKeyboardMarkup(
    [
        ["Mother", "Father"],
        ["Son", "Daughter"],
        ["Brother", "Sister"],
        ["Spouse", "Other"],
    ],
    resize_keyboard=True,
    one_time_keyboard=True,
)
OPTIONAL_AGE_KEYBOARD = ReplyKeyboardMarkup(
    [["Skip"]], resize_keyboard=True, one_time_keyboard=True
)
GENDER_KEYBOARD = ReplyKeyboardMarkup(
    [
        ["Woman", "Man"],
        ["Non-binary", "Self-described"],
        ["Prefer not to say"],
    ],
    resize_keyboard=True,
    one_time_keyboard=True,
)
MAIN_KEYBOARD = ReplyKeyboardMarkup(
    [["Addresses", "Add Address"], ["Cart", "Payments"]], resize_keyboard=True
)
PAYMENT_MENU_KEYBOARD = ReplyKeyboardMarkup(
    [
        ["Add Card", "Refresh Saved Cards"],
        ["Create Mandate", "View Mandates"],
        ["Show All (30 Days)"],
        ["Back to Shopping"],
    ],
    resize_keyboard=True,
)
MANDATE_AMOUNT_INLINE_KEYBOARD = InlineKeyboardMarkup(
    [
        [
            InlineKeyboardButton("₹50", callback_data="mandateamt:50"),
            InlineKeyboardButton("₹100", callback_data="mandateamt:100"),
        ],
        [
            InlineKeyboardButton("₹500", callback_data="mandateamt:500"),
            InlineKeyboardButton("₹1000", callback_data="mandateamt:1000"),
        ],
    ]
)
MANDATE_AMOUNT_KEYBOARD = ReplyKeyboardMarkup(
    [
        ["₹50", "₹100"],
        ["₹500", "₹1000"],
        ["Custom Amount"],
        ["Back to Payments"],
    ],
    resize_keyboard=True,
    one_time_keyboard=True,
)
MANDATE_FREQUENCY_KEYBOARD = ReplyKeyboardMarkup(
    [
        ["One-Time (Any Merchant)"],
        ["Weekly", "Monthly", "Yearly"],
        ["Back to Payments"],
    ],
    resize_keyboard=True,
    one_time_keyboard=True,
)

YES_NO_CHECKBOX = InlineKeyboardMarkup(
    [[
        InlineKeyboardButton("☐ Yes", callback_data="onboarding:add-dependent:yes"),
        InlineKeyboardButton("☐ No", callback_data="onboarding:add-dependent:no"),
    ]]
)
FIRST_DEPENDENT_CHECKBOX = InlineKeyboardMarkup(
    [[
        InlineKeyboardButton("☐ Add Dependent", callback_data="onboarding:first-dependent:yes"),
        InlineKeyboardButton("☐ Skip", callback_data="onboarding:first-dependent:no"),
    ]]
)
CONSENT_CHECKBOX = InlineKeyboardMarkup(
    [[InlineKeyboardButton(
        "☐ Yes, I Consent", callback_data="onboarding:consent:yes"
    )], [InlineKeyboardButton(
        "☐ No, Continue Without Zepto", callback_data="onboarding:consent:no"
    )]]
)
HERMES_CONFIRMATION_CHECKBOX = InlineKeyboardMarkup(
    [[
        InlineKeyboardButton("☐ Yes, Approve", callback_data="hermes:approve"),
        InlineKeyboardButton("☐ No, Leave It", callback_data="hermes:decline"),
    ]]
)
TELEGRAM_LANGUAGES = {
    "en-IN": "English",
    "hi-IN": "हिन्दी",
    "bn-IN": "বাংলা",
    "ta-IN": "தமிழ்",
    "te-IN": "తెలుగు",
    "mr-IN": "मराठी",
    "gu-IN": "ગુજરાતી",
    "kn-IN": "ಕನ್ನಡ",
    "ml-IN": "മലയാളം",
    "pa-IN": "ਪੰਜਾਬੀ",
}
LANGUAGE_MARKUP = InlineKeyboardMarkup([
    [InlineKeyboardButton(label, callback_data=f"language:{locale}")]
    for locale, label in TELEGRAM_LANGUAGES.items()
])
ADDRESS_COUNTRIES = (
    ("IN", "India"),
    ("US", "United States"),
    ("GB", "United Kingdom"),
    ("AE", "United Arab Emirates"),
    ("SG", "Singapore"),
    ("AU", "Australia"),
    ("CA", "Canada"),
)
BOT_COMMANDS = [
    BotCommand("start", "start a fresh shopping session"),
    BotCommand("addresses", "list saved delivery addresses"),
    BotCommand("reselect", "choose a different delivery address"),
    BotCommand("addaddress", "add a new delivery address"),
    BotCommand("cart", "show your wellness cart"),
    BotCommand("payments", "manage cards and mandates"),
    BotCommand("language", "choose English or a regional language"),
    BotCommand("cancel", "cancel the current setup step"),
]


class TokkoAPIError(RuntimeError):
    def __init__(self, status_code: int, message: str, details: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details or {}


def _init_db() -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        # Keep the original table for a non-destructive migration of existing
        # installations that stored customerId as family_id.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS family_ids ("
            "chat_id INTEGER PRIMARY KEY, family_id TEXT NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS family_bindings ("
            "chat_id INTEGER PRIMARY KEY, "
            "user_id INTEGER NOT NULL, "
            "customer_id TEXT, "
            "family_phone TEXT, "
            "response_language TEXT NOT NULL DEFAULT 'en-IN')"
        )
        try:
            conn.execute(
                "ALTER TABLE family_bindings ADD COLUMN response_language TEXT NOT NULL DEFAULT 'en-IN'"
            )
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc).lower():
                raise
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pending_hermes_actions ("
            "chat_id INTEGER PRIMARY KEY, "
            "approval_token TEXT NOT NULL, "
            "description TEXT, "
            "expires_at INTEGER NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pending_ucp_card_choices ("
            "chat_id INTEGER PRIMARY KEY, "
            "choices_json TEXT NOT NULL, "
            "expires_at INTEGER NOT NULL)"
        )
        legacy_rows = conn.execute(
            "SELECT chat_id, family_id FROM family_ids"
        ).fetchall()
        for chat_id, family_id in legacy_rows:
            match = re.fullmatch(r"tokko_family_(\d+)", str(family_id))
            if match:
                conn.execute(
                    "INSERT OR IGNORE INTO family_bindings "
                    "(chat_id, user_id, customer_id) VALUES (?, ?, ?)",
                    (chat_id, int(match.group(1)), family_id),
                )
        conn.commit()
    finally:
        conn.close()


def _get_family_binding_sync(chat_id: int) -> dict | None:
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute(
            "SELECT user_id, customer_id, family_phone, response_language "
            "FROM family_bindings WHERE chat_id = ?",
            (chat_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "userId": int(row[0]),
            "customerId": row[1],
            "familyPhone": row[2],
            "responseLanguage": row[3] or "en-IN",
        }
    finally:
        conn.close()


def _set_family_binding_sync(chat_id: int, binding: dict) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "INSERT INTO family_bindings "
            "(chat_id, user_id, customer_id, family_phone, response_language) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(chat_id) DO UPDATE SET "
            "user_id = excluded.user_id, "
            "customer_id = excluded.customer_id, "
            "family_phone = COALESCE(excluded.family_phone, family_bindings.family_phone), "
            "response_language = COALESCE(excluded.response_language, family_bindings.response_language)",
            (
                chat_id,
                int(binding["userId"]),
                binding.get("customerId"),
                binding.get("familyPhone"),
                binding.get("responseLanguage") or "en-IN",
            ),
        )
        conn.commit()
    finally:
        conn.close()


async def get_family_binding(chat_id: int) -> dict | None:
    local = await asyncio.to_thread(_get_family_binding_sync, chat_id)
    if local is not None:
        return local
    base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.get(
            f"{base_url}/api/v1/integrations/telegram/bindings/{chat_id}",
            headers=_tokko_headers(),
        )
    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        raise _api_error(response)
    binding = response.json()
    await asyncio.to_thread(_set_family_binding_sync, chat_id, binding)
    return binding


async def set_family_binding(chat_id: int, binding: dict) -> None:
    await asyncio.to_thread(_set_family_binding_sync, chat_id, binding)
    if os.environ.get("VERCEL"):
        base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
        async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
            response = await client.put(
                f"{base_url}/api/v1/integrations/telegram/bindings/{chat_id}",
                headers={**_tokko_headers(), "Content-Type": "application/json"},
                json={"familyUserId": int(binding["userId"])},
            )
        if response.status_code >= 400:
            raise _api_error(response)


def _set_pending_action_sync(chat_id: int, action: dict) -> None:
    token = str(action.get("token") or "")
    if not token:
        return
    expires_in = max(1, int(action.get("expiresInSeconds") or 600))
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "INSERT INTO pending_hermes_actions "
            "(chat_id, approval_token, description, expires_at) "
            "VALUES (?, ?, ?, CAST(strftime('%s', 'now') AS INTEGER) + ?) "
            "ON CONFLICT(chat_id) DO UPDATE SET "
            "approval_token = excluded.approval_token, "
            "description = excluded.description, "
            "expires_at = excluded.expires_at",
            (chat_id, token, str(action.get("description") or ""), expires_in),
        )
        conn.commit()
    finally:
        conn.close()


def _get_pending_action_sync(chat_id: int) -> dict | None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "DELETE FROM pending_hermes_actions "
            "WHERE expires_at <= CAST(strftime('%s', 'now') AS INTEGER)"
        )
        row = conn.execute(
            "SELECT approval_token, description, expires_at "
            "FROM pending_hermes_actions WHERE chat_id = ?",
            (chat_id,),
        ).fetchone()
        conn.commit()
        if not row:
            return None
        return {
            "token": row[0],
            "description": row[1],
            "expiresAt": int(row[2]),
        }
    finally:
        conn.close()


def _clear_pending_action_sync(chat_id: int) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("DELETE FROM pending_hermes_actions WHERE chat_id = ?", (chat_id,))
        conn.commit()
    finally:
        conn.close()


async def set_pending_action(chat_id: int, action: dict) -> None:
    await asyncio.to_thread(_set_pending_action_sync, chat_id, action)


async def get_pending_action(chat_id: int) -> dict | None:
    return await asyncio.to_thread(_get_pending_action_sync, chat_id)


async def clear_pending_action(chat_id: int) -> None:
    await asyncio.to_thread(_clear_pending_action_sync, chat_id)


def _set_pending_ucp_cards_sync(chat_id: int, choices: list) -> None:
    safe_choices = [
        {
            "token": str(choice.get("token") or ""),
            "brand": str(choice.get("brand") or "card"),
            "last4": str(choice.get("last4") or ""),
            "isDefault": bool(choice.get("isDefault")),
            **(
                {"type": str(choice.get("type"))}
                if choice.get("type") else {}
            ),
            **(
                {"label": str(choice.get("label"))}
                if choice.get("label") else {}
            ),
            **(
                {"paymentMethodId": str(choice.get("paymentMethodId"))}
                if choice.get("paymentMethodId") else {}
            ),
            **(
                {"orderId": str(choice.get("orderId"))}
                if choice.get("orderId") else {}
            ),
            **(
                {"purpose": str(choice.get("purpose"))}
                if choice.get("purpose") else {}
            ),
        }
        for choice in choices[:50]
        if (choice.get("token") or choice.get("paymentMethodId"))
        and (
            str(choice.get("type") or "saved_card") == "add_card"
            or re.fullmatch(r"\d{4}", str(choice.get("last4") or ""))
        )
    ]
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "INSERT INTO pending_ucp_card_choices "
            "(chat_id, choices_json, expires_at) VALUES (?, ?, CAST(strftime('%s', 'now') AS INTEGER) + 600) "
            "ON CONFLICT(chat_id) DO UPDATE SET "
            "choices_json = excluded.choices_json, expires_at = excluded.expires_at",
            (chat_id, json.dumps(safe_choices)),
        )
        conn.commit()
    finally:
        conn.close()


def _get_pending_ucp_card_sync(chat_id: int, index: int) -> dict | None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "DELETE FROM pending_ucp_card_choices "
            "WHERE expires_at <= CAST(strftime('%s', 'now') AS INTEGER)"
        )
        row = conn.execute(
            "SELECT choices_json FROM pending_ucp_card_choices WHERE chat_id = ?",
            (chat_id,),
        ).fetchone()
        conn.commit()
        if not row:
            return None
        choices = json.loads(row[0])
        return choices[index] if 0 <= index < len(choices) else None
    finally:
        conn.close()


def _clear_pending_ucp_cards_sync(chat_id: int) -> None:
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("DELETE FROM pending_ucp_card_choices WHERE chat_id = ?", (chat_id,))
        conn.commit()
    finally:
        conn.close()


def _card_choice_label(choice: dict, selected: bool = False) -> str:
    prefix = "✓ " if selected else ""
    if choice.get("type") == "add_card":
        return f"{prefix}{str(choice.get('label') or 'Add a new saved card')}"
    default = "✓ " if choice.get("isDefault") and not selected else ""
    return (
        f"{prefix}{default}{str(choice.get('brand') or 'Card').title()} "
        f"•••• {choice.get('last4')}"
    )


def _mandate_frequency_inline_keyboard(amount: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton(
                "One-Time (Any Merchant)",
                callback_data=f"mandatefreq:{amount}:o:a",
            )],
            [
                InlineKeyboardButton(
                    "Weekly", callback_data=f"mandatefreq:{amount}:w:l"
                ),
                InlineKeyboardButton(
                    "Monthly", callback_data=f"mandatefreq:{amount}:m:l"
                ),
                InlineKeyboardButton(
                    "Yearly", callback_data=f"mandatefreq:{amount}:y:l"
                ),
            ],
        ]
    )


def _normalize_phone(phone: str) -> str:
    normalized = re.sub(r"[\s().-]", "", str(phone).strip())
    if not normalized.startswith("+"):
        normalized = f"+{normalized}"
    if not re.fullmatch(r"\+[1-9]\d{7,14}", normalized):
        raise ValueError("Use a valid phone number with country code, for example +919876543210.")
    return normalized


def _normalize_dependent_phone(phone: str, account_phone: str) -> str:
    supplied = str(phone).strip()
    digits = re.sub(r"\D", "", supplied)
    if not supplied.startswith("+") and len(digits) == 10 and account_phone.startswith("+91"):
        supplied = f"+91{digits}"
    return _normalize_phone(supplied)


def _tokko_headers() -> dict:
    return {"X-API-Key": _required_env("HERMES_API_KEY")}


def _api_error(response: httpx.Response) -> TokkoAPIError:
    try:
        body = response.json()
    except ValueError:
        body = {}
    message = body.get("error") if isinstance(body, dict) else None
    return TokkoAPIError(
        response.status_code,
        str(message or f"Tokko returned HTTP {response.status_code}"),
        body if isinstance(body, dict) else {},
    )


async def _lookup_family(phone: str) -> dict:
    base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
    e164 = _normalize_phone(phone)
    url = f"{base_url}/api/v1/onboarding/{quote(e164, safe='')}"
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.get(url, headers=_tokko_headers())
    if response.status_code >= 400:
        raise _api_error(response)
    data = response.json()
    try:
        return {
            "userId": int(data["userId"]),
            "customerId": data["customerId"],
            "familyPhone": e164,
            "profileComplete": bool(data.get("profileComplete")),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"Could not parse Tokko family lookup: {exc}") from exc


async def _create_family(payload: dict) -> dict:
    base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.post(
            f"{base_url}/api/v1/onboarding",
            headers={**_tokko_headers(), "Content-Type": "application/json"},
            json=payload,
        )
    if response.status_code >= 400:
        raise _api_error(response)
    data = response.json()
    try:
        return {
            "userId": int(data["userId"]),
            "customerId": data["customerId"],
            "familyPhone": payload["primaryParentPhone"],
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"Could not parse Tokko onboarding response: {exc}") from exc


async def _family_api(
    binding: dict,
    method: str,
    path: str,
    payload: dict | None = None,
) -> dict:
    base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
    url = f"{base_url}/api/v1/onboarding/{binding['userId']}/{path.lstrip('/')}"
    headers = _tokko_headers()
    if payload is not None:
        headers = {**headers, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.request(
            method,
            url,
            headers=headers,
            json=payload,
        )
    if response.status_code >= 400:
        raise _api_error(response)
    return response.json()


async def _telegram_address_session(
    chat_id: int,
    method: str = "GET",
    payload: dict | None = None,
) -> dict:
    base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
    url = (
        f"{base_url}/api/v1/integrations/telegram/bindings/"
        f"{chat_id}/address-session"
    )
    headers = _tokko_headers()
    if payload is not None:
        headers = {**headers, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.request(method, url, headers=headers, json=payload)
    if response.status_code >= 400:
        raise _api_error(response)
    return response.json()


async def _set_telegram_language(chat_id: int, language: str) -> dict:
    base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
    url = f"{base_url}/api/v1/integrations/telegram/bindings/{chat_id}/language"
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.post(
            url,
            headers={**_tokko_headers(), "Content-Type": "application/json"},
            json={"language": language},
        )
    if response.status_code >= 400:
        raise _api_error(response)
    return response.json()


async def _address_session_confirmed(
    chat_id: int,
    context: ContextTypes.DEFAULT_TYPE,
) -> bool:
    if context.user_data.get("delivery_address_confirmed"):
        return True
    if not os.environ.get("VERCEL"):
        return False
    try:
        return bool((await _telegram_address_session(chat_id)).get("confirmed"))
    except Exception:
        log.warning("Could not read Telegram address session", exc_info=True)
        return False


async def _awaiting_address_input(
    chat_id: int,
    context: ContextTypes.DEFAULT_TYPE,
) -> bool:
    if context.user_data.get("awaiting_tokko_address"):
        return True
    if not os.environ.get("VERCEL"):
        return False
    try:
        return bool((await _telegram_address_session(chat_id)).get("awaitingAddress"))
    except Exception:
        log.warning("Could not read durable Telegram address input state", exc_info=True)
        return False


async def _pending_address_country(
    chat_id: int,
    context: ContextTypes.DEFAULT_TYPE,
) -> str:
    local = str(context.user_data.get("pending_address_country") or "").upper()
    if re.fullmatch(r"[A-Z]{2}", local):
        return local
    if not os.environ.get("VERCEL"):
        return "" if context.user_data.get("awaiting_tokko_address") else "IN"
    try:
        session = await _telegram_address_session(chat_id)
        country = str(session.get("pendingCountryCode") or "").upper()
        if re.fullmatch(r"[A-Z]{2}", country):
            return country
        return "" if session.get("awaitingAddress") else "IN"
    except Exception:
        log.warning("Could not read durable Telegram address country", exc_info=True)
        return "IN"


async def _family_state(binding: dict) -> dict:
    base_url = _required_env("TOKKO_API_BASE_URL").rstrip("/")
    url = f"{base_url}/api/v1/onboarding/{binding['userId']}"
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.get(url, headers=_tokko_headers())
    if response.status_code >= 400:
        raise _api_error(response)
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError("Could not parse Tokko family state")
    return data


async def _call_hermes(
    chat_id: int,
    binding: dict,
    text: str = "",
    approval_token: str | None = None,
) -> dict:
    payload = {
        "telegramChatId": chat_id,
        "familyUserId": binding["userId"],
        "language": binding.get("responseLanguage") or "en-IN",
    }
    if text:
        payload["text"] = text
    if approval_token:
        payload["approvalToken"] = approval_token
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.post(
            _required_env("HERMES_ENDPOINT_URL"),
            json=payload,
            headers={**_tokko_headers(), "Content-Type": "application/json"},
        )
    if response.status_code >= 400:
        raise _api_error(response)
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get("message"), str):
        raise RuntimeError("Could not parse Hermes response: message is missing")
    return data


async def _retry_hermes_after_country_cart_clear(
    chat_id: int,
    binding: dict,
) -> dict:
    endpoint = _required_env("HERMES_ENDPOINT_URL").rstrip("/")
    endpoint = (
        f"{endpoint}/cart-country-retry"
        if endpoint.endswith("/hermes")
        else f"{endpoint}/cart-country-retry"
    )
    payload = {
        "telegramChatId": chat_id,
        "familyUserId": binding["userId"],
        "language": binding.get("responseLanguage") or "en-IN",
    }
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.post(
            endpoint,
            json=payload,
            headers={**_tokko_headers(), "Content-Type": "application/json"},
        )
    if response.status_code >= 400:
        raise _api_error(response)
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get("message"), str):
        raise RuntimeError("Could not parse the retried Hermes response")
    return data


async def _select_ucp_card(
    chat_id: int,
    binding: dict,
    token: str,
    bot_username: str | None = None,
) -> dict:
    endpoint = _required_env("HERMES_ENDPOINT_URL").rstrip("/")
    if endpoint.endswith("/hermes"):
        endpoint = f"{endpoint}/payment-choice"
    else:
        endpoint = f"{endpoint}/payment-choice"
    payload = {
        "telegramChatId": chat_id,
        "familyUserId": binding["userId"],
        "token": token,
    }
    if bot_username:
        payload["botUsername"] = bot_username
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.post(
            endpoint,
            json=payload,
            headers={**_tokko_headers(), "Content-Type": "application/json"},
        )
    if response.status_code >= 400:
        raise _api_error(response)
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError("Could not parse saved-card selection response")
    return data


async def _mandate_card_options(
    chat_id: int,
    binding: dict,
    amount: str,
    frequency: str,
    merchant_scope: str,
) -> dict:
    endpoint = _required_env("HERMES_ENDPOINT_URL").rstrip("/")
    endpoint = f"{endpoint}/mandate-options"
    payload = {
        "telegramChatId": chat_id,
        "familyUserId": binding["userId"],
        "amount": amount,
        "frequency": frequency,
        "merchantScope": merchant_scope,
    }
    async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
        response = await client.post(
            endpoint,
            json=payload,
            headers={**_tokko_headers(), "Content-Type": "application/json"},
        )
    if response.status_code >= 400:
        raise _api_error(response)
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError("Could not parse mandate card options")
    return data


async def _telegram_return_context(context: ContextTypes.DEFAULT_TYPE) -> dict:
    username = str(context.bot.username or os.environ.get("TELEGRAM_BOT_USERNAME") or "")
    username = username.strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,30}bot", username, re.IGNORECASE):
        me = await context.bot.get_me()
        username = str(me.username or "").strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,30}bot", username, re.IGNORECASE):
        raise RuntimeError("Telegram bot username is unavailable for the payment return link")
    return {
        "returnContext": {
            "channel": "telegram",
            "botUsername": username,
        }
    }


def _confirmation_answer(value: str) -> bool | None:
    normalized = re.sub(r"[^a-z]+", " ", str(value).lower()).strip()
    if normalized in {
        "yes", "y", "yes approve", "approve", "approved", "confirm",
        "confirmed", "go ahead", "okay", "ok", "sure", "do it",
        "yes i consent", "i consent", "agree",
    }:
        return True
    if normalized in {
        "no", "n", "decline", "cancel", "stop", "leave it", "no leave it", "do not",
        "dont", "don t", "no continue without zepto",
    }:
        return False
    return None


def _selected_checkbox(label: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(f"☑ {label}", callback_data="selection:done")]]
    )


def _address_button_label(address: dict, index: int, selected: bool = False) -> str:
    label = str(address.get("label") or f"Address {index + 1}").strip()
    country = str(address.get("countryCode") or "").strip().upper()
    country_label = f" [{country}]" if re.fullmatch(r"[A-Z]{2}", country) else ""
    return f"{'☑' if selected else '☐'} {index + 1}. {label}{country_label}"[:64]


def _address_selection_markup(
    addresses: list[dict], selected_address_id: str | None = None
) -> InlineKeyboardMarkup:
    rows = []
    for index, address in enumerate(addresses):
        address_id = str(address.get("id") or address.get("addressId") or "").strip()
        if not address_id:
            continue
        rows.append([
            InlineKeyboardButton(
                _address_button_label(
                    address,
                    index,
                    selected=address_id == str(selected_address_id or ""),
                ),
                callback_data=f"address:select:{address_id}",
            )
        ])
    rows.append([
        InlineKeyboardButton("＋ Add New Address", callback_data="address:add")
    ])
    return InlineKeyboardMarkup(
        rows
    )


def _address_country_markup() -> InlineKeyboardMarkup:
    rows = []
    for index in range(0, len(ADDRESS_COUNTRIES), 2):
        rows.append([
            InlineKeyboardButton(
                f"{name} [{code}]",
                callback_data=f"address:country:{code}",
            )
            for code, name in ADDRESS_COUNTRIES[index:index + 2]
        ])
    rows.append([
        InlineKeyboardButton("Other Country", callback_data="address:country:OTHER")
    ])
    return InlineKeyboardMarkup(rows)


def _address_list_text(addresses: list[dict]) -> str:
    rows = ["Choose a delivery address saved in Tokko:"]
    for index, address in enumerate(addresses, start=1):
        readable = str(address.get("formattedAddress") or "").strip()
        country = str(address.get("countryCode") or "").strip().upper()
        country_label = f"[{country}] " if re.fullmatch(r"[A-Z]{2}", country) else ""
        rows.append(f"{index}. {country_label}{readable or 'Saved Tokko address'}")
    return "\n\n".join(rows)


async def _offer_address_or_ready(
    update: Update,
    binding: dict,
    connected_message: str | None = None,
    selected_address_id: str | None = "",
) -> None:
    message = update.effective_message
    try:
        result = await _family_api(binding, "GET", "addresses")
        addresses = result.get("addresses") or []
        if not addresses:
            prefix = f"{connected_message}\n\n" if connected_message else ""
            await message.reply_text(
                f"{prefix}No delivery address is saved in Tokko yet. Add one to continue.",
                reply_markup=_address_selection_markup([]),
            )
            return
        prefix = f"{connected_message}\n\n" if connected_message else ""
        selected = result.get("selectedAddress") or {}
        marked_address_id = (
            str(selected.get("id") or selected.get("addressId") or "")
            if selected_address_id is None
            else str(selected_address_id or "")
        )
        await message.reply_text(
            prefix + _address_list_text(addresses),
            reply_markup=_address_selection_markup(
                addresses,
                marked_address_id,
            ),
        )
    except Exception as exc:
        log.exception("Could not load Tokko delivery addresses")
        await message.reply_text(
            f"Your Tokko account is connected, but I couldn't load Tokko addresses: {exc}. "
            "Send /start to retry.",
            reply_markup=MAIN_KEYBOARD,
        )


def _text(update: Update) -> str:
    return str(update.message.text or "").strip()


def _parse_tokko_address_text(
    value: str,
    default_country: str = "IN",
) -> tuple[str, str, str]:
    supplied = re.sub(r"^address\s*:\s*", "", str(value), flags=re.IGNORECASE).strip()
    parts = [part.strip() for part in supplied.split("|")]
    if len(parts) >= 3 and re.fullmatch(r"[A-Za-z]{2}", parts[1]):
        return parts[0], parts[1].upper(), " | ".join(parts[2:]).strip()
    if len(parts) >= 2:
        return parts[0], default_country, " | ".join(parts[1:]).strip()
    return "Home", default_country, supplied


def _mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    return f"••••{digits[-4:]}" if len(digits) >= 4 else "selected number"


async def _keep_typing(bot, chat_id: int) -> None:
    try:
        while True:
            await bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)
            await asyncio.sleep(4)
    except asyncio.CancelledError:
        pass


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    chat_id = update.effective_chat.id
    try:
        await context.bot.set_my_commands(BOT_COMMANDS)
    except Exception:
        log.warning("Could not refresh Telegram command menu", exc_info=True)
    binding = await get_family_binding(chat_id)
    return_payload = context.args[0] if context.args else ""
    mandate_callback_match = re.fullmatch(r"pmr_([0-9a-fA-F]{32})", return_payload)
    card_callback_match = re.fullmatch(r"pcr_([0-9a-fA-F]{32})", return_payload)
    if binding is not None and (
        return_payload in {
        "payments_card_return",
        "payments_mandate_return",
        }
        or mandate_callback_match is not None
        or card_callback_match is not None
    ):
        try:
            if card_callback_match is not None:
                compact = card_callback_match.group(1).lower()
                order_id = (
                    f"{compact[:8]}-{compact[8:12]}-{compact[12:16]}-"
                    f"{compact[16:20]}-{compact[20:]}"
                )
                result = await _family_api(
                    binding,
                    "POST",
                    f"merchants/ucp/orders/{order_id}/payment/continue",
                    {},
                )
                credential = result.get("sandboxPaymentCredential") or {}
                token = str(credential.get("token") or "").strip()
                if result.get("tokenIssued") and token:
                    message = (
                        "You're back from Prava. The saved-card payment-result API "
                        "returned this single-use sandbox token:\n\n"
                        f"{token}\n"
                        f"Transaction: {credential.get('transactionId') or 'pending'}\n"
                        "This temporary virtual PAN is displayed for testing and is not stored by Tokko."
                    )
                elif result.get("tokenIssued"):
                    message = (
                        "You're back from Prava. The saved-card payment was approved "
                        "and Tokko stored only the one-time credential fingerprint."
                    )
                else:
                    message = (
                        "You're back from Prava, but the saved-card payment result is "
                        f"still {result.get('pravaStatus') or 'pending'}. Use Continue Payment again in a moment."
                    )
            elif return_payload == "payments_card_return":
                try:
                    mandate_result = await _call_hermes(
                        chat_id,
                        binding,
                        text="/start payments_card_return",
                    )
                except TokkoAPIError as exc:
                    if exc.status_code not in {404, 410}:
                        raise
                    mandate_result = None
                if mandate_result is not None:
                    await _send_hermes_result(update, mandate_result, binding)
                    await update.message.reply_text(
                        "You are back in the same shopping conversation.",
                        reply_markup=MAIN_KEYBOARD,
                    )
                    return ConversationHandler.END
                result = await _family_api(binding, "GET", "payment-methods")
                message = (
                    "You're back from Prava.\n\n"
                    + _saved_cards_text(result.get("paymentMethods") or [])
                )
            elif mandate_callback_match is not None:
                compact = mandate_callback_match.group(1).lower()
                callback_id = (
                    f"{compact[:8]}-{compact[8:12]}-{compact[12:16]}-"
                    f"{compact[16:20]}-{compact[20:]}"
                )
                result = await _family_api(
                    binding,
                    "POST",
                    "payment/mandates/callback/complete",
                    {"callbackId": callback_id},
                )
                credential = result.get("sandboxPaymentCredential") or {}
                token = str(credential.get("token") or "").strip()
                message = (
                    "You're back from Prava. The mandate is active, and Tokko "
                    f"called the mandate Charge API for {result.get('currency')} "
                    f"{result.get('chargeAmount')}.\n\n"
                    "Prava sandbox token:\n"
                    f"{token}\n"
                    f"Transaction: {credential.get('transactionId') or 'pending'}\n"
                    "This single-use virtual PAN is shown for testing. Tokko stored only its fingerprint."
                )
            else:
                result = await _family_api(binding, "GET", "payment/mandates")
                message = (
                    "You're back from Prava.\n\n"
                    + _mandates_text(
                        result.get("mandates") or [],
                        total_count=result.get("totalCount"),
                        has_more=bool(result.get("hasMore")),
                    )
                )
        except Exception as exc:
            log.exception("Could not refresh Prava data after Telegram return")
            message = (
                "You're back from Prava. I couldn't refresh the result yet: "
                f"{exc}. Choose Refresh Saved Cards or View Mandates to retry."
            )
        await update.message.reply_text(
            f"{message}\n\nYou are back in the same shopping conversation. Tell me what you need next.",
            reply_markup=MAIN_KEYBOARD,
        )
        return ConversationHandler.END
    context.user_data.pop("onboarding", None)
    context.user_data.pop("awaiting_tokko_address", None)
    context.user_data["delivery_address_confirmed"] = False
    if binding is not None:
        if os.environ.get("VERCEL"):
            try:
                await _telegram_address_session(chat_id, "POST", {"reset": True})
            except Exception:
                log.warning("Could not reset Telegram address session", exc_info=True)
        await _offer_address_or_ready(
            update,
            binding,
            "You're connected to Tokko.",
        )
        return ConversationHandler.END
    await update.message.reply_text(
        "Hi, I'm Tokko. Share your own phone number so I can find your family account. "
        "If you're new, I'll open Tokko's onboarding flow.",
        reply_markup=CONTACT_KEYBOARD,
    )
    return WAIT_CONTACT


async def ask_for_contact(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.message.reply_text(
        "Please use the Share My Phone Number button to continue.",
        reply_markup=CONTACT_KEYBOARD,
    )
    return WAIT_CONTACT


async def handle_contact(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    chat_id = update.effective_chat.id
    contact = update.message.contact
    if contact.user_id and contact.user_id != update.effective_user.id:
        await update.message.reply_text(
            "Please share your own phone number, not someone else's contact.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return WAIT_CONTACT
    try:
        phone = _normalize_phone(contact.phone_number)
    except ValueError as exc:
        await update.message.reply_text(str(exc), reply_markup=CONTACT_KEYBOARD)
        return WAIT_CONTACT
    try:
        binding = await _lookup_family(phone)
    except TokkoAPIError as exc:
        if exc.status_code != 404:
            log.exception("Tokko lookup failed")
            await update.message.reply_text(
                f"I couldn't check Tokko right now: {exc}. Please try sharing your number again.",
                reply_markup=CONTACT_KEYBOARD,
            )
            return WAIT_CONTACT
        binding = None
    except Exception as exc:
        log.exception("Tokko lookup failed")
        await update.message.reply_text(
            f"I couldn't check Tokko right now: {exc}. Please try again.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return WAIT_CONTACT

    if binding and binding["profileComplete"]:
        await set_family_binding(chat_id, binding)
        if os.environ.get("VERCEL"):
            await _telegram_address_session(chat_id, "POST", {"reset": True})
        await _offer_address_or_ready(
            update,
            binding,
            "Found your family account. You're connected to Tokko.",
        )
        return ConversationHandler.END

    context.user_data.pop("onboarding", None)
    await update.message.reply_text(
        "I couldn't find a completed Tokko family for this number. Complete onboarding "
        "on Tokko, then return here and send /start to connect your new account.",
        reply_markup=NEW_ONBOARDING_KEYBOARD,
    )
    return ConversationHandler.END


async def onboarding_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = _text(update)
    if len(name) < 2 or len(name) > 200:
        await update.message.reply_text("Please enter your full name.")
        return ONBOARD_NAME
    context.user_data["onboarding"]["primaryParentName"] = name
    await update.message.reply_text(
        "What email should be linked to this family? Prava requires it for secure card and mandate setup.",
        reply_markup=ReplyKeyboardRemove(),
    )
    return ONBOARD_EMAIL


async def onboarding_email(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    value = _text(update)
    if len(value) > 320 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        await update.message.reply_text(
            "Enter a valid email address. It is required for Prava payment setup."
        )
        return ONBOARD_EMAIL
    context.user_data["onboarding"]["accountEmail"] = value.lower()
    await update.message.reply_text(
        "Age and gender are optional. They help Trakko avoid irrelevant questions and "
        "unsuitable wellness suggestions, and they are not sent to merchants during checkout.\n\n"
        "What is your age? Send a whole number from 0 to 120, or choose Skip.",
        reply_markup=OPTIONAL_AGE_KEYBOARD,
    )
    return ONBOARD_AGE


async def onboarding_age(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    value = _text(update)
    if value.lower() != "skip":
        if not value.isdigit() or not 0 <= int(value) <= 120:
            await update.message.reply_text(
                "Send a whole number from 0 to 120, or choose Skip.",
                reply_markup=OPTIONAL_AGE_KEYBOARD,
            )
            return ONBOARD_AGE
        context.user_data["onboarding"]["primaryParentAge"] = int(value)
    await update.message.reply_text(
        "How should Trakko understand your gender? You can choose Prefer not to say.",
        reply_markup=GENDER_KEYBOARD,
    )
    return ONBOARD_GENDER


async def _ask_first_dependent(update: Update) -> int:
    await update.effective_message.reply_text(
        "Would you like to add a dependent? This is optional, and you can add family members later.",
        reply_markup=FIRST_DEPENDENT_CHECKBOX,
    )
    return ADD_FIRST_DEPENDENT


async def onboarding_gender(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    value = _text(update)
    known = {"woman": "Woman", "man": "Man", "non-binary": "Non-binary"}
    if value.lower() == "prefer not to say":
        return await _ask_first_dependent(update)
    if value.lower() == "self-described":
        await update.message.reply_text(
            "Tell me how you would like this recorded, in 40 characters or fewer.",
            reply_markup=ReplyKeyboardRemove(),
        )
        return ONBOARD_GENDER_DESCRIPTION
    if value.lower() not in known:
        await update.message.reply_text(
            "Choose one of the options, including Prefer not to say.",
            reply_markup=GENDER_KEYBOARD,
        )
        return ONBOARD_GENDER
    context.user_data["onboarding"]["primaryParentGender"] = known[value.lower()]
    return await _ask_first_dependent(update)


async def onboarding_gender_description(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    value = _text(update)
    if not value or len(value) > 40:
        await update.message.reply_text("Enter a description of 40 characters or fewer.")
        return ONBOARD_GENDER_DESCRIPTION
    context.user_data["onboarding"]["primaryParentGender"] = value
    return await _ask_first_dependent(update)


async def add_first_dependent(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    answer = _confirmation_answer(_text(update))
    if answer is None:
        await update.message.reply_text(
            "Choose Add Dependent or Skip.", reply_markup=FIRST_DEPENDENT_CHECKBOX
        )
        return ADD_FIRST_DEPENDENT
    if not answer:
        return await _ask_merchant_phone(update, context)
    await update.message.reply_text(
        "What is the family member's name?", reply_markup=ReplyKeyboardRemove()
    )
    return DEPENDENT_NAME


async def add_first_dependent_checked(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    query = update.callback_query
    await query.answer()
    answer = query.data.rsplit(":", 1)[-1] == "yes"
    await query.edit_message_reply_markup(
        reply_markup=_selected_checkbox("Add Dependent" if answer else "Skip")
    )
    if not answer:
        return await _ask_merchant_phone(update, context)
    await query.message.reply_text(
        "What is the family member's name?", reply_markup=ReplyKeyboardRemove()
    )
    return DEPENDENT_NAME


async def dependent_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = _text(update)
    if len(name) < 1 or len(name) > 200:
        await update.message.reply_text("Please enter the family member's name.")
        return DEPENDENT_NAME
    context.user_data["onboarding"]["pendingDependent"] = {"name": name}
    await update.message.reply_text(
        "What is their phone number? Include the country code, for example +919876543210. "
        "For Indian numbers, a 10-digit number also works."
    )
    return DEPENDENT_PHONE


async def dependent_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    draft = context.user_data["onboarding"]
    try:
        phone = _normalize_dependent_phone(_text(update), draft["primaryParentPhone"])
    except ValueError as exc:
        await update.message.reply_text(str(exc))
        return DEPENDENT_PHONE
    used = {draft["primaryParentPhone"]} | {
        dependent["phone"] for dependent in draft["dependents"]
    }
    if phone in used:
        await update.message.reply_text(
            "That number is already in this family. Enter a different phone number."
        )
        return DEPENDENT_PHONE
    draft["pendingDependent"]["phone"] = phone
    await update.message.reply_text(
        "What is their relationship to you?",
        reply_markup=RELATIONSHIP_KEYBOARD,
    )
    return DEPENDENT_RELATIONSHIP


async def _ask_dependent_age(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    relationship: str,
) -> int:
    draft = context.user_data["onboarding"]
    draft["pendingDependent"]["relationshipToUser"] = relationship
    await update.effective_message.reply_text(
        "Their age is optional and helps Trakko avoid irrelevant wellness questions. "
        "Send a whole number from 0 to 120, or choose Skip.",
        reply_markup=OPTIONAL_AGE_KEYBOARD,
    )
    return DEPENDENT_AGE


async def _save_dependent(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    draft = context.user_data["onboarding"]
    dependent = draft.pop("pendingDependent")
    draft["dependents"].append(dependent)
    await update.message.reply_text(
        "Add another family member?",
        reply_markup=YES_NO_CHECKBOX,
    )
    return ADD_ANOTHER_DEPENDENT


async def dependent_age(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    value = _text(update)
    if value.lower() != "skip":
        if not value.isdigit() or not 0 <= int(value) <= 120:
            await update.message.reply_text(
                "Send a whole number from 0 to 120, or choose Skip.",
                reply_markup=OPTIONAL_AGE_KEYBOARD,
            )
            return DEPENDENT_AGE
        context.user_data["onboarding"]["pendingDependent"]["age"] = int(value)
    await update.message.reply_text(
        "How should Trakko understand their gender? You can choose Prefer not to say.",
        reply_markup=GENDER_KEYBOARD,
    )
    return DEPENDENT_GENDER


async def dependent_gender(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    value = _text(update)
    known = {"woman": "Woman", "man": "Man", "non-binary": "Non-binary"}
    if value.lower() == "prefer not to say":
        return await _save_dependent(update, context)
    if value.lower() == "self-described":
        await update.message.reply_text(
            "Tell me how they would like this recorded, in 40 characters or fewer.",
            reply_markup=ReplyKeyboardRemove(),
        )
        return DEPENDENT_GENDER_DESCRIPTION
    if value.lower() not in known:
        await update.message.reply_text(
            "Choose one of the options, including Prefer not to say.",
            reply_markup=GENDER_KEYBOARD,
        )
        return DEPENDENT_GENDER
    context.user_data["onboarding"]["pendingDependent"]["gender"] = known[
        value.lower()
    ]
    return await _save_dependent(update, context)


async def dependent_gender_description(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    value = _text(update)
    if not value or len(value) > 40:
        await update.message.reply_text("Enter a description of 40 characters or fewer.")
        return DEPENDENT_GENDER_DESCRIPTION
    context.user_data["onboarding"]["pendingDependent"]["gender"] = value
    return await _save_dependent(update, context)


async def dependent_relationship(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    relationship = _text(update)
    known = {"mother", "father", "son", "daughter", "brother", "sister", "spouse"}
    if relationship.lower() == "other":
        await update.message.reply_text(
            "Please describe the relationship, for example aunt, grandfather, or guardian.",
            reply_markup=ReplyKeyboardRemove(),
        )
        return DEPENDENT_OTHER_RELATIONSHIP
    if relationship.lower() not in known:
        await update.message.reply_text(
            "Choose a relationship from the buttons, or choose Other.",
            reply_markup=RELATIONSHIP_KEYBOARD,
        )
        return DEPENDENT_RELATIONSHIP
    return await _ask_dependent_age(update, context, relationship.title())


async def dependent_other_relationship(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    relationship = _text(update)
    if not relationship or len(relationship) > 80:
        await update.message.reply_text("Enter a relationship of 80 characters or fewer.")
        return DEPENDENT_OTHER_RELATIONSHIP
    return await _ask_dependent_age(update, context, relationship)


async def add_another_dependent(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    answer = _confirmation_answer(_text(update))
    if answer is True:
        if len(context.user_data["onboarding"]["dependents"]) >= 20:
            await update.message.reply_text("A family can contain at most 20 members.")
        else:
            await update.message.reply_text(
                "What is the next family member's name?",
                reply_markup=ReplyKeyboardRemove(),
            )
            return DEPENDENT_NAME
    elif answer is not False:
        await update.message.reply_text(
            "Please choose Yes or No.", reply_markup=YES_NO_CHECKBOX
        )
        return ADD_ANOTHER_DEPENDENT
    return await _ask_merchant_phone(update, context)


async def add_another_dependent_checked(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    query = update.callback_query
    await query.answer()
    answer = query.data.rsplit(":", 1)[-1] == "yes"
    await query.edit_message_reply_markup(
        reply_markup=_selected_checkbox("Yes" if answer else "No")
    )
    if answer and len(context.user_data["onboarding"]["dependents"]) < 20:
        await query.message.reply_text(
            "What is the next family member's name?",
            reply_markup=ReplyKeyboardRemove(),
        )
        return DEPENDENT_NAME
    if answer:
        await query.message.reply_text("A family can contain at most 20 members.")
    return await _ask_merchant_phone(update, context)


async def _ask_merchant_phone(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    draft = context.user_data["onboarding"]
    owner_supported = draft["primaryParentPhone"].startswith("+91")
    choices = {
        f"My Number ({_mask_phone(draft['primaryParentPhone'])})"
        f"{'' if owner_supported else ' · Zepto unsupported'}": {
            "phone": draft["primaryParentPhone"],
            "subjectType": "account_holder",
        }
    }
    for index, dependent in enumerate(draft["dependents"], start=1):
        supported = dependent["phone"].startswith("+91")
        label = (
            f"{index}. {dependent['name'][:24]} ({_mask_phone(dependent['phone'])})"
            f"{'' if supported else ' · Zepto unsupported'}"
        )
        choices[label] = {
            "phone": dependent["phone"],
            "subjectType": "dependent",
        }
    choices["Continue without Zepto"] = {"skip": True}
    draft["merchantPhoneChoices"] = choices
    keyboard = ReplyKeyboardMarkup(
        [[label] for label in choices], resize_keyboard=True, one_time_keyboard=True
    )
    await update.effective_message.reply_text(
        "Which phone number should Tokko use to authenticate with Zepto? "
        "Zepto currently supports Indian +91 mobile numbers only.",
        reply_markup=keyboard,
    )
    return SELECT_MERCHANT_PHONE


async def select_merchant_phone(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    draft = context.user_data["onboarding"]
    selected = draft.get("merchantPhoneChoices", {}).get(_text(update))
    if not selected:
        return await _ask_merchant_phone(update, context)
    if selected.get("skip"):
        draft["merchantAuthPhone"] = draft["primaryParentPhone"]
        draft["merchantAuthSubjectType"] = "account_holder"
        return await _complete_onboarding(update, context, False)
    if not selected["phone"].startswith("+91"):
        await update.message.reply_text(
            "That number cannot connect to Zepto. Zepto currently supports Indian +91 mobile numbers only. "
            "Choose an Indian number or Continue without Zepto."
        )
        return await _ask_merchant_phone(update, context)
    draft["merchantAuthPhone"] = selected["phone"]
    draft["merchantAuthSubjectType"] = selected["subjectType"]
    await update.message.reply_text(
        "Consent: Tokko will use the selected phone number only to authenticate with Zepto. "
        "You can revoke this consent later. Do you consent?",
        reply_markup=CONSENT_CHECKBOX,
    )
    return CONFIRM_MERCHANT_CONSENT


async def _complete_onboarding(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    consented: bool,
) -> int:
    message = update.effective_message
    draft = context.user_data["onboarding"]
    payload = {
        "primaryParentName": draft["primaryParentName"],
        "primaryParentPhone": draft["primaryParentPhone"],
        "dependents": draft["dependents"],
        "merchantAuthPhone": draft["merchantAuthPhone"],
        "merchantAuthSubjectType": draft["merchantAuthSubjectType"],
        "consent": {"useSelectedPhoneForMerchantAuth": consented},
    }
    if draft.get("primaryParentAge") is not None:
        payload["primaryParentAge"] = draft["primaryParentAge"]
    if draft.get("primaryParentGender"):
        payload["primaryParentGender"] = draft["primaryParentGender"]
    if draft.get("accountEmail"):
        payload["accountEmail"] = draft["accountEmail"]
    try:
        binding = await _create_family(payload)
    except Exception as exc:
        log.exception("Tokko onboarding failed")
        await message.reply_text(
            f"I couldn't finish onboarding: {exc}. Choose your consent again to retry, "
            "or use /cancel and /start to begin again.",
            reply_markup=CONSENT_CHECKBOX,
        )
        return CONFIRM_MERCHANT_CONSENT

    await set_family_binding(update.effective_chat.id, binding)
    context.user_data.pop("onboarding", None)
    context.user_data["delivery_address_confirmed"] = False
    if os.environ.get("VERCEL"):
        await _telegram_address_session(
            update.effective_chat.id,
            "POST",
            {"reset": True},
        )
    await _offer_address_or_ready(
        update,
        binding,
        "Your Tokko family is ready."
        + ("" if consented else " Merchant access remains disabled."),
    )
    return ConversationHandler.END


async def confirm_merchant_consent(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    consented = _confirmation_answer(_text(update))
    if consented is None:
        await update.message.reply_text(
            "Please choose one of the consent options.",
            reply_markup=CONSENT_CHECKBOX,
        )
        return CONFIRM_MERCHANT_CONSENT
    return await _complete_onboarding(update, context, consented)


async def confirm_merchant_consent_checked(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    query = update.callback_query
    await query.answer()
    consented = query.data.rsplit(":", 1)[-1] == "yes"
    label = "Yes, I Consent" if consented else "No, Continue Without Zepto"
    await query.edit_message_reply_markup(reply_markup=_selected_checkbox(label))
    return await _complete_onboarding(update, context, consented)


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.pop("onboarding", None)
    await update.message.reply_text(
        "Onboarding cancelled. Send /start whenever you're ready.",
        reply_markup=ReplyKeyboardRemove(),
    )
    return ConversationHandler.END


def _saved_cards_text(cards: list) -> str:
    if not cards:
        return "No tokenized Prava cards are saved yet. Choose Add Card to create one."
    rows = [f"Saved Prava cards: {len(cards)}"]
    for index, card in enumerate(cards, start=1):
        brand = str(card.get("brand") or "card").upper()
        last4 = str(card.get("last4") or "••••")
        expiry = f"{card.get('expMonth')}/{card.get('expYear')}"
        default = ", default" if card.get("isDefault") else ""
        rows.append(f"{index}. {brand} •••• {last4}, expires {expiry}{default}")
    return "\n".join(rows)


def _mandates_text(
    mandates: list,
    *,
    total_count=None,
    has_more: bool = False,
    history: bool = False,
) -> str:
    visible = list(mandates) if history else list(mandates)[:5]
    if history and not visible:
        return "No Prava mandate activity was found in the last 30 days."
    if not visible:
        return "No Prava mandates are available. Choose Create Mandate to add one."
    heading = (
        f"Prava mandate history, last 30 days: {len(visible)}"
        if history
        else f"Top Prava mandates: {len(visible)}"
    )
    rows = [heading]
    for index, mandate in enumerate(visible, start=1):
        status = str(mandate.get("status") or "pending").lower()
        frequency = str(mandate.get("frequency") or "one_time").replace("_", " ")
        currency = str(mandate.get("currency") or "INR")
        approved = str(mandate.get("approvedAmount") or "0")
        remaining = str(mandate.get("remaining") or approved)
        merchant = (
            "Any merchant"
            if str(mandate.get("merchantScope") or "").lower() == "any"
            else str(mandate.get("merchantName") or "Listed merchant")
        )
        rows.append(
            f"{index}. {status}, {merchant}, {currency} {remaining} remaining "
            f"of {approved} per charge, {frequency}"
        )
        if history:
            last_charge = mandate.get("lastCharge") or {}
            activity_at = (
                mandate.get("updatedAt")
                or mandate.get("createdAt")
                or last_charge.get("at")
                or last_charge.get("createdAt")
            )
            if activity_at:
                rows.append(f"   activity: {str(activity_at)[:10]}")
    if not history:
        try:
            available_total = max(len(visible), int(total_count))
        except (TypeError, ValueError):
            available_total = len(visible)
        if has_more or available_total > len(visible):
            rows.append(
                f"\nShowing {len(visible)} of {available_total}. "
                "Choose Show All (30 Days) for one-month history."
            )
    return "\n".join(rows)


async def payments_entry(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await update.message.reply_text(
            "Please send /start and finish family onboarding first.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return ConversationHandler.END
    context.user_data.pop("payment_setup", None)
    await update.message.reply_text(
        "Manage your family's Prava cards and mandates. Card details are collected only on Prava's hosted page.",
        reply_markup=PAYMENT_MENU_KEYBOARD,
    )
    return PAYMENT_MENU_STATE


async def _show_payment_menu(update: Update, message: str) -> int:
    chunks = []
    remainder = str(message or "")
    while len(remainder) > 3800:
        split_at = remainder.rfind("\n", 0, 3800)
        if split_at < 1:
            split_at = 3800
        chunks.append(remainder[:split_at])
        remainder = remainder[split_at:].lstrip("\n")
    chunks.append(remainder or "No mandate records were returned.")
    for index, chunk in enumerate(chunks):
        reply_markup = PAYMENT_MENU_KEYBOARD if index == len(chunks) - 1 else None
        await update.message.reply_text(chunk, reply_markup=reply_markup)
    return PAYMENT_MENU_STATE


async def payment_menu_action(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    action = _text(update)
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        return await payments_entry(update, context)
    if action == "Back to Shopping":
        context.user_data.pop("payment_setup", None)
        await update.message.reply_text(
            "Back to shopping. Tell me what you need.", reply_markup=MAIN_KEYBOARD
        )
        return ConversationHandler.END
    if action == "Add Card":
        try:
            return_context = await _telegram_return_context(context)
            session = await _family_api(
                binding,
                "POST",
                "payment/tokenization-session",
                return_context,
            )
            approval_url = str(session.get("approvalUrl") or "")
            if not approval_url.startswith("https://"):
                raise RuntimeError("Prava did not return a secure hosted-card URL")
            return await _show_payment_menu(
                update,
                "Open this secure Prava page to enter the card, complete OTP, and approve the passkey:\n"
                f"{approval_url}\n\nWhen finished, return here and choose Refresh Saved Cards.",
            )
        except Exception as exc:
            log.exception("Prava card setup failed")
            return await _show_payment_menu(update, f"I couldn't start card setup: {exc}")
    if action == "Refresh Saved Cards":
        try:
            result = await _family_api(binding, "GET", "payment-methods")
            return await _show_payment_menu(
                update, _saved_cards_text(result.get("paymentMethods") or [])
            )
        except Exception as exc:
            log.exception("Prava card list failed")
            return await _show_payment_menu(update, f"I couldn't refresh saved cards: {exc}")
    if action == "View Mandates":
        try:
            result = await _family_api(binding, "GET", "payment/mandates")
            return await _show_payment_menu(
                update,
                _mandates_text(
                    result.get("mandates") or [],
                    total_count=result.get("totalCount"),
                    has_more=bool(result.get("hasMore")),
                ),
            )
        except Exception as exc:
            log.exception("Prava mandate list failed")
            return await _show_payment_menu(update, f"I couldn't list mandates: {exc}")
    if action == "Show All (30 Days)":
        try:
            result = await _family_api(
                binding, "GET", "payment/mandates?view=history&days=30"
            )
            return await _show_payment_menu(
                update,
                _mandates_text(result.get("mandates") or [], history=True),
            )
        except Exception as exc:
            log.exception("Prava mandate history failed")
            return await _show_payment_menu(
                update, f"I couldn't load the last 30 days of mandate history: {exc}"
            )
    if action == "Create Mandate":
        await update.message.reply_text(
            "Choose the maximum amount for each charge. For a custom amount, send a message such as “create a ₹750 any-merchant mandate”.",
            reply_markup=MANDATE_AMOUNT_INLINE_KEYBOARD,
        )
        return ConversationHandler.END
    return await _show_payment_menu(update, "Choose a payment option from the buttons.")


async def mandate_card_selected(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    if _text(update) == "Back to Payments":
        return await _show_payment_menu(update, "Mandate setup cancelled.")
    setup = context.user_data.get("payment_setup") or {}
    payment_method_id = setup.get("cardChoices", {}).get(_text(update))
    if not payment_method_id:
        await update.message.reply_text("Choose one of the saved cards shown above.")
        return MANDATE_CARD_STATE
    if payment_method_id == "__add_card__":
        setup["addNewCard"] = True
        setup.pop("paymentMethodId", None)
    else:
        setup["paymentMethodId"] = payment_method_id
        setup.pop("addNewCard", None)
    context.user_data["payment_setup"] = setup
    await update.message.reply_text(
        "Choose the maximum amount Prava may authorize for each Zepto charge. "
        "This is a spending cap, not prepaid balance.",
        reply_markup=MANDATE_AMOUNT_KEYBOARD,
    )
    return MANDATE_AMOUNT_STATE


def _valid_mandate_amount(value: str) -> str | None:
    normalized = value.strip().replace("₹", "").replace(",", "")
    if not re.fullmatch(r"\d+(?:\.\d{1,2})?", normalized):
        return None
    amount = float(normalized)
    if amount <= 0 or amount > 1_000_000:
        return None
    return f"{amount:.2f}"


async def mandate_amount_selected(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    value = _text(update)
    if value == "Back to Payments":
        return await _show_payment_menu(update, "Mandate setup cancelled.")
    if value == "Custom Amount":
        await update.message.reply_text(
            "Enter the per-charge limit in rupees, for example 250 or 750.50.",
            reply_markup=ReplyKeyboardRemove(),
        )
        return MANDATE_CUSTOM_AMOUNT_STATE
    amount = _valid_mandate_amount(value)
    if not amount:
        await update.message.reply_text(
            "Choose one of the displayed amounts or Custom Amount.",
            reply_markup=MANDATE_AMOUNT_KEYBOARD,
        )
        return MANDATE_AMOUNT_STATE
    context.user_data["payment_setup"]["amount"] = amount
    return await _ask_mandate_frequency(update)


async def mandate_custom_amount(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    amount = _valid_mandate_amount(_text(update))
    if not amount:
        await update.message.reply_text(
            "Enter a positive rupee amount with no more than two decimal places."
        )
        return MANDATE_CUSTOM_AMOUNT_STATE
    context.user_data["payment_setup"]["amount"] = amount
    return await _ask_mandate_frequency(update)


async def _ask_mandate_frequency(update: Update) -> int:
    await update.message.reply_text(
        "How often should this authorization cycle renew?",
        reply_markup=MANDATE_FREQUENCY_KEYBOARD,
    )
    return MANDATE_FREQUENCY_STATE


async def mandate_frequency_selected(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> int:
    value = _text(update)
    if value == "Back to Payments":
        return await _show_payment_menu(update, "Mandate setup cancelled.")
    if value == "One-Time (Any Merchant)":
        frequency = "one_time"
        merchant_scope = "any"
    else:
        frequency = value.lower()
        merchant_scope = "listed"
    if frequency not in {"one_time", "weekly", "monthly", "yearly"}:
        await update.message.reply_text(
            "Choose One-Time (Any Merchant), Weekly, Monthly, or Yearly.",
            reply_markup=MANDATE_FREQUENCY_KEYBOARD,
        )
        return MANDATE_FREQUENCY_STATE
    binding = await get_family_binding(update.effective_chat.id)
    setup = context.user_data.get("payment_setup") or {}
    try:
        return_context = await _telegram_return_context(context)
        if setup.get("addNewCard"):
            options = await _mandate_card_options(
                update.effective_chat.id,
                binding,
                setup["amount"],
                frequency,
                merchant_scope,
            )
            add_card = next(
                (
                    choice
                    for choice in options.get("cardChoices") or []
                    if choice.get("type") == "add_card" and choice.get("token")
                ),
                None,
            )
            if add_card is None:
                raise RuntimeError("Tokko did not return an add-card option")
            session = await _select_ucp_card(
                update.effective_chat.id,
                binding,
                add_card["token"],
                return_context["returnContext"]["botUsername"],
            )
            context.user_data.pop("payment_setup", None)
            await _send_hermes_result(update, session, binding)
            await update.message.reply_text(
                "After saving the card, return here and Tokko will automatically prepare the mandate approval.",
                reply_markup=PAYMENT_MENU_KEYBOARD,
            )
            return PAYMENT_MENU_STATE
        session = await _family_api(
            binding,
            "POST",
            "payment/mandates/session",
            {
                "paymentMethodId": setup["paymentMethodId"],
                "amount": setup["amount"],
                "frequency": frequency,
                "merchantScope": merchant_scope,
                **return_context,
            },
        )
        approval_url = str(session.get("approvalUrl") or "")
        if not approval_url.startswith("https://"):
            raise RuntimeError("Prava did not return a secure mandate approval URL")
        context.user_data.pop("payment_setup", None)
        return await _show_payment_menu(
            update,
            f"Approve the {frequency.replace('_', ' ')} mandate with a ₹{setup['amount']} per-charge cap here:\n"
            f"{approval_url}\n\nCreating the mandate does not deduct money. After approval, "
            "Prava returns to this chat and Tokko automatically requests a ₹1 sandbox token.",
        )
    except Exception as exc:
        log.exception("Prava mandate setup failed")
        return await _show_payment_menu(update, f"I couldn't create the mandate session: {exc}")


async def payment_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.pop("payment_setup", None)
    await update.message.reply_text(
        "Payment setup closed. Back to shopping.", reply_markup=MAIN_KEYBOARD
    )
    return ConversationHandler.END


async def select_mandate_amount(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    query = update.callback_query
    amount = query.data.split(":", 1)[1]
    await query.answer("Amount selected")
    await query.edit_message_text(
        f"₹{amount} per charge. Choose the mandate frequency and merchant scope:",
        reply_markup=_mandate_frequency_inline_keyboard(amount),
    )


async def prepare_mandate_card_choices(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    query = update.callback_query
    _, amount, frequency_code, scope_code = query.data.split(":", 3)
    frequency = {
        "o": "one_time",
        "w": "weekly",
        "m": "monthly",
        "y": "yearly",
    }[frequency_code]
    merchant_scope = {"a": "any", "l": "listed"}[scope_code]
    await query.answer("Loading saved cards...")
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await query.message.reply_text(
            "Please send /start and connect your Tokko family again.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    try:
        result = await _mandate_card_options(
            update.effective_chat.id,
            binding,
            amount,
            frequency,
            merchant_scope,
        )
        await query.edit_message_reply_markup(reply_markup=None)
        await _send_hermes_result(update, result, binding)
    except Exception as exc:
        log.exception("Could not prepare mandate card choices")
        await query.message.reply_text(f"I couldn't prepare the mandate: {exc}")


async def select_mandate_card_choice(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    _, amount, frequency_code, scope_code, choice_key = query.data.split(":", 4)
    frequency = {
        "o": "one_time",
        "w": "weekly",
        "m": "monthly",
        "y": "yearly",
    }[frequency_code]
    merchant_scope = {"a": "any", "l": "listed"}[scope_code]
    await query.answer("Applying card choice...")
    chat_id = update.effective_chat.id
    binding = await get_family_binding(chat_id)
    if binding is None:
        await query.message.reply_text(
            "Please send /start and connect your Tokko family again.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    try:
        options = await _mandate_card_options(
            chat_id,
            binding,
            amount,
            frequency,
            merchant_scope,
        )
        choice = next(
            (
                item
                for item in options.get("cardChoices") or []
                if (
                    choice_key == "new" and item.get("type") == "add_card"
                ) or (
                    choice_key != "new"
                    and item.get("type") != "add_card"
                    and str(item.get("id")) == choice_key
                )
            ),
            None,
        )
        if choice is None or not choice.get("token"):
            raise RuntimeError("That card choice is no longer available")
        return_context = await _telegram_return_context(context)
        result = await _select_ucp_card(
            chat_id,
            binding,
            choice["token"],
            return_context["returnContext"]["botUsername"],
        )
        await query.edit_message_reply_markup(
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    _card_choice_label(choice, selected=True),
                    callback_data="selection:done",
                )
            ]])
        )
        await _send_hermes_result(update, result, binding)
    except Exception as exc:
        log.exception("Could not apply mandate card choice")
        await query.message.reply_text(f"I couldn't apply that card choice: {exc}")


async def _send_hermes_result(
    update: Update,
    result: dict,
    binding: dict | None = None,
) -> None:
    chat_id = update.effective_chat.id
    pending = result.get("pendingAction")
    markup = None
    if isinstance(pending, dict) and pending.get("token"):
        await set_pending_action(chat_id, pending)
        markup = HERMES_CONFIRMATION_CHECKBOX
    country_conflict = result.get("cartCountryConflict") or {}
    if country_conflict.get("code") == "cart_delivery_country_conflict":
        markup = InlineKeyboardMarkup([[
            InlineKeyboardButton(
                "Clear Cart & Retry",
                callback_data="cart:country-retry",
            ),
            InlineKeyboardButton(
                "Keep Current Cart",
                callback_data="cart:country-keep",
            ),
        ]])

    reply = str(result.get("message") or "Tokko completed the request.")
    chunks = [reply[offset : offset + 4000] for offset in range(0, len(reply), 4000)]
    if not chunks:
        chunks = ["Tokko completed the request."]
    for index, chunk in enumerate(chunks):
        await update.effective_message.reply_text(
            chunk,
            reply_markup=markup if index == len(chunks) - 1 else None,
        )
    if "cartSummary" in result:
        cart_summary = result.get("cartSummary") or {}
        await update.effective_message.reply_text(
            _ucp_cart_text(cart_summary),
            reply_markup=_ucp_cart_checkout_markup(cart_summary) or MAIN_KEYBOARD,
        )
    checkout_summary = result.get("checkoutSummary") or {}
    checkout_totals = checkout_summary.get("totals") or []
    if checkout_totals:
        currency = str(checkout_summary.get("currency") or "INR").upper()
        total_lines = ["Merchant quote:"]
        for line in checkout_totals:
            label = str(line.get("label") or line.get("type") or "Amount")
            try:
                amount = int(line.get("amountMinor") or 0) / 100
            except (TypeError, ValueError):
                amount = 0
            total_lines.append(f"{label}: {currency} {amount:.2f}")
            for detail in line.get("lines") or []:
                detail_label = str(detail.get("label") or "Detail")
                try:
                    detail_amount = int(detail.get("amountMinor") or 0) / 100
                except (TypeError, ValueError):
                    detail_amount = 0
                total_lines.append(f"  {detail_label}: {currency} {detail_amount:.2f}")
        total_lines.append(
            "Shipping is included in this merchant quote."
            if checkout_summary.get("shippingQuoted")
            else "The merchant did not return a shipping charge. Tokko will not invent one."
        )
        delivery = checkout_summary.get("deliveryWindow") or {}
        delivery_period = " to ".join(str(value) for value in (
            delivery.get("description"),
            delivery.get("earliest"),
            delivery.get("latest"),
        ) if value)
        if delivery_period:
            total_lines.append(f"Delivery: {delivery_period}")
        forex = checkout_summary.get("forex") or {}
        if forex.get("appliedByTokko"):
            try:
                forex_base = int(forex.get("baseAmountMinor") or 0) / 100
            except (TypeError, ValueError):
                forex_base = 0
            total_lines.append(
                f"{forex.get('ratePercent') or 3}% forex is calculated on the complete "
                f"merchant cart value of {currency} {forex_base:.2f}. "
                "Mandate coverage uses the final total payable."
            )
        elif forex.get("returnedByMerchant"):
            total_lines.append(
                "Merchant-returned foreign-exchange charges are included above."
            )
        else:
            total_lines.append(
                "No separate forex charge was returned; the card network may apply one later."
            )
        await update.effective_message.reply_text("\n".join(total_lines))
        order_id = str(checkout_summary.get("orderId") or "")
        if checkout_summary.get("confirmationRequired") and re.fullmatch(
            r"[0-9a-fA-F-]{36}", order_id
        ):
            await update.effective_message.reply_text(
                "Confirm this final price:",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton(
                        "Approve Checkout",
                        callback_data=f"ucporder:yes:{order_id}",
                    ),
                    InlineKeyboardButton(
                        "Do Not Place Order",
                        callback_data=f"ucporder:no:{order_id}",
                    ),
                ]]),
            )
    card_choices = [
        choice for choice in (result.get("cardChoices") or [])
        if choice.get("token") and (
            choice.get("type") == "add_card"
            or re.fullmatch(r"\d{4}", str(choice.get("last4") or ""))
        )
    ][:8]
    if card_choices:
        mandate_setup = result.get("mandateSetup") or result.get("mandate") or {}
        mandate_choice = bool(mandate_setup)
        choice_buttons = None
        if mandate_choice:
            amount = _valid_mandate_amount(str(mandate_setup.get("amount") or ""))
            frequency_code = {
                "one_time": "o",
                "weekly": "w",
                "monthly": "m",
                "yearly": "y",
            }.get(str(mandate_setup.get("frequency") or ""))
            scope_code = {
                "any": "a",
                "listed": "l",
            }.get(str(mandate_setup.get("merchantScope") or ""))
            if amount and frequency_code and scope_code:
                choice_buttons = [
                    [InlineKeyboardButton(
                        _card_choice_label(choice),
                        callback_data=(
                            f"mandatecard:{amount}:{frequency_code}:{scope_code}:"
                            f"{'new' if choice.get('type') == 'add_card' else choice.get('id')}"
                        ),
                    )]
                    for choice in card_choices
                    if choice.get("type") == "add_card" or choice.get("id") is not None
                ]
        if not choice_buttons:
            await asyncio.to_thread(_set_pending_ucp_cards_sync, chat_id, card_choices)
            choice_buttons = [
                [InlineKeyboardButton(
                    _card_choice_label(choice),
                    callback_data=f"ucpcard:{index}",
                )]
                for index, choice in enumerate(card_choices)
            ]
        await update.effective_message.reply_text(
            (
                "Choose a saved Prava card for this mandate, or add a new saved card:"
                if mandate_choice
                else "No active mandate covers the checkout total. Choose a saved Prava card:"
            ),
            reply_markup=InlineKeyboardMarkup(choice_buttons),
        )
    next_action = result.get("nextAction") or {}
    payment_url = str(next_action.get("url") or result.get("paymentLink") or "")
    if payment_url.startswith("https://"):
        handoff = next_action.get("paymentHandoff") or result.get("paymentHandoff") or {}
        await update.effective_message.reply_text(
            "Prava secure approval:",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    str(next_action.get("label") or "Open Secure Payment")[:64],
                    url=payment_url,
                )
            ]]),
        )
    products = list(result.get("productChoices") or [])[:10]
    pagination = result.get("productPagination") or {}
    offset = max(0, int(pagination.get("offset") or 0))
    for product in products:
        merchant = str(product.get("merchantName") or "merchant")
        name = str(product.get("productName") or "product")
        variant = str(product.get("optionText") or product.get("variantName") or "")
        currency = str(product.get("currency") or "INR")
        price = product.get("price") or 0
        availability = "available" if product.get("available") else "unavailable"
        caption = (
            f"{product.get('searchQuery') or ''}\n{name}\n{variant}\n"
            f"{merchant} · {currency} {price} · {availability}"
        )[:1024]
        choice_id = str(product.get("choiceId") or "")
        product_markup = None
        if product.get("available") and re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f-]{27}", choice_id, re.IGNORECASE
        ):
            product_markup = InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "Add to Cart",
                    callback_data=f"product:add:{choice_id}",
                )
            ]])
        image_url = str(product.get("imageUrl") or "")
        if image_url.startswith("https://"):
            try:
                await update.effective_message.reply_photo(
                    photo=image_url,
                    caption=caption,
                    reply_markup=product_markup,
                )
                continue
            except Exception:
                log.exception("Could not send one Telegram product image")
        await update.effective_message.reply_text(
            caption,
            reply_markup=product_markup,
        )
    if pagination.get("hasMore"):
        next_offset = int(pagination.get("nextOffset") or offset + len(products))
        await update.effective_message.reply_text(
            f"Showing {len(products)} results from the most relevant merchant.",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "Show 10 More",
                    callback_data=f"products:more:{next_offset}",
                )
            ]]),
        )


def _ucp_cart_text(cart: dict) -> str:
    groups = cart.get("merchantGroups") or []
    prescription_items = cart.get("prescriptionReviewItems") or []
    if not groups and not prescription_items:
        return "Your cart is empty. Search for a wellness product and tap Add to Cart."
    lines = [f"Cart: {int(cart.get('itemCount') or 0)} item(s)"]
    for group in groups:
        lines.append(f"\n{group.get('merchantName') or group.get('merchant') or 'Merchant'}")
        for item in group.get("items") or []:
            lines.append(
                f"• {item.get('productName') or 'Product'} × {int(item.get('quantity') or 1)}"
            )
        for subtotal in group.get("subtotals") or []:
            lines.append(
                f"Item subtotal: {subtotal.get('currency') or 'INR'} {subtotal.get('amount') or '0.00'}"
            )
    if len(groups) > 1:
        lines.append("\nThis legacy cart mixes merchants and must be repaired before checkout.")
    elif groups:
        lines.append("\nThis cart is locked to this merchant. Final charges come from its live UCP quote.")
    if prescription_items:
        lines.append("\nPrescription review, checkout blocked until licensed verification:")
        for item in prescription_items:
            lines.append(f"• {item.get('name') or 'Medicine'}: verification required")
    return "\n".join(lines)


def _ucp_cart_checkout_markup(cart: dict) -> InlineKeyboardMarkup | None:
    rows = []
    groups = cart.get("merchantGroups") or []
    for item in cart.get("items") or []:
        item_id = str(item.get("id") or "")
        if not re.fullmatch(r"[1-9]\d*", item_id):
            continue
        name = str(item.get("productName") or "Product")
        rows.append([InlineKeyboardButton(
            f"Remove {name}"[:64],
            callback_data=f"cart:remove:{item_id}",
        )])
    if cart.get("items"):
        rows.append([InlineKeyboardButton("Empty Cart", callback_data="cart:empty")])
    if len(groups) != 1:
        return InlineKeyboardMarkup(rows) if rows else None
    for group in groups:
        merchant = str(group.get("merchant") or "").strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,45}", merchant):
            continue
        label = "Proceed to Checkout"
        rows.append([InlineKeyboardButton(
            label,
            callback_data=f"cart:checkout:{merchant}",
        )])
    return InlineKeyboardMarkup(rows) if rows else None


async def modify_ucp_cart(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    query = update.callback_query
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await query.answer("Send /start first", show_alert=True)
        return
    try:
        if query.data == "cart:empty":
            await query.answer("Emptying cart...")
            result = await _family_api(binding, "DELETE", "merchants/ucp/cart")
            cart = result.get("cart") or {}
            message = "Your cart is now empty."
        else:
            item_id = query.data.rsplit(":", 1)[-1]
            await query.answer("Removing item...")
            result = await _family_api(
                binding,
                "DELETE",
                f"merchants/ucp/cart/items/{item_id}",
            )
            cart = result.get("cart") or {}
            removed = result.get("removedItem") or {}
            message = f"Removed {removed.get('productName') or 'that item'} from your cart."
        await query.edit_message_text(
            f"{message}\n\n{_ucp_cart_text(cart)}",
            reply_markup=_ucp_cart_checkout_markup(cart) or MAIN_KEYBOARD,
        )
    except Exception as exc:
        log.exception("Could not update UCP cart")
        await query.message.reply_text(f"I couldn't update your cart: {exc}")


async def add_ucp_product_to_cart(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    await query.answer("Adding to cart...")
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await query.message.reply_text("Please send /start and connect your Tokko family again.")
        return
    choice_id = query.data.rsplit(":", 1)[-1]
    try:
        result = await _family_api(
            binding,
            "POST",
            "merchants/ucp/cart/items",
            {"choiceId": choice_id, "quantity": 1},
        )
        await query.edit_message_reply_markup(
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("✓ Added to Cart", callback_data="selection:done")
            ]])
        )
        await query.message.reply_text(
            _ucp_cart_text(result.get("cart") or {}),
            reply_markup=_ucp_cart_checkout_markup(result.get("cart") or {}),
        )
    except TokkoAPIError as exc:
        if exc.details.get("code") == "merchant_cart_conflict":
            conflict = exc.details.get("conflict") or {}
            await query.message.reply_text(
                f"Your cart is locked to {conflict.get('currentMerchantName') or 'the current merchant'}. "
                f"Adding this item would replace it with {conflict.get('requestedMerchantName') or 'the new merchant'}. "
                "Choose what to do:",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton(
                        "Replace Cart",
                        callback_data=f"cart:replace:{choice_id}",
                    ),
                    InlineKeyboardButton("Keep Current Cart", callback_data="cart:keep"),
                ]]),
            )
            return
        log.exception("Could not add UCP product to cart")
        await query.message.reply_text(f"I couldn't add that product: {exc}")
    except Exception as exc:
        log.exception("Could not add UCP product to cart")
        await query.message.reply_text(f"I couldn't add that product: {exc}")


async def resolve_ucp_cart_conflict(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    replace = query.data.startswith("cart:replace:")
    await query.answer("Updating cart..." if replace else "Keeping current cart")
    if not replace:
        await query.edit_message_text("Kept the current merchant cart unchanged.")
        return
    choice_id = query.data.rsplit(":", 1)[-1]
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", choice_id):
        await query.edit_message_text("That product choice expired. Search again.")
        return
    binding = await get_family_binding(update.effective_chat.id)
    try:
        result = await _family_api(
            binding,
            "POST",
            "merchants/ucp/cart/items",
            {"choiceId": choice_id, "quantity": 1, "replaceCart": True},
        )
        await query.edit_message_text("Replaced the old merchant cart with this product.")
        await query.message.reply_text(
            _ucp_cart_text(result.get("cart") or {}),
            reply_markup=_ucp_cart_checkout_markup(result.get("cart") or {}),
        )
    except Exception as exc:
        await query.edit_message_text(f"I couldn't replace the cart: {exc}")


async def show_ucp_cart(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await update.effective_message.reply_text(
            "Please send /start and connect your Tokko family first.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    try:
        cart = await _family_api(binding, "GET", "merchants/ucp/cart")
        await update.effective_message.reply_text(
            _ucp_cart_text(cart),
            reply_markup=_ucp_cart_checkout_markup(cart) or MAIN_KEYBOARD,
        )
    except Exception as exc:
        log.exception("Could not load UCP cart")
        await update.effective_message.reply_text(f"I couldn't load your cart: {exc}")


async def checkout_ucp_merchant_cart(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    await query.answer("Preparing merchant checkout...")
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await query.message.reply_text("Please send /start and connect your Tokko family again.")
        return
    merchant = query.data.rsplit(":", 1)[-1]
    try:
        checkout = await _family_api(
            binding,
            "POST",
            "merchants/ucp/cart/checkout",
            {"merchant": merchant},
        )
        await _send_hermes_result(
            update,
            _ucp_checkout_hermes_result(checkout),
            binding,
        )
    except Exception as exc:
        log.exception("Could not create merchant UCP cart checkout")
        await query.message.reply_text(f"I couldn't create that merchant checkout: {exc}")


def _ucp_checkout_hermes_result(checkout: dict) -> dict:
    approval_required = checkout.get("approvalRequired") is True
    payment_route = str(checkout.get("paymentRoute") or "")
    currency = str(checkout.get("currency") or "").upper()
    total = str(checkout.get("totalAmount") or "")
    merchant_name = str(checkout.get("merchantName") or "The merchant")
    mandate_count = int(
        (checkout.get("mandateCheck") or {}).get("checkedMandateCount") or 0
    )
    if approval_required:
        message = (
            f"{merchant_name} returned a complete quote of {currency} {total}, "
            "including shipping and the 3% forex charge. Review it before approving."
        )
    elif payment_route == "card_selection_required":
        message = (
            f"{merchant_name} returned a final quote of {currency} {total}. "
            "No active mandate covers it; choose a saved Prava card."
        )
    elif payment_route == "mandate":
        message = (
            f"{merchant_name} returned a final quote of {currency} {total}. "
            f"Tokko checked {mandate_count} Prava mandate(s) and selected one "
            "that covers the total. Review the quote before continuing."
        )
    else:
        message = (
            f"{merchant_name} returned a final quote of {currency} {total}. "
            "Review every charge and delivery estimate before continuing."
        )
    result = {
        **checkout,
        "message": message.strip(),
        "checkoutSummary": {
            **checkout,
            "confirmationRequired": approval_required,
        },
    }
    handoff_url = str(checkout.get("merchantHandoffUrl") or "")
    if (
        not approval_required
        and payment_route != "card_selection_required"
        and handoff_url.startswith("https://")
    ):
        result["nextAction"] = {
            "type": "merchant_ucp_checkout",
            "label": f"Continue to {merchant_name} checkout",
            "url": handoff_url,
            "paymentHandoff": checkout.get("paymentHandoff"),
            "paymentSelection": checkout.get("paymentSelection"),
        }
    else:
        result["nextAction"] = None
    return result


async def decide_ucp_order(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    query = update.callback_query
    _, answer, order_id = query.data.split(":", 2)
    proceed = answer == "yes"
    await query.answer("Confirming price..." if proceed else "Canceling order")
    binding = await get_family_binding(update.effective_chat.id)
    try:
        result = await _family_api(
            binding,
            "POST",
            f"merchants/ucp/orders/{order_id}/decision",
            {"proceed": proceed},
        )
        if not proceed:
            await query.edit_message_text(
                "Order canceled. No payment was attempted and no merchant order was placed."
            )
            return
        await query.edit_message_text(
            "Checkout approved. Resolving your approved payment route..."
        )
        await _send_hermes_result(
            update,
            _ucp_checkout_hermes_result(result),
            binding,
        )
    except Exception as exc:
        await query.message.reply_text(f"I couldn't save that order choice: {exc}")


async def show_ucp_payment_category(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    query = update.callback_query
    _, category, order_id = query.data.split(":", 2)
    await query.answer("Loading Prava options...")
    binding = await get_family_binding(update.effective_chat.id)
    try:
        options = await _family_api(
            binding,
            "GET",
            f"merchants/ucp/orders/{order_id}/payment-options",
        )
        if category == "m":
            recommended = options.get("recommendedMandate") or {}
            rows = []
            if recommended.get("id"):
                rows.append([InlineKeyboardButton(
                    "Use Smallest Covering Mandate",
                    callback_data=f"ucppay:m:{order_id}",
                )])
            rows.append([InlineKeyboardButton(
                "Create Mandate",
                callback_data=f"ucppay:n:{order_id}",
            )])
            if recommended.get("id"):
                status = (
                    f"{int(options.get('eligibleMandateCount') or 1)} active mandate(s) cover the cart. "
                    f"Tokko will use the smallest one: {recommended.get('currency') or ''} "
                    f"{recommended.get('remaining') or recommended.get('approvedAmount') or ''}."
                )
            else:
                status = "No active mandate covers the full cart. You can create one using a saved card."
            await query.edit_message_text(status, reply_markup=InlineKeyboardMarkup(rows))
            return
        cards = options.get("savedCards") or []
        choices = [
            {
                "paymentMethodId": card.get("id"),
                "orderId": order_id,
                "purpose": "ucp_order_payment",
                "brand": card.get("brand"),
                "last4": card.get("last4"),
                "isDefault": card.get("isDefault"),
            }
            for card in cards
        ]
        await asyncio.to_thread(
            _set_pending_ucp_cards_sync,
            update.effective_chat.id,
            choices,
        )
        rows = [
            [InlineKeyboardButton(
                f"{'✓ ' if card.get('isDefault') else ''}{str(card.get('brand') or 'Card').title()} •••• {card.get('last4')}",
                callback_data=f"ucpordercard:{index}",
            )]
            for index, card in enumerate(cards)
        ]
        rows.append([InlineKeyboardButton(
            "Save New Card",
            callback_data=f"ucppay:a:{order_id}",
        )])
        await query.edit_message_text(
            "Choose a saved card for this Prava payment, or save a new one:",
            reply_markup=InlineKeyboardMarkup(rows),
        )
    except Exception as exc:
        log.exception("Could not load UCP payment category")
        await query.message.reply_text(f"I couldn't load those payment options: {exc}")


async def _present_ucp_payment_start(query, result: dict, method: str, order_id: str) -> None:
    if result.get("tokenIssued"):
        selected = result.get("selectedMandate") or {}
        credential = result.get("sandboxPaymentCredential") or {}
        suffix = (
            f" Tokko selected the smallest covering mandate, {selected.get('currency')} {selected.get('remaining')}."
            if selected.get("id") else ""
        )
        token_text = (
            "\n\nPrava sandbox mandate Charge API token:\n"
            f"{credential.get('token')}\n"
            f"Transaction: {credential.get('transactionId') or 'pending'}\n"
            "This temporary credential is displayed for testing and is not stored by Tokko."
            if credential.get("token") else ""
        )
        await query.edit_message_text(
            "Prava issued a one-time credential. Tokko linked only its fingerprint to this order."
            f"{suffix}{token_text}"
        )
        return
    url = str(result.get("pravaCheckoutUrl") or "")
    if not url.startswith("https://"):
        raise RuntimeError("Prava did not return a secure hosted URL")
    rows = [[InlineKeyboardButton("Open Prava", url=url)]]
    if method in {"card", "create_mandate"}:
        rows.append([InlineKeyboardButton(
            "I Approved, Check Payment Result",
            callback_data=f"ucppay:r:{order_id}",
        )])
    await query.edit_message_text(
        "Continue on Prava's secure hosted page. Tokko will read the payment result after approval.",
        reply_markup=InlineKeyboardMarkup(rows),
    )


async def choose_ucp_order_payment(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    _, method_code, order_id = query.data.split(":", 2)
    method = {"m": "mandate", "c": "card", "n": "create_mandate", "a": "add_card"}.get(method_code)
    if not method:
        await query.answer("Unknown payment option", show_alert=True)
        return
    await query.answer("Starting Prava...")
    binding = await get_family_binding(update.effective_chat.id)
    try:
        return_context = await _telegram_return_context(context)
        result = await _family_api(
            binding,
            "POST",
            f"merchants/ucp/orders/{order_id}/payment",
            {"method": method, "frequency": "monthly", **return_context},
        )
        await _present_ucp_payment_start(query, result, method, order_id)
    except Exception as exc:
        await query.message.reply_text(f"I couldn't start that Prava flow: {exc}")


async def select_ucp_order_card(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    await query.answer("Starting saved-card payment...")
    chat_id = update.effective_chat.id
    binding = await get_family_binding(chat_id)
    index = int(query.data.rsplit(":", 1)[-1])
    choice = await asyncio.to_thread(_get_pending_ucp_card_sync, chat_id, index)
    if not choice or choice.get("purpose") != "ucp_order_payment":
        await query.message.reply_text("That saved-card choice expired. Open payment options again.")
        return
    order_id = str(choice.get("orderId") or "")
    payment_method_id = str(choice.get("paymentMethodId") or "")
    try:
        return_context = await _telegram_return_context(context)
        result = await _family_api(
            binding,
            "POST",
            f"merchants/ucp/orders/{order_id}/payment",
            {
                "method": "card",
                "paymentMethodId": payment_method_id,
                **return_context,
            },
        )
        await asyncio.to_thread(_clear_pending_ucp_cards_sync, chat_id)
        await _present_ucp_payment_start(query, result, "card", order_id)
    except Exception as exc:
        log.exception("Could not start selected-card UCP payment")
        await query.message.reply_text(f"I couldn't start that saved-card payment: {exc}")


async def continue_ucp_order_payment(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    query = update.callback_query
    order_id = query.data.rsplit(":", 1)[-1]
    await query.answer("Checking Prava result...")
    binding = await get_family_binding(update.effective_chat.id)
    try:
        result = await _family_api(
            binding,
            "POST",
            f"merchants/ucp/orders/{order_id}/payment/continue",
            {},
        )
        credential = result.get("sandboxPaymentCredential") or {}
        token_source = (
            "saved-card payment-result API"
            if credential.get("sessionId")
            else "mandate Charge API"
        )
        await query.message.reply_text(
            (
                f"Prava returned the sandbox {token_source} token:\n"
                f"{credential.get('token')}\n"
                f"Transaction: {credential.get('transactionId') or 'pending'}\n"
                "This temporary credential is displayed for testing and is not stored by Tokko."
            )
            if result.get("tokenIssued") and credential.get("token")
            else "Prava returned the one-time credential. Tokko saved only its fingerprint against this order."
            if result.get("tokenIssued")
            else f"Prava is still {result.get('pravaStatus') or 'pending'}. Finish approval and retry."
        )
    except Exception as exc:
        await query.message.reply_text(f"I couldn't read the Prava payment result: {exc}")


async def select_ucp_saved_card(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    await query.answer("Applying card choice...")
    chat_id = update.effective_chat.id
    binding = await get_family_binding(chat_id)
    if binding is None:
        await query.message.reply_text(
            "Please send /start and connect your Tokko family again.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    index = int(query.data.rsplit(":", 1)[-1])
    choice = await asyncio.to_thread(_get_pending_ucp_card_sync, chat_id, index)
    if not choice:
        await query.message.reply_text(
            "That card choice expired. Ask Tokko to prepare the payment again."
        )
        return
    try:
        return_context = await _telegram_return_context(context)
        result = await _select_ucp_card(
            chat_id,
            binding,
            choice["token"],
            return_context["returnContext"]["botUsername"],
        )
        await asyncio.to_thread(_clear_pending_ucp_cards_sync, chat_id)
        await query.edit_message_reply_markup(
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    _card_choice_label(choice, selected=True),
                    callback_data="selection:done",
                )
            ]])
        )
        await _send_hermes_result(update, result, binding)
    except Exception as exc:
        log.exception("Could not apply Prava card choice")
        await query.message.reply_text(f"I couldn't apply that card choice: {exc}")


async def confirm_delivery_address(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    await query.answer("Confirming address...")
    chat_id = update.effective_chat.id
    binding = await get_family_binding(chat_id)
    if binding is None:
        await query.message.reply_text(
            "Please send /start and connect your Tokko family again.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    try:
        address_id = query.data.rsplit(":", 1)[-1]
        replace_cart = query.data.startswith("address:replace:")
        result = (
            await _telegram_address_session(
                chat_id,
                "POST",
                {"addressId": address_id, "replaceCart": replace_cart},
            )
            if os.environ.get("VERCEL")
            else await _family_api(
                binding,
                "POST",
                "addresses/select",
                {"addressId": address_id, "replaceCart": replace_cart},
            )
        )
        selected = result.get("selectedAddress") or {}
        label = str(selected.get("label") or "Delivery Address")
        readable = str(selected.get("formattedAddress") or label)
        await query.edit_message_reply_markup(
            reply_markup=_selected_checkbox(label[:55])
        )
        context.user_data["delivery_address_confirmed"] = True
        await query.message.reply_text(
            f"Delivery address confirmed:\n{readable}\n\n"
            "hello, i’m tokko. tell me what you need, and i’ll compare live delivery-ready matches.",
            reply_markup=MAIN_KEYBOARD,
        )
    except TokkoAPIError as exc:
        if exc.details.get("code") == "cart_delivery_country_conflict":
            conflict = exc.details.get("conflict") or {}
            await query.message.reply_text(
                f"Your current cart is for {conflict.get('cartCountry') or 'another country'}, "
                f"but this address is in {conflict.get('targetCountry') or 'a different country'}. "
                "Clear the cart and switch addresses?",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton(
                        "Clear Cart & Switch",
                        callback_data=f"address:replace:{address_id}",
                    ),
                    InlineKeyboardButton(
                        "Keep Current Address",
                        callback_data="selection:done",
                    ),
                ]]),
            )
            return
        log.exception("Could not confirm Tokko delivery address")
        await query.message.reply_text(
            f"I couldn't confirm that address: {exc}. Please select it again."
        )
    except Exception as exc:
        log.exception("Could not confirm Tokko delivery address")
        await query.message.reply_text(
            f"I couldn't confirm that address: {exc}. Please select it again."
        )


async def resolve_country_cart_search_conflict(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    query = update.callback_query
    if query.data == "cart:country-keep":
        await query.answer("Keeping current cart")
        await query.edit_message_text(
            "Kept your current cart unchanged. Choose a compatible delivery address when you are ready."
        )
        return
    await query.answer("Clearing cart and retrying...")
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await query.message.reply_text(
            "Please send /start and connect your Tokko family again.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    try:
        result = await _retry_hermes_after_country_cart_clear(
            update.effective_chat.id,
            binding,
        )
        await query.edit_message_reply_markup(reply_markup=None)
        await _send_hermes_result(update, result, binding)
    except Exception as exc:
        log.exception("Could not clear incompatible cart and retry search")
        await query.message.reply_text(
            f"I couldn't clear the incompatible cart and retry: {exc}"
        )


async def prompt_add_tokko_address(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    await query.answer()
    context.user_data["awaiting_tokko_address"] = True
    context.user_data.pop("pending_address_country", None)
    if os.environ.get("VERCEL"):
        await _telegram_address_session(
            update.effective_chat.id,
            "POST",
            {"awaitingAddress": True},
        )
    await query.message.reply_text(
        "First choose the delivery country code:",
        reply_markup=_address_country_markup(),
    )


async def select_tokko_address_country(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    selected = query.data.rsplit(":", 1)[-1].upper()
    await query.answer("Country selected" if selected != "OTHER" else "Enter country code")
    context.user_data["awaiting_tokko_address"] = True
    if selected == "OTHER":
        context.user_data.pop("pending_address_country", None)
        if os.environ.get("VERCEL"):
            await _telegram_address_session(
                update.effective_chat.id,
                "POST",
                {"awaitingAddress": True},
            )
        await query.message.reply_text(
            "Send the address as:\n"
            "Address: label | two-letter country code | full delivery address\n\n"
            "Example: Address: Paris Home | FR | 10 Rue de Rivoli, Paris 75001"
        )
        return
    context.user_data["pending_address_country"] = selected
    if os.environ.get("VERCEL"):
        await _telegram_address_session(
            update.effective_chat.id,
            "POST",
            {"awaitingAddress": True, "countryCode": selected},
        )
    country_name = next(
        (name for code, name in ADDRESS_COUNTRIES if code == selected),
        selected,
    )
    await query.message.reply_text(
        f"{country_name} [{selected}] selected. Now send:\n"
        "Address: label | full delivery address\n\n"
        "Example: Address: Parents | 12 Park Street, Kolkata 700016"
    )


async def list_tokko_addresses(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await update.effective_message.reply_text(
            "Please send /start and connect your Tokko family first.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    await _offer_address_or_ready(update, binding, selected_address_id=None)


async def reselect_tokko_address(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    context.user_data["delivery_address_confirmed"] = False
    if os.environ.get("VERCEL"):
        await _telegram_address_session(
            update.effective_chat.id,
            "POST",
            {"reset": True},
        )
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await update.effective_message.reply_text(
            "Please send /start and connect your Tokko family first.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    await _offer_address_or_ready(update, binding)


async def add_tokko_address_command(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await update.effective_message.reply_text(
            "Please send /start and connect your Tokko family first.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    context.user_data["awaiting_tokko_address"] = True
    context.user_data.pop("pending_address_country", None)
    if os.environ.get("VERCEL"):
        await _telegram_address_session(
            update.effective_chat.id,
            "POST",
            {"awaitingAddress": True},
        )
    await update.effective_message.reply_text(
        "First choose the delivery country code:",
        reply_markup=_address_country_markup(),
    )


async def show_more_products(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    await query.answer("Loading up to 10 more...")
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await query.message.reply_text("Please send /start and connect your Tokko family again.")
        return
    if not await _address_session_confirmed(update.effective_chat.id, context):
        await _offer_address_or_ready(
            update,
            binding,
            "Choose the delivery address before shopping.",
        )
        return
    offset = int(query.data.rsplit(":", 1)[-1])
    typing_task = asyncio.create_task(_keep_typing(context.bot, update.effective_chat.id))
    try:
        result = await _call_hermes(
            update.effective_chat.id,
            binding,
            f"show up to 10 more results from my previous product search, starting at offset {offset}; use the merchant locked to my current cart",
        )
        await _send_hermes_result(update, result, binding)
    except Exception as exc:
        log.exception("Could not load more wellness products")
        await query.message.reply_text(f"I couldn't load more products: {exc}")
    finally:
        typing_task.cancel()


async def handle_hermes_confirmation(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    await query.answer()
    chat_id = update.effective_chat.id
    pending = await get_pending_action(chat_id)
    if pending is None:
        await query.edit_message_reply_markup(reply_markup=None)
        await query.message.reply_text(
            "That approval has expired or was already used. Please ask Tokko again."
        )
        return

    approved = query.data == "hermes:approve"
    binding = None
    if approved:
        binding = await get_family_binding(chat_id)
        if binding is None:
            await query.message.reply_text("Please send /start and connect your Tokko family again.")
            return
        if not await _address_session_confirmed(chat_id, context):
            await _offer_address_or_ready(
                update,
                binding,
                "Choose the delivery address before approving a shopping action.",
            )
            return
    label = "Yes, Approve" if approved else "No, Leave It"
    await query.edit_message_reply_markup(reply_markup=_selected_checkbox(label))
    await clear_pending_action(chat_id)
    if not approved:
        await query.message.reply_text("Okay, I did not make that change.")
        return

    typing_task = asyncio.create_task(_keep_typing(context.bot, chat_id))
    try:
        result = await _call_hermes(
            chat_id,
            binding,
            approval_token=pending["token"],
        )
        await _send_hermes_result(update, result, binding)
    except Exception as exc:
        await set_pending_action(
            chat_id,
            {
                "token": pending["token"],
                "description": pending.get("description") or "pending action",
                "expiresInSeconds": 600,
            },
        )
        log.exception("Hermes approval failed")
        await query.edit_message_reply_markup(
            reply_markup=HERMES_CONFIRMATION_CHECKBOX
        )
        await query.message.reply_text(
            f"I couldn't complete that approval: {exc}. You can tap Approve again."
        )
    finally:
        typing_task.cancel()


async def ignore_completed_selection(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    await update.callback_query.answer("Already selected")


async def choose_language(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    await update.effective_message.reply_text(
        "Choose the language for voice search and Tokko replies:",
        reply_markup=LANGUAGE_MARKUP,
    )


async def set_language(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    del context
    query = update.callback_query
    language = query.data.split(":", 1)[-1]
    if language not in TELEGRAM_LANGUAGES:
        await query.answer("Unsupported language", show_alert=True)
        return
    await query.answer("Saving language...")
    binding = await get_family_binding(update.effective_chat.id)
    if binding is None:
        await query.message.reply_text("Please send /start first.")
        return
    try:
        await _set_telegram_language(update.effective_chat.id, language)
        binding["responseLanguage"] = language
        await asyncio.to_thread(
            _set_family_binding_sync,
            update.effective_chat.id,
            binding,
        )
        await query.edit_message_reply_markup(reply_markup=_selected_checkbox(
            TELEGRAM_LANGUAGES[language]
        ))
        await query.message.reply_text(
            f"Voice search and replies will use {TELEGRAM_LANGUAGES[language]}.",
            reply_markup=MAIN_KEYBOARD,
        )
    except Exception as exc:
        log.exception("Could not save Telegram language")
        await query.message.reply_text(f"I couldn't save that language: {exc}")


async def handle_voice_message(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    chat_id = update.effective_chat.id
    binding = await get_family_binding(chat_id)
    if binding is None:
        await update.message.reply_text("Please send /start and connect your Tokko family first.")
        return
    if not await _address_session_confirmed(chat_id, context):
        await _offer_address_or_ready(update, binding, "Choose the delivery address before voice search.")
        return
    media = update.message.voice or update.message.audio
    typing_task = asyncio.create_task(_keep_typing(context.bot, chat_id))
    try:
        telegram_file = await context.bot.get_file(media.file_id)
        payload = bytes(await telegram_file.download_as_bytearray())
        if len(payload) > 2_250_000:
            raise RuntimeError("Voice note is too large. Keep it under about 30 seconds.")
        transcription = await _family_api(
            binding,
            "POST",
            "hermes/transcribe",
            {
                "audioBase64": base64.b64encode(payload).decode("ascii"),
                "mimeType": media.mime_type or "audio/ogg",
                "language": binding.get("responseLanguage") or "en-IN",
            },
        )
        transcript = str(transcription.get("transcript") or "").strip()
        await update.message.reply_text(f"I heard: {transcript}")
        result = await _call_hermes(chat_id, binding, transcript)
        await _send_hermes_result(update, result, binding)
    except Exception as exc:
        log.exception("Telegram voice search failed")
        await update.message.reply_text(f"Voice search failed: {exc}")
    finally:
        typing_task.cancel()


async def handle_shopping_upload(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    chat_id = update.effective_chat.id
    binding = await get_family_binding(chat_id)
    if binding is None:
        await update.message.reply_text("Please send /start and connect your Tokko family first.")
        return
    if not await _address_session_confirmed(chat_id, context):
        await _offer_address_or_ready(update, binding, "Choose the delivery address before using an upload.")
        return
    document = update.message.document
    if update.message.photo:
        media = update.message.photo[-1]
        mime_type = "image/jpeg"
    elif document:
        media = document
        mime_type = document.mime_type or "application/octet-stream"
    else:
        return
    if mime_type not in {
        "application/pdf", "image/heic", "image/jpeg", "image/png", "image/webp"
    }:
        await update.message.reply_text("Upload a JPEG, PNG, WebP, HEIC, or PDF file.")
        return
    typing_task = asyncio.create_task(_keep_typing(context.bot, chat_id))
    try:
        telegram_file = await context.bot.get_file(media.file_id)
        payload = bytes(await telegram_file.download_as_bytearray())
        if len(payload) > 2_250_000:
            raise RuntimeError("Upload is larger than 2.25 MB.")
        result = await _family_api(
            binding,
            "POST",
            "hermes/media",
            {
                "dataBase64": base64.b64encode(payload).decode("ascii"),
                "mimeType": mime_type,
                "declaredType": "auto",
                "language": binding.get("responseLanguage") or "en-IN",
            },
        )
        await _send_hermes_result(update, result, binding)
    except Exception as exc:
        log.exception("Telegram shopping upload failed")
        await update.message.reply_text(f"Upload failed: {exc}")
    finally:
        typing_task.cancel()


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    binding = await get_family_binding(chat_id)
    if binding is None:
        await update.message.reply_text(
            "Please send /start and share your phone number first.",
            reply_markup=CONTACT_KEYBOARD,
        )
        return
    text = _text(update)
    if await _awaiting_address_input(chat_id, context) or re.match(
        r"^address\s*:", text, re.IGNORECASE
    ):
        pending_country = await _pending_address_country(chat_id, context)
        label, country_code, formatted_address = _parse_tokko_address_text(
            text,
            pending_country,
        )
        if (
            not label
            or not re.fullmatch(r"[A-Z]{2}", country_code)
            or len(formatted_address) < 5
        ):
            context.user_data["awaiting_tokko_address"] = True
            await update.message.reply_text(
                "Choose a country button first, or send: "
                "Address: label | two-letter country code | full delivery address"
            )
            return
        try:
            await _family_api(
                binding,
                "POST",
                "addresses",
                {
                    "label": label,
                    "countryCode": country_code,
                    "formattedAddress": formatted_address,
                },
            )
            context.user_data.pop("awaiting_tokko_address", None)
            context.user_data.pop("pending_address_country", None)
            if os.environ.get("VERCEL"):
                await _telegram_address_session(
                    chat_id,
                    "POST",
                    {"awaitingAddress": False},
                )
            await _offer_address_or_ready(
                update,
                binding,
                "Address saved in Tokko.",
            )
        except Exception as exc:
            log.exception("Could not save Tokko address")
            context.user_data["awaiting_tokko_address"] = True
            await update.message.reply_text(f"I couldn't save that address: {exc}")
        return
    if re.fullmatch(r"(?:addresses|list addresses|show addresses)", text, re.IGNORECASE):
        await list_tokko_addresses(update, context)
        return
    if re.fullmatch(r"(?:reselect|reselect address|change address)", text, re.IGNORECASE):
        await reselect_tokko_address(update, context)
        return
    if re.fullmatch(r"(?:add address|new address)", text, re.IGNORECASE):
        await add_tokko_address_command(update, context)
        return
    if re.fullmatch(r"(?:cart|show cart|my cart)", text, re.IGNORECASE):
        await show_ucp_cart(update, context)
        return
    if re.match(
        r"^(?:/emptycart|empty (?:my )?cart|clear (?:my )?cart|remove\b|delete\b|take\b)",
        text,
        re.IGNORECASE,
    ):
        try:
            result = await _call_hermes(chat_id, binding, text)
            await _send_hermes_result(update, result, binding)
        except Exception as exc:
            await update.message.reply_text(f"I couldn't update your cart: {exc}")
        return
    if not await _address_session_confirmed(chat_id, context):
        await _offer_address_or_ready(
            update,
            binding,
            "Choose the delivery address before shopping.",
        )
        return
    pending = await get_pending_action(chat_id)
    if pending is not None:
        answer = _confirmation_answer(text)
        if answer is False:
            await clear_pending_action(chat_id)
            await update.message.reply_text("Okay, I did not make that change.")
            return
        if answer is True:
            await clear_pending_action(chat_id)
            typing_task = asyncio.create_task(_keep_typing(context.bot, chat_id))
            try:
                result = await _call_hermes(
                    chat_id,
                    binding,
                    approval_token=pending["token"],
                )
                await _send_hermes_result(update, result, binding)
            except Exception as exc:
                await set_pending_action(
                    chat_id,
                    {
                        "token": pending["token"],
                        "description": pending.get("description") or "pending action",
                        "expiresInSeconds": 600,
                    },
                )
                log.exception("Hermes text approval failed")
                await update.message.reply_text(
                    f"I couldn't complete that approval: {exc}. Please try Yes again."
                )
            finally:
                typing_task.cancel()
            return
        # A new request replaces an unanswered approval instead of leaving a
        # stale token that can cause the previous question to be repeated.
        await clear_pending_action(chat_id)
    typing_task = asyncio.create_task(_keep_typing(context.bot, chat_id))
    try:
        result = await _call_hermes(chat_id, binding, text)
    except httpx.TimeoutException:
        log.exception("Hermes call timed out")
        await update.message.reply_text(
            "That's taking longer than expected. Please wait a minute and check your order history "
            "before retrying, so an order is not placed twice."
        )
        return
    except Exception as exc:
        log.exception("Hermes call failed")
        await update.message.reply_text(f"Tokko request failed: {exc}")
        return
    finally:
        typing_task.cancel()
    await _send_hermes_result(update, result, binding)


async def handle_application_error(
    update: object,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    log.error("Unhandled Telegram update error", exc_info=context.error)
    effective_message = getattr(update, "effective_message", None)
    if effective_message is None:
        return
    try:
        await effective_message.reply_text(
            "Tokko hit a temporary service error. Please try again in a moment."
        )
    except Exception:
        log.exception("Could not send Telegram error fallback")


def build_application() -> Application:
    app = Application.builder().token(_required_env("TELEGRAM_BOT_TOKEN")).build()
    onboarding = ConversationHandler(
        entry_points=[
            CommandHandler("start", start),
            MessageHandler(filters.CONTACT, handle_contact),
        ],
        states={
            WAIT_CONTACT: [
                MessageHandler(filters.CONTACT, handle_contact),
                MessageHandler(filters.TEXT & ~filters.COMMAND, ask_for_contact),
            ],
            ONBOARD_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, onboarding_name)],
            ONBOARD_EMAIL: [MessageHandler(filters.TEXT & ~filters.COMMAND, onboarding_email)],
            ONBOARD_AGE: [MessageHandler(filters.TEXT & ~filters.COMMAND, onboarding_age)],
            ONBOARD_GENDER: [MessageHandler(filters.TEXT & ~filters.COMMAND, onboarding_gender)],
            ONBOARD_GENDER_DESCRIPTION: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, onboarding_gender_description)
            ],
            ADD_FIRST_DEPENDENT: [
                CallbackQueryHandler(
                    add_first_dependent_checked,
                    pattern=r"^onboarding:first-dependent:(?:yes|no)$",
                ),
                MessageHandler(filters.TEXT & ~filters.COMMAND, add_first_dependent),
            ],
            DEPENDENT_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, dependent_name)],
            DEPENDENT_PHONE: [MessageHandler(filters.TEXT & ~filters.COMMAND, dependent_phone)],
            DEPENDENT_RELATIONSHIP: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, dependent_relationship)
            ],
            DEPENDENT_OTHER_RELATIONSHIP: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, dependent_other_relationship)
            ],
            DEPENDENT_AGE: [MessageHandler(filters.TEXT & ~filters.COMMAND, dependent_age)],
            DEPENDENT_GENDER: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, dependent_gender)
            ],
            DEPENDENT_GENDER_DESCRIPTION: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, dependent_gender_description)
            ],
            ADD_ANOTHER_DEPENDENT: [
                CallbackQueryHandler(
                    add_another_dependent_checked,
                    pattern=r"^onboarding:add-dependent:(?:yes|no)$",
                ),
                MessageHandler(filters.TEXT & ~filters.COMMAND, add_another_dependent)
            ],
            SELECT_MERCHANT_PHONE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, select_merchant_phone)
            ],
            CONFIRM_MERCHANT_CONSENT: [
                CallbackQueryHandler(
                    confirm_merchant_consent_checked,
                    pattern=r"^onboarding:consent:(?:yes|no)$",
                ),
                MessageHandler(filters.TEXT & ~filters.COMMAND, confirm_merchant_consent)
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
        allow_reentry=True,
    )
    payments = ConversationHandler(
        entry_points=[
            CommandHandler("payments", payments_entry),
            MessageHandler(filters.Regex(r"^Payments$"), payments_entry),
            MessageHandler(
                filters.Regex(
                    r"^(?:Add Card|Refresh Saved Cards|Create Mandate|View Mandates|Show All \(30 Days\)|Back to Shopping)$"
                ),
                payment_menu_action,
            ),
        ],
        states={
            PAYMENT_MENU_STATE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, payment_menu_action)
            ],
            MANDATE_CARD_STATE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, mandate_card_selected)
            ],
            MANDATE_AMOUNT_STATE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, mandate_amount_selected)
            ],
            MANDATE_CUSTOM_AMOUNT_STATE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, mandate_custom_amount)
            ],
            MANDATE_FREQUENCY_STATE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, mandate_frequency_selected)
            ],
        },
        fallbacks=[CommandHandler("cancel", payment_cancel)],
        allow_reentry=True,
    )
    app.add_handler(onboarding)
    app.add_handler(payments)
    app.add_handler(CommandHandler("addresses", list_tokko_addresses))
    app.add_handler(CommandHandler("reselect", reselect_tokko_address))
    app.add_handler(CommandHandler("addaddress", add_tokko_address_command))
    app.add_handler(CommandHandler("cart", show_ucp_cart))
    app.add_handler(CommandHandler("language", choose_language))
    app.add_handler(
        CallbackQueryHandler(
            handle_hermes_confirmation,
            pattern=r"^hermes:(?:approve|decline)$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(select_mandate_amount, pattern=r"^mandateamt:\d+(?:\.\d{1,2})?$")
    )
    app.add_handler(
        CallbackQueryHandler(
            prepare_mandate_card_choices,
            pattern=r"^mandatefreq:\d+(?:\.\d{1,2})?:[owmy]:[al]$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            select_mandate_card_choice,
            pattern=r"^mandatecard:\d+(?:\.\d{1,2})?:[owmy]:[al]:(?:new|[1-9]\d*)$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(select_ucp_saved_card, pattern=r"^ucpcard:\d+$")
    )
    app.add_handler(
        CallbackQueryHandler(
            confirm_delivery_address,
            pattern=r"^address:(?:select|replace):[1-9]\d*$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(prompt_add_tokko_address, pattern=r"^address:add$")
    )
    app.add_handler(
        CallbackQueryHandler(
            select_tokko_address_country,
            pattern=r"^address:country:(?:[A-Z]{2}|OTHER)$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(show_more_products, pattern=r"^products:more:\d+$")
    )
    app.add_handler(
        CallbackQueryHandler(
            add_ucp_product_to_cart,
            pattern=r"^product:add:[0-9a-fA-F-]{36}$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            resolve_ucp_cart_conflict,
            pattern=r"^(?:cart:keep|cart:replace:[0-9a-fA-F-]{36})$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            resolve_country_cart_search_conflict,
            pattern=r"^cart:country-(?:retry|keep)$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            modify_ucp_cart,
            pattern=r"^(?:cart:empty|cart:remove:[1-9]\d*)$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            checkout_ucp_merchant_cart,
            pattern=r"^cart:checkout:[a-z0-9][a-z0-9_-]{0,45}$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            decide_ucp_order,
            pattern=r"^ucporder:(?:yes|no):[0-9a-fA-F-]{36}$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            continue_ucp_order_payment,
            pattern=r"^ucppay:r:[0-9a-fA-F-]{36}$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            show_ucp_payment_category,
            pattern=r"^ucppaycat:[mc]:[0-9a-fA-F-]{36}$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            select_ucp_order_card,
            pattern=r"^ucpordercard:\d+$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            choose_ucp_order_payment,
            pattern=r"^ucppay:[mcna]:[0-9a-fA-F-]{36}$",
        )
    )
    app.add_handler(
        CallbackQueryHandler(set_language, pattern=r"^language:[a-z]{2}-IN$")
    )
    app.add_handler(
        CallbackQueryHandler(ignore_completed_selection, pattern=r"^selection:done$")
    )
    app.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, handle_voice_message))
    app.add_handler(
        MessageHandler(filters.PHOTO | filters.Document.ALL, handle_shopping_upload)
    )
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_error_handler(handle_application_error)
    return app


def main() -> None:
    _init_db()
    app = build_application()
    log.info("Bot starting, polling Telegram...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
