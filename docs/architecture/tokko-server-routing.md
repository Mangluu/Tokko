# Tokko server routing

_Tokko HTTP server architecture — raw node:http monolith, route table by group, the 5 auth tiers, request lifecycle, Vercel adapters, startup._

`server.js` (~6260 lines) is a **raw `node:http` monolith — no framework**. Every concern (auth, body
parse, error) is imperative inside each handler. Part of [tokko-overview](tokko-overview.md).

## Request lifecycle (`handler`, server.js:6159)
1. `await initializeApplication()` (memoized; see Startup). Failure → 500.
2. `matchRoute(method, url)` (server.js:171) — **linear scan** of `routes[]`. Segment-count must match;
   `:param` captured via `decodeURIComponent`; first match wins. NOT a switch/regex table; no trailing-slash tolerance.
3. `match.handler(req,res,params)` in try/catch. No match + `/api/` → 404 JSON; else `serveStatic` from `./public`.
- **Body:** `readRawBody` caps at **1 MB → 413**; `parseBody` JSON (invalid→400, empty→`{}`); Vercel-adapter aware.
- **Responses:** `sendJson` always `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`.
- **⚠ No CORS / no OPTIONS anywhere** — API is same-origin only.
- **Errors** (server.js:6171): only handler-set `error.status` leaks its message; bare 500s → generic "Internal server error".
- **Route metadata** (`auth`/`group` on `route()`, server.js:161) is DESCRIPTIVE only (surfaced by `GET /api/v1/system/apis`); **enforcement is per-handler**, not routing-layer.

## Auth tiers (enforced as first line of each handler)
- **Public** — no auth call.
- **Web** = `auth.requireUser(req)` (lib/auth.js:85). Precedence: (1) `req.tokkoServiceUserId` (set only
  internally by the Telegram handler, never client input) → `trusted_service`; (2) `plantri_session` cookie
  (SHA-256 lookup) → `website_session`; (3) `Authorization: Bearer` Clerk session token → `clerk_session`; else 401.
- **Svc** = `auth.requireService(req)` (lib/auth.js:136). Clerk `["m2m_token","api_key"]` OR timing-safe
  `X-API-Key` vs comma-split `EXTERNAL_API_KEYS`. Clerk-503 swallowed so key-only deploys work.
- **Web+Zepto** = `auth.withPlatformTool` → `requireUser` + `platformConnectionForUser` (lib/auth.js:273):
  valid merchant-auth consent whose `subject_phone` == profile merchant-auth phone, a stored Zepto token,
  AND token `authenticated_phone` matches (403 mismatch). Lazily refreshes near expiry.
- **TG** = `requireTelegramIntegration` (server.js:855): `X-Telegram-Bot-Api-Secret-Token` vs `TELEGRAM_WEBHOOK_SECRET`, else falls back to Svc.
- **Webhook** = `linq.verifyWebhook` Standard-Webhooks HMAC (see [tokko-auth-onboarding](tokko-auth-onboarding.md)).

## Route groups (~68 routes; full table in docs/API.md, but code has extras)
- **Public/auth:** `/api/health`, `/api/config`, `/.well-known/ucp`, `/api/auth/{signup,signup/verify,login,clerk/session,logout}`, `/api/auth/session`(Web), `/api/payments/return`.
- **Account (Web):** `/api/me`, `PUT /api/onboarding/{profile,merchant-consent}`.
- **Payments (Web):** `/api/payments/{tokenization-session,payment-methods,mandates,mandates/session,payment-results}`. See [tokko-payments-checkout](tokko-payments-checkout.md).
- **UCP merchant (Web):** `/api/merchants/ucp{,/search,/checkout,/payment-choice}`. See [tokko-ucp-shopping](tokko-ucp-shopping.md).
- **Zepto connect (Web):** `/api/merchant/zepto/connect/{start,verify}`, `/api/zepto-status`, `/api/platforms`.
- **Family control-plane (Web):** `/api/addresses*`, `/api/care-rules`, `/api/preferences`, `/api/decisions*`, `/api/activity`.
- **Zepto shopping (Web+Zepto):** `/api/{location/serviceability,search,product/:id,cart,payment-methods,order,order/online,order/payment-status,order/cod-decision,orders,orders/:id,past-items}`.
- **Hermes (Web / Web+Zepto):** `POST /api/hermes/chat`, `/api/hermes/{memory,transcribe}`, `/api/hermes/checkout/continue`.
- **Service `/api/v1/*` (Svc):** `system/{apis,db,db/records}`, `onboarding`, `linq/{onboard,resolve}`, `onboarding/:id/*` (payments, addresses, zepto connect + `zepto/tools/:toolName`, merchant-consent), `decisions`, `integrations/telegram/bindings/:chatId*`.
- **Telegram Hermes (TG):** `POST /api/integrations/telegram/hermes{,/payment-choice}`.
- **Webhook:** `POST /api/webhooks/linq`.
- `/api/v1/onboarding/:id/*` → `resolveOnboardingUserId` (server.js:755): numeric id OR URL-encoded E.164 (ambiguous→409, none→404). Zepto tools also gated by 16-name `EXTERNAL_ZEPTO_TOOLS` allowlist.

## Entrypoints / deploy
- `server.js` — monolith; `module.exports = server` with `{handler,start,...}` attached; self-starts only under `require.main === module` (`node server.js`).
- `server.ts` — 5-line persistent-server entry: `require("./server.js").start()`.
- `api/server.js` — Vercel **serverless function** adapter; Vercel rewrites `/api/*` → this fn carrying path in `__tokkoPath`; reconstructs `req.url`, calls `handler`. `vercel.json` wires the function (framework vite, `maxDuration:60`, SPA fallback to `/index.html`).
- ⚠ Two Vercel entry models coexist; `vercel.json` uses only the function.

## Startup (`initializeApplication`, server.js:6194)
Idempotent + memoized (nulled on failure to retry). Called lazily on first request line (critical for
serverless cold start). Runs `db.initialize()` (schema, see [tokko-db-schema](tokko-db-schema.md)) then
`platforms.ensureAllOAuthClients` (seed Zepto OAuth clients). `PORT=3456`, `BASE_URL` from env→`$VERCEL_PROJECT_PRODUCTION_URL`→localhost.
