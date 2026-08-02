const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
process.env.HERMES_ACTION_SECRET ||= "test-hermes-action-secret";
const server = require("../server.js");
const db = require("../lib/db.js");
const payments = require("../lib/payments.js");
const ucp = require("../lib/ucp.js");

test("server.js exports the HTTP server expected by Vercel", () => {
  assert.equal(server instanceof http.Server, true);
  assert.equal(typeof server.handler, "function");
  assert.equal(typeof server.initializeApplication, "function");
  assert.equal(typeof server.savedAddressInput, "function");
  assert.equal(typeof server.familyAddressInput, "function");
  assert.equal(typeof server.ucpPurchaseContext, "function");
  assert.equal(typeof server.ucpQuoteWithForexCharge, "function");
  assert.equal(typeof server.continueUcpOrderPayment, "function");
  assert.equal(typeof server.listPravaMandatesForUser, "function");
  assert.equal(typeof server.start, "function");
  assert.equal(
    server.canonicalPravaCustomerId(42),
    "tokko_family_42"
  );
});

test("Prava mandate lookup merges current and historical family customer IDs", { concurrency: false }, async () => {
  const original = payments.listMandates;
  const requested = [];
  try {
    payments.listMandates = async (customerId) => {
      requested.push(customerId);
      if (customerId === "tokko_user_42") {
        return [{
          id: "mdt_legacy_active",
          status: "active",
          remaining: "150.00",
          approvedAmount: "150.00",
          currency: "INR",
        }];
      }
      return [];
    };
    const result = await server.listPravaMandatesForUser(
      42,
      "tokko_family_42"
    );
    assert.deepEqual(requested.sort(), ["tokko_family_42", "tokko_user_42"]);
    assert.equal(result.mandates.length, 1);
    assert.equal(result.mandates[0].id, "mdt_legacy_active");
  } finally {
    payments.listMandates = original;
  }
});

test("saved-card payment continuation returns the Prava payment-result token in sandbox", { concurrency: false }, async () => {
  const originals = {
    getUcpOrderIntent: db.getUcpOrderIntent,
    saveUcpOrderIntent: db.saveUcpOrderIntent,
    getPaymentResult: payments.getPaymentResult,
    configuration: payments.configuration,
  };
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    merchant_slug: "himalaya",
    merchant_name: "Himalaya Wellness",
    merchant_url: "https://himalayawellness.in",
    merchant_checkout_id: "checkout_1",
    selection_token: "selection_1",
    quote_snapshot: {},
    currency: "INR",
    total_minor: 10300,
    status: "PRAVA_CARD_APPROVAL_REQUIRED",
    price_confirmed_at: new Date().toISOString(),
    payment_route: "card",
    prava_session_id: "sess_saved_card_1",
  };
  try {
    db.getUcpOrderIntent = async () => row;
    db.saveUcpOrderIntent = async (_userId, input) => ({
      ...row,
      status: input.status,
      prava_transaction_id: input.pravaTransactionId,
      credential_fingerprint: input.credentialFingerprint,
      credential_issued_at: input.credentialIssuedAt,
    });
    payments.getPaymentResult = async () => ({
      status: "awaiting_result",
      transactions: [{
        status: "awaiting_result",
        line_items: [{
          txn_ref_id: "tli_saved_1",
          status: "awaiting_result",
          token: "4111111111111111",
          dynamic_cvv: "456",
          expiry_month: "12",
          expiry_year: "2030",
        }],
      }],
    });
    payments.configuration = () => ({ environment: "sandbox", configured: true });
    const result = await server.continueUcpOrderPayment(42, row.id);
    assert.equal(result.tokenIssued, true);
    assert.equal(result.sandboxPaymentCredential.sessionId, "sess_saved_card_1");
    assert.equal(result.sandboxPaymentCredential.transactionId, "tli_saved_1");
    assert.equal(result.sandboxPaymentCredential.token, "4111111111111111");
    assert.match(result.note, /payment-result/i);
  } finally {
    Object.assign(db, {
      getUcpOrderIntent: originals.getUcpOrderIntent,
      saveUcpOrderIntent: originals.saveUcpOrderIntent,
    });
    Object.assign(payments, {
      getPaymentResult: originals.getPaymentResult,
      configuration: originals.configuration,
    });
  }
});

