# Tokko backend API guide

This document describes the APIs exposed by the Tokko deployment, including
website-session calls, external microservice calls, LINQ onboarding, Prava card
tokenization, Zepto OTP authentication, addresses, shopping, and diagnostics.

Production base URL:

```sh
BASE_URL="https://zepto-shop.vercel.app"
```

All request and response bodies are JSON unless stated otherwise. Examples use
[`jq`](https://jqlang.github.io/jq/) to format responses.

## Authentication

| API type | Authentication |
| --- | --- |
| Public | No authentication |
| Website | HttpOnly website-session cookie |
| External service | `Authorization: Bearer <Clerk machine token>` or `X-API-Key: <key>` |
| LINQ webhook | Standard Webhooks signature headers |

An external API key must match one of the comma-separated values configured in
the Vercel `EXTERNAL_API_KEYS` environment variable.

### Website cookie file

`curl` creates the cookie file automatically after signup or login. `/tmp`
already exists on macOS and Linux.

```sh
COOKIE_JAR="/tmp/tokko.cookies"
```

Use `-c "$COOKIE_JAR"` when an endpoint sets the cookie and
`-b "$COOKIE_JAR"` on authenticated requests.

### Phone-number format

APIs accept E.164 phone numbers:

```text
+919876543210
```

Family onboarding also accepts separate country code and local number fields.
For example:

```json
{
  "primaryParentCountryCode": "+91",
  "primaryParentLocalPhone": "9876543210"
}
```

## Route summary

### Public and website-session routes

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Check application and PostgreSQL health |
| `GET` | `/.well-known/ucp` | Public | Tokko's cacheable UCP agent profile used for merchant negotiation |
| `GET` | `/api/config` | Public | Check browser auth, Prava, LINQ, and consent configuration |
| `POST` | `/api/auth/signup` | Public | Start a Clerk-backed signup challenge |
| `POST` | `/api/auth/signup/verify` | Public | Verify the OTP and create the account/session |
| `POST` | `/api/auth/login` | Public | Login and create a website session |
| `GET` | `/api/auth/session` | Website | Validate the current session |
| `POST` | `/api/auth/logout` | Public | Revoke the supplied session |
| `GET` | `/api/me` | Website | Read consolidated account state |
| `PUT` | `/api/onboarding/profile` | Website | Reconcile active family members; omitted members are archived |
| `PUT` | `/api/onboarding/merchant-consent` | Website | Legacy: grant or revoke selected-phone merchant consent |
| `POST` | `/api/payments/tokenization-session` | Website | Create a Prava tokenization session |
| `POST` | `/api/payments/payment-methods` | Website | Store a completed tokenized card |
| `GET` | `/api/payments/payment-methods?familyPhone=...` | Website | List masked family cards; optional phone must belong to the signed-in family |
| `GET` | `/api/payments/mandates` | Website | List the top five Prava mandates plus aggregate totals; use `?view=history&days=30` for one-month history |
| `POST` | `/api/payments/mandates/session` | Website | Start one-time approval for a standing Prava mandate |
| `GET` | `/api/payments/payment-results?checkoutId=...` | Website | Read redacted Prava session and mandate result diagnostics |
| `GET` | `/api/platforms` | Website | List configured merchant platforms |
| `GET` | `/api/merchants/ucp` | Website | Discover the audited India and US UCP merchant registry |
| `POST` | `/api/merchants/ucp/search` | Website | Search Shopify Global Catalog plus audited merchant UCPs; optionally filter `market` to `IN` or `US` |
| `POST` | `/api/merchants/ucp/checkout` | Website | Create checkout with the selected Tokko address, E.164 phone, fulfillment choice, and merchant totals |
| `GET` | `/api/zepto-status` | Website | Read Zepto connection state |
| `POST` | `/api/merchant/zepto/connect/start` | Website | Send or resend a Zepto OTP |
| `POST` | `/api/merchant/zepto/connect/verify` | Website | Verify Zepto OTP and store connection |
| `GET` | `/api/addresses` | Website | List addresses stored directly in Tokko |
| `POST` | `/api/addresses` | Website | Add a Tokko-owned address and assign family members |
| `PUT` | `/api/addresses/:id` | Website | Edit an owned address and its member assignments |
| `DELETE` | `/api/addresses/:id` | Website | Remove an owned address and safely select a remaining default |
| `POST` | `/api/addresses/select` | Website | Select a Tokko-owned delivery address |
| `GET`, `PUT` | `/api/care-rules` | Website | Read or update approval mode, caps, categories, and blocked items |
| `GET`, `PUT` | `/api/preferences` | Website | Read or update decision, delivery, and digest notifications |
| `GET` | `/api/decisions` | Website | List the family's pending or historical decision requests |
| `POST` | `/api/decisions/:id/resolve` | Website | Idempotently approve or decline one pending request |
| `GET` | `/api/activity` | Website | Read the family control-plane audit timeline |
| `POST` | `/api/v1/decisions` | Service | Create a family decision request from an agent or messaging adapter |
| `POST` | `/api/location/serviceability` | Website + Zepto | Check coordinates and select a store |
| `GET` | `/api/search?q=milk&pageNumber=0` | Website + Zepto | Search one Zepto result page |
| `GET` | `/api/product/:id` | Website + Zepto | Get product details |
| `GET` | `/api/cart` | Website + Zepto | Read cart |
| `POST` | `/api/cart` | Website + Zepto | Set product quantities |
| `GET` | `/api/payment-methods` | Website + Zepto | Read Zepto checkout methods |
| `POST` | `/api/order` | Website + Zepto | Preview or create a COD order |
| `POST` | `/api/order/online` | Website + Zepto | Preview or create an online-payment order |
| `POST` | `/api/order/payment-status` | Website + Zepto | Check online-payment status |
| `POST` | `/api/order/cod-decision` | Website + Zepto | Approve or decline COD after three failed card attempts |
| `GET` | `/api/checkout/activity` | Website | Read card-attempt and COD-fallback activity |
| `GET` | `/api/orders?limit=10` | Website + Zepto | List order history |
| `GET` | `/api/orders/:id` | Website + Zepto | Read order details |
| `GET` | `/api/past-items` | Website + Zepto | Read previously ordered products |
| `POST` | `/api/hermes/chat` | Website | Chat with the Hermes UCP personal shopper |
| `POST` | `/api/hermes/checkout/continue` | Website + Zepto | Continue a Hermes one-time Prava card payment after passkey approval |

“Website + Zepto” means the caller needs a valid website session, current
selected-phone consent, and a Zepto token authenticated for that same phone.

The browser starts product search at `pageNumber=0` and continues requesting
pages until Zepto returns no new products. It deduplicates by Zepto product ID
and renders the MCP `structuredContent`, including Zepto-hosted product images,
stock, price, and MRP. API clients can request individual pages directly.

### Wellness merchant UCP flow

Search all supported merchant profiles with the website session cookie:

```sh
curl -fsS -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"query":"ashwagandha","market":"IN","limit":50,"offset":0}' \
  https://zepto-shop.vercel.app/api/merchants/ucp/search | jq
```

Tokko calls Shopify's Global Catalog UCP and the live UCP profiles in its
audited India and US registry. Omit `market` to search both delivery markets.
Results are grouped by delivery market and currency, then sorted by price
inside each group; currencies are never compared without an exchange-rate
policy. The response contains at most 50 products and every product has an
HTTPS image. Each product contains a short-lived, signed `selectionToken`; callers should not
construct or edit it. Send the chosen token back to create the selected merchant
checkout:

```sh
curl -fsS -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"selectionToken":"SIGNED_SELECTION_FROM_SEARCH","quantity":1}' \
  https://zepto-shop.vercel.app/api/merchants/ucp/checkout | jq
```

Tokko submits `buyer.phone_number` and a selected fulfillment destination with
the contact's E.164 phone and structured address. If the merchant returns
shipping options without selecting one, Tokko calls `update_checkout` with the
cheapest option and uses that response as the final quote. The response keeps
every merchant `totals[]` line in its original order, including subtotal,
discount, shipping (`fulfillment`), tax, fees, and total. `totalAmount` is the
merchant's authoritative `type: total` value; `shippingMinor` is the sum of
the merchant's fulfillment lines.

The response keeps the merchant's UCP `continue_url` as `checkoutUrl`,
`continueUrl`, and `merchantHandoffUrl`. Shopify general-access UCP does not
return a separate payment-only URL, so `paymentLink` and `paymentUrl` are
`null`. Before returning the handoff, Tokko reads the exact UCP `total`, lists
every active Prava mandate for the family, and selects the smallest
merchant-compatible mandate that covers that total. If one is available, Tokko calls
`POST /v1/mandates/{id}/charge` and returns the fresh, memory-only credential in
`paymentHandoff.credentials` with its `mandateId` and `transactionId`.

Minting the credential does not mean the merchant charged it or placed the
order. The public Prava REST API does not expose its Browser Harness checkout
operation, so Tokko presents the credential only to the authenticated caller
for the trusted merchant payment page. A Zepto-scoped mandate is not reused for
another merchant because Prava rejects listed-scope merchant mismatches.
Kapiva's current live profile advertises checkout but not catalogue search, so
its status is reported separately. See [the live merchant audit](UCP-MERCHANT-AUDIT.md)
for the tested India and US fulfillment matrix.

### External service routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/system/apis` | Return the live route catalog |
| `GET` | `/api/v1/system/db` | Return database and configuration diagnostics |
| `GET` | `/api/v1/system/db/records?limit=20` | Return sanitized recent records |
| `POST` | `/api/v1/onboarding` | Create or complete a family without requiring LINQ |
| `POST` | `/api/v1/linq/onboard` | Create or update LINQ family onboarding |
| `GET` | `/api/v1/linq/resolve?from=...&to=...` | Resolve LINQ numbers to a Tokko user |
| `GET` | `/api/v1/onboarding/:id` | Read consolidated onboarding state |
| `PUT` | `/api/v1/onboarding/:id/merchant-consent` | Grant or revoke merchant consent |
| `POST` | `/api/v1/onboarding/:id/payment/tokenization-session` | Start Prava card tokenization |
| `GET` | `/api/v1/onboarding/:id/payment-methods` | List masked cards owned by the resolved family |
| `GET` | `/api/v1/onboarding/:id/payment/mandates` | List the family's top five Prava mandates plus aggregate totals; use `?view=history&days=30` for one-month history |
| `POST` | `/api/v1/onboarding/:id/payment/mandates/session` | Start hosted approval for a standing Prava mandate |
| `POST` | `/api/v1/onboarding/:id/payment/complete` | Store a completed tokenized card |
| `GET` | `/api/v1/onboarding/:id/addresses` | List Tokko-owned family addresses and clear the obsolete Zepto address preference |
| `POST` | `/api/v1/onboarding/:id/addresses` | Add a Tokko-owned family address |
| `POST` | `/api/v1/onboarding/:id/addresses/select` | Select a Tokko-owned family address |
| `GET` | `/api/v1/integrations/telegram/bindings/:chatId/address-session` | Check whether this Telegram shopper session confirmed an address |
| `POST` | `/api/v1/integrations/telegram/bindings/:chatId/address-session` | Reset the Telegram address gate or confirm one family address |
| `POST` | `/api/v1/onboarding/:id/merchants/ucp/search` | Return a service-authenticated 50-product image page |
| `POST` | `/api/v1/onboarding/:id/merchant/zepto/connect/start` | Send or resend Zepto OTP |
| `POST` | `/api/v1/onboarding/:id/merchant/zepto/connect/verify` | Verify Zepto OTP |
| `GET` | `/api/v1/onboarding/:id/merchant/zepto/addresses` | List all saved Zepto addresses unless one is already confirmed |
| `POST` | `/api/v1/onboarding/:id/merchant/zepto/address/confirm` | Activate and persist one family delivery address |
| `POST` | `/api/v1/onboarding/:id/merchant/zepto/tools/:toolName` | Call an allowlisted Zepto MCP tool |
| `POST` | `/api/integrations/telegram/hermes` | Send a Telegram conversation turn to the family-scoped Hermes shopper |
| `POST` | `/api/integrations/telegram/hermes/mandate-options` | Return masked saved-card and add-card choices for a Telegram mandate |
| `POST` | `/api/integrations/telegram/hermes/payment-choice` | Apply a signed saved-card/add-card choice and continue checkout or mandate setup |

### Telegram Hermes endpoint

Set these variables in the Telegram bot deployment:

```dotenv
HERMES_ENDPOINT_URL=https://zepto-shop.vercel.app/api/integrations/telegram/hermes
HERMES_API_KEY=the-same-key-configured-in-tokko-external-api-keys
```

The bot calls `HERMES_ENDPOINT_URL` with `X-API-Key: $HERMES_API_KEY`. On the
first message for a chat, include one Tokko family identifier. A parent or
dependent phone resolves to the same shared family account:

```sh
curl -sS "$HERMES_ENDPOINT_URL" \
  -H "X-API-Key: $HERMES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "telegramChatId": "123456789",
    "familyPhone": "+919876543210",
    "text": "show the saved delivery addresses",
    "language": "en-IN"
  }' | jq
```

Tokko permanently binds that Telegram chat ID to the resolved family. Later
requests need only the chat ID and text:

```sh
curl -sS "$HERMES_ENDPOINT_URL" \
  -H "X-API-Key: $HERMES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "telegramChatId": "123456789",
    "text": "find one litre of milk",
    "language": "en-IN"
  }' | jq
```

The endpoint also accepts Telegram update-shaped JSON, including
`message.chat.id`, `message.from.username`, and `message.text`. Its response
contains `message`, optional `pendingAction`, `tools`, `model`, and:

```json
{
  "telegram": {
    "chatId": "123456789",
    "familyLinked": true
  }
}
```

For a write that returns `pendingAction`, show its description to the user.
After they confirm, repeat the request with the returned token in
`approvalToken`. Send the response's `message` back with Telegram's
`sendMessage` API. The endpoint stores a short, family-scoped chat history, so
the bot does not need to resend the entire conversation.

For mandate setup, a message such as `create a ₹500 any-merchant mandate`
returns `cardChoices`. Each existing choice contains masked card metadata and a
signed `token`; the final choice has `type: "add_card"`. Render all choices as
Telegram buttons without exposing the token in message text. When the user
selects one, post its token to the payment-choice endpoint:

```sh
curl -sS "$HERMES_ENDPOINT_URL/payment-choice" \
  -H "X-API-Key: $HERMES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "telegramChatId": "123456789",
    "botUsername": "TokkoShopperBot",
    "token": "signed-card-choice-token"
  }' | jq
```

A saved-card choice immediately returns the mandate `approvalUrl`. The add-card
choice returns a secure Prava card-enrollment URL and stores the pending mandate
on the Telegram chat. After enrollment, Prava redirects to
`/start payments_card_return`. Forward that ordinary Telegram update to the
main Hermes endpoint; Tokko detects the return, identifies the newly saved card,
and automatically creates the mandate approval session from it. The user must
still open the second Prava URL and approve the mandate with their passkey.

Bot adapters that do not use natural-language tool selection can call
`$HERMES_ENDPOINT_URL/mandate-options` directly with `telegramChatId`, `amount`,
`frequency`, and `merchantScope` to receive the same `cardChoices` contract.

To reconnect Zepto entirely through Telegram, send `reconnect zepto with otp`,
repeat the request with `approvalToken` after the user confirms, and then send
their six-digit OTP as the next ordinary `text` value. The backend finds the
latest unexpired family authentication attempt and verifies the OTP directly.
It does not persist the OTP or send it to the language model.

The endpoint can alternatively verify Telegram's
`X-Telegram-Bot-Api-Secret-Token` header when `TELEGRAM_WEBHOOK_SECRET` is set.
An API-key-authenticated bot adapter is recommended because this endpoint
returns Hermes JSON and does not itself call Telegram's `sendMessage` API.

## 1. Create an account or login

Website signup uses email and password. New accounts must verify the email with
a six-digit OTP. Existing accounts can then log in with either their email or
any uniquely linked account-holder/dependent phone number plus the same
password. Login does not require another OTP.

### Create account

Passwords must contain between 10 and 128 characters.

```sh
SIGNUP_RESPONSE="$(curl -sS \
  -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "asha@example.com",
    "password": "secure-password-123"
  }')"

echo "$SIGNUP_RESPONSE" | jq
CHALLENGE_ID="$(echo "$SIGNUP_RESPONSE" | jq -r '.challengeId')"
```

The browser then uses the configured Clerk JavaScript SDK to create a signup,
send the email code, and verify it. After Clerk returns a completed
`clerkSignUpId`, Tokko creates its website session:

```sh
curl -sS -c "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/auth/signup/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"challengeId\": \"$CHALLENGE_ID\",
    \"email\": \"asha@example.com\",
    \"clerkSignUpId\": \"sua_COMPLETED_CLERK_SIGNUP_ID\"
  }" | jq
```

The `clerkSignUpId` is accepted only when Clerk’s Backend API confirms that the
signup is complete and belongs to the same email. Use the website for the
complete interactive email-code flow; a standalone `curl` request cannot
perform Clerk’s browser verification step.

### Login to an existing account

With email:

```sh
curl -sS -c "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "asha@example.com",
    "password": "secure-password-123"
  }' | jq
```

With a linked phone number:

```sh
curl -sS -c "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876543210",
    "password": "secure-password-123"
  }' | jq
```

The browser accepts a country code and national number separately and
normalizes them to E.164 before sending this request. Phone login fails closed
when a number is not linked or is ambiguously linked to more than one account.

### Check the session

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/auth/session" | jq
```

### Read the complete account

This returns the account, family profile, dependent list, masked cards, consent,
and Zepto connection state.

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/me" | jq
```

### Logout

```sh
curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/auth/logout" | jq
```

There is no user-password login endpoint for an external microservice. External
services authenticate themselves and operate on an onboarding `userId`.

## 2. Add or update dependent information

`PUT /api/onboarding/profile` is a full replacement operation. It is not a
partial update. To add, edit, or remove one dependent:

1. Read the current state with `GET /api/me`.
2. Modify the `dependents` array.
3. Send the complete account-holder and dependent payload.

```sh
curl -sS -b "$COOKIE_JAR" \
  -X PUT "$BASE_URL/api/onboarding/profile" \
  -H "Content-Type: application/json" \
  -d '{
    "primaryParentName": "Asha Khan",
    "primaryParentPhone": "+919876543210",
    "primaryParentAge": 42,
    "primaryParentGender": "Woman",
    "secondaryParentName": "Ravi Khan",
    "secondaryParentPhone": "+919812345678",
    "dependents": [
      {
        "name": "Mira",
        "phone": "+919900112233",
        "relationshipToUser": "Daughter",
        "age": 19,
        "gender": "Woman"
      },
      {
        "name": "Leela",
        "phone": "+919911223344",
        "relationshipToUser": "Mother"
      },
      {
        "name": "Neel",
        "phone": "+919922334455",
        "relationshipToUser": "Other dependent",
        "otherRelationship": "Cousin"
      }
    ],
    "merchantAuthPhone": "+919876543210",
    "merchantAuthSubjectType": "account_holder"
  }' | jq
```

Use `merchantAuthSubjectType: "account_holder"` when
`merchantAuthPhone` is the account-holder phone. Use
`merchantAuthSubjectType: "dependent"` when it matches a dependent.

Dependents, age, and gender are optional. Age must be a whole number from 0 to
120 when supplied. Gender accepts a short user-provided identity. Trakko uses
these fields to avoid irrelevant or unsuitable wellness questions; they are
not sent to merchants as checkout data. A family can contain at most 20
dependents, and dependent phone numbers must be unique.

### Grant or revoke selected-phone consent

Grant consent:

```sh
curl -sS -b "$COOKIE_JAR" \
  -X PUT "$BASE_URL/api/onboarding/merchant-consent" \
  -H "Content-Type: application/json" \
  -d '{"consented":true}' | jq
```

Revoke consent:

```sh
curl -sS -b "$COOKIE_JAR" \
  -X PUT "$BASE_URL/api/onboarding/merchant-consent" \
  -H "Content-Type: application/json" \
  -d '{"consented":false}' | jq
```

Revoking consent removes the stored Zepto connection. Changing the selected
merchant-auth phone requires renewed consent and Zepto reconnection.

## 3. Add or update a tokenized card

Tokko does not accept raw card numbers or CVCs. Card enrollment uses Prava's
hosted checkout page in a separate browser tab. No Prava iframe or card form is
embedded in Tokko.

### Check whether Prava is enabled

```sh
curl -sS "$BASE_URL/api/config" | jq
```

`pravaConfigured` must be `true`. The Prava secret key remains server-side.

The publishable and secret keys must belong to the same Prava environment.
Prava requires an amount and purchase context when creating a session, so Tokko
uses a ₹1 authorize-only enrollment context. It is not submitted as a merchant
purchase.

### Step 1: Create a tokenization session

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/payments/tokenization-session" | jq
```

Example response:

```json
{
  "provider": "prava",
  "sessionId": "sess_123",
  "approvalUrl": "https://checkout.prava.space/s/sess_123",
  "expiresAt": "2026-07-28T12:15:00Z"
}
```

### Step 2: Open Prava's hosted page

Open `approvalUrl` verbatim in a new browser tab. Prava collects the card,
performs OTP and passkey verification, then redirects to
`https://zepto-shop.vercel.app/?pravaCard=return`.

### Step 3: Refresh the safe card list

Tokko calls Prava's server-side `listCards` API when the original tab regains
focus and every four seconds while setup is pending. The UI also provides an
explicit refresh button. Tokko stores only card IDs and masked metadata.

### List saved cards

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/payments/payment-methods" | jq
```

Repeating the tokenization flow adds another card and marks the newest
completed card as default. Existing cards remain stored. There is currently no
delete-card endpoint.

An authenticated browser may prove that a dependent resolves to the same family
while reading the shared masked cards:

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/payments/payment-methods?familyPhone=%2B919900112233" | jq
```

The phone must be the account holder, secondary parent, or a dependent in the
signed-in account. A phone from another family returns `403`; a phone never
replaces website authentication.

Prava enrollment IDs stored by Tokko are not sent to Zepto. For an approved
standing mandate, Tokko requests a fresh single-use Prava credential for the
final Zepto total. The credential is not stored in PostgreSQL or logs.

### Create and check a standing Prava mandate

Start mandate setup against a saved card:

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/payments/mandates/session" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentMethodId":"DATABASE_PAYMENT_METHOD_ID",
    "amount":"500.00",
    "frequency":"monthly"
  }' | jq
