# Hermes personal shopper

Tokko exposes an authenticated Hermes chat endpoint at:

```text
POST /api/hermes/chat
```

Telegram bot adapters use:

```text
POST /api/integrations/telegram/hermes
```

The integration follows the Hermes agent tool loop and uses Gemini as its
model provider. Product discovery calls Shopify Global Catalog UCP for the
selected delivery market and also queries Tokko's audited India and US merchant
profiles. Results are grouped by delivery market and currency, then sorted by
native price inside each group.

Upstream project: <https://github.com/nousresearch/hermes-agent>

## Required environment

```dotenv
GEMINI_API_KEY=replace-with-a-google-ai-studio-key
GEMINI_MODEL=gemini-3.5-flash-lite
HERMES_ACTION_SECRET=replace-with-a-long-random-secret
UCP_AGENT_PROFILE_URL=https://zepto-shop.vercel.app/.well-known/ucp
UCP_SELECTION_SECRET=replace-with-a-long-random-secret
```

`GOOGLE_API_KEY` is accepted as an alias for `GEMINI_API_KEY`.
`HERMES_ACTION_SECRET` is recommended in production. If it is omitted, Tokko
derives an isolated approval-signing key from the server-only Gemini key.

For a Telegram bot adapter, configure:

```dotenv
HERMES_ENDPOINT_URL=https://zepto-shop.vercel.app/api/integrations/telegram/hermes
HERMES_API_KEY=replace-with-a-key-from-tokko-external-api-keys
```

`HERMES_ENDPOINT_URL` and `HERMES_API_KEY` belong in the bot deployment.
`HERMES_API_KEY` must match one of Tokko's comma-separated
`EXTERNAL_API_KEYS`. The first request for a Telegram chat includes
`familyEmail`, `familyPhone`, or `familyUserId`; later requests reuse the
stored chat-to-family binding and server-side conversation history. See the
[API guide](API.md#telegram-hermes-endpoint) for complete examples.

The `tokko-shopper` bridge first calls `GET /api/v1/onboarding/:phone`. If the
phone has no completed family profile, it collects the account holder,
dependents, relationships, selected merchant-auth phone, and explicit consent,
then calls `POST /api/v1/onboarding`. The returned numeric `userId` is supplied
to this endpoint as `familyUserId`, so the newly onboarded chat can begin
shopping immediately.

After family resolution, the bridge calls
`GET /api/v1/onboarding/:id/addresses` and renders every Tokko-owned address as
a Telegram checkbox. The chosen checkbox is sent to
`POST /api/v1/onboarding/:id/addresses/select`. If none exist, Telegram prompts
for a new address and stores it with `POST /api/v1/onboarding/:id/addresses`.
These routes use Tokko's PostgreSQL database and never call Zepto MCP. Every
fresh browser shopper view and Telegram `/start` requires an explicit address
choice before a product request is sent to Hermes. A previously selected
database address is displayed but is not silently reused for the new session.

The browser provides **List**, **Reselect**, and **Add** controls. After an
address has been selected, the composer also understands `/addresses`,
`/reselect`, and `/addaddress`. Telegram exposes those same three slash
commands in its command menu and provides **Addresses** and **Add Address**
reply-keyboard buttons.

Product discovery returns pages of at most 50 products. Results without an
HTTPS image are excluded, and the remaining products are sorted by price from
lowest to highest. Telegram sends those images in media groups and offers
**Show 50 More** only when the response has another page.

The Telegram bridge also provides a deterministic `/payments` menu outside the
model tool loop. It can open Prava's hosted card enrollment, refresh all masked
family cards, show the five most relevant standing mandates, open a separate
last-30-day history view, and create weekly, monthly, or yearly mandate
approval sessions. Card data and passkeys remain on Prava's hosted origin; the
bridge receives only masked card metadata and approval URLs.

## Request

The browser sends only recent user and assistant text:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "show my saved addresses"
    }
  ],
  "language": "bn-IN"
}
```

The server:

1. verifies the Tokko website session;
2. resolves the shared family account;
3. discovers the three merchants' live `/.well-known/ucp` profiles;
4. calls every advertised UCP `search_catalog` tool and sorts valid matches by price;
5. returns product cards containing opaque, signed selections;
6. calls the selected merchant's UCP `create_checkout` tool;
7. reads the exact UCP total and checks every active Prava mandate for the family;
8. if a merchant-compatible mandate covers the total, calls Prava's mandate
   Charge API and receives the fresh single-use credential;
9. returns Shopify's exact merchant checkout handoff and the ephemeral Prava
   credential handoff.

The Charge API only mints the payment credential. It does not mean that Shopify
charged it or placed an order. Shopify storefronts normally return
`requires_escalation`, which means the buyer continues on the merchant-hosted
checkout URL to provide shipping details, review, and submit payment. Shopify's
general-access Checkout MCP does not return a separate payment-only URL, so
Tokko exposes `merchantHandoffUrl` and leaves `paymentUrl` as `null`.

The shopper answers in English by default. It supports `en-IN`, `hi-IN`,
`bn-IN`, `ta-IN`, `te-IN`, `mr-IN`,
`gu-IN`, `kn-IN`, `ml-IN`, and `pa-IN`. The browser can read each response
aloud with the device's matching regional voice. Speech synthesis stays in the
browser, so no audio or family data is sent to a separate voice service.
The microphone control records a short clip locally and sends it to the
authenticated `/api/hermes/transcribe` endpoint for Gemini audio transcription
in the selected language. This avoids the browser speech-recognition network
service that can fail independently of Tokko. Browsers without `MediaRecorder`
fall back to their native speech-recognition capability. The transcript is
placed in the composer for review and is submitted only when the person presses
Send.

## Reconnect Zepto in chat

Website and Telegram conversations can reconnect the family's selected Zepto
phone without leaving Hermes:

1. Say `reconnect zepto with otp`.
2. Approve the signed `start_zepto_reconnect` action. Tokko sends an OTP only
   to the phone already selected and consented for merchant authentication.
3. Reply with the six-digit OTP within ten minutes.
4. Tokko verifies it against the latest family-scoped authentication attempt,
   replaces the stored Zepto session, and refreshes website account state.

The six-digit code is handled deterministically by the backend. It is never
sent to Gemini, included in an approval token, or saved in Telegram message
history. Reconnect remains available when the existing Zepto access token is
missing or expired, because it is a Tokko-owned tool rather than a Zepto MCP
tool.

For broad product requests, Tokko first checks recent orders, compares the full
Zepto result, then asks whether to choose the cheapest or healthiest suitable
option. It can also inspect the cart, infer a likely meal, and suggest missing
ingredients. Multiple accepted ingredients are signed together and require one
approval before their individual Zepto cart updates run.

The shopper starts by asking the user to select a saved delivery address. The
current wellness UCP catalogue searches are country-scoped rather than
address-stock-scoped, but the explicit selection gives the merchant checkout
the family's intended delivery context and prevents a previous session's
address from being silently reused.

## Adaptive family memory

Tokko does not keep a hardcoded regional grocery dictionary. It stores
family-scoped memories in `hermes_memories`, including explicit vocabulary
corrections, successful search queries, recurring Zepto products, approved cart
choices, and the last selected delivery-address label. Relevant memories are
retrieved for later Hermes turns and accumulate confidence as evidence repeats.

A person can teach Tokko naturally, for example by saying that a family word
means a catalogue term. Explicit corrections receive higher confidence than
inferences from searches. Memories are isolated by the shared family `user_id`
and are deleted automatically if that family account is deleted.

This is retrieval-based adaptation. The Gemini API does not update model
weights from a live conversation, so Tokko does not describe this behavior as
model fine-tuning or claim that the underlying model retrained itself.

The signed-in family can inspect the memories used by Hermes:

```bash
curl -fsS https://zepto-shop.vercel.app/api/hermes/memory \
  -b cookies.txt | jq
