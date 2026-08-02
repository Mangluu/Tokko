# Tokko env integrations

_Tokko environment-variable registry + external service endpoints (Clerk, Prava, Zepto, LINQ, Gemini, Telegram, Nominatim) and the deploy/verify runbook._

Env checklist source = `.env.example` (blocked from reading — env file); consolidated here from
`docs/DEPLOY_AND_CHECK.md` + code. Part of [tokko-overview](tokko-overview.md). Deploy = Vercel + Neon Postgres, schema idempotent at boot.

## Env vars by domain
- **Core:** `BASE_URL` (HTTPS origin, no trailing slash), `DATABASE_URL`, `PGPOOL_MAX`, `PORT` (default 3456).
- **Clerk:** `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (same instance), `CLERK_AUTHORIZED_PARTIES`. Enable email signup +
  email-verification-code + password in Clerk dashboard. See [tokko-auth-onboarding](tokko-auth-onboarding.md).
- **Service API:** `EXTERNAL_API_KEYS` (comma-separated `X-API-Key` allowlist).
- **Agent (Gemini):** `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`), `GEMINI_MODEL` (code default `gemini-3.5-flash-lite`). See [tokko-hermes-agent](tokko-hermes-agent.md).
- **Hermes/Telegram:** `HERMES_ACTION_SECRET` (approval-token HMAC), `HERMES_ENDPOINT_URL`
  (prod `https://zepto-shop.vercel.app/api/integrations/telegram/hermes`), `HERMES_API_KEY` (= one `EXTERNAL_API_KEYS` value),
  `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_DEFAULT_FAMILY_EMAIL` (optional single-family shortcut).
- **LINQ:** `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET` (`whsec_`-prefixed), `LINQ_PHONE_NUMBER`, `LINQ_PHONE_NUMBER_ID`,
  `LINQ_API_BASE_URL`. Blank → LINQ disabled. Numbers must be pre-provisioned by a LINQ rep (no self-serve V3 create/delete).
- **Prava:** `PRAVA_PUBLISHABLE_KEY`+`PRAVA_SECRET_KEY` (both sandbox `_test_` or both live `_live_`), `PRAVA_API_BASE_URL`
  (else derived from prefix), `PRAVA_MERCHANT_URL/NAME/COUNTRY_CODE`, `PRAVA_CARD_ENROLLMENT_AMOUNT/CURRENCY`,
  `PRAVA_MANDATE_*`, `PRAVA_ZEPTO_MERCHANT_*`. Blank → card tokenization disabled (onboarding still completes). See [tokko-payments-checkout](tokko-payments-checkout.md).
- **Zepto:** `ZEPTO_OAUTH_CLIENT_ID`, `ZEPTO_OAUTH_REDIRECT_URI` (loopback `http://localhost:3456/auth/callback`), + DCR fallback.
- **Consent/geocoding:** `CONSENT_POLICY_VERSION`, `ADDRESS_GEOCODING_URL`, `ADDRESS_GEOCODING_USER_AGENT`.

## External service endpoints
- Clerk API (`@clerk/backend`), Google Gemini `generativelanguage.googleapis.com/v1beta`, Prava `api.prava.space` /
  `sandbox.api.prava.space` (`/v1/*`), Zepto MCP `mcp.zepto.co.in/mcp` + auth `auth.zepto.co.in`, LINQ
  `api.linqapp.com/api/partner/v3`, Shopify Global Catalog `catalog.shopify.com/api/ucp/mcp`, Nominatim `nominatim.openstreetmap.org`.

## Deploy / verify (docs/DEPLOY_AND_CHECK.md)
1. Vercel import (framework vite, build→`public/`), add Neon Postgres (injects `DATABASE_URL`). 2. Set env vars above.
3. `npx vercel` (preview) → `npx vercel --prod`. 4. Smoke: `node --env-file=.env.check scripts/check-api.js` (health,
config, `GET /api/v1/system/apis`, `/api/v1/system/db`). 5. `npm run check:db` / `check:db:user` = read-only masked DB report.
6. `E2E_BASE_URL=... npm run check:browser` = Playwright acceptance. Troubleshooting table in the doc (401s, 503 payment, etc).
LINQ webhook subscription → `https://YOUR_DOMAIN/api/webhooks/linq?version=2026-02-03`.