```

Open the returned `approvalUrl` once and approve it with the cardholder's
passkey. The amount is a per-charge cap, not a prepaid wallet balance. Tokko
sets the recurring validity window to Prava's documented horizon: one year for
weekly mandates, two years for monthly mandates, and five years for yearly
mandates.

After approval, list status:

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/payments/mandates" | jq
```

The default response returns at most five mandates while `summary` still
contains totals calculated across every mandate. Open the separate one-month
history view with:

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/payments/mandates?view=history&days=30" | jq
```

An `active` mandate lets a backend invoke
`POST /v1/mandates/{id}/charge` without a new passkey, OTP, or manually entered
CVV. Prava does not run a scheduled debit automatically: Tokko must initiate
each permitted charge, submit the returned single-use card credentials to the
merchant, and report the result to Prava.

For the wellness UCP flow, `POST /api/merchants/ucp/checkout` returns:

```json
{
  "merchantHandoffUrl": "https://merchant.example/checkout/...",
  "paymentUrl": null,
  "paymentLink": null,
  "paymentUrlAvailable": false,
  "paymentUrlStatus": "not_returned_by_shopify_ucp_general_access"
}
```

Shopify general-access Checkout MCP returns `continue_url`; it does not expose
a separate card-payment URL. Tokko therefore names this value
`merchantHandoffUrl` and never labels it as a payment link. When an eligible
Prava mandate exists, the same authenticated response also contains the
single-use Prava credential under `paymentHandoff`; the current public
secret-key integration does not submit that credential into Shopify.

Zepto's current MCP `create_online_payment_order` schema returns a secure
payment URL but has no card-credential input. Tokko therefore returns the
single-use credential only to the authenticated website checkout response,
keeps it in browser memory, and asks the user to enter it on Zepto's secure
card page. Automatic server-side insertion requires a future Zepto
card-credential API or a Prava Browser Harness that supports Zepto.

## 4. Choose a platform

### List platforms

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/platforms" | jq
```

