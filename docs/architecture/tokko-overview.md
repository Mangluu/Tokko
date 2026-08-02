# Tokko overview

_What Tokko is — agentic family-care shopping assistant; stack, repo layout, deployment, and the Plantri/Trakko/Hermes naming drift._

**Tokko** (repo `tokko-hackathon`, root `~/Documents/Projects/Personal/Tokko`) is a warm, agentic
**family-care assistant** for health/wellness/everyday essentials, aimed at NRI families (India +
US delivery). Family members chat over a messaging channel; the agent understands the request,
checks family context + payment rules, and pauses for human approval when needed. Live app:
`tokko-drab.vercel.app`. It is a **hackathon repo, part of the broader Prava payments ecosystem**
(uses Prava cards/mandates + Zepto MCP + Shopify UCP) but is NOT one of the repos in the Prava
Obsidian index. Sanitized/credential-free copy (see `SANITIZATION.md`).

## Stack
- **Backend:** raw `node:http` monolith — `server.js` (~6260 lines, ~68 routes, no framework) over
  `lib/*` modules. **PostgreSQL** (27 tables, idempotent schema at boot). See [tokko-server-routing](tokko-server-routing.md), [tokko-db-schema](tokko-db-schema.md).
- **Frontend:** single-file **React 19 SPA** (`src/main.jsx`, Vite build), a *control plane* only —
  family/addresses/rules/decision-inbox/wallet. No product-browsing UI. See [tokko-frontend](tokko-frontend.md).
- **Agent brain:** Google **Gemini** (`gemini-3.5-flash-lite`), engine `lib/hermes.js`, persona "Trakko"
  (`lib/trakko-context.js`). See [tokko-hermes-agent](tokko-hermes-agent.md).
- **Deploy:** Vercel + Neon Postgres. See [tokko-env-integrations](tokko-env-integrations.md) and `docs/DEPLOY_AND_CHECK.md`.

## Two onboarding channels (same family-profile model)
- **Website:** email/password OR family-phone+password → opaque HttpOnly session. Clerk backs email-OTP
  signup + Google OAuth. See [tokko-auth-onboarding](tokko-auth-onboarding.md).
- **LINQ:** authenticated partner service creates a family + gets a provisioned LINQ number; SMS/chat channel.

Chat surfaces: browser (`/api/hermes/chat`), Telegram bot (`/api/integrations/telegram/hermes`), LINQ.

## External integrations
Clerk (auth/OTP) · **Prava** (card tokenization + single-use tokens + standing mandates, money path) ·
**Zepto** (grocery MCP over OAuth-OTP) · **Shopify UCP** (Universal Commerce Protocol product catalog +
audited wellness merchants) · **Gemini** (agent) · Telegram · LINQ · OpenStreetMap Nominatim (geocoding).

## ⚠ Naming drift (all one product)
`tokko-hackathon` (repo) / **`plantri`** (default DB user+name, session cookie `plantri_session`,
LINQ idempotency `plantri-onboard-*`) / **`trakko`** (assistant persona + `trakko-context.js` + `docs/TRAKKO-AI.md`) /
**`hermes`** (agent engine + Telegram bot). `HERMES_SOURCE_URL = nousresearch/hermes-agent` is a
red herring — no Nous/Hermes model is used; it's Gemini. See [tokko-gotchas](tokko-gotchas.md).

## Testing
`npm test` = `node --test` unit tests (`test/*.test.js`). `npm run check:browser` = Playwright e2e (`e2e/*.spec.js`).
`scripts/check-api.js` = read-only prod smoke test. Local port **3456**.