test("UCP payable total adds three percent forex after the full merchant cart", () => {
  const quote = server.ucpQuoteWithForexCharge({
    currency: "INR",
    totalMinor: 12345,
    totalAmount: "123.45",
    totals: [
      { type: "subtotal", label: "Items", amountMinor: 10000 },
      { type: "tax", label: "Tax", amountMinor: 845 },
      { type: "fulfillment", label: "Shipping", amountMinor: 1500 },
      { type: "total", label: "Merchant total", amountMinor: 12345 },
    ],
  });
  assert.equal(quote.merchantTotalMinor, 12345);
  assert.equal(quote.forexChargeMinor, 370);
  assert.equal(quote.totalMinor, 12715);
  assert.equal(quote.totalAmount, "127.15");
  assert.deepEqual(quote.totals.at(-2), {
    type: "forex",
    label: "Foreign exchange charge (3%)",
    amountMinor: 370,
    lines: [],
  });
  assert.deepEqual(quote.totals.at(-1), {
    type: "total",
    label: "Total payable",
    amountMinor: 12715,
    lines: [],
  });
});

test("UCP Prava context uses the exact final quote with a non-empty order description", () => {
  const context = server.ucpPurchaseContext({
    merchantName: "Himalaya Wellness",
    merchantUrl: "https://himalayawellness.in",
    market: "IN",
    checkoutId: "checkout_himalaya_1",
    totalAmount: "171.00",
    items: [{
      quantity: 1,
      productName: "Himalaya Gentle Daily Care Natural Protein Shampoo",
      variantName: "180ml",
      quotedUnitPrice: 146,
    }],
  });
  assert.equal(context.length, 1);
  assert.match(
    context[0].product_details[0].description,
    /Himalaya Gentle Daily Care Natural Protein Shampoo/
  );
  assert.equal(context[0].product_details[0].unit_price, "171.00");
  assert.equal(context[0].product_details[0].quantity, 1);
});

test("email OTP verification is a public signup route", () => {
  assert.ok(server.matchRoute("POST", "/api/auth/signup"));
  assert.ok(server.matchRoute("POST", "/api/auth/signup/verify"));
  assert.ok(server.matchRoute("POST", "/api/auth/login"));
});

test("Hermes chat is a website-session route", () => {
  const matched = server.matchRoute("POST", "/api/hermes/chat");
  assert.ok(matched);
  assert.ok(server.matchRoute("GET", "/api/hermes/memory"));
  assert.ok(server.matchRoute("POST", "/api/hermes/transcribe"));
  assert.ok(server.matchRoute("POST", "/api/hermes/media"));
  assert.ok(server.matchRoute("POST", "/api/hermes/checkout/continue"));
  assert.ok(server.matchRoute("DELETE", "/api/merchants/ucp/cart"));
  assert.ok(server.matchRoute("DELETE", "/api/merchants/ucp/cart/items/123"));
  assert.ok(server.matchRoute("GET", "/api/merchants/ucp/orders/0d34ce08-b382-44fc-a10f-3bc6d6d67ce0/payment-options"));
});

test("cart requests can show, remove one item, or empty the cart", () => {
  const items = [{ id: "10", productName: "Neem Shampoo", variantName: "200 ml" }];
  assert.deepEqual(
    server.requestedCartAction([{ role: "user", content: "show my cart" }], items),
    { type: "show" }
  );
  assert.equal(
    server.requestedCartAction([{ role: "user", content: "remove shampoo from cart" }], items).item.id,
    "10"
  );
  assert.deepEqual(
    server.requestedCartAction([{ role: "user", content: "empty my cart" }], items),
    { type: "clear" }
  );
});

test("UCP cart detects a delivery-country change before merchant search", () => {
  const cart = [{
    id: "10",
    merchant: "himalayawellness",
    merchantName: "Himalaya Wellness",
    market: "IN",
    currency: "INR",
    productName: "Men's Face Wash",
    quantity: 1,
  }];
  const conflict = server.ucpCartCountryConflict(cart, "US");
  assert.equal(conflict.code, "cart_delivery_country_conflict");
  assert.equal(conflict.cartCountry, "IN");
  assert.equal(conflict.targetCountry, "US");
  assert.equal(conflict.currentMerchant, "himalayawellness");
  assert.equal(conflict.itemCount, 1);
  assert.equal(server.ucpCartCountryConflict(cart, "IN"), null);
});