Only Zepto is currently configured. There is no separate generic
`select-platform` endpoint. Selecting Zepto means:

1. Choose the account-holder or dependent phone in the family profile.
2. Grant merchant-auth consent.
3. Start Zepto authentication.
4. Verify the OTP.

### Check Zepto status

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/zepto-status" | jq
```

## 5. Open Zepto, send OTP, or resend OTP

### Send an OTP

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/merchant/zepto/connect/start" | jq
```

Example response:

```json
{
  "pendingId": "pending-auth-id",
  "merchant": "zepto",
  "phone": "+919876543210",
  "expiresInSeconds": 600
}
```

### Resend an OTP or reconnect

Call the same start endpoint again:

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/merchant/zepto/connect/start" | jq
```

Use the newest returned `pendingId`.

### Verify the OTP

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/merchant/zepto/connect/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "pendingId": "pending-auth-id",
    "otp": "123456"
  }' | jq
```

The pending authentication expires after 10 minutes. Successful verification
upserts the stored Zepto access/refresh token for the selected phone. Existing
valid tokens are reused, so reopening Zepto does not require another OTP.

There is no backend `open-platform` endpoint. “Open Zepto” is browser
navigation. Once connected, the caller can immediately use the Zepto-backed
address, product, cart, and order APIs.

