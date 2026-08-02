const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
process.env.HERMES_ACTION_SECRET ||= "test-hermes-action-secret";
const server = require("../server.js");
const db = require("../lib/db.js");
const hermes = require("../lib/hermes.js");
const payments = require("../lib/payments.js");
const ucp = require("../lib/ucp.js");

test("server.js exports the HTTP server expected by Vercel", () => {
  assert.equal(server instanceof http.Server, true);
  assert.equal(typeof server.handler, "function");
  assert.equal(typeof server.initializeApplication, "function");
  assert.equal(typeof server.savedAddressInput, "function");
  assert.equal(typeof server.familyAddressInput, "function");
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
          merchantScope: "any",
          remaining: "150.00",
          approvedAmount: "150.00",
          currency: "INR",
        }];
      }
      return [];
    };
    const mandates = await server.listPravaMandatesForUser(
      42,
      "tokko_family_42"
    );
    assert.deepEqual(requested.sort(), ["tokko_family_42", "tokko_user_42"]);
    assert.equal(mandates.length, 1);
    assert.equal(mandates[0].id, "mdt_legacy_active");
  } finally {
    payments.listMandates = original;
  }
});

test("Hermes UCP search fans out without a merchant filter and returns only three", async () => {
  const originalSearchAll = ucp.searchAll;
  let capturedOptions;
  ucp.searchAll = async (_query, options) => {
    capturedOptions = options;
    return {
      products: [1, 2, 3, 4].map((price) => ({ price })),
      pagination: { hasMore: true },
    };
  };
  try {
    const result = await server.executeHermesTool(
      {},
      42,
      "search_wellness_merchants",
      { query: "vitamin", market: "IN", merchant: "himalayawellness", limit: 50 }
    );
    assert.equal(capturedOptions.limit, 3);
    assert.equal(capturedOptions.offset, 0);
    assert.equal(capturedOptions.merchantResultLimit, 50);
    assert.equal("merchant" in capturedOptions, false);
    assert.deepEqual(result.products.map((product) => product.price), [1, 2, 3]);
    assert.equal(result.selectedMerchant, null);
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.limit, 3);
  } finally {
    ucp.searchAll = originalSearchAll;
  }
});

test("email OTP verification is a public signup route", () => {
  assert.ok(server.matchRoute("POST", "/api/auth/signup"));
  assert.ok(server.matchRoute("POST", "/api/auth/signup/verify"));
  assert.ok(server.matchRoute("POST", "/api/auth/clerk/session"));
  assert.ok(server.matchRoute("POST", "/api/auth/login"));
});

test("functional family dashboard routes are registered", () => {
  assert.ok(server.matchRoute("PUT", "/api/onboarding/profile"));
  assert.ok(server.matchRoute("GET", "/api/addresses"));
  assert.ok(server.matchRoute("PUT", "/api/addresses/42"));
  assert.ok(server.matchRoute("DELETE", "/api/addresses/42"));
  assert.ok(server.matchRoute("PUT", "/api/care-rules"));
  assert.ok(server.matchRoute("PUT", "/api/preferences"));
  assert.ok(server.matchRoute("GET", "/api/decisions"));
  assert.ok(server.matchRoute("POST", "/api/decisions/request-id/resolve"));
  assert.ok(server.matchRoute("POST", "/api/v1/decisions"));
  assert.ok(server.matchRoute("GET", "/api/activity"));
});

test("care rules enforce bounded automatic spending", () => {
  const rules = server.careRulesInput({
    approvalMode: "auto_essentials",
    monthlyCap: 5000,
    perOrderCap: 1200,
    allowedCategories: ["medicines", "wellness"],
    repeatKnownEssentials: true,
  });
  assert.equal(rules.approvalMode, "auto_essentials");
  assert.equal(rules.perOrderCap, 1200);
  assert.throws(
    () => server.careRulesInput({
      approvalMode: "auto_essentials",
      monthlyCap: 500,
      perOrderCap: 1000,
      allowedCategories: ["medicines"],
    }),
    /cannot exceed/
  );
});