test("Telegram Hermes integration exposes the configured bot endpoint", () => {
  assert.ok(server.matchRoute("POST", "/api/v1/onboarding"));
  assert.ok(
    server.matchRoute("GET", "/api/v1/onboarding/42/payment/mandates")
  );
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/v1/onboarding/42/payment/mandates/session"
    )
  );
  assert.ok(
    server.matchRoute(
      "GET",
      "/api/v1/onboarding/42/merchants/ucp/orders/0d34ce08-b382-44fc-a10f-3bc6d6d67ce0"
    )
  );
  assert.ok(
    server.matchRoute("POST", "/api/integrations/telegram/hermes")
  );
  assert.ok(
    server.matchRoute(
      "POST", "/api/integrations/telegram/hermes/cart-country-retry"
    )
  );
  assert.ok(
    server.matchRoute("POST", "/api/v1/onboarding/42/hermes/transcribe")
  );
  assert.ok(
    server.matchRoute("POST", "/api/v1/onboarding/42/hermes/media")
  );
  assert.ok(
    server.matchRoute(
      "GET",
      "/api/v1/integrations/telegram/bindings/7783253227"
    )
  );
  assert.ok(
    server.matchRoute(
      "PUT",
      "/api/v1/integrations/telegram/bindings/7783253227"
    )
  );
  assert.ok(
    server.matchRoute(
      "GET",
      "/api/v1/integrations/telegram/bindings/7783253227/address-session"
    )
  );
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/v1/integrations/telegram/bindings/7783253227/address-session"
    )
  );
  assert.ok(
    server.matchRoute(
      "GET", "/api/v1/onboarding/42/addresses"
    )
  );
  assert.ok(
    server.matchRoute(
      "POST", "/api/v1/onboarding/42/addresses/select"
    )
  );
  assert.ok(server.matchRoute("POST", "/api/v1/onboarding/42/addresses"));
  assert.ok(
    server.matchRoute("POST", "/api/v1/onboarding/42/merchants/ucp/search")
  );
  assert.equal(
    server.telegramChatIdentifier({ telegramChatId: 123456789 }),
    "123456789"
  );
  assert.equal(
    server.telegramChatIdentifier({
      message: { chat: { id: -1001234567890 }, text: "find milk" },
    }),
    "-1001234567890"
  );
  assert.equal(
    server.telegramMessageText({
      message: { chat: { id: 123 }, text: "  find milk  " },
    }),
    "find milk"
  );
  assert.throws(
    () => server.telegramChatIdentifier({ telegramChatId: "not-a-chat" }),
    /telegramChatId is required/
  );
  assert.equal(server.HERMES_ZEPTO_RECONNECT_TOOL.name, "start_zepto_reconnect");
  assert.equal(
    server.hermesOtpFromMessages([
      { role: "user", content: "my otp is 123456" },
    ]),
    "123456"
  );
  assert.equal(
    server.hermesOtpFromMessages([
      { role: "user", content: "reconnect zepto" },
    ]),
    null
  );
});

test("Tokko-native addresses do not require merchant coordinates", () => {
  const address = server.familyAddressInput({
    label: "Parents",
    formattedAddress: "12 Park Street, Kolkata 700016",
  });
  assert.equal(address.label, "Parents");
  assert.equal(address.formattedAddress, "12 Park Street, Kolkata 700016");
  assert.equal(address.countryCode, "IN");
  assert.equal("latitude" in address, false);
  assert.equal("longitude" in address, false);
});

test("Tokko-native addresses accept any ISO two-letter delivery country", () => {
  const address = server.familyAddressInput({
    label: "London",
    formattedAddress: "10 Downing Street, London SW1A 2AA",
    countryCode: "gb",
    contactPhone: "+447911123456",
  });
  assert.equal(address.countryCode, "GB");
  assert.equal(address.contactPhone, "+447911123456");
});