## 6. Address APIs

Latitude and longitude are optional for address creation. When both are
omitted, Tokko resolves and caches an approximate pin from `shortAddress`
(area, city, and state) before calling Zepto. Tokko does not automatically ask
for browser location and does not run a separate serviceability check while
saving. Callers may still send both coordinates when they need a precise pin.

### Add an address

`buildingName` is optional. Tokko sends `Independent house` to Zepto when it is
omitted. `formattedAddress` is composed on the server.

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/addresses" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "HOME",
    "name": "Home",
    "flatDetails": "12A",
    "buildingName": "",
    "floor": "2",
    "landmark": "Near City Park",
    "shortAddress": "Salt Lake, Kolkata, West Bengal",
    "contactName": "Asha Khan",
    "contactNumber": "+919876543210"
  }' | jq
```

Allowed address types are `HOME`, `WORK`, and `OTHER`. If coordinates are
provided, send both as valid numbers; they cannot both be zero.

### List addresses

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/addresses" | jq
```

### Select an address

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/addresses/select" \
  -H "Content-Type: application/json" \
  -d '{"addressId":"ZEPTO_ADDRESS_ID"}' | jq
```

### Check location serviceability

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/location/serviceability" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 22.5726,
    "longitude": 88.3639
  }' | jq
```