test("Hermes chat is a website-session route", () => {
  const matched = server.matchRoute("POST", "/api/hermes/chat");
  assert.ok(matched);
  assert.ok(server.matchRoute("GET", "/api/hermes/memory"));
  assert.ok(server.matchRoute("POST", "/api/hermes/transcribe"));
  assert.ok(server.matchRoute("POST", "/api/hermes/checkout/continue"));
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
    server.matchRoute("POST", "/api/integrations/telegram/hermes")
  );
  assert.ok(server.matchRoute("POST", "/api/webhooks/linq"));
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/integrations/telegram/hermes/mandate-options"
    )
  );
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/integrations/telegram/hermes/payment-choice"
    )
  );
  assert.ok(
    server.matchRoute(
      "GET",
      "/api/v1/onboarding/42/merchants/ucp/cart"
    )
  );
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/v1/onboarding/42/merchants/ucp/cart/items"
    )
  );
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/v1/onboarding/42/merchants/ucp/cart/checkout"
    )
  );
  assert.ok(
    server.matchRoute(
      "POST",
      "/api/v1/onboarding/42/merchants/ucp/orders/11111111-1111-4111-8111-111111111111/decision"
    )
  );
  assert.ok(
    server.matchRoute(
      "DELETE",
      "/api/v1/onboarding/42/merchants/ucp/cart/items/7"
    )
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
    server.matchRoute("POST", "/api/v1/onboarding/42/merchant/zepto/search"),
    null
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

test("LINQ text replies expose numbered products and parse selections", () => {
  const choices = server.linqPendingChoices({
    productChoices: [{
      choiceId: "11111111-1111-4111-8111-111111111111",
      productName: "Vitamin C",
      price: 499,
      currency: "INR",
      merchantName: "Himalaya Wellness",
    }],
  });
  assert.equal(choices.type, "product");
  assert.equal(
    server.linqChoiceRequest("add 1", choices).item.choiceId,
    "11111111-1111-4111-8111-111111111111"
  );
  const reply = server.linqReplyText({
    message: "I found one option.",
    productChoices: [{
      productName: "Vitamin C",
      price: 499,
      currency: "INR",
      merchantName: "Himalaya Wellness",
    }],
  });
  assert.match(reply, /1\. Vitamin C — INR 499\.00 — Himalaya Wellness/);
  assert.match(reply, /Reply ADD 1/);
});

test("LINQ duplicate phones prefer the account owner over dependents", () => {
  const owner = { id: 40, is_account_owner: true };
  const dependent = { id: 44, is_account_owner: false };
  assert.equal(
    server.selectLinqFamilyCandidate([dependent, owner]),
    owner
  );
  assert.equal(
    server.selectLinqFamilyCandidate([
      owner,
      { id: 45, is_account_owner: true },
    ]),
    null
  );
  assert.equal(
    server.selectLinqFamilyCandidate([dependent]),
    dependent
  );
  assert.equal(
    server.selectLinqFamilyCandidate([
      dependent,
      { id: 46, is_account_owner: false },
    ]),
    null
  );
});

test("Telegram UCP cart groups safe product data without exposing selection tokens", () => {
  const cart = server.publicUcpCart({
    items: [{
      id: 1,
      choiceId: "11111111-1111-4111-8111-111111111111",
      selectionToken: "must-not-leak",
      merchant: "kapiva",
      merchantName: "Kapiva",
      productName: "Amla Juice",
      currency: "INR",
      price: 299,
      quantity: 2,
    }],
  });
  assert.equal(cart.itemCount, 2);
  assert.equal(cart.merchantGroups[0].merchant, "kapiva");
  assert.equal(cart.items[0].selectionToken, undefined);
});

test("Telegram mandate setup validates scope and recognizes Prava card returns", () => {
  assert.deepEqual(server.telegramMandateIntent({ amount: "500" }), {
    amount: "500.00",
    frequency: "one_time",
    merchantScope: "any",
  });
  assert.deepEqual(
    server.telegramMandateIntent({ amount: 750, frequency: "monthly" }),
    {
      amount: "750.00",
      frequency: "monthly",
      merchantScope: "listed",
    }
  );
  assert.throws(
    () => server.telegramMandateIntent({
      amount: 750,
      frequency: "monthly",
      merchantScope: "any",
    }),
    /only supported with frequency one_time/
  );
  assert.equal(
    server.telegramCardReturnMessage("/start payments_card_return"),
    true
  );
  assert.equal(server.telegramCardReturnMessage("payments_card_return"), false);
});

test(
  "Telegram mandate setup returns every masked saved card and an add-card choice",
  { concurrency: false },
  async () => {
    const originalGetMethods = db.getPaymentMethods;
    const originalGetCustomer = db.getPaymentCustomer;
    try {
      db.getPaymentMethods = async () => [{
        id: "7",
        provider: "prava",
        provider_payment_method_id: "card_saved_7",
        type: "card",
        brand: "visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030,
        is_default: true,
      }];
      db.getPaymentCustomer = async () => null;

      const result = await server.prepareTelegramMandateChoices(42, {
        amount: "500.00",
        frequency: "one_time",
        merchantScope: "any",
      });
      assert.equal(result.stage, "choose_card");
      assert.equal(result.cardChoices.length, 2);
      assert.deepEqual(
        result.cardChoices.map((choice) => choice.type),
        ["saved_card", "add_card"]
      );
      assert.equal(result.cardChoices[0].last4, "4242");
      assert.equal(
        "provider_payment_method_id" in result.cardChoices[0],
        false
      );
      const savedChoice = hermes.verifyApproval(
        result.cardChoices[0].token,
        42
      );
      assert.equal(savedChoice.toolName, "create_mandate_with_saved_card");
      assert.equal(savedChoice.args.paymentMethodId, "7");
      const addChoice = hermes.verifyApproval(
        result.cardChoices[1].token,
        42
      );
      assert.equal(addChoice.toolName, "create_mandate_with_new_card");
    } finally {
      db.getPaymentMethods = originalGetMethods;
      db.getPaymentCustomer = originalGetCustomer;
    }
  }
);

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

test("website delivery addresses require a real delivery contact", () => {
  assert.throws(
    () => server.familyAddressInput(
      { formattedAddress: "12 Park Street, Kolkata 700016" },
      { requireContact: true }
    ),
    /contact name and phone number/
  );
  const address = server.familyAddressInput(
    {
      formattedAddress: "12 Park Street, Kolkata 700016",
      contactName: "Asha",
      contactPhone: "+919876543210",
    },
    { requireContact: true }
  );
  assert.equal(address.contactPhone, "+919876543210");
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
    {
      id: "mdt-any-merchant",
      status: "active",
      merchantScope: "any",
      merchantName: "Tokko Health & Wellness",
      remaining: "275.00",
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
    "mdt-any-merchant",
    "mdt-himalaya-small",
    "mdt-himalaya-large",
  ]);
});