test("mandate presentation shows five records and keeps one month of history", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const mandates = Array.from({ length: 8 }, (_, index) => ({
    id: `mdt_${index + 1}`,
    status: index < 6 ? "active" : "expired",
    state: index < 6 ? "available" : null,
    approvedAmount: String((index + 1) * 100),
    remaining: String((index + 1) * 50),
    currency: "INR",
    frequency: "monthly",
    merchantName: "Zepto",
    createdAt: new Date(now - index * 7 * 24 * 60 * 60 * 1_000).toISOString(),
  }));
  const summary = server.mandateListPayload(mandates, {}, now);
  assert.equal(summary.view, "summary");
  assert.equal(summary.mandates.length, 5);
  assert.equal(summary.totalCount, 8);
  assert.equal(summary.hasMore, true);
  assert.equal(summary.summary.activeCount, 6);
  assert.equal(summary.summary.approvedAmount, 2100);

  const history = server.mandateListPayload(
    mandates,
    { view: "history", days: "30" },
    now
  );
  assert.equal(history.view, "history");
  assert.equal(history.historyDays, 30);
  assert.deepEqual(
    history.mandates.map((mandate) => mandate.id),
    ["mdt_1", "mdt_2", "mdt_3", "mdt_4", "mdt_5"]
  );
});

test("Tokko exposes readable Zepto address choices without internal-only text", () => {
  const addressId = "0899ae1f-bfb1-4eb7-bf0f-55c993389c27";
  const rows = server.zeptoSavedAddressRows({
    content: [{
      type: "text",
      text: [
        "1. **parents home**: 12a lake view, salt lake, kolkata 700091",
        "---",
        `1. parents home -> Address ID: ${addressId}`,
      ].join("\n"),
    }],
  });
  assert.deepEqual(rows, [{
    id: addressId,
    label: "parents home",
    formattedAddress: "parents home: 12a lake view, salt lake, kolkata 700091",
  }]);
});

test("Tokko payment routing checks all mandates before card and COD", () => {
  const mandates = [
    {
      id: "mandate-500-paused",
      status: "paused",
      remaining: "500.00",
      currency: "INR",
      merchantName: "Zepto",
    },
    {
      id: "mandate-200",
      status: "active",
      remaining: "200.00",
      currency: "INR",
      merchantName: "Zepto",
    },
    {
      id: "mandate-150",
      status: "active",
      remaining: "150.00",
      currency: "INR",
      merchantName: "Zepto",
    },
  ];
  const paymentMethods = [{ id: 7, is_default: true, last4: "4242" }];
  const mandateRoute = server.tokkoPaymentRoute({
    mandates,
    paymentMethods,
    amount: "140.00",
  });
  assert.equal(mandateRoute.route, "mandate");
  assert.equal(mandateRoute.mandate.id, "mandate-150");
  assert.equal(mandateRoute.checkedMandateCount, 3);

  const cardRoute = server.tokkoPaymentRoute({
    mandates,
    paymentMethods,
    amount: "250.00",
  });
  assert.equal(cardRoute.route, "prava_card");
  assert.equal(cardRoute.card.id, 7);
  assert.equal(cardRoute.checkedMandateCount, 3);

  const codRoute = server.tokkoPaymentRoute({
    mandates,
    paymentMethods: [],
    amount: "250.00",
  });
  assert.equal(codRoute.route, "cod");
  assert.equal(codRoute.checkedMandateCount, 3);
});

test("UCP mandate routing requires active balance and matching merchant scope", () => {
  const mandates = [
    {
      id: "mdt-zepto",
      status: "active",
      merchantScope: "listed",
      merchantName: "Zepto",
      remaining: "1000.00",
      currency: "INR",
    },
    {
      id: "mdt-himalaya-large",
      status: "active",
      merchantScope: "listed",
      merchantName: "Himalaya Wellness",
      remaining: "500.00",
      currency: "INR",
    },
    {
      id: "mdt-himalaya-small",
      state: "available",
      merchantScope: "listed",
      merchantName: "Himalaya Wellness",
      remaining: "300.00",
      currency: "INR",
    },
  ];
  const usable = server.usablePravaMandatesForMerchant(
    mandates,
    "260.00",
    "Himalaya Wellness",
    "https://himalayawellness.in"
  );
  assert.deepEqual(usable.map((mandate) => mandate.id), [
    "mdt-himalaya-small",
    "mdt-himalaya-large",
  ]);
});