```

## Approval for writes

Address changes, cart changes, account updates, payment creation, and order
placement never execute on the first model request. The response contains a
signed, family-scoped, ten-minute approval:

```json
{
  "message": "ready to save this address. good to send?",
  "pendingAction": {
    "token": "server-signed-one-time-action",
    "toolName": "add_saved_address",
    "description": "save this address to the linked zepto account: home",
    "expiresInSeconds": 600
  }
}
```

After the person presses `Yes, approve`, the browser sends:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "save home as 12a park street, kolkata"
    }
  ],
  "approvalToken": "server-signed-one-time-action"
}
```

The backend verifies the signature, family ID, expiry, and current Zepto tool
availability before executing it. The token contains no Zepto credential.
Approved actions return their Zepto result directly without spending another
Gemini request, so a later model quota limit cannot turn a completed write into
a false failure.

## Checkout payment policy

When Hermes is asked to place the current cart, it uses the server-owned
`checkout_current_cart` action. One explicit chat approval authorizes this
ordered policy:

1. fetch Zepto's payable total and list every standing Prava mandate;
2. choose the smallest active, INR, Zepto-compatible mandate that individually
   covers the full total;
3. if none covers it, create a normal one-time Prava session with the default
   saved card;
4. if neither online route can start and the approved action allows it, restore
   the cart if necessary and place Cash on Delivery.

A mandate charge does not ask for another passkey. A normal card transaction
does: the chat displays Prava's hosted approval URL, then calls the authenticated
continuation endpoint after the person selects `I Approved, Continue`:

```bash
curl -fsS https://zepto-shop.vercel.app/api/hermes/checkout/continue \
  -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"checkoutId":"11111111-1111-4111-8111-111111111111"}' | jq
```

The continuation reads Prava's payment result and reports the eventual Zepto
outcome to Prava. Prava credentials remain single-use. Zepto MCP currently
returns a hosted payment link without a card-credential input, so the chat
shows the ephemeral virtual card only in the authenticated payment action and
does not claim server-side insertion.

## Deployment check

```bash
curl -fsS https://zepto-shop.vercel.app/api/config | jq '{
  hermesConfigured,
  hermesProvider,
  hermesModel,
  hermesRuntime
}'
```

The chat endpoint requires the website's `plantri_session` HttpOnly cookie, so
an unauthenticated curl should return `401`:

```bash
curl -i -X POST https://zepto-shop.vercel.app/api/hermes/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"show my saved addresses"}]}'
```
