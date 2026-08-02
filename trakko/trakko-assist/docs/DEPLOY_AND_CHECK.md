# Deploy and verify

## 1. Prerequisites

- Node.js 20.9 or newer
- A Vercel account and Vercel CLI
- A Clerk instance with email/password signup and email verification codes enabled
- Prava sandbox keys when card tokenization is enabled
- A LINQ partner API key and at least one already-provisioned LINQ number when LINQ
  onboarding is enabled
- A Zepto OAuth client, or a Zepto authorization server that supports dynamic client
  registration
- `psql` for the optional direct database checks

From the project directory:

```sh
cd /Users/nilufa.islam/zepto-shop
npm install
npm test
npx vercel login
npx vercel link
```

## 2. Create and connect PostgreSQL

In the Vercel dashboard:

1. Open the project's **Storage** tab.
2. Install a Postgres provider from the Marketplace, such as Neon.
3. Create the database in a region close to the Vercel Functions.
4. Connect it to this project.
5. Confirm that the integration supplied `DATABASE_URL` to Production and Preview.

No separate migration command is needed for the first deployment. The server creates
the schema idempotently when it starts. Use the provider's pooled connection string for
serverless traffic when it offers one.

## 3. Configure environment variables

Use [`.env.example`](../.env.example) as the checklist. Set these in Vercel Project
Settings for Production, and use test credentials for Preview:

```text
BASE_URL
CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
CLERK_AUTHORIZED_PARTIES
EXTERNAL_API_KEYS
GEMINI_API_KEY
GEMINI_MODEL
HERMES_ACTION_SECRET
TELEGRAM_WEBHOOK_SECRET
TELEGRAM_DEFAULT_FAMILY_EMAIL
DATABASE_URL
PGPOOL_MAX
LINQ_API_KEY
LINQ_WEBHOOK_SECRET
LINQ_PHONE_NUMBER
LINQ_PHONE_NUMBER_ID
PRAVA_PUBLISHABLE_KEY
PRAVA_SECRET_KEY
PRAVA_API_BASE_URL
PRAVA_MERCHANT_URL
PRAVA_MERCHANT_NAME
PRAVA_MERCHANT_COUNTRY_CODE
PRAVA_CARD_ENROLLMENT_AMOUNT
PRAVA_CARD_ENROLLMENT_CURRENCY
ZEPTO_OAUTH_CLIENT_ID
ZEPTO_OAUTH_REDIRECT_URI
CONSENT_POLICY_VERSION
```

Notes:

- `BASE_URL` is the final HTTPS origin, with no trailing slash.
- New-account email OTPs are sent and verified by the configured Clerk
  instance. In Clerk Dashboard, enable **Sign-up with email**, **Verify at
  sign-up → Email verification code**, and **Sign-up with password**. The
  publishable and secret keys must belong to the same Clerk instance.
- `EXTERNAL_API_KEYS` is a comma-separated emergency/fallback key list. Generate long,
  random values. `CLERK_AUTHORIZED_PARTIES` is only needed for Clerk session
  validation outside the signup flow.
- A Telegram bot adapter sets
  `HERMES_ENDPOINT_URL=https://zepto-shop.vercel.app/api/integrations/telegram/hermes`
  and sets `HERMES_API_KEY` to one value from this server's
  `EXTERNAL_API_KEYS`. `TELEGRAM_WEBHOOK_SECRET` is needed only when Telegram
  posts updates directly. `TELEGRAM_DEFAULT_FAMILY_EMAIL` is an optional
  single-family shortcut; otherwise the bot supplies a family identifier on
  the first chat request.
- Leave the LINQ values blank to disable LINQ onboarding while testing the website.
- `LINQ_PHONE_NUMBER` and `LINQ_PHONE_NUMBER_ID` are optional if the partner account can
  list its provisioned numbers.
- Leave both Prava key values blank to disable card tokenization. Website onboarding still
  completes. Zepto is connected later from the signed-in Platforms page. Search, Cart,
  and Orders remain hidden until a platform is selected.
- The Prava publishable and secret keys must both be sandbox keys or both be production
  keys. The API host is derived from their prefixes unless `PRAVA_API_BASE_URL` is set.
- Add the production and preview frontend origins to the allowed-domain list in the
  Prava dashboard. `PRAVA_MERCHANT_URL` must be an HTTPS URL.
- Saved-card checkout requires both Prava keys. The saved Prava enrollment ID remains
  inside Tokko; Zepto's **Pay Online (UPI / Cards / Wallets)** payment link securely
  collects the card again because Zepto does not accept third-party enrollment IDs.
- Zepto currently accepts the loopback redirect
  `http://localhost:3456/auth/callback` for dynamic clients. The application exchanges
  the authorization code server-side; the browser is not navigated to localhost.
- Mark all secret keys, API keys, webhook secrets, and `DATABASE_URL` as sensitive.
- Do not put real card details, Prava enrollment IDs, or merchant access tokens in
  environment variables.

Audit the configured names without printing their values:

```sh
npx vercel env ls production
npx vercel env ls preview
```