test(
  "UCP checkout checks mandates and returns the Charge API token with the checkout handoff",
  { concurrency: false },
  async () => {
    const originals = {
      createCheckout: ucp.createCheckout,
      configuration: payments.configuration,
      listCards: payments.listCards,
      listMandates: payments.listMandates,
      chargeMandate: payments.chargeMandate,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      getFamilyAddresses: db.getFamilyAddresses,
    };
    let chargeInput;
    let checkoutOptions;
    try {
      ucp.createCheckout = async (_token, options) => {
        checkoutOptions = options;
        return ({
        merchant: "himalayawellness",
        merchantName: "Himalaya Wellness",
        merchantUrl: "https://himalayawellness.in",
        productName: "Ashwagandha",
        variantName: "60 N",
        variantId: "gid://shopify/ProductVariant/301",
        quantity: 1,
        currency: "INR",
        quotedUnitPrice: 260,
        totalMinor: 26000,
        totalAmount: "260.00",
        totals: [{ type: "total", label: "Total", amountMinor: 26000 }],
        checkoutId: "gid://shopify/Checkout/test",
        status: "requires_escalation",
        checkoutUrl: "https://merchant.example/cart/c/test",
        continueUrl: "https://merchant.example/cart/c/test",
          paymentHandlers: ["dev.shopify.card"],
        });
      };
      payments.configuration = () => ({
        configured: true,
        environment: "sandbox",
      });
      payments.listCards = async () => [];
      payments.listMandates = async () => [{
        id: "mdt_himalaya",
        status: "active",
        merchantScope: "listed",
        merchantName: "Himalaya Wellness",
        remaining: "500.00",
        currency: "INR",
      }];
      payments.chargeMandate = async (input) => {
        chargeInput = input;
        return {
          mandateId: input.mandateId,
          transactionId: "txn_ucp_1",
          status: "awaiting_result",
          deduplicated: false,
          credentials: {
            token: "4111111111111111",
            dynamicCvv: "321",
            expiryMonth: "12",
            expiryYear: "2030",
          },
        };
      };
      db.getUserById = async () => ({ id: 42, email: "family@example.com" });
      db.getProfile = async () => ({
        user_id: 42,
        primary_parent_name: "Family Parent",
        primary_parent_phone: "+919876543210",
      });
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_42",
      });
      db.getPaymentMethods = async () => [];
      db.getFamilyAddresses = async () => [{
        id: 101,
        label: "Parents",
        formatted_address: "12 Park Street, Kolkata 700016, West Bengal",
        address_line1: "12 Park Street",
        city: "Kolkata 700016, West Bengal",
        state: null,
        postal_code: null,
        country_code: "IN",
        contact_name: "Family Parent",
        contact_phone: "+919876543210",
        is_selected: true,
      }];

      const result = await server.createUcpCheckoutWithPayment(42, {
        selectionToken: "signed-selection",
        quantity: 1,
      });
      assert.equal(chargeInput.mandateId, "mdt_himalaya");
      assert.equal(chargeInput.amount, "260.00");
      assert.equal(chargeInput.purchaseContext, undefined);
      assert.equal(result.merchantHandoffUrl, "https://merchant.example/cart/c/test");
      assert.equal(result.paymentUrl, null);
      assert.equal(result.paymentUrlAvailable, false);
      assert.equal(result.paymentRoute, "mandate");
      assert.equal(result.mandateCheck.status, "credential_issued");
      assert.equal(result.paymentHandoff.credentials.token, "4111111111111111");
      assert.equal(result.nextAction.url, result.merchantHandoffUrl);
      assert.equal(result.autofill.addressId, "101");
      assert.equal(result.autofill.phoneLast4, "3210");
      assert.equal(checkoutOptions.destination.address_locality, "Kolkata");
      assert.equal(checkoutOptions.destination.address_region, "West Bengal");
      assert.equal(checkoutOptions.destination.postal_code, "700016");
      assert.equal(
        checkoutOptions.destination.street_address,
        "12 Park Street"
      );
    } finally {
      Object.assign(ucp, { createCheckout: originals.createCheckout });
      Object.assign(payments, {
        configuration: originals.configuration,
        listCards: originals.listCards,
        listMandates: originals.listMandates,
        chargeMandate: originals.chargeMandate,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getPaymentMethods: originals.getPaymentMethods,
        getFamilyAddresses: originals.getFamilyAddresses,
      });
    }
  }
);