## 7. Product, cart, and order APIs

### Search products

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/search?q=milk" | jq
```

### Get product details

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/product/PRODUCT_VARIANT_ID" | jq
```

### Read cart

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/cart" | jq
```

### Set a product quantity

Use identifiers returned by product search. Set `quantity` to `0` to remove the
product.

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/cart" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "+919876543210",
    "cartItems": [
      {
        "productVariantId": "PRODUCT_VARIANT_ID",
        "storeProductId": "STORE_PRODUCT_ID",
        "quantity": 2
      }
    ]
  }' | jq
```

### Read Zepto payment methods

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/payment-methods" | jq
```

This is distinct from Tokko’s Prava card endpoint
`/api/payments/payment-methods`.

### Preview or create a COD order

Preview:

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/order" \
  -H "Content-Type: application/json" \
  -d '{
    "userAddressId": "ZEPTO_ADDRESS_ID",
    "confirmOrder": false,
    "useZeptoCash": false,
    "riderTip": 0
  }' | jq
```

After confirming the preview, repeat with `"confirmOrder": true`.

### Preview or create an online-payment order

Use the same UUID `checkoutId` for the preview, each of the three card attempts,
and payment-status checks. Obtain `paymentMethodId` from
`GET /api/payments/payment-methods` and an active `mandateId` from
`GET /api/payments/mandates`. One mandate must individually cover the full
order; Zepto does not support splitting one payment across multiple mandate
credentials.

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/order/online" \
  -H "Content-Type: application/json" \
  -d '{
    "checkoutId": "11111111-1111-4111-8111-111111111111",
    "paymentMethodId": "42",
    "mandateId": "mdt_123",
    "userAddressId": "ZEPTO_ADDRESS_ID",
    "confirmOrder": false,
    "allowCodFallback": true,
    "useZeptoCash": false,
    "riderTip": 0
  }' | jq
