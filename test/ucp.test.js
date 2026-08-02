const assert = require("node:assert/strict");
const test = require("node:test");

process.env.UCP_SELECTION_SECRET = "test-ucp-selection-secret";
const ucp = require("../lib/ucp.js");

function discovery(endpoint, { catalog = true, transport = "mcp" } = {}) {
  return {
    ucp: {
      version: "2026-04-08",
      services: {
        "dev.ucp.shopping": [{ transport, endpoint }],
      },
      capabilities: {
        ...(catalog
          ? { "dev.ucp.shopping.catalog.search": [{ version: "2026-04-08" }] }
          : {}),
        "dev.ucp.shopping.checkout": [{ version: "2026-04-08" }],
      },
    },
  };
}

function rpc(value) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "test",
      result: {
        content: [{ type: "text", text: JSON.stringify(value) }],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function product(title, variantId, amount, available = true) {
  return {
    id: `gid://shopify/Product/${variantId}`,
    title,
    url: `https://merchant.example/products/${variantId}`,
    variants: [{
      id: `gid://shopify/ProductVariant/${variantId}`,
      title: "60 tablets",
      price: { amount, currency: "INR" },
      availability: { available },
      media: [{ type: "image", url: `https://cdn.example/${variantId}.jpg` }],
    }],
  };
}

test("searches only live UCP merchants present in Hermes memory", async () => {
  const requestedUrls = [];
  const fakeFetch = async (url, options = {}) => {
    requestedUrls.push(url);
    if (url === "https://setu.in/.well-known/ucp") {
      return Response.json(discovery("https://setu.test/mcp"));
    }
    if (url === "https://himalayawellness.in/.well-known/ucp") {
      return Response.json(discovery("https://himalaya.test/mcp"));
    }
    if (!options.body) throw new Error(`Unavailable Hermes merchant: ${url}`);
    const request = JSON.parse(options.body);
    assert.equal(request.method, "tools/call");
    assert.equal(request.params.name, "search_catalog");
    assert.equal(
      request.params.arguments.meta["ucp-agent"].profile,
      "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json"
    );
    assert.equal(options.headers["MCP-Protocol-Version"], "2026-04-08");
    if (url === "https://setu.test/mcp") {
      return rpc({ products: [product("Setu Ashwagandha Choice", "101", 59900)] });
    }
    if (url === "https://himalaya.test/mcp") {
      return rpc({
        products: [
          product("Free Ashwagandha Gift Sample", "200", 0),
          product("Himalaya Ashwagandha Value", "201", 19900),
          product("Unavailable Ashwagandha Deal", "202", 9900, false),
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await ucp.searchAll("ashwagandha", {
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(
    result.products.map((entry) => entry.productName),
    [
      "Unavailable Ashwagandha Deal",
      "Himalaya Ashwagandha Value",
      "Setu Ashwagandha Choice",
    ]
  );
  assert.equal(result.products[0].price, 99);
  assert.equal(result.pagination.limit, 50);
  assert.ok(result.products[0].selectionToken);
  assert.equal(result.source, "live_hermes_merchant_ucp");
  assert.equal(requestedUrls.includes("https://catalog.shopify.com/api/ucp/mcp"), false);
  assert.equal(requestedUrls.includes("https://www.oziva.in/.well-known/ucp"), false);
});

test("logs a credential-free curl command when a merchant MCP search fails", async () => {
  const messages = [];
  const originalError = console.error;
  console.error = (...values) => messages.push(values.join(" "));
  try {
    const fakeFetch = async (url) => {
      if (url === "https://drorthooil.com/.well-known/ucp") {
        return Response.json(discovery("https://drortho.test/api/ucp/mcp"));
      }
      if (url === "https://drortho.test/api/ucp/mcp") {
        return Response.json(
          { error: { message: "catalog temporarily unavailable" } },
          { status: 503 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const result = await ucp.searchAll("vitamin", {
      market: "IN",
      merchant: "drortho",
      baseUrl: "https://tokko.example",
      fetchImpl: fakeFetch,
    });
    assert.equal(result.products.length, 0);
  } finally {
    console.error = originalError;
  }
  const diagnostic = messages.find((message) => message.includes("catalog_mcp"));
  assert.match(diagnostic, /curl -sS/);
  assert.match(diagnostic, /https:\/\/drortho\.test\/api\/ucp\/mcp/);
  assert.match(diagnostic, /MCP-Protocol-Version: 2026-04-08/);
  assert.match(diagnostic, /search_catalog/);
  assert.doesNotMatch(diagnostic, /authorization|api[_-]?key|secret/i);
});

test("targets the remembered merchant UCP without Global Catalog fallback", async () => {
  let merchantRequest;
  const requestedUrls = [];
  const fakeFetch = async (url, options = {}) => {
    requestedUrls.push(url);
    if (url === "https://www.livemomentous.com/.well-known/ucp") {
      return Response.json(discovery("https://momentous.test/api/ucp/mcp"));
    }
    if (url === "https://momentous.test/api/ucp/mcp") {
      merchantRequest = JSON.parse(options.body);
      return rpc({
        products: [{
          id: "gid://shopify/p/momentous-whey",
          title: "Grass-Fed Whey Protein",
          url: "https://www.livemomentous.com/products/whey-protein",
          media: [{ type: "image", url: "https://cdn.example/momentous-whey.jpg" }],
          variants: [{
            id: "gid://shopify/ProductVariant/momentous-whey-1",
            title: "Vanilla",
            price: { amount: 5999, currency: "USD" },
            availability: { available: true },
            seller: {
              name: "Momentous",
              url: "https://www.livemomentous.com",
            },
          }],
        }],
        pagination: { has_next_page: false },
      });
    }
    throw new Error(`Unexpected merchant request: ${url}`);
  };
  const result = await ucp.searchAll("whey protein", {
    market: "US",
    merchant: "momentous",
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  assert.equal(merchantRequest.params.name, "search_catalog");
  assert.equal(merchantRequest.params.arguments.catalog.context.address_country, "US");
  assert.equal(result.source, "live_hermes_merchant_ucp");
  assert.equal(result.selectedMerchant, "momentous");
  assert.equal(result.products[0].merchant, "momentous");
  assert.equal(result.products[0].market, "US");
  assert.equal(result.products[0].currency, "USD");
  assert.equal(requestedUrls.includes("https://catalog.shopify.com/api/ucp/mcp"), false);
});

test("rejects merchants outside Hermes merchant memory", async () => {
  await assert.rejects(
    ucp.searchAll("ashwagandha", {
      market: "IN",
      merchant: "oziva",
      fetchImpl: async () => {
        throw new Error("must not issue a request");
      },
    }),
    /unsupported hermes ucp merchant/i
  );
});

test("returns image-backed products in fifty-result price pages", async () => {
  const merchantProducts = (prefix, start) => Array.from(
    { length: 80 },
    (_, index) => product(`${prefix} Wellness ${index + 1}`, `${start + index}`, (index + 1) * 100)
  );
  const fakeFetch = async (url, options = {}) => {
    if (url === "https://himalayawellness.in/.well-known/ucp") {
      return Response.json(discovery("https://himalaya.test/mcp"));
    }
    if (url === "https://himalaya.test/mcp") {
      return rpc({ products: merchantProducts("Himalaya", 2000) });
    }
    throw new Error(`Unexpected URL: ${url} ${options.method || "GET"}`);
  };

  const first = await ucp.searchAll("wellness", {
    limit: 50,
    merchant: "himalayawellness",
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  assert.equal(first.products.length, 50);
  assert.ok(first.products.every((entry) => entry.imageUrl.startsWith("https://")));
  assert.deepEqual(
    first.products.map((entry) => entry.price),
    [...first.products.map((entry) => entry.price)].sort((a, b) => a - b)
  );
  assert.equal(first.pagination.hasMore, true);
  assert.equal(first.pagination.nextOffset, 50);

  const second = await ucp.searchAll("wellness", {
    limit: 50,
    offset: 50,
    merchant: "himalayawellness",
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  assert.equal(second.products.length, 30);
  assert.equal(second.pagination.offset, 50);
  assert.equal(second.pagination.hasMore, false);
});

test("multi-word searches exclude cheaper products that match only one term", async () => {
  const fakeFetch = async (url, options = {}) => {
    if (url === "https://himalayawellness.in/.well-known/ucp") {
      return Response.json(discovery("https://himalaya.test/mcp"));
    }
    if (url === "https://himalaya.test/mcp") {
      return rpc({ products: [
        product("Plant Protein + Pro-Digest", "protein-1", 69900),
        product("Natural Protein Conditioner", "shampoo-1", 9000),
      ] });
    }
    throw new Error(`Unexpected URL: ${url} ${options.method || "GET"}`);
  };
  const result = await ucp.searchAll("plant protein", {
    merchant: "himalayawellness",
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(
    result.products.map((entry) => entry.productName),
    ["Plant Protein + Pro-Digest"]
  );
});

test("broadens an empty multi-word merchant query without hardcoded product aliases", async () => {
  const catalogueQueries = [];
  const fakeFetch = async (url, options = {}) => {
    if (url === "https://kapiva.in/.well-known/ucp") {
      return Response.json(discovery("https://kapiva.in/api/ucp", {
        catalog: false,
        transport: "rest",
      }));
    }
    if (url === "https://www.oziva.in/.well-known/ucp") {
      return Response.json(discovery("https://oziva.test/mcp"));
    }
    if (url === "https://himalayawellness.in/.well-known/ucp") {
      return Response.json(discovery("https://himalaya.test/mcp"));
    }
    const request = JSON.parse(options.body);
    const query = request.params.arguments.catalog.query;
    catalogueQueries.push(query);
    if (url === "https://oziva.test/mcp") return rpc({ products: [] });
    if (url === "https://himalaya.test/mcp") {
      return rpc({
        products: query === "syrup"
          ? [product("Tulasi Syrup", "cough-301", 17000)]
          : [],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await ucp.searchAll("cough syrup", {
    merchant: "himalayawellness",
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.searchStrategy, "broadened_terms");
  assert.deepEqual(result.queriesTried, ["cough syrup", "cough", "syrup"]);
  assert.deepEqual(
    result.products.map((entry) => entry.productName),
    ["Tulasi Syrup"]
  );
  assert.ok(catalogueQueries.includes("cough syrup"));
  assert.ok(catalogueQueries.includes("syrup"));
});

test("creates checkout from a signed search selection and returns continue_url", async () => {
  let selected;
  let submittedCheckout;
  const fakeFetch = async (url, options = {}) => {
    if (url === "https://himalayawellness.in/.well-known/ucp") {
      return Response.json(discovery("https://himalaya.checkout.test/mcp"));
    }
    const request = JSON.parse(options.body);
    if (request.params.name === "search_catalog") {
      return rpc({ products: [product("Himalaya Wellness Value", "301", 24900)] });
    }
    if (request.params.name === "create_checkout") {
      submittedCheckout = request.params.arguments.checkout;
      selected = request.params.arguments.checkout.line_items[0];
      return rpc({
        checkout: {
          id: "checkout-1",
          status: "incomplete",
          currency: "INR",
          totals: [
            { type: "subtotal", display_text: "Items", amount: 49800 },
            { type: "fulfillment", display_text: "Shipping", amount: 4900 },
            { type: "total", display_text: "Total", amount: 54700 },
          ],
          fulfillment: {
            methods: [{
              id: "shipping-1",
              type: "shipping",
              selected_destination_id: "tokko_address_101",
              destinations: [submittedCheckout.fulfillment.methods[0].destinations[0]],
              groups: [{
                id: "package-1",
                selected_option_id: "standard",
                options: [{
                  id: "standard",
                  title: "Standard Shipping",
                  totals: [{ type: "total", amount: 4900 }],
                }],
              }],
            }],
          },
          continue_url: "https://himalaya.example/checkouts/secure-1",
        },
      });
    }
    throw new Error(`Unexpected tool: ${request.params.name}`);
  };

  const products = await ucp.searchMerchant("himalayawellness", "wellness", {
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  const result = await ucp.createCheckout(products[0].selectionToken, {
    quantity: 2,
    baseUrl: "https://tokko.example",
    buyer: {
      first_name: "Nilufa",
      email: "nilufa@example.com",
      phone_number: "+919876543210",
    },
    destination: {
      id: "tokko_address_101",
      first_name: "Nilufa",
      street_address: "12 Park Street",
      address_locality: "Kolkata",
      address_region: "West Bengal",
      postal_code: "700016",
      address_country: "IN",
      phone_number: "+919876543210",
    },
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(selected, {
    item: { id: "gid://shopify/ProductVariant/301" },
    quantity: 2,
  });
  assert.equal(result.checkoutUrl, "https://himalaya.example/checkouts/secure-1");
  assert.equal(result.continueUrl, "https://himalaya.example/checkouts/secure-1");
  assert.equal(result.totalAmount, "547.00");
  assert.equal(result.subtotalMinor, 49800);
  assert.equal(result.shippingMinor, 4900);
  assert.equal(result.totalMinor, 54700);
  assert.equal(result.reconciles, true);
  assert.equal(result.shippingQuoted, true);
  assert.equal(result.destinationSelected, true);
  assert.equal(result.phoneAccepted, true);
  assert.equal(result.shippingOptions[0].title, "Standard Shipping");
  assert.equal(result.paymentLink, undefined);
  assert.equal(result.merchantName, "Himalaya Wellness");
  assert.equal(submittedCheckout.buyer.email, "nilufa@example.com");
  assert.equal(
    submittedCheckout.fulfillment.methods[0].destinations[0].phone_number,
    "+919876543210"
  );
  assert.equal(
    submittedCheckout.fulfillment.methods[0].selected_destination_id,
    "tokko_address_101"
  );
  assert.equal(submittedCheckout.context.postal_code, "700016");
});

test("creates one merchant checkout containing every cart item", async () => {
  let submittedLineItems;
  const fakeFetch = async (url, options = {}) => {
    if (url === "https://zanducare.com/.well-known/ucp") {
      return Response.json(discovery("https://zandu.cart.test/mcp"));
    }
    const request = JSON.parse(options.body);
    if (request.params.name === "search_catalog") {
      return rpc({ products: [
        product("Cart Vitamin C", "cart-501", 10000),
        product("Cart Herbal Tonic", "cart-502", 25000),
      ] });
    }
    if (request.params.name === "create_checkout") {
      submittedLineItems = request.params.arguments.checkout.line_items;
      return rpc({ checkout: {
        id: "checkout-cart-1",
        status: "incomplete",
        currency: "INR",
        line_items: submittedLineItems,
        totals: [
          { type: "subtotal", amount: 45000 },
          { type: "total", amount: 45000 },
        ],
        continue_url: "https://zandu.example/checkouts/cart-1",
      } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const products = await ucp.searchMerchant("zanducare", "cart", {
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  const result = await ucp.createCheckout([
    { selectionToken: products[0].selectionToken, quantity: 2 },
    { selectionToken: products[1].selectionToken, quantity: 1 },
  ], {
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(submittedLineItems, [
    { item: { id: "gid://shopify/ProductVariant/cart-501" }, quantity: 2 },
    { item: { id: "gid://shopify/ProductVariant/cart-502" }, quantity: 1 },
  ]);
  assert.equal(result.productName, "2 cart items");
  assert.equal(result.quantity, 3);
  assert.equal(result.totalAmount, "450.00");
  assert.equal(result.continueUrl, "https://zandu.example/checkouts/cart-1");
});

test("advertises fulfillment and searches live UCP merchants in India and the US", () => {
  const profile = ucp.agentProfile("https://tokko.example").document;
  assert.ok(profile.ucp.capabilities["dev.ucp.shopping.fulfillment"]);
  assert.equal(ucp.MERCHANTS.zanducare.market, "IN");
  assert.equal(ucp.MERCHANTS.momentous.market, "US");
  assert.equal(Object.keys(ucp.MERCHANTS).length, 18);
});

test("selects the cheapest returned shipping option with update_checkout before finalizing totals", async () => {
  let updateArguments;
  const fakeFetch = async (url, options = {}) => {
    if (url === "https://himalayawellness.in/.well-known/ucp") {
      return Response.json(discovery("https://himalaya.shipping.test/mcp"));
    }
    const request = JSON.parse(options.body);
    if (request.params.name === "search_catalog") {
      return rpc({ products: [product("Shipping Test Vitamin", "shipping-401", 10000)] });
    }
    if (request.params.name === "create_checkout") {
      const input = request.params.arguments.checkout;
      return rpc({ checkout: {
        id: "checkout-shipping-1",
        status: "incomplete",
        currency: "INR",
        buyer: input.buyer,
        line_items: [{
          id: "line-1",
          item: { id: "gid://shopify/ProductVariant/shipping-401" },
          quantity: 1,
        }],
        totals: [
          { type: "subtotal", amount: 10000 },
          { type: "total", amount: 10000 },
        ],
        fulfillment: { methods: [{
          id: "shipping-method-1",
          type: "shipping",
          line_item_ids: ["line-1"],
          selected_destination_id: "tokko_address_55",
          destinations: input.fulfillment.methods[0].destinations,
          groups: [{
            id: "package-1",
            selected_option_id: null,
            options: [
              { id: "express", title: "Express", totals: [{ type: "total", amount: 1500 }] },
              { id: "standard", title: "Standard", totals: [{ type: "total", amount: 500 }] },
            ],
          }],
        }] },
        continue_url: "https://merchant.example/checkouts/shipping-1",
      } });
    }
    if (request.params.name === "update_checkout") {
      updateArguments = request.params.arguments;
      return rpc({ checkout: {
        id: "checkout-shipping-1",
        status: "incomplete",
        currency: "INR",
        totals: [
          { type: "subtotal", display_text: "Items", amount: 10000 },
          { type: "fulfillment", display_text: "Standard Shipping", amount: 500 },
          { type: "total", display_text: "Total", amount: 10500 },
        ],
        fulfillment: { methods: [{
          id: "shipping-method-1",
          type: "shipping",
          selected_destination_id: "tokko_address_55",
          destinations: request.params.arguments.checkout.fulfillment.methods[0].destinations,
          groups: [{
            id: "package-1",
            selected_option_id: "standard",
            options: [{ id: "standard", title: "Standard", totals: [{ type: "total", amount: 500 }] }],
          }],
        }] },
        continue_url: "https://merchant.example/checkouts/shipping-1",
      } });
    }
    throw new Error(`Unexpected tool: ${request.params.name}`);
  };

  const products = await ucp.searchMerchant("himalayawellness", "shipping test vitamin", {
    baseUrl: "https://tokko.example",
    fetchImpl: fakeFetch,
  });
  const result = await ucp.createCheckout(products[0].selectionToken, {
    baseUrl: "https://tokko.example",
    buyer: { email: "buyer@example.com", phone_number: "+919876543210" },
    destination: {
      id: "tokko_address_55",
      street_address: "12 Park Street",
      extended_address: "Apartment 3A",
      address_locality: "Kolkata",
      address_region: "West Bengal",
      postal_code: "700016",
      address_country: "IN",
      phone_number: "+919876543210",
    },
    fetchImpl: fakeFetch,
  });
  assert.equal(updateArguments.id, "checkout-shipping-1");
  assert.equal(updateArguments.checkout.id, undefined);
  assert.equal(
    updateArguments.checkout.fulfillment.methods[0].groups[0].selected_option_id,
    "standard"
  );
  assert.equal(result.shippingMinor, 500);
  assert.equal(result.totalMinor, 10500);
  assert.equal(result.shippingOptions[0].selected, true);
});
