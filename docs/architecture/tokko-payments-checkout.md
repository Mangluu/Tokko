# Tokko payments checkout

_Tokko money path — Prava tokenization/mandates (lib/payments.js), the two checkout flows + COD-fallback state machine in server.js, memory-only credential handoff, security invariants._

The security-critical money path. Part of [tokko-overview](tokko-overview.md). **⚠ `lib/checkout.js` is NOT orchestration** —
it's pure Zepto price/cart parsing (`zeptoPriceBreakdown`→`totalPaise`, `zeptoCartSnapshot`,
`zeptoOnlinePaymentAvailability`). The Prava client is **`lib/payments.js`**; **orchestration is in `server.js`**
(esp. lines 1395–1802, 2050–2245, 2376–3187, 5002–5696).

## Prava (lib/payments.js) — external payments API
Base `api.prava.space` / `sandbox.api.prava.space` (env from key prefix `_test_`/`_live_`; mismatch ⇒ 503).
Tokko NEVER sees PAN/CVC. Auth `Authorization: Bearer <PRAVA_SECRET_KEY>`. `pravaRequest` remaps Prava 401/403/429 → **502**
(so clients never misread integration faults as their own). Env: `PRAVA_PUBLISHABLE_KEY`/`SECRET_KEY`, `PRAVA_API_BASE_URL`,
`PRAVA_CARD_ENROLLMENT_AMOUNT/CURRENCY`, `PRAVA_MANDATE_*`, `PRAVA_MERCHANT_*`, `PRAVA_ZEPTO_MERCHANT_*`.
- Endpoints (`/v1/*`): `POST /sessions` (tokenization / mandate / one-time-card, all `integration_type:"full_checkout"`,
  returns `session_id`+`iframe_url` → `approvalUrl`), `GET /listCards`, `GET /mandates` (+retry), `GET /mandates/:id`,
  `POST /mandates/:id/charge`, `POST /mandates/:id/charges/:txn/report`, `POST /sessions/:id/report-status`,
  `GET /sessions/:id/payment-result`, `POST /sessions/:id/revoke`.

## Card model
**Stored** (`safePaymentMethod`): only `providerPaymentMethodId` (enrollment/card id), `brand`, `last4`, `expMonth/Year`,
`isDefault` (409 if incomplete/expired). **Never stored/sent:** PAN, CVC (enter only Prava's hosted page). Tests assert
`card_number`/`cvv` absent from `/v1/sessions` bodies. Preferred = `is_default` else first card.

## Standing mandates (the "care" mandate)
Authorize-once (`mandate_setup` session preselecting saved `card_id`, no credential shown) → charge-later within a cap.
Frequency→limits: weekly=52/1yr, monthly=24/2yr, yearly=5/5yr. **Money cap is Prava-side**; Tokko only ever charges a
single mandate with `remaining >= amount`.
- Eligibility: `usablePravaMandatesForAmount` (server.js:1679) — active, INR, remaining≥amount, **Zepto-scoped**
  (`!merchantName || /zepto/i`), smallest-covering wins. Non-INR → saved card. `usablePravaMandatesForMerchant` (:1731)
  for UCP adds `merchantIdentityMatches` (scope "any" matches all; nameless mandate matches only if none in the set is named).
- **Credential minting:** only AFTER the authoritative final total is known → `chargeMandate({mandateId, amount, reference,
  purchase_context})` mints a fresh single-use credential (`token \d{12,19}`, `dynamicCvv`, expiry — else 502; 409 if Prava
  failed). `reference` is a stable dedup key so retries reuse the credential (`tokko_hermes_<flow>`, `tokko_ucp_<sha256(...)>`).
  Per commit a1cd543, a mandate is only spent on the APPROVED report.

## Two checkout flows (policy `active_mandate_then_saved_card` → COD)
Persisted `checkout_flows` row tracks card_failure_count / COD flags / prava_* / snapshots / status enum
(`REVIEW_CARD`, `CARD_PAYMENT_PENDING`, `SANDBOX_ZEPTO_PAYMENT_PENDING/FAILED`, `CARD_PAYMENT_RECEIVED/FAILED`,
`COD_PERMISSION_REQUIRED`, `COD_FALLBACK_*`).
- **A) Zepto cart** (`executeHermesCheckoutPolicy` :2515; `POST /api/order/online` :5002): preview (`confirmOrder:false`,
  no order placed) → breakdown → `REVIEW_CARD`. On confirm: route smallest-covering Zepto mandate → saved card → COD.
  Mandate route re-confirms the real Zepto order (needs `orderId`+`paymentLink`), charges mandate for the exact confirmed
  total (`exactZeptoOrderBreakdown` 409 if no positive total), `check_payment_status` → APPROVED/DECLINED report.
- **B) UCP / Shopify** (`createUcpCheckoutWithPayment` :2050): checks merchant-scoped mandate, charges **only if
  `totalIsAuthoritative !== false`**; else presents saved cards. See [tokko-ucp-shopping](tokko-ucp-shopping.md).
- **Care-rule verify at order time:** automatic care never inferred from a saved card alone — re-verifies active mandate + current care-rule caps.

## Memory-only credential handoff
Zepto/Shopify hosted payment links have **no card-credential input field**, so Tokko returns the minted one-time
credential to the client with `storage:"memory_only"`, `automaticInsertion:false`, `requiresManualEntry:true`
(`pravaPaymentHandoff`/`pravaSessionPaymentHandoff`/`pravaUcpPaymentHandoff`). User manually enters the one-time
PAN/CVV on the merchant page. Only mandate/transaction **references** persist server-side. Diagnostics redact token/PAN/CVV.

## Sandbox vs production
`sandboxZeptoAttempt = environment !== "production"`. Preview never places an order (confirm = explicit opt-in to a
real hosted attempt). **Sandbox confirm:** mints a fresh sandbox credential, attempts the real sandbox Zepto order,
then since a sandbox PAN is never truly paid, any non-success → `closeSandboxPaymentAttempt` reports **DECLINED** (the
"simulated declined charge"). **COD is permanently disabled on the sandbox/opt-in path** (`applyCardFailureOutcome`:
sandbox & failure<3 → `SANDBOX_ZEPTO_PAYMENT_FAILED`, no COD); cart preserved on rejection.
- **Production COD:** only when `card_failure_count >= 3` AND `allow_cod_fallback !== false` → sets `COD_PERMISSION_REQUIRED`;
  user must approve via `POST /api/order/cod-decision` → `placeCodFallback` (`create_order` = COD). **3 "distinct" failures**
  = new `orderId` only (same-order retries don't increment). **pending/unknown NEVER triggers COD** (only FAILED/CANCELLED do).

## Security invariants
1. No raw-PAN/CVC API. 2. Credential only in browser memory (never auto-submitted/persisted). 3. Non-authoritative total
never charges a mandate (a1cd543 — routes to saved card instead). 4. Prava auth/rate-limit → 502 (not caller's 401/403/429).
Test coverage: `test/payments.test.js`, `test/checkout.test.js`.