```

The preview returns `priceBreakdown` using the taxes and charges supplied by
Zepto MCP. It never mints or returns a card credential. After explicit user
confirmation, repeat the request with `confirmOrder: true`:

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/order/online" \
  -H "Content-Type: application/json" \
  -d '{
    "checkoutId": "11111111-1111-4111-8111-111111111111",
    "paymentMethodId": "42",
    "mandateId": "mdt_123",
    "userAddressId": "ZEPTO_ADDRESS_ID",
    "confirmOrder": true,
    "allowCodFallback": true,
    "useZeptoCash": false,
    "riderTip": 0
  }' | jq
```

For production Prava keys, a pending Zepto payment returns a sensitive,
single-use handoff:

```json
{
  "paymentLink": "https://secure-payment-link-from-zepto.example",
  "paymentHandoff": {
    "mode": "prava_mandate",
    "mandateId": "mdt_123",
    "transactionId": "txn_123",
    "amount": "47.00",
    "currency": "INR",
    "credentials": {
      "token": "single-use-network-PAN",
      "dynamicCvv": "123",
      "expiryMonth": "12",
      "expiryYear": "2030"
    },
    "sentToZepto": false,
    "automaticInsertion": false,
    "requiresManualEntry": true,
    "storage": "memory_only"
  }
}
```

Never log, persist, cache, or retry the returned credentials. Open
`paymentLink`, enter the values on Zepto's card form, then call the payment
status endpoint. Tokko reports `APPROVED` or `DECLINED` to Prava when Zepto
returns a terminal status. Prava's public Browser Harness cannot be pointed at
this URL: it starts from a Shopify UCP checkout, while Zepto MCP's
`create_online_payment_order` accepts no card-credential field. Tokko therefore
does not claim that the virtual PAN was inserted automatically.

With Prava sandbox keys, each **Pay online** click first mints a fresh Prava
sandbox mandate transaction and then attempts the Zepto online order. Because
Zepto's live processor cannot complete a Prava sandbox credential, Tokko closes
every non-successful sandbox result—including `PENDING`, `PROCESSING`, and
merchant setup rejection—as a terminal sandbox failure and reports `DECLINED`
to Prava. This deterministic test behavior does not claim that Zepto processed
the sandbox card.

The browser reuses the same checkout ID across retries. Sandbox attempts one
and two remain retryable; attempt three changes the flow to
`COD_PERMISSION_REQUIRED` and displays explicit **Yes, place COD order** /
**No, keep my cart** controls. No COD order is created without that consent.

With production Prava credentials, pending Zepto payments remain open. The user
must manually enter the virtual PAN, expiry, and dynamic CVV on Zepto's page
because Zepto MCP has no credential-input field, then use **Check Zepto payment
status**. Only Zepto's terminal `FAILED`, `CANCELLED`, or `CANCELED` result
increments a production attempt.

Tokko stores each failed card attempt without marking payment as received.
Only a terminal Zepto failure after Prava issued a distinct mandate transaction
counts toward the three-attempt limit; setup, amount, and credential-minting
errors do not consume an attempt.
After the third failure it changes the flow to `COD_PERMISSION_REQUIRED`.
It does not create a COD order until the user explicitly approves it through
`POST /api/order/cod-decision`.
The cart should be cleared only when `checkoutFlow.status` is
`CARD_PAYMENT_RECEIVED`, `COD_CONFIRMED`, or `COD_FALLBACK_CONFIRMED` and a
Zepto order ID is present.

### Check online-payment status

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/order/payment-status" \
  -H "Content-Type: application/json" \
  -d '{
    "checkoutId": "11111111-1111-4111-8111-111111111111",
    "orderId": "ZEPTO_ORDER_ID",
    "poll": false
  }' | jq
```

### Approve or decline COD after three failures

Approve only after presenting the decision to the user:

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/order/cod-decision" \
  -H "Content-Type: application/json" \
  -d '{
    "checkoutId": "11111111-1111-4111-8111-111111111111",
    "approve": true
  }' | jq
```

Keep the cart and create no order:

```sh
curl -sS -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/api/order/cod-decision" \
  -H "Content-Type: application/json" \
  -d '{
    "checkoutId": "11111111-1111-4111-8111-111111111111",
    "approve": false
  }' | jq
```

### Check Prava payment results

Tokko's authenticated endpoint combines the selected checkout's Prava mandate
charge status with recent Prava session `payment-result` responses. Virtual PAN,
CVV, and cryptogram values are redacted:

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/payments/payment-results?checkoutId=11111111-1111-4111-8111-111111111111&limit=3" \
  | jq
```

Call Prava's payment-session result API directly:

```sh
PRAVA_API_BASE_URL="https://sandbox.api.prava.space"
PRAVA_SESSION_ID="ses_replace_me"