test(
  "UCP payable total includes shipping before three percent forex",
  () => {
    const result = server.withUcpCheckoutCharges({
      currency: "INR",
      totals: [
        { type: "fulfillment", label: "Shipping", amountMinor: 500 },
        { type: "total", label: "Merchant total", amountMinor: 10000 },
      ],
      subtotalMinor: 0,
      itemsSubtotalMinor: 10000,
      shippingMinor: 500,
      taxMinor: 0,
      feeMinor: 0,
      discountMinor: 0,
      totalMinor: 10000,
    });
    assert.equal(result.merchantTotalAmount, "105.00");
    assert.equal(result.shippingAmount, "5.00");
    assert.equal(result.forexAmount, "3.15");
    assert.equal(result.cartTotalAmount, "108.15");
    assert.deepEqual(
      result.totals.slice(-2).map((line) => [line.type, line.amountMinor]),
      [["forex", 315], ["total", 10815]]
    );
  }
);

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

      const quote = await server.createUcpCheckoutQuote(42, {
        selectionToken: "signed-selection",
        quantity: 1,
      });
      assert.equal(chargeInput, undefined);
      assert.equal(quote.cartTotalAmount, "267.80");
      assert.equal(quote.autofill.addressId, "101");
      assert.equal(checkoutOptions.buyer.first_name, "Family");
      assert.equal(checkoutOptions.buyer.last_name, "Parent");
      assert.equal(checkoutOptions.buyer.phone_number, "+919876543210");
      assert.equal(
        checkoutOptions.destination.phone_number,
        "+919876543210"
      );

      const result = await server.createUcpCheckoutWithPayment(42, {
        selectionToken: "signed-selection",
        quantity: 1,
      });
      assert.equal(chargeInput.mandateId, "mdt_himalaya");
      assert.equal(chargeInput.amount, "267.80");
      assert.equal(
        chargeInput.purchaseContext[0].merchant_details.name,
        "Himalaya Wellness"
      );
      assert.equal(result.merchantHandoffUrl, "https://merchant.example/cart/c/test");
      assert.equal(result.paymentUrl, null);
      assert.equal(result.paymentUrlAvailable, false);
      assert.equal(result.paymentRoute, "mandate");
      assert.equal(result.merchantTotalAmount, "260.00");
      assert.equal(result.shippingAmount, "0.00");
      assert.equal(result.forexAmount, "7.80");
      assert.equal(result.cartTotalAmount, "267.80");
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

