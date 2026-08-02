# Tokko — repo guide for agents

**Tokko** is a warm, agentic **family-care shopping assistant** (health/wellness/essentials for NRI
families, delivery to India + US). Family members chat over a messaging channel; a Gemini agent
understands the request, checks family context + payment rules, and pauses for human approval when
needed. Live: `tokko-drab.vercel.app`. Hackathon repo; part of the broader Prava payments ecosystem.

## Shape
- **Backend:** raw `node:http` monolith — `server.js` (~6260 lines, ~68 routes, **no framework**, linear
  route scan, per-handler auth) over `lib/*`. **PostgreSQL** (27 tables, idempotent schema at boot).
- **Frontend:** single-file **React 19 SPA** (`src/main.jsx`, Vite) — a *control plane* (family / addresses /
  care-rules / decision-inbox / wallet). No product-browsing UI; shopping happens via the agent.
- **Agent:** Google **Gemini** (`gemini-3.5-flash-lite`), engine `lib/hermes.js`, persona "Trakko".
- **Deploy:** Vercel + Neon Postgres. Local: `node --env-file=.env server.js` → `http://localhost:3456`.
- **Integrations:** Clerk (auth/OTP) · Prava (cards + mandates, money path) · Zepto (grocery MCP) ·
  Shopify UCP (catalog) · LINQ (phone/SMS partner) · Telegram · Nominatim (geocoding).

## Detailed architecture map → [`docs/architecture/`](docs/architecture/)
| Doc | Covers |
|---|---|
| [tokko-overview](docs/architecture/tokko-overview.md) | stack, channels, integrations, naming drift |
| [tokko-server-routing](docs/architecture/tokko-server-routing.md) | route table, 5 auth tiers, Vercel adapters, startup |
| [tokko-db-schema](docs/architecture/tokko-db-schema.md) | 27 tables, pg.Pool, inline migrations, data-access fns |
| [tokko-auth-onboarding](docs/architecture/tokko-auth-onboarding.md) | sessions, Clerk, service keys, LINQ + webhook HMAC |
| [tokko-payments-checkout](docs/architecture/tokko-payments-checkout.md) | Prava mandates, 2 checkout flows, COD state machine |
| [tokko-hermes-agent](docs/architecture/tokko-hermes-agent.md) | Gemini loop, Needs-You approvals, MCP, Zepto OAuth-OTP |
| [tokko-ucp-shopping](docs/architecture/tokko-ucp-shopping.md) | Shopify catalog + 18 merchants, selection tokens |
| [tokko-frontend](docs/architecture/tokko-frontend.md) | SPA control plane, state machine, hydration, build |
| [tokko-env-integrations](docs/architecture/tokko-env-integrations.md) | env-var registry, endpoints, deploy runbook |
| [tokko-gotchas](docs/architecture/tokko-gotchas.md) | traps — read before editing |

Product/API docs also live in `docs/` (`API.md`, `HERMES.md`, `DEPLOY_AND_CHECK.md`, `UCP-MERCHANT-AUDIT.md`, `TRAKKO-AI.md`).

## ⚠ Gotchas that will waste your time (full list in tokko-gotchas)
- **Naming drift, one product:** repo `tokko`, DB/cookie `plantri`, persona `trakko`, engine/bot `hermes`.
  Agent is **Gemini** — `HERMES_SOURCE_URL=nousresearch/…` is a red herring (no Nous model).
- **Misleading modules:** `lib/checkout.js` is only Zepto price-parsing (orchestration is in `server.js`).
  `lib/pg.js` is a dead standalone raw client — the live pool is `pg.Pool` in `lib/db.js`.
- **Dormant tools:** the agent only exposes 2 UCP tools to the LLM; the full Zepto MCP toolset is coded but
  not passed to Gemini (`server.js:5827`).
- **Frontend ≠ README:** no "Ask Tokko" tab; card/mandate setup is full-page navigation, not a new tab.
- **Money-path invariants:** memory-only single-use credential handoff; a mandate is charged only against an
  authoritative merchant total (commit a1cd543); COD only after **3 distinct production** failures + explicit
  user approval, and is disabled entirely on the sandbox path.
- **No CORS/OPTIONS** (same-origin only); 1 MB body cap; no SSL config in the db pool.
- Secret reuse: UCP/Hermes token-signing secrets fall back to `CLERK_SECRET_KEY`/`GEMINI_API_KEY` — rotating
  an auth key silently invalidates signed tokens.

## Conventions
- No typecheck (plain JS). Before claiming done: `npm test` (`node --test`) for unit, `npm run check:browser`
  (Playwright) for e2e, `node scripts/check-api.js` for a deployed smoke test.
- Never add an API that accepts raw PAN/CVC. Never store card credentials server-side (references only).
- `file:LINE` refs in the architecture docs were captured at HEAD `bcb67c1` — re-verify after large edits.