curl -sS \
  "$PRAVA_API_BASE_URL/v1/sessions/$PRAVA_SESSION_ID/payment-result" \
  -H "Authorization: Bearer $PRAVA_SECRET_KEY" \
  | jq
```

Check the mandate ledger after a charge/report:

```sh
PRAVA_MANDATE_ID="mdt_replace_me"

curl -sS \
  "$PRAVA_API_BASE_URL/v1/mandates/$PRAVA_MANDATE_ID" \
  -H "Authorization: Bearer $PRAVA_SECRET_KEY" \
  | jq
```

List all standing mandates for a Prava customer:

```sh
PRAVA_CUSTOMER_ID="tokko_user_replace_me"

curl -sS -G \
  "$PRAVA_API_BASE_URL/v1/mandates" \
  -H "Authorization: Bearer $PRAVA_SECRET_KEY" \
  --data-urlencode "customer_id=$PRAVA_CUSTOMER_ID" \
  --data-urlencode "standing_only=true" \
  | jq
```

The following call reports a merchant result to Prava and therefore **changes
state**. Use the real Zepto result; do not use it merely to inspect:

```sh
PRAVA_TRANSACTION_ID="txn_replace_me"

curl -sS \
  -X POST "$PRAVA_API_BASE_URL/v1/mandates/$PRAVA_MANDATE_ID/charges/$PRAVA_TRANSACTION_ID/report" \
  -H "Authorization: Bearer $PRAVA_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"txn_status":"DECLINED","txn_type":"PURCHASE","response_code":"05"}' \
  | jq
```

### Read checkout activity

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/checkout/activity?limit=10" | jq
```

Each entry separately exposes `cardPaymentReceived`, `cardFailureCount`,
`fallbackToCod`, the confirmed Zepto `orderId`, and the MCP
`priceBreakdown`.

### Order history

```sh
curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/orders?limit=10" | jq

curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/orders/ZEPTO_ORDER_ID" | jq

curl -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/past-items" | jq
```

## 8. External microservice API examples

Set the service credentials:

```sh
TOKKO_API_KEY="replace-with-a-key-from-EXTERNAL_API_KEYS"
SERVICE_AUTH=(-H "X-API-Key: $TOKKO_API_KEY")
```

The array syntax above is supported by Bash and Zsh. Alternatively, add the
header directly to every command.

### Create a family from Telegram or another service

This route creates the same family, dependent, Prava-customer, and merchant
consent records used by the website. It does not allocate a LINQ number:

```sh
curl -sS \
  -X POST "$BASE_URL/api/v1/onboarding" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "accountEmail": "asha@example.com",
    "primaryParentName": "Asha Khan",
    "primaryParentPhone": "+919876543210",
    "primaryParentAge": 42,
    "primaryParentGender": "Woman",
    "dependents": [
      {
        "name": "Mira",
        "phone": "+919900112233",
        "relationshipToUser": "Daughter",
        "age": 19,
        "gender": "Woman"
      }
    ],
    "merchantAuthPhone": "+919876543210",
    "merchantAuthSubjectType": "account_holder",
    "consent": {
      "useSelectedPhoneForMerchantAuth": true
    }
  }' | jq
```

The response includes `userId`, the shared Prava `customerId`, normalized
`profile`, and `merchantConsent`. The Telegram bridge supplies the returned
`userId` as `familyUserId` on its first Hermes request, which permanently binds
that Telegram chat to the new family.

### Create or update LINQ onboarding

```sh
curl -sS \
  -X POST "$BASE_URL/api/v1/linq/onboard" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "accountEmail": "asha@example.com",
    "primaryParentName": "Asha Khan",
    "primaryParentPhone": "+919876543210",
    "primaryParentAge": 42,
    "primaryParentGender": "Woman",
    "dependents": [
      {
        "name": "Mira",
        "phone": "+919900112233",
        "relationshipToUser": "Daughter"
      }
    ],
    "merchantAuthPhone": "+919876543210",
    "merchantAuthSubjectType": "account_holder",
    "consent": {
      "useSelectedPhoneForMerchantAuth": true
    },
    "sendWelcomeMessage": false
  }' | jq
```

The response contains `userId` and `linqNumber`. Onboarding is idempotent by
primary-parent phone. `accountEmail` is optional; providing it allows the same
family to be linked when that email signs up on the website.

LINQ variables must be configured. Otherwise this endpoint returns HTTP `503`.

### Resolve a LINQ caller

```sh
curl -sS \
  "$BASE_URL/api/v1/linq/resolve?from=%2B919876543210&to=%2B1234567890" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

### Read onboarding state

```sh
USER_ID="123"

curl -sS \
  "$BASE_URL/api/v1/onboarding/$USER_ID" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

Every external `/api/v1/onboarding/:id/...` route accepts either the numeric
`userId` or a URL-encoded E.164 phone belonging to the account holder,
secondary parent, or any dependent. Service authentication remains mandatory.
All of those identifiers resolve to the owning family before payment access.
The account holder and every dependent therefore receive the same persisted
Prava `customerId`; Tokko never creates a separate Prava customer from a
dependent phone number.
For example, use a dependent's phone to resolve the owning family and list its
masked cards:

```sh
DEPENDENT_PHONE="%2B919900112233"

curl -sS \
  "$BASE_URL/api/v1/onboarding/$DEPENDENT_PHONE/payment-methods" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

The response includes the canonical family ID:

```json
{
  "userId": 42,
  "customerId": "tokko_family_42",
  "paymentMethods": []
}
```

Existing families retain their original Prava customer ID so already-tokenized
cards and mandates remain attached; it is still shared by every family phone.

The same phone identifier can be used with the Zepto tool route:

```sh
curl -sS \
  -X POST \
  "$BASE_URL/api/v1/onboarding/$DEPENDENT_PHONE/merchant/zepto/tools/view_cart" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq
```

This uses the owning family's stored Zepto connection and payment preferences.
Raw Prava card identifiers and credentials are never returned.

There is currently no generic
`PUT /api/v1/onboarding/:id/profile` endpoint. External family updates use the
LINQ onboarding endpoint and must resubmit the complete family payload.

### Update consent

```sh
curl -sS \
  -X PUT "$BASE_URL/api/v1/onboarding/$USER_ID/merchant-consent" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"consented":true}' | jq
```

### Start and complete card setup

```sh
curl -sS \
  -X POST \
  "$BASE_URL/api/v1/onboarding/$USER_ID/payment/tokenization-session" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "returnContext": {
      "channel": "telegram",
      "botUsername": "TokkoShopperBot"
    }
  }' | jq
```

Open the returned `approvalUrl` in a browser. After the cardholder finishes the
hosted Prava flow, list the synchronized cards:

```sh
curl -sS \
  -X GET "$BASE_URL/api/v1/onboarding/$USER_ID/payment-methods" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  | jq
```

List the family's standing mandates:

```sh
curl -sS \
  "$BASE_URL/api/v1/onboarding/$USER_ID/payment/mandates" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

The Telegram/API counterpart can retrieve every mandate with activity in the
last 30 days through the history view:

```sh
curl -sS \
  "$BASE_URL/api/v1/onboarding/$USER_ID/payment/mandates?view=history&days=30" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

Create a mandate approval session against one returned payment-method `id`:

```sh
curl -sS \
  -X POST \
  "$BASE_URL/api/v1/onboarding/$USER_ID/payment/mandates/session" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentMethodId": "7",
    "amount": "500.00",
    "frequency": "monthly",
    "returnContext": {
      "channel": "telegram",
      "botUsername": "TokkoShopperBot"
    }
  }' | jq
```

Open the returned `approvalUrl` to approve with Prava. The amount is a
per-charge authorization cap, not stored balance, and creating the mandate
does not deduct money.

For a one-time mandate that the Telegram bot may use at any merchant, send
`frequency: "one_time"` with `merchantScope: "any"`:

```sh
curl -sS \
  -X POST \
  "$BASE_URL/api/v1/onboarding/$USER_ID/payment/mandates/session" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentMethodId": "7",
    "amount": "500.00",
    "frequency": "one_time",
    "merchantScope": "any",
    "returnContext": {
      "channel": "telegram",
      "botUsername": "TokkoShopperBot"
    }
  }' | jq
```

Prava permits `any` only for one-time mandates. Weekly, monthly, and yearly
mandates remain merchant-scoped and must use `merchantScope: "listed"`.

`returnContext` is optional. When omitted, Prava returns to the Tokko website.
For `channel: "telegram"`, Tokko validates the bot username, receives Prava's
return on `/api/payments/return`, and redirects to the same bot using a Telegram
deep link. Arbitrary return URLs are not accepted.

### Send, resend, or reconnect Zepto OTP

```sh
curl -sS \
  -X POST \
  "$BASE_URL/api/v1/onboarding/$USER_ID/merchant/zepto/connect/start" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

Call the same endpoint again to resend an OTP. Verify using the latest
`pendingId`:

```sh
curl -sS \
  -X POST \
  "$BASE_URL/api/v1/onboarding/$USER_ID/merchant/zepto/connect/verify" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "pendingId": "pending-auth-id",
    "otp": "123456"
  }' | jq
```

### Call a Zepto tool

```sh
curl -sS \
  -X POST \
  "$BASE_URL/api/v1/onboarding/$USER_ID/merchant/zepto/tools/list_saved_addresses" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq
```

Allowlisted tool names:

- `list_saved_addresses`
- `get_location_serviceability`
- `select_store`
- `add_saved_address`
- `select_saved_address`
- `search_products`
- `get_product_details`
- `view_cart`
- `update_cart`
- `get_payment_methods`
- `create_order`
- `create_online_payment_order`
- `check_payment_status`
- `list_order_history`
- `get_order_detail`
- `get_past_order_items`

The JSON request body is passed as that tool’s arguments.

## 9. System and database diagnostics

### Public health

```sh
curl -sS "$BASE_URL/api/health" | jq
curl -sS "$BASE_URL/api/config" | jq
```

### Complete live API catalog

```sh
curl -sS \
  "$BASE_URL/api/v1/system/apis" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

### Database health and row counts

```sh
curl -sS \
  "$BASE_URL/api/v1/system/db" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

### Sanitized recent database records

```sh
curl -sS \
  "$BASE_URL/api/v1/system/db/records?limit=20" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

The records endpoint is capped at 50 entries. It never returns password hashes,
session tokens, database credentials, raw card data, Prava enrollment IDs,
Zepto access tokens, or refresh tokens.

## 10. LINQ webhook

```text
POST /api/webhooks/linq
```

Configure LINQ to send Standard Webhooks signature headers. Tokko verifies the
signature and timestamp and deduplicates events by webhook ID.

## Error responses

Typical response:

```json
{
  "error": "Human-readable explanation"
}
```

Common status codes:

| Status | Meaning |
| --- | --- |
| `400` | Invalid or missing request fields |
| `401` | Missing/expired website session or invalid service credential |
| `403` | Consent missing, platform disconnected, or wrong authenticated phone |
| `404` | Route, onboarding, platform, or record not found |
| `409` | Required profile/setup state is incomplete or conflicting |
| `503` | Prava, LINQ, or merchant OAuth is not configured |

Some Zepto MCP operations may return a tool-level message inside an HTTP `200`
response. Callers should inspect the response body instead of relying only on
the HTTP status.