To enter the two required Prava values through encrypted terminal prompts, without
creating or updating a local env file:

```sh
npx vercel env add PRAVA_PUBLISHABLE_KEY production
npx vercel env add PRAVA_SECRET_KEY production
npx vercel --prod
```

Use a matching pair (`pk_test_*` + `sk_test_*`, or `pk_live_*` + `sk_live_*`).
Do not paste the secret key into a shell command, source file, or chat transcript.

## 4. Deploy

Create and check a Preview first:

```sh
npx vercel
```

Then deploy the same project to Production:

```sh
npx vercel --prod
```

The root [`server.js`](../server.js) is detected as the Node server entrypoint.

## 5. Run the read-only API smoke test

Create a local ignored file named `.env.check`:

```text
BASE_URL=https://your-project.vercel.app
TOKKO_API_KEY=one-key-from-EXTERNAL_API_KEYS
```

Run:

```sh
node --env-file=.env.check scripts/check-api.js
```

Expected checks:

```text
PASS  public health
PASS  public config
PASS  consolidated API catalog
PASS  database diagnostics
```

To also verify one onboarding record:

```sh
ONBOARDING_ID=42 node --env-file=.env.check scripts/check-api.js
```

The same information can be checked manually:

```sh
curl -sS "$BASE_URL/api/health" | jq

curl -sS "$BASE_URL/api/v1/system/apis" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq

curl -sS "$BASE_URL/api/v1/system/db" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq

curl -sS "$BASE_URL/api/v1/system/db/records?limit=20" \
  -H "X-API-Key: $TOKKO_API_KEY" | jq
```

`/api/v1/system/db` must show `database.connected: true`. Its table counts should
increase after website or LINQ onboarding.

## 6. Check the database directly

Run the safe, read-only database report with Vercel's Production environment injected:

```sh
npx vercel env run -e production -- npm run check:db
```

It reports:

- connection and Postgres version
- missing/available tables
- row counts
- the latest 20 onboardings
- masked parent phones
- consent state
- card brand and last four digits
- whether a Zepto connection exists

It never prints payment-method tokens or merchant access/refresh tokens.

Inspect one user:

```sh
USER_ID=42 npx vercel env run -e production -- npm run check:db:user
```

You can also use the database provider's SQL editor and paste
[`scripts/check-db.sql`](../scripts/check-db.sql) or
[`scripts/check-user.sql`](../scripts/check-user.sql).

## 7. End-to-end acceptance check

Use test accounts and test credentials.

The automated browser check creates an email/password test user, saves Indian parent and
multiple dependent phone numbers, exercises a declared “Other dependent” relationship,
verifies optional card setup, and confirms that no Zepto connection UI is rendered:

```sh
npx playwright install chromium
E2E_BASE_URL=https://your-project.vercel.app npm run check:browser
```

Set `E2E_BASE_URL` if you want to test a Preview URL instead of the configured
`BASE_URL`. The test asserts that the LINQ-style dependent list, relationship controls,
and add-dependent button are present, consent is saved, card tokenization is optional,
and the Zepto connection step is absent.

1. Open the Production URL, create an account using only email and password, and sign
   back in.
2. Enter local phone numbers using the separate country-code selectors. Add dependents
   (including Mother or Father if applicable), and select “Other dependent” to verify
   the declared-relationship field appears. Choose either the account holder or one
   dependent for merchant authentication and verify the consent text shows that phone.
3. If Prava is configured, use sandbox keys and a card from Prava's current
   [sandbox test-card list](https://docs.prava.space/api-reference/test-cards).
   Confirm that Prava opens in a separate tab and only masked metadata is saved
   after returning to Tokko.
4. Run `check:db:user`; confirm the profile, consent record, and only masked card
   metadata are present.
5. Call LINQ onboarding with `sendWelcomeMessage: false`; verify the returned `userId`
   and assigned `linqNumber`, then rerun the same request to confirm idempotency.
6. Only when the selected person controls the test phone and has consented, start the
   Zepto connection, enter the OTP, and verify `has_access_token = true` without
   displaying the token.
7. Revoke consent and verify Zepto calls fail and the stored Zepto connection is removed.

The request examples and full route matrix are in [`docs/API.md`](API.md).

## 8. Troubleshooting

Inspect Production errors:

```sh
npx vercel logs --environment production --level error --level warning
```

Common failures:

| Result | Likely cause |
| --- | --- |
| `/api/health` returns 500 | `DATABASE_URL` missing, unreachable, or not SSL/pool compatible |
| Website API returns 401 | Email session is missing, expired, or signed out |
| Service API returns 401 | Invalid Clerk machine token or `X-API-Key` not in `EXTERNAL_API_KEYS` |
| Payment setup returns 503 | Prava keys are absent or from mismatched environments |
| Prava hosted page fails to open | Recreate the session and open the returned `approvalUrl` verbatim |
| LINQ onboarding returns 503 | LINQ key absent or no provisioned number available |
| Zepto start returns 403 | Consent missing, revoked, or recorded for a different selected phone |
| Zepto start returns 503 | OAuth client registration/configuration incomplete |