test(
  "selectUcpSavedCard returns the Prava approval URL (not the Shopify handoff) when a Tokko flow is threaded",
  { concurrency: false },
  async () => {
    const originals = {
      configuration: payments.configuration,
      listCards: payments.listCards,
      createPaymentSession: payments.createPaymentSession,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      getCheckoutFlow: db.getCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
    };
    try {
      payments.configuration = () => ({ configured: true, environment: "sandbox" });
      payments.listCards = async () => [];
      db.getUserById = async () => ({ id: 55, email: "flow@example.com" });
      db.getProfile = async () => ({
        user_id: 55,
        primary_parent_name: "Flow Parent",
        primary_parent_phone: "+919900112233",
      });
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_55",
      });
      db.getPaymentMethods = async () => [{
        id: 9,
        provider: "prava",
        provider_payment_method_id: "card_saved_9",
        brand: "visa",
        last4: "2259",
        is_default: true,
      }];
      db.getCheckoutFlow = async () => ({
        id: "flow-55",
        user_id: 55,
        platform: "ucp",
        status: "UCP_APPROVED",
        address_id: 1,
        card_brand: null,
        card_last4: null,
        card_failure_count: 0,
        card_payment_received: false,
        allow_cod_fallback: false,
        fallback_to_cod: false,
        payment_route: "merchant_checkout",
        price_breakdown: {},
        cart_snapshot: [],
      });
      db.saveCheckoutFlow = async (flow) => flow;
      let sessionArgs = null;
      payments.createPaymentSession = async (args) => {
        sessionArgs = args;
        return {
          provider: "prava",
          sessionId: "sess_1",
          approvalUrl: "https://sandbox.prava.space/approve/sess_1",
          orderId: null,
          expiresAt: null,
          amount: "101.97",
          currency: "INR",
        };
      };
      const token = hermes.signApproval({
        userId: 55,
        toolName: "select_ucp_saved_card",
        args: {
          checkoutId: "gid://shopify/Checkout/x",
          tokkoFlowId: "flow-55",
          merchant: "himalayawellness",
          merchantName: "Himalaya Wellness",
          merchantHandoffUrl: "https://merchant.example/cart/c/x",
          totalAmount: "101.97",
          currency: "INR",
          paymentMethodId: "9",
        },
      });
      const result = await server.selectUcpSavedCard(55, token);
      assert.equal(result.paymentRoute, "prava_card");
      assert.equal(result.nextAction.type, "prava_card_approval");
      assert.equal(
        result.nextAction.url,
        "https://sandbox.prava.space/approve/sess_1"
      );
      assert.notEqual(result.nextAction.url, "https://merchant.example/cart/c/x");
      assert.equal(result.savedCard.last4, "2259");
      assert.equal(sessionArgs.cardId, "card_saved_9");
    } finally {
      Object.assign(payments, {
        configuration: originals.configuration,
        listCards: originals.listCards,
        createPaymentSession: originals.createPaymentSession,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getPaymentMethods: originals.getPaymentMethods,
        getCheckoutFlow: originals.getCheckoutFlow,
        saveCheckoutFlow: originals.saveCheckoutFlow,
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
  assert.equal(
    server.matchRoute("POST", "/api/payments/setup-intent"),
    null
  );
});

test("Prava callbacks return website flows to the app and Telegram flows to the bot bridge", () => {
  const website = new URL(server.pravaReturnCallback("card"));
  assert.equal(website.searchParams.get("pravaCard"), "return");

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
    })
  );
  assert.equal(mandate.searchParams.get("flow"), "mandate");
  assert.throws(
    () => server.pravaReturnCallback("card", {
      channel: "telegram",
      botUsername: "https://evil.example/redirect",
    }),
    /valid Telegram bot username/
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