test(
  "UCP checkout asks the user to choose a saved Prava card when mandates do not cover it",
  { concurrency: false },
  async () => {
    const originals = {
      createCheckout: ucp.createCheckout,
      configuration: payments.configuration,
      listCards: payments.listCards,
      listMandates: payments.listMandates,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      getFamilyAddresses: db.getFamilyAddresses,
    };
    try {
      ucp.createCheckout = async () => ({
        merchant: "oziva",
        merchantName: "OZiva",
        merchantUrl: "https://www.oziva.in",
        productName: "Plant Protein",
        variantName: "1 kg",
        variantId: "gid://shopify/ProductVariant/401",
        quantity: 1,
        currency: "INR",
        totalMinor: 99900,
        totalAmount: "999.00",
        totals: [{ type: "total", label: "Total", amountMinor: 99900 }],
        checkoutId: "gid://shopify/Checkout/card-test",
        status: "requires_escalation",
        checkoutUrl: "https://merchant.example/cart/c/card-test",
        continueUrl: "https://merchant.example/cart/c/card-test",
        paymentHandlers: ["dev.shopify.card"],
      });
      payments.configuration = () => ({ configured: true, environment: "sandbox" });
      payments.listCards = async () => [];
      payments.listMandates = async () => [];
      db.getUserById = async () => ({ id: 43, email: "card@example.com" });
      db.getProfile = async () => ({
        user_id: 43,
        primary_parent_name: "Card Parent",
        primary_parent_phone: "+919900112233",
      });
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_43",
      });
      db.getPaymentMethods = async () => [{
        id: 7,
        provider: "prava",
        provider_payment_method_id: "card_saved_7",
        brand: "visa",
        last4: "4242",
        is_default: true,
      }];
      db.getFamilyAddresses = async () => [{
        id: 102,
        label: "Home",
        formatted_address: "1 Lake Road, Kolkata 700029",
        address_line1: "1 Lake Road",
        city: "Kolkata",
        state: "West Bengal",
        postal_code: "700029",
        country_code: "IN",
        contact_name: "Card Parent",
        contact_phone: "+919900112233",
        is_selected: true,
      }];

      const result = await server.createUcpCheckoutWithPayment(43, {
        selectionToken: "signed-card-selection",
        quantity: 1,
      });
      assert.equal(result.paymentRoute, "card_selection_required");
      assert.equal(result.cardChoices[0].brand, "visa");
      assert.equal(result.cardChoices[0].last4, "4242");
      assert.equal(result.mandateCheck.checkedMandateCount, 0);
      assert.equal(result.mandateCheck.status, "card_selection_required");
      assert.equal(result.paymentSelection.route, "prava_card");
      assert.equal(result.paymentSelection.selected, false);
      assert.equal(result.paymentSelection.merchantInstrumentSelected, false);
      assert.equal(result.autofill.phoneLast4, "2233");

      const selected = await server.selectUcpSavedCard(
        43,
        result.cardChoices[0].token
      );
      assert.equal(selected.paymentRoute, "prava_card");
      assert.equal(selected.savedCard.last4, "4242");
      assert.equal(
        selected.nextAction.url,
        "https://merchant.example/cart/c/card-test"
      );
    } finally {
      Object.assign(ucp, { createCheckout: originals.createCheckout });
      Object.assign(payments, {
        configuration: originals.configuration,
        listCards: originals.listCards,
        listMandates: originals.listMandates,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getPaymentMethods: originals.getPaymentMethods,
        getFamilyAddresses: originals.getFamilyAddresses,
      });
    }
  }
);

test("Zepto online-order helpers accept structured MCP response variants", () => {
  assert.equal(
    server.zeptoOrderId({ data: { id: "order-structured-1" } }),
    "order-structured-1"
  );
  assert.equal(
    server.zeptoOrderId({ result: { order_id: "order-structured-2" } }),
    "order-structured-2"
  );
  assert.equal(
    server.zeptoPaymentLink({
      order: { paymentUrl: "https://pay.example.test/order-1" },
    }),
    "https://pay.example.test/order-1"
  );
  assert.deepEqual(
    server.zeptoOrderRows({
      data: {
        orders: [
          { id: "order-history-1", formattedStatus: "CONFIRMED" },
        ],
      },
    }),
    [{ id: "order-history-1", formattedStatus: "CONFIRMED" }]
  );
});

