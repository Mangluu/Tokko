process.env.UCP_SELECTION_SECRET ||= "local-global-catalog-smoke-only";
const ucp = require("../lib/ucp.js");

(async () => {
  const query = process.argv[2] || "plant protein";
  const market = String(process.argv[3] || "IN").toUpperCase();
  const raw = await ucp.callMcp({
    endpoint: "https://catalog.shopify.com/api/ucp/mcp",
    toolName: "search_catalog",
    arguments: {
      catalog: {
        query,
        view: "offer",
        context: { address_country: market, currency: market === "US" ? "USD" : "INR" },
        filters: { available: true, ships_to: { country: market } },
        pagination: { limit: 50 },
      },
    },
    baseUrl: "https://zepto-shop.vercel.app",
  });
  const sellers = [...new Map((raw.products || []).flatMap((product) =>
    (product.variants || []).map((variant) => {
      const seller = variant.seller || {};
      return [seller.url || seller.domain || seller.name, {
        name: seller.name,
        url: seller.url,
        domain: seller.domain,
        product: product.title,
      }];
    })
  ).filter(([key]) => key)).values()];
  const result = await ucp.searchGlobalCatalog(query, {
    markets: [market], limit: 50, baseUrl: "https://zepto-shop.vercel.app",
  });
  const selection = result.products.find((product) => product.available);
  const checkout = process.argv[4] === "checkout" && selection
    ? await ucp.createCheckout(selection.selectionToken, {
        baseUrl: "https://zepto-shop.vercel.app",
        buyer: {
          first_name: "Test", last_name: "Buyer",
          email: "ucp-audit@example.com",
          phone_number: market === "US" ? "+12125550123" : "+919876543210",
        },
        destination: market === "US" ? {
          id: "tokko_audit_us", first_name: "Test", last_name: "Buyer",
          street_address: "123 Main Street", extended_address: "Apartment 4B",
          address_locality: "New York", address_region: "NY", postal_code: "10001",
          address_country: "US", phone_number: "+12125550123",
        } : {
          id: "tokko_audit_in", first_name: "Test", last_name: "Buyer",
          street_address: "12 Park Street", extended_address: "Apartment 3A",
          address_locality: "Kolkata", address_region: "West Bengal", postal_code: "700016",
          address_country: "IN", phone_number: "+919876543210",
        },
      })
    : null;
  process.stdout.write(`${JSON.stringify({
    rawProductCount: (raw.products || []).length,
    rawFirstProduct: (raw.products || [])[0] || null,
    markets: result.markets,
    sellers,
    products: result.products.slice(0, 10).map(({ selectionToken, ...product }) => product),
    checkout,
  }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n${error.cause?.stack || error.cause?.message || ""}\n`);
  process.exitCode = 1;
});
