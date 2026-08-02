# Tokko gotchas

_Tokko traps for future sessions — naming drift, misleading module names, dormant Zepto tools, docs drift, dead frontend code, secret-reuse couplings, and other verified surprises._

Verified surprises that will waste a future session's time if not known up front. Part of [tokko-overview](tokko-overview.md).

## Naming drift — everything is one product
Repo `tokko-hackathon`; DB user+name default `plantri`; session cookie `plantri_session`; LINQ idempotency
`plantri-onboard-*`; assistant persona `trakko` (`lib/trakko-context.js`, `docs/TRAKKO-AI.md`); agent engine + Telegram bot
`hermes`; live app `tokko-drab.vercel.app`; prod Hermes endpoint `zepto-shop.vercel.app`. `HERMES_SOURCE_URL =
nousresearch/hermes-agent` is a **red herring** — the model is **Google Gemini**, no Nous/Hermes model.

## Misleading module names
- **`lib/checkout.js` is NOT checkout orchestration** — only Zepto price/cart parsing. Orchestration is in `server.js`
  (~lines 1395-1802, 2050-2245, 2376-3187, 5002-5696). See [tokko-payments-checkout](tokko-payments-checkout.md).
- **`lib/pg.js` is NOT the live DB pool** — it's a standalone hand-rolled raw-wire client, never imported by `lib/db.js`
  (which uses `pg.Pool`). See [tokko-db-schema](tokko-db-schema.md).

## Live agent tools ≠ coded tools
The default browser/Telegram agent path offers the LLM **only** `search_wellness_merchants` + `create_wellness_checkout`
(UCP). The entire raw-Zepto MCP toolset + `checkout_current_cart` + `start_zepto_reconnect` are fully coded and dispatchable
but **dormant** — not passed to Gemini in `runHermesBackend` (server.js:5827). See [tokko-hermes-agent](tokko-hermes-agent.md).

## Frontend ≠ README marketing
No "Ask Tokko"/product-browsing tab exists — the SPA is a control plane (Home/Needs you/Family/Wallet/More). Card & mandate
setup use **full-page `window.location.assign`, not a new tab**. `src/api.js` carries dead/alt-flow helpers
(`setupFromUserState`, `onboardingPayload`, `resultContent`, `resultText`) not imported by `main.jsx`. See [tokko-frontend](tokko-frontend.md).

## Docs drift (routes in code, absent from docs/API.md)
`/api/merchants/ucp/payment-choice`, `/api/hermes/memory`, `/api/hermes/transcribe`, `/api/auth/clerk/session`,
`/api/integrations/telegram/hermes/payment-choice`, `/api/v1/decisions`. See [tokko-server-routing](tokko-server-routing.md).

## Security / infra couplings to watch
- **Secret reuse:** UCP selection-token signing secret falls back to `CLERK_SECRET_KEY`/`GEMINI_API_KEY`; Hermes approval
  secret falls back to Gemini/Clerk key. Rotating an auth key silently invalidates signed tokens.
- **No CORS/OPTIONS** anywhere — same-origin only. Body cap 1 MB → 413.
- **No SSL config** in `lib/db.js` pool (relies on connection-string params).
- **`gemini-3.5-flash-lite`** is an unusual model id (public flash-lite is 2.0/2.5-series) — likely internal alias; confirm `GEMINI_MODEL`.
- **Exactly-one-family-per-phone** invariant: phone login + `resolveOnboardingUserId` fail closed (409) on ambiguity.
- **LINQ webhook** currently only ACKs + dedupes; no event-type dispatch yet.
- **Imageless products dropped:** UCP normalizers silently drop any variant without an image URL.
- **`payment_customers.provider_customer_id` = `tokko_family_<id>`; mandate/UCP charge `reference` keys are dedup anchors** —
  don't change their format or retries mint duplicate credentials.

## Memory-map provenance
This map was synthesized 2026-08-02 at HEAD `bcb67c1` from 6 parallel subsystem deep-reads. Re-verify `file:LINE` refs after
large `server.js`/`lib/db.js` edits before trusting them.