test("Prava tokenization routes replace the legacy payment setup route", () => {
  assert.ok(
    server.matchRoute("POST", "/api/payments/tokenization-session")
  );
  assert.ok(
    server.matchRoute("GET", "/api/payments/payment-results")
  );
  assert.ok(
    server.matchRoute("POST", "/api/order/cod-decision")
  );
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/v1/onboarding/42/payment/tokenization-session"
    )
  );
  assert.ok(
    server.matchRoute("POST", "/api/v1/onboarding/42/payment/complete")
  );
  assert.ok(
    server.matchRoute(
      "GET",
      "/api/v1/onboarding/%2B919900112233/payment-methods"
    )
  );
  assert.ok(server.matchRoute("GET", "/api/payments/return"));
  assert.ok(
    server.matchRoute("POST", "/api/payments/mandates/callback/complete")
  );
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/v1/onboarding/42/payment/mandates/callback/complete"
    )
  );
  assert.equal(
    server.matchRoute("POST", "/api/payments/setup-intent"),
    null
  );
});

test("Prava callbacks return website flows to the app and Telegram flows to the bot bridge", () => {
  const website = new URL(server.pravaReturnCallback("card"));
  assert.equal(website.searchParams.get("pravaCard"), "return");

  const websiteMandate = new URL(server.pravaReturnCallback("mandate", {
    channel: "web",
    page: "assistant",
    orderId: "33333333-3333-4333-8333-333333333333",
    callbackId: "44444444-4444-4444-8444-444444444444",
  }));
  assert.equal(websiteMandate.searchParams.get("pravaMandate"), "return");
  assert.equal(websiteMandate.searchParams.get("pravaReturnPage"), "assistant");
  assert.equal(
    websiteMandate.searchParams.get("pravaCallback"),
    "44444444-4444-4444-8444-444444444444"
  );
  assert.equal(
    websiteMandate.searchParams.get("ucpOrder"),
    "33333333-3333-4333-8333-333333333333"
  );

  const telegram = new URL(
    server.pravaReturnCallback("card", {
      channel: "telegram",
      botUsername: "TokkoShopperBot",
    })
  );
  assert.equal(telegram.pathname, "/api/payments/return");
  assert.equal(telegram.searchParams.get("channel"), "telegram");
  assert.equal(telegram.searchParams.get("bot"), "TokkoShopperBot");
  assert.equal(telegram.searchParams.get("flow"), "card");

  const mandate = new URL(
    server.pravaReturnCallback("mandate", {
      channel: "telegram",
      botUsername: "@TokkoShopperBot",
      callbackId: "55555555-5555-4555-8555-555555555555",
    })
  );
  assert.equal(mandate.searchParams.get("flow"), "mandate");
  assert.equal(
    mandate.searchParams.get("callback"),
    "55555555-5555-4555-8555-555555555555"
  );
  assert.throws(
    () => server.pravaReturnCallback("card", {
      channel: "telegram",
      botUsername: "https://evil.example/redirect",
    }),
    /valid Telegram bot username/
  );
  assert.throws(
    () => server.pravaReturnCallback("mandate", {
      callbackId: "not-a-callback",
    }),
    /valid Prava callback ID/
  );
});

test("sandbox Prava handoff exposes the ephemeral credential for inspection only", () => {
  const handoff = server.pravaPaymentHandoff(
    {
      id: "checkout-sandbox-1",
      prava_charge_amount: "36.50",
      card_brand: "visa",
      card_last4: "4242",
    },
    {
      mandateId: "mdt-sandbox",
      transactionId: "txn-sandbox",
      credentials: {
        token: "4111111111111111",
        dynamicCvv: "321",
        expiryMonth: "12",
        expiryYear: "2030",
      },
    },
    { sandbox: true }
  );

  assert.equal(handoff.sandbox, true);
  assert.equal(handoff.destination, "sandbox_inspection_only");
  assert.equal(handoff.requiresManualEntry, false);
  assert.equal(handoff.sentToZepto, false);
  assert.equal(handoff.automaticInsertion, false);
  assert.equal(handoff.storage, "memory_only");
  assert.deepEqual(handoff.credentials, {
    token: "4111111111111111",
    dynamicCvv: "321",
    expiryMonth: "12",
    expiryYear: "2030",
  });
});

