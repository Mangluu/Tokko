# UCP health and wellness merchant audit

Audit date: 2026-08-01

Tokko uses the official Shopify Global Catalog MCP endpoint for broad product
discovery and each selected merchant's `/.well-known/ucp` profile for checkout.
UCP intentionally has no central merchant registry, so "all merchants" cannot
be enumerated from the protocol itself. This matrix records the health and
wellness domains inspected in Tokko's India and US seed registry, plus merchants
returned dynamically by Global Catalog.

The checkout audit only created incomplete quote sessions. It did not complete
orders or submit payment. Amounts below are the merchant responses for one test
item and one complete test address; shipping and tax can change by item,
destination, time, and promotion.

## Shipping-inclusive checkout results

| Delivery market | Merchant | Test subtotal | Shipping returned | Authoritative total | Address and phone echoed |
| --- | --- | ---: | ---: | ---: | --- |
| IN | Himalaya Wellness | INR 450.00 | INR 0.00 | INR 450.00 | Yes |
| IN | ZanduCare | INR 399.00 | INR 49.00 | INR 448.00 | Yes |
| IN | Organic India | INR 187.00 | INR 0.00 | INR 187.00 | Yes |
| IN | OZiva | INR 1,299.00 | INR 0.00 | INR 1,299.00 | Yes |
| IN | Setu Nutrition | INR 749.00 | INR 0.00 | INR 749.00 | Yes |
| IN | Wellbeing Nutrition | INR 599.00 | INR 0.00 | INR 599.00 | Yes |
| IN | Dr. Ortho | INR 248.00 | INR 50.00 | INR 298.00 | Yes |
| IN | YogaBar | INR 1,099.00 | INR 0.00 | INR 1,099.00 | Yes |
| IN | Mamaearth | INR 838.00 | INR 0.00 | INR 593.30 after merchant discount | Yes |
| IN | Dot & Key | INR 595.00 | INR 0.00 | INR 595.00 | Yes |
| IN | The Derma Co | INR 1,398.00 | INR 0.00 | INR 838.80 after merchant discount | Yes |
| IN | Carbamide Forte | INR 649.00 | INR 40.00 | INR 689.00 | Yes |
| US | Momentous | USD 59.99 | USD 8.00 | USD 67.99 | Yes |
| US | Teami Blends | USD 15.99 | USD 0.00 | USD 17.41 including tax | Yes |
| US | Perelel | USD 47.00 | USD 7.00 | USD 58.81 including tax | Yes |
| US | Needed | USD 42.99 | USD 7.00 | USD 54.43 including tax | Yes |

These 16 merchants returned a top-level `fulfillment` amount, including zero
when the selected shipping option was free. Tokko renders the merchant's full
`totals[]` array, so discounts, multiple taxes, and fees remain visible in the
order supplied by the merchant.

## Advertised UCP but not a complete shipping quote in the test

| Merchant | Finding |
| --- | --- |
| Ritual | Advertised checkout and fulfillment, but the tested US checkout returned subtotal, tax, and total without a fulfillment line or echoed destination. |
| Kapiva | Advertised checkout and fulfillment over REST, but its profile did not advertise catalog search, so Tokko could not safely obtain a current variant for this quote audit. |
| HPN Supplements | Discovered through Shopify Global Catalog and advertised MCP checkout plus fulfillment. The tested Kolkata checkout required merchant handoff and did not return a shipping line or echo the destination. |

Tokko marks these responses as `shippingQuoted: false`; it does not invent a
zero shipping charge. The buyer must review the merchant handoff if the quote
remains incomplete.

## Profiles inspected

Valid UCP profiles in the seeded registry:

- India: Kapiva, OZiva, Himalaya Wellness, ZanduCare, Organic India, Setu
  Nutrition, Wellbeing Nutrition, Dr. Ortho, YogaBar, Mamaearth, Dot & Key,
  The Derma Co, and Carbamide Forte.
- United States: Ritual, Momentous, Teami Blends, Perelel, and Needed.

Other domains checked during the seed audit:

- HealthKart and Nutrabay returned non-UCP content.
- Thorne, Seed, HUM, GNC, and iHerb did not publish a profile at the checked
  well-known path.
- AG1 rate-limited the probe, and The Vitamin Shoppe blocked it, so neither is
  claimed as supported or unsupported.

## Implementation contract

1. `search_catalog` is called on Shopify Global Catalog with `ships_to.country`
   and matching UCP context for IN, US, or both.
2. A selected dynamic merchant is resolved through its signed product URL and
   public `/.well-known/ucp` profile. Only HTTPS MCP checkout plus fulfillment
   is accepted.
3. `create_checkout` receives buyer name, email, E.164 phone, line item,
   currency, and a shipping method whose `selected_destination_id` points at
   the full saved destination.
4. If the merchant returns shipping groups without a selected option, Tokko
   calls `update_checkout` with the checkout ID outside the replacement
   checkout object and selects the cheapest returned option.
5. Tokko preserves every top-level merchant total in response order and uses
   the merchant's `type: total` as `totalAmount`. It verifies, but never
   replaces, the merchant total.

Relevant specifications:

- <https://shopify.dev/docs/agents/catalog/global-catalog>
- <https://ucp.dev/latest/specification/checkout/>
- <https://ucp.dev/latest/specification/fulfillment/>
- <https://ucp.dev/latest/specification/checkout-mcp/>
- <https://ucp.dev/documentation/core-concepts/>
