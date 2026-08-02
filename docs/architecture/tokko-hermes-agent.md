# Tokko hermes agent

_Tokko's agent — Gemini-backed Hermes engine (persona Trakko), the 8-round tool loop, HMAC-signed Needs-You approvals, MCP client, Zepto OAuth-OTP, and the UCP-only live tool surface._

`lib/hermes.js` (~2730 lines) is the agent engine; persona "Trakko" from `lib/trakko-context.js`. Part of [tokko-overview](tokko-overview.md).

## Model / provider — Google Gemini (NOT Claude/OpenAI)
`DEFAULT_MODEL = "gemini-3.5-flash-lite"` (hermes.js:8, overridable via `GEMINI_MODEL`). Endpoint
`generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key`, key
`GEMINI_API_KEY`/`GOOGLE_API_KEY`. Used for chat + audio transcription. **⚠ `gemini-3.5-flash-lite` is an unusual id**
(public flash-lite is 2.0/2.5-series) — treat as internal alias, confirm against deployment's `GEMINI_MODEL`.
`HERMES_SOURCE_URL = nousresearch/hermes-agent` is a red herring — no Nous model used.

## Channels
Browser `POST /api/hermes/chat` (Web) · Telegram `POST /api/integrations/telegram/hermes` (TG, chat↔family binding) ·
LINQ (lib/linq.js) · Voice `/api/hermes/transcribe`. System prompt (`systemPrompt`, hermes.js:125) = policy version +
`TRAKKO_SYSTEM_CONTEXT` + runtime instructions + JSON family context + JSON learned memory (`hermes_memories`).

## Agent loop (`run()`, hermes.js:2220)
- ≤ **`MAX_TOOL_ROUNDS = 8`**. Each round → `callGemini` with `functionDeclarations`, `thinkingBudget:2048`,
  `maxOutputTokens:8192`, 4 retries + 429 backoff.
- **Read vs write:** `READ_ONLY_TOOLS` run without approval; everything else + **unknown tools** need approval (deliberate
  write-default safety).
- **Needs-You approval:** on a mutating/unknown tool the loop does NOT execute — it returns `pendingAction` with a
  **signed token** (`signApproval`: base64url payload + HMAC-SHA256, **10-min TTL**, family-scoped by userId, bundles ≤20
  actions, embeds each `functionCall`; secret `HERMES_ACTION_SECRET`). Client resumes with `approvalToken`; `verifyApproval`
  checks HMAC/userId/expiry/name match, then approved actions execute **directly without another Gemini call** (so a later
  quota error can't turn a done write into a false failure).
- **Auto-continue after address approval:** if the approved action is `select_saved_address` and the message named products,
  server pre-runs serviceability→store→search and feeds results back so the model keeps shopping without re-asking.
- **Search resilience:** multi-item parse, learned-vocabulary substitution, broad-category-first, resilient retry +
  sequential fallback, read cache (TTL + stale fallback), per-user 650ms min interval, partial-results on mid-trace 429.

## ⚠ Live tool surface is UCP-ONLY today
`runHermesBackend` passes only **`search_wellness_merchants`** + **`create_wellness_checkout`** to the model
(server.js:5827). The full raw-Zepto tool surface + `checkout_current_cart` + `start_zepto_reconnect` are fully coded and
dispatchable (hermes.js:46-74; dispatch server.js:6022) but **NOT offered to the LLM in the default path** — wired but dormant.

## MCP client (lib/mcp.js)
Generic **Streamable-HTTP MCP**, per-user/per-platform, no globals. JSON-RPC 2.0 over HTTP POST; `parseMcpResponse` handles
plain JSON AND SSE. Protocol `2025-03-26`, `clientInfo{name:"tokko"}`. Session via `mcp-session-id` header (persisted to DB;
re-inits once on expired-session error). Auth `Bearer <accessToken>` from `auth.platformConnectionForUser`. Methods:
initialize / `tools/call` / `tools/list`. **No allowlist inside mcp.js** — enforced upstream in Hermes.

## Zepto (platforms.json single entry)
`mcp_url: mcp.zepto.co.in/mcp`, `auth_server_url: auth.zepto.co.in`, scopes `tools:read tools:write`, `auth_flow_type: oauth2_otp`.
- **Connect/OTP** (`lib/platforms.js authAdapters.oauth2_otp`): dynamic client registration (`POST /register`,
  `token_endpoint_auth_method:none`, redirect **loopback** `http://localhost:3456/auth/callback` — never navigated, code
  exchanged server-side); PKCE S256; scrape `sessionId` from `/authorize` HTML → `POST /api/send-otp`; verify `POST /api/login`
  → code → `POST /token` (`resource=mcp_url`). Client id persisted.
- **Consent binding:** token stored per user; `platformConnectionForUser` requires consent whose `subject_phone` == family
  merchant-auth phone AND rejects a token bound to a different `authenticated_phone`.
- **In-chat reconnect:** `start_zepto_reconnect` → `startMerchantAuth` sends OTP only to the consented phone; 6-digit code
  handled server-side, **never sent to Gemini or stored in Telegram history**.
- **Tool allowlist** (hermes.js:46-74): reads = search_products, search_multiple_products, get_product_details, view_cart,
  list_saved_addresses, get_payment_methods, list_order_history, get_order_detail, check_payment_status, get_user_details,
  get_location_serviceability, get_past_order_items. writes = update_cart, add/select_saved_address, select_store,
  create_order / create_online_payment_order / create_upi_reserve_pay_order / create_wallet_order, update_drop_zone, update_user_name.
- **Checkout:** `checkout_current_cart` runs server-owned policy (mandate → one-time card → COD, see [tokko-payments-checkout](tokko-payments-checkout.md));
  Zepto returns a hosted payment link with no card input → memory-only credential handoff; `/api/hermes/checkout/continue` reconciles.

## Extension seam
`lib/platforms.js`: per-slug DCR + persistence + pluggable auth adapters keyed by `auth_flow_type` (only `oauth2_otp`
implemented; `getAdapter` throws on unknown). Chat-channel/transport selection is in server.js (`routeGroup`), NOT platforms.json.
See `docs/HERMES.md`, `docs/TRAKKO-AI.md`.
