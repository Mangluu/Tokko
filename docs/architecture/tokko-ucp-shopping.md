# Tokko ucp shopping

_Tokko UCP shopping (lib/ucp.js) — Shopify Global Catalog + 18 audited wellness merchants, MCP-only transport, HMAC selection tokens, merchant-authoritative totals, SSRF guards._

`lib/ucp.js` (~1206 lines) = Shopify **Universal Commerce Protocol** agent (`UCP_VERSION="2026-04-08"`). Part of
[tokko-overview](tokko-overview.md); feeds the UCP checkout in [tokko-payments-checkout](tokko-payments-checkout.md); exposed to the agent as
`search_wellness_merchants`/`create_wellness_checkout` (see [tokko-hermes-agent](tokko-hermes-agent.md)).

## Two discovery paths (run in parallel, `searchAll` ucp.js:717)
1. **Shopify Global Catalog** — one hosted MCP `catalog.shopify.com/api/ucp/mcp` via `search_catalog` per market
   (broad "any Shopify merchant"; can surface dynamic merchants not in the seed registry).
2. **Seeded live-merchant UCP** — hardcoded `MERCHANTS` registry (ucp.js:18); each merchant's own `/.well-known/ucp`
   profile discovered + per-store MCP `search_catalog`.
Results merged/deduped, sorted by market→currency→lowest native price→availability→name. Markets restricted **IN/US**.

## Flow: search → select → quote/create_checkout → shipping → continue_url
- **select:** each variant gets a signed **selectionToken** (`signSelection`, HMAC, **30-min TTL**, embeds merchant +
  `variantId` (must be `gid://shopify/ProductVariant/…`) + price + currency). ⚠ Normalizers drop any item **without an image**.
- **create_checkout** (`createCheckout` :1074): `verifySelection` (HMAC+expiry+GID) → `discoverSelectionMerchant`
  (seeded slug OR dynamic global-catalog merchant by HTTPS origin) → `callMcp("create_checkout")` with line_items/buyer/
  shipping-to-`selected_destination_id`.
- **shipping:** if merchant returns unselected shipping groups, `shippingSelectionUpdate` picks the **cheapest** option and
  issues `callMcp("update_checkout")`.
- **continue_url handoff:** `checkoutLink` extracts an HTTPS `continue_url` (502 if absent). Tokko never collects payment;
  returned as `checkoutUrl`/`continueUrl`.

## Merchant registry (18 = 13 IN + 5 US), regions, adapters
Each = frozen `{slug,name,market,currency,origin,discoveryUrl}` (`<origin>/.well-known/ucp`).
- **IN (INR):** kapiva, oziva, himalayawellness, zanducare, organicindia, setunutrition, wellbeingnutrition, drortho, yogabar, mamaearth, dotandkey, thedermaco, carbamideforte.
- **US (USD):** ritual, momentous, teamiblends, perelel, needed.
- **Audit** (`docs/UCP-MERCHANT-AUDIT.md`, 2026-08-01): 16 returned complete shipping-inclusive quotes. Exceptions flagged
  `shippingQuoted:false`: Ritual (no fulfillment line), Kapiva (REST-only, no catalog-search), HPN (dynamic, merchant handoff).
  Tokko does NOT invent zero shipping.
- **Transport:** `serviceEndpoint` prefers **MCP** over REST; search + checkout **require `transport==="mcp"`** (why REST-only
  Kapiva can't be searched/quoted).
- **SSRF guard for dynamic merchants:** `safeHttpsOrigin` (HTTPS-only, port 443, no creds, no localhost/raw-IP); dynamic
  merchants must advertise BOTH checkout AND fulfillment or 422. Seeded merchants trusted by slug.

## Smart vs raw search (`searchAll` two-tier)
- `searchStrategy:"exact"` (default) — every non-stopword token must appear (`relevantProduct` matchMode "all").
- `searchStrategy:"broadened_terms"` — fallback only when exact yields zero + query has >1 word; per-term matchMode "any",
  relevance scored vs original query; merchants marked `broadened:true`.

## Totals — verify but never replace
`checkoutPricing`/`checkoutTotals` preserve the merchant's entire `totals[]` in order and derive `*Minor` subtotals.
`totalIsAuthoritative` = merchant supplied a positive `total` line; `reconciles` = summed lines match total. **Tokko never
replaces the merchant's authoritative `type:"total"`**; 502 if no positive total. `totalIsAuthoritative===false` routes UCP
checkout to a saved card instead of minting a mandate credential (see [tokko-payments-checkout](tokko-payments-checkout.md) invariant #3).

## ⚠ Signing-secret coupling
UCP selection secret falls back `UCP_SELECTION_SECRET → HERMES_ACTION_SECRET → CLERK_SECRET_KEY → GEMINI_API_KEY` (reuses
auth secrets as a token-signing key). See [tokko-gotchas](tokko-gotchas.md).
