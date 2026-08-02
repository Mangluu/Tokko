# Tokko Telegram shopper

This bot connects Telegram users to Tokko's family-scoped Hermes shopper. It
looks up the user's own Telegram contact number first. If no completed Tokko
family exists, it guides the user through onboarding in Telegram before
opening the normal shopping chat.

The onboarding flow collects:

- account holder name, phone, and email required by Prava;
- one or more family members, their phones, and relationships;
- the account-holder or family-member phone to use for Zepto authentication;
- explicit consent to use that selected phone for Zepto authentication.

Existing and newly-created families are sent to Hermes using Tokko's numeric
`familyUserId`:

```
POST https://zepto-shop.vercel.app/api/integrations/telegram/hermes
X-API-Key: <HERMES_API_KEY>
{
  "telegramChatId": "123456789",
  "familyUserId": 42,
  "text": "reconnect zepto with otp",
  "language": "en-IN"
}
```
expecting back:
```
{"message": "...", "pendingAction": null, "tools": []}
```

Immediately after a connected family is found, `/start` loads every address
stored directly in Tokko and displays one checkbox per address. It never reads
or writes a Zepto address. If the family has no Tokko address, **Add New
Address** asks for `Address: label | full delivery address` and stores it in
Tokko's PostgreSQL database. Every later `/start` fetches the current list
again, so a legacy cached merchant address cannot reappear. A normal shopping
message is not sent to Hermes until one address has been explicitly selected
for that Telegram session.

Address commands:

- `/addresses`: fetch and list the family's saved Tokko addresses;
- `/reselect`: fetch the list and require a fresh selection before shopping;
- `/addaddress`: prompt for and save a new Tokko address.

The **Addresses** and **Add Address** reply-keyboard buttons provide the same
actions without typing commands.

Wellness searches return at most 50 image-backed products per response, sorted
by delivery market and currency, then by price. Telegram sends product images in media
groups. When more results exist, **Show 50 More** requests the next page.

## Prava cards and mandates

Send `/payments` or tap **Payments** after onboarding. The menu supports:

- adding any number of cards through Prava's hosted card flow;
- refreshing and listing the family's masked saved cards;
- showing the five most relevant mandates by default;
- opening the complete last-30-day mandate history with **Show All (30 Days)**;
- creating ₹50, ₹100, ₹500, ₹1000, or custom mandates;
- weekly, monthly, and yearly authorization cycles.

Mandate amounts are per-charge caps, not prepaid wallet balances. Creating a
mandate does not deduct money. The cardholder opens the returned Prava URL and
uses OTP/passkey approval there; raw card details never enter this bot.

Card and mandate sessions created from Telegram carry a Telegram return
context. Prava returns to Tokko's safe callback first, which immediately opens
the originating bot with a `/start payments_card_return` or
`/start payments_mandate_return` deep link. The bot then refreshes the family's
saved cards or mandates. Sessions created on the website continue returning to
the website.

Hermes confirmations use Telegram inline checkbox-style buttons. A typed
answer such as `yes`, `approve`, `go ahead`, `no`, or `leave it` works too. The
bot persists Hermes' signed one-time approval token in its SQLite state until
the choice is used or expires, so a valid answer executes the pending action
instead of making Hermes repeat the question.

## 1. Get a Telegram bot token

1. Open Telegram, message **@BotFather**
2. Send `/newbot`, follow the prompts (name + username)
3. BotFather gives you a token like `123456789:AAExample...` — save it

## 2. Set up the project

```bash
cd ~/Downloads/tokko-shopper
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env`:
- `TELEGRAM_BOT_TOKEN` — from BotFather
- `HERMES_ENDPOINT_URL` — Tokko's `/api/integrations/telegram/hermes` URL
- `HERMES_API_KEY` — one exact key from Tokko's `EXTERNAL_API_KEYS`
- `TOKKO_API_BASE_URL` — Tokko's public origin, used for family lookup and
  service-authenticated onboarding
- `TELEGRAM_BOT_USERNAME` — optional BotFather username fallback used only
  when Telegram has not populated the bot username yet

## 3. Run it

```bash
python bot.py
```

Open the bot, send `/start`, and share your own contact using Telegram's native
button. Existing users select one of their Tokko addresses or add a new one,
then enter shopping. New users complete family onboarding and save a Tokko
delivery address before shopping.

To connect Zepto after granting consent, say `reconnect zepto with otp`, approve
the action, and reply with the six-digit OTP. Tokko saves the resulting merchant
session in its backend, not in this bridge.

## Notes

- The bridge's SQLite file stores only `chat_id`, Tokko `userId`, Prava
  `customerId`, and the family phone. Zepto tokens stay in Tokko's PostgreSQL
  backend.
- Existing installations are migrated automatically from the original
  `family_ids` SQLite table.
- Send `/cancel` at any time during onboarding to discard the current draft.
- **Long polling** is used (`app.run_polling`), so the bot just needs
  outbound internet access — no public URL, webhook, or open port required.
- **This needs to keep running** to work — for always-on use, run it under
  `systemd`, `pm2`, `tmux`/`screen`, or a small Docker container on a VPS.
- If Hermes runs on the same machine, `http://localhost:PORT/...` works fine
  since polling means the bot machine only makes outbound calls.
