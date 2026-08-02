# Tokko

**Live app:** [tokko-drab.vercel.app](https://tokko-drab.vercel.app)

Tokko is a warm, agentic family-care assistant for health, wellness and everyday
essentials. Family members ask through a familiar messaging channel; Tokko
understands the request, checks family context and payment rules, and pauses for
human judgment when needed.

This private hackathon repository combines the Tokko onboarding/dashboard UI
with the standalone Node/Postgres backend from `feat/backend-integ`. Local
credentials, deployment linkage, generated test reports and installed
dependencies are intentionally excluded.

## Integrated web experience

The React frontend is connected to the backend's real contracts:

- email/password login and Clerk email-code signup
- opaque HttpOnly website sessions
- `/api/me` account hydration
- phone-first family onboarding with stable member IDs and archival removal
- assigned delivery addresses with explicit country and contact details
- ask-every-time or bounded automatic care rules
- masked Prava cards and standing mandate summaries
- a persisted **Needs You** decision inbox and activity timeline
- notification preferences and honest empty/provider-error states

The current backend exposes Hermes through Telegram and LINQ/service adapters.
The UI keeps the broader family-messaging product language; a native iMessage
transport adapter is not yet implemented and should not be represented as live.

This Node application supports two onboarding channels:

- Website: direct email/password sign-up creates an opaque, HttpOnly server session.
- LINQ: an authenticated external service creates a family profile, receives one of the
  partner's provisioned LINQ numbers, and can use the service APIs on that family's behalf.

Both channels store the same family profile and a list of members with their
relationships to the account holder. The website additionally persists address
assignments, care rules, notification preferences, decision requests and activity.
Legacy merchant-consent and Zepto routes remain available for integration
compatibility but are not part of the Tokko web onboarding or dashboard.

## Security model

- Website APIs require the email session cookie. Passwords are stored only as salted
  scrypt hashes and session tokens are stored only as SHA-256 hashes.
- `/api/v1/*` integration APIs require a Clerk machine token (`m2m_token`) or an
  `X-API-Key` listed in `EXTERNAL_API_KEYS`.
- `POST /api/v1/onboarding` lets trusted Telegram or service integrations create
  the normal Tokko family profile without requiring LINQ provisioning.
- `/api/webhooks/linq` verifies Standard Webhooks HMAC signatures and rejects deliveries
  older than five minutes.
- Card setup opens Prava's hosted page in a separate tab. Card number and CVC
  never enter Tokko's page or backend.
  PostgreSQL stores only the Prava enrollment ID, brand, last four digits, and expiry.
- An account-holder phone is optional. Each active family member needs a distinct
  E.164 messaging number, and removing a member archives the record and revokes
  new phone-based access without erasing the audit trail.
- Website delivery addresses require a country, contact name and contact phone.
  Automatic care is never inferred from a saved card alone: Tokko still verifies
  an active Prava mandate and the current care-rule limits at order time.
- Zepto OTP can only be requested after an explicit, versioned consent record authorizes
  use of the currently selected phone. Revoking consent removes the Zepto token.
- Card saving is optional. When Prava keys are blank, the browser explains that
  tokenization is unavailable and still allows access to the family account.
- Checkout shows the default masked Prava card as the preferred card. An active
  Zepto-scoped mandate mints a fresh, amount-scoped Prava PAN/CVV after Zepto
  confirms the final total. Zepto MCP returns a secure payment link but has no
  card-credential input, so Tokko keeps the credential only in browser memory for
  manual entry on that page. It stores only Prava mandate/transaction references and
  reports Zepto's terminal result back to Prava. With sandbox keys, Tokko can show
  the actual one-time sandbox token for inspection, immediately closes the simulated
  charge as declined, and never creates or modifies a live Zepto order by default.
  A separate explicit opt-in can create a real Zepto hosted-payment attempt for
  manual entry of the sandbox virtual PAN; that path permanently disables COD
  fallback for the attempt and preserves the cart on rejection. After three
  distinct production terminal failures, a confirmed checkout can
  fall back to **Cash on Delivery**; pending or unknown status never triggers COD.
- Zepto connection uses the phone chosen during family onboarding. The first
  connection sends an OTP to that phone. The resulting
  access token, refresh token, and MCP session are persisted in PostgreSQL, so later
  shopping requests work without another OTP. Users can explicitly reconnect with a
  new OTP, which replaces the stored token and records the authenticated phone. Saved
  addresses are available through Ask Tokko. Coordinates are optional during address
  creation: Tokko estimates a pin from the area/city/state when they are omitted,
  while browser location remains an explicit opt-in for a more precise pin.
- The signed-in Family page includes **Add or manage dependents**, which reopens the
  populated family editor without creating a new account or repeating signup.
- The **Ask Tokko** tab searches Shopify Global Catalog UCP plus audited health
  and wellness merchants serving India and the US. Selecting a product calls
  the merchant's `create_checkout`, sends the saved shipping address and E.164
  phone, selects a quoted shipping option when needed, and displays every
  merchant-provided total line before the secure `continue_url` handoff.

## Run locally

Requires Node.js 20.9 or newer and PostgreSQL.

```sh
cp .env.example .env
npm install
node --env-file=.env server.js
```

Open `http://localhost:3456`.

## Deploy to Vercel

1. Import this directory as a Vercel project. Vercel serves the Vite build from
   `public` and routes `/api/*` through `api/server.js`, which adapts the existing
   Node HTTP handler without changing its API contracts. `server.js` remains the
   local entrypoint.
2. Add a Postgres provider from the Vercel Marketplace (Neon is one option) and ensure it
   injects `DATABASE_URL`.
3. Add all required values from `.env.example` to the project environment variables.
4. Set `BASE_URL` to the production HTTPS origin. Configure matching Clerk
   publishable/secret keys and enable email/password signup with email-code
   verification in that Clerk instance.
5. In LINQ, use a provisioned partner line and create a webhook subscription pointing to
   `https://YOUR_DOMAIN/api/webhooks/linq?version=2026-02-03`. Put the returned signing
   secret in `LINQ_WEBHOOK_SECRET`.
6. Deploy. Database tables and configured merchant rows are created idempotently at
   startup.

The complete command-by-command runbook, smoke tests, direct database checks, and
troubleshooting table are in [Deploy and verify](docs/DEPLOY_AND_CHECK.md).
Hermes configuration, its chat contract, and the approval flow are in
[Hermes personal shopper](docs/HERMES.md).

LINQ does not offer a self-serve V3 endpoint that creates or deletes phone numbers.
Numbers must first be provisioned on the partner account by a LINQ representative. The
onboarding API consistently assigns one of those usable lines and returns it.

## External integration API

Send either `Authorization: Bearer <CLERK_M2M_TOKEN>` or
`X-API-Key: <configured key>` on every `/api/v1` request.

Use these protected diagnostics after every deployment:

- `GET /api/v1/system/apis` returns the consolidated live route catalog.
- `GET /api/v1/system/db` confirms the database connection, table counts, and required
  service configuration without returning secrets.
- `GET /api/v1/system/db/records?limit=20` returns recent sanitized onboarding records,
  masked card metadata, and connection booleans without hashes or tokens.

The consolidated auth and route matrix is in [Backend API](docs/API.md).

### Onboard through LINQ

`POST /api/v1/linq/onboard`

```json
{
  "accountEmail": "asha@example.com",
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
  "merchantAuthSubjectType": "account_holder",
  "consent": {
    "useSelectedPhoneForMerchantAuth": true
  },
  "sendWelcomeMessage": true
}
```

The response includes `userId` and `linqNumber`. The request is idempotent by primary
parent phone; its welcome message uses a stable LINQ idempotency key. The legacy
`dependentName`, `dependentPhone`, `dependentRelationship`, and
`merchantAuthDependentPhone` fields remain accepted for integrations that submit a
single dependent.

### Resolve an inbound LINQ conversation

`GET /api/v1/linq/resolve?from=%2B919876543210&to=%2B12025551234`

This maps the sender plus assigned LINQ number to the Tokko `userId`.

### Read status and update consent

- `GET /api/v1/onboarding/:id`
- `PUT /api/v1/onboarding/:id/merchant-consent` with
  `{"consented": true}` or `{"consented": false}`

### Tokenize a card

- `POST /api/v1/onboarding/:id/payment/tokenization-session`
- Open the returned `approvalUrl` on Prava's hosted page in a separate tab.
- Telegram callers may send
  `{"returnContext":{"channel":"telegram","botUsername":"TokkoShopperBot"}}`
  so the hosted flow returns to the originating bot instead of the web app.
- Telegram callers may create a one-time, any-merchant mandate with
  `{"frequency":"one_time","merchantScope":"any"}`. Recurring mandates must
  remain `merchantScope: "listed"`.
- Telegram mandate setup returns every masked saved card plus an add-new-card
  choice. Selecting a saved card starts mandate approval immediately. Selecting
  add-card opens Prava enrollment and persists the pending intent; when the bot
  forwards `/start payments_card_return`, Tokko automatically continues with
  the newly saved card and returns the mandate approval URL.
- After the cardholder completes OTP and passkey verification, call
  `GET /api/v1/onboarding/:id/payment-methods` to synchronize and list cards.

Do not add an API that accepts raw PAN or CVC values.

### Connect Zepto using the consented phone

- `POST /api/v1/onboarding/:id/merchant/zepto/connect/start`
- Give the six-digit code received by the selected account holder or dependent to
  `POST /api/v1/onboarding/:id/merchant/zepto/connect/verify`:

```json
{
  "pendingId": "returned-by-connect-start",
  "otp": "123456"
}
```

OTP state is stored in PostgreSQL, so start and verify can hit different Vercel instances.

### Call the Zepto backend for a LINQ user

`POST /api/v1/onboarding/:id/merchant/zepto/tools/:toolName`

The JSON request body is passed as tool arguments. Only the allowlisted tools used by this
shop are exposed. Consent and a valid Zepto connection are checked on every call.

Example:

```sh
curl -X POST "$BASE_URL/api/v1/onboarding/42/merchant/zepto/tools/search_products" \
  -H "X-API-Key: $TOKKO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"milk"}'
```

## Website API

The browser sends its opaque HttpOnly website-session cookie. Existing users
can create it with either email + password or a uniquely linked family phone +
password:

- `POST /api/auth/signup`
- `POST /api/auth/signup/verify`
- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/me`
- `PUT /api/onboarding/profile` with the same account-holder, guardian, `dependents`
  list, `merchantAuthPhone`, and `merchantAuthSubjectType` used by LINQ onboarding
- `PUT /api/onboarding/merchant-consent`
- `POST /api/payments/tokenization-session`
- `POST /api/payments/payment-methods`
- `POST /api/merchant/zepto/connect/start`
- `POST /api/merchant/zepto/connect/verify`
- `POST /api/hermes/chat`

The existing shopping routes remain under `/api/addresses`, `/api/search`, `/api/cart`,
`/api/payment-methods`, `/api/order`, and `/api/orders`; they require a signed-in
website session plus current merchant consent.