test("sandbox Zepto handoff permits manual entry without sending credentials", () => {
  const handoff = server.pravaPaymentHandoff(
    {
      id: "checkout-sandbox-zepto-1",
      prava_charge_amount: "36.50",
      card_brand: "visa",
      card_last4: "4242",
    },
    {
      mandateId: "mdt-sandbox",
      transactionId: "txn-sandbox-zepto",
      credentials: {
        token: "4111111111111111",
        dynamicCvv: "321",
        expiryMonth: "12",
        expiryYear: "2030",
      },
    },
    { sandbox: true, zeptoAttempt: true }
  );

  assert.equal(handoff.sandbox, true);
  assert.equal(handoff.destination, "zepto_secure_payment_link");
  assert.equal(handoff.requiresManualEntry, true);
  assert.equal(handoff.sentToZepto, false);
  assert.equal(handoff.automaticInsertion, false);
});

test("savedAddressInput composes an address when building is omitted", () => {
  const input = server.savedAddressInput({
    type: "home",
    name: "Home",
    flatDetails: "12A",
    shortAddress: "Salt Lake, Kolkata, West Bengal",
    contactName: "Example User",
    contactNumber: "+919876543210",
    latitude: 22.5726,
    longitude: 88.3639,
  });

  assert.deepEqual(input, {
    type: "HOME",
    name: "Home",
    flatDetails: "12A",
    buildingName: "Independent house",
    floor: undefined,
    landmark: undefined,
    latitude: 22.5726,
    longitude: 88.3639,
    formattedAddress: "12A, Independent house, Salt Lake, Kolkata, West Bengal",
    shortAddress: "Salt Lake, Kolkata, West Bengal",
    contactName: "Example User",
    contactNumber: "+919876543210",
    buildingType: "BUILDING_TYPE_HOUSE",
  });
});

test("savedAddressInput normalizes Indian delivery contact numbers", () => {
  const input = server.savedAddressInput({
    type: "HOME",
    name: "Home",
    flatDetails: "12A",
    shortAddress: "Kolkata, West Bengal",
    contactName: "Example User",
    contactNumber: "98765 43210",
    latitude: 22.5726,
    longitude: 88.3639,
  });
  assert.equal(input.contactNumber, "+919876543210");
  assert.throws(
    () =>
      server.savedAddressInput({
        type: "HOME",
        name: "Home",
        flatDetails: "12A",
        shortAddress: "Kolkata, West Bengal",
        contactName: "Example User",
        contactNumber: "+911234567890",
        latitude: 22.5726,
        longitude: 88.3639,
      }),
    /valid 10-digit Indian/
  );
});

test("savedAddressInput allows coordinates to be omitted", () => {
  const input = server.savedAddressInput({
    type: "HOME",
    name: "Home",
    flatDetails: "12A",
    shortAddress: "Kolkata, West Bengal",
    contactName: "Example User",
    contactNumber: "+919876543210",
  });
  assert.equal(input.latitude, undefined);
  assert.equal(input.longitude, undefined);
});

test("Zepto address context resolves saved coordinates and the primary store", () => {
  const addressId = "0899ae1f-bfb1-4eb7-bf0f-55c993389c27";
  assert.deepEqual(
    server.zeptoAddressLocationContext({
      addresses: [{
        id: addressId,
        latitude: 22.510117368562877,
        longitude: 88.40566797181964,
      }],
    }, addressId),
    {
      latitude: 22.510117368562877,
      longitude: 88.40566797181964,
      storeId: "",
    }
  );
  assert.deepEqual(
    server.zeptoAddressLocationContext(
      "Serviceable in 10 minutes. Primary store ID: 9cc80a80-f39d-4da4-9ce6-14fad42e470e"
    ),
    {
      latitude: null,
      longitude: null,
      storeId: "9cc80a80-f39d-4da4-9ce6-14fad42e470e",
    }
  );
});

test("savedAddressInput validates coordinates only when supplied", () => {
  assert.throws(
    () =>
      server.savedAddressInput({
        type: "HOME",
        name: "Home",
        flatDetails: "12A",
        shortAddress: "Kolkata",
        contactName: "Example User",
        contactNumber: "+919876543210",
        latitude: 22.5726,
      }),
    /both latitude and longitude/
  );
  assert.throws(
    () =>
      server.savedAddressInput({
        type: "HOME",
        name: "Home",
        flatDetails: "12A",
        shortAddress: "Kolkata",
        contactName: "Example User",
        contactNumber: "+919876543210",
        latitude: 0,
        longitude: 0,
      }),
    /valid coordinates/
  );
});
