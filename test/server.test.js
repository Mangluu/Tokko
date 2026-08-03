const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
process.env.HERMES_ACTION_SECRET ||= "test-hermes-action-secret";
const server = require("../server.js");
const db = require("../lib/db.js");
const auth = require("../lib/auth.js");
const hermes = require("../lib/hermes.js");
const linq = require("../lib/linq.js");
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

    await server.executeHermesTool(
      { tokkoUcpCartMerchant: "himalayawellness" },
      42,
      "search_wellness_merchants",
      { query: "magnesium", market: "IN" }
    );
    assert.equal(capturedOptions.merchant, "himalayawellness");
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
  assert.ok(server.matchRoute(
    "POST",
    "/api/integrations/telegram/prava-return"
  ));
  assert.ok(server.matchRoute("GET", "/api/payments/telegram/options?state=x"));
  assert.ok(server.matchRoute(
    "GET",
    "/api/payments/telegram/options/continue?state=x&action=direct_card"
  ));
  assert.ok(server.matchRoute(
    "GET",
    "/api/payments/telegram/options/exit?state=x"
  ));
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
  assert.equal(
    server.linqChoiceRequest("add Vitamin C", choices).item.choiceId,
    "11111111-1111-4111-8111-111111111111"
  );
  assert.equal(
    server.linqChoiceRequest("add vitamin c to my cart", choices).item.choiceId,
    "11111111-1111-4111-8111-111111111111"
  );
  for (const text of [
    "select 1st product",
    "choose the first product",
    "pick product 1",
    "I want the first one",
  ]) {
    assert.deepEqual(
      server.linqChoiceRequest(text, choices),
      server.linqChoiceRequest("ADD 1", choices),
      text
    );
  }
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
  assert.match(reply, /ADD <product name>/);
  assert.equal(server.linqAddSavedCardRequest("add saved card"), true);
  assert.equal(server.linqAddSavedCardRequest("create a new card"), true);
  assert.equal(server.linqAddSavedCardRequest("add vitamin c"), false);
});

test("LINQ cart and checkout replies preserve Telegram action states", () => {
  const cart = {
    items: [{
      id: "cart-item-1",
      merchant: "kapiva",
      productName: "Amla Juice",
      quantity: 2,
    }],
  };
  const cartChoices = server.linqCartChoices(cart);
  assert.deepEqual(
    cartChoices.map((choice) => choice.action),
    ["empty", "checkout"]
  );
  const cartState = server.linqPendingChoices({ cart });
  assert.equal(
    server.linqChoiceRequest("checkout", cartState).item.action,
    "checkout"
  );
  assert.equal(
    server.linqChoiceRequest("2", cartState).item.action,
    "checkout"
  );
  assert.equal(
    server.linqChoiceRequest("choose the second option", cartState).item.action,
    "checkout"
  );
  const cartReply = server.linqReplyText({
    message: "Added Amla Juice to your cart.",
    cart,
  });
  assert.doesNotMatch(cartReply, /Remove Amla Juice/);
  assert.match(cartReply, /1\. Empty Cart/);
  assert.match(cartReply, /2\. Proceed to Checkout/);
  assert.match(cartReply, /REMOVE <product name>/);
  assert.match(cartReply, /reply CHECKOUT/i);

  const checkoutResult = server.linqUcpCheckoutResult({
    orderId: "11111111-1111-4111-8111-111111111111",
    approvalRequired: true,
    merchantName: "Kapiva",
    currency: "INR",
    totalAmount: "412.00",
    totals: [{ label: "Total", amountMinor: 41200 }],
  });
  const checkoutState = server.linqPendingChoices(checkoutResult);
  assert.equal(checkoutState.type, "checkout");
  assert.equal(
    server.linqChoiceRequest("YES", checkoutState).item.action,
    "approve"
  );
  assert.equal(
    server.linqChoiceRequest("2", checkoutState).item.action,
    "cancel"
  );
  assert.equal(
    server.linqChoiceRequest("select the second option", checkoutState).item
      .action,
    "cancel"
  );
  const checkoutReply = server.linqReplyText(checkoutResult);
  assert.match(checkoutReply, /Quote:/);
  assert.match(checkoutReply, /1\. Approve Checkout/);
  assert.match(checkoutReply, /2\. Do Not Place Order/);

  const correctedAmount = server.linqUcpCheckoutResult({
    approvalRequired: true,
    merchantName: "Kapiva",
    currency: "INR",
    totalMinor: 5300,
    totalAmount: "53.00",
    cartTotalMinor: 11400,
    cartTotalAmount: "114.00",
    totals: [{
      type: "total",
      label: "Cart total payable",
      amountMinor: 11400,
    }],
  });
  assert.equal(correctedAmount.totalAmount, "114.00");
  assert.equal(correctedAmount.checkoutSummary.totalAmount, "114.00");
  assert.match(correctedAmount.message, /INR 114\.00/);
  assert.doesNotMatch(correctedAmount.message, /INR 53\.00/);
});

test("LINQ recognizes a new request as a cart context switch", () => {
  const binding = {
    pending_action: { token: "old-approval" },
    pending_choices: { type: "checkout", items: [] },
  };
  assert.equal(
    server.linqContextSwitchesCart("find vitamin c instead", binding),
    true
  );
  assert.equal(server.linqContextSwitchesCart("YES", binding), false);
  assert.equal(server.linqContextSwitchesCart("show cart", binding), false);
  assert.equal(
    server.linqContextSwitchesCart(
      "remove vitamin c",
      binding,
      { type: "cart" }
    ),
    false
  );
  assert.equal(
    server.linqContextSwitchesCart(
      "choose the first option",
      binding,
      { type: "checkout", item: { action: "approve" } }
    ),
    false
  );
  assert.equal(
    server.linqContextSwitchesCart("find vitamin c", {}),
    false
  );

  const activeCartBinding = {
    pending_action: null,
    pending_choices: { type: "cart", items: [] },
  };
  assert.equal(
    server.linqContextSwitchesCart(
      "find magnesium too",
      activeCartBinding
    ),
    false
  );
  assert.equal(
    server.linqContextSwitchesCart(
      "find magnesium too",
      activeCartBinding,
      null,
      { productChoices: [] }
    ),
    false
  );
  assert.equal(
    server.linqContextSwitchesCart(
      "tell me a joke",
      activeCartBinding,
      null,
      { message: "Here is a joke." }
    ),
    true
  );
});

test(
  "typed cart removal matches a product name and removes the full cart line",
  { concurrency: false },
  async () => {
    const originals = {
      getUcpCart: db.getUcpCart,
      saveUcpCart: db.saveUcpCart,
    };
    let cart = {
      items: [{
        id: 1,
        choiceId: "choice-a",
        merchant: "himalayawellness",
        productName: "Vitamin C Gummies",
        variantName: "60 count",
        quantity: 2,
      }, {
        id: 2,
        choiceId: "choice-b",
        merchant: "himalayawellness",
        productName: "Magnesium Tablets",
        quantity: 1,
      }],
    };
    try {
      db.getUcpCart = async () => cart;
      db.saveUcpCart = async (_userId, value) => {
        cart = value;
        return cart;
      };

      assert.equal(
        server.ucpCartRemovalTarget("remove vitamin c from cart"),
        "vitamin c"
      );
      const removal = await server.removeUcpCartItemByName(55, "vitamin c");
      assert.equal(removal.removed, true);
      assert.equal(removal.removedItem.productName, "Vitamin C Gummies");
      assert.deepEqual(
        cart.items.map((item) => item.productName),
        ["Magnesium Tablets"]
      );
      const missing = await server.removeUcpCartItemByName(55, "zinc");
      assert.equal(missing.removed, false);
      assert.deepEqual(
        cart.items.map((item) => item.productName),
        ["Magnesium Tablets"]
      );
    } finally {
      Object.assign(db, originals);
    }
  }
);

test(
  "UCP cart accumulates products from one merchant and rejects another merchant",
  { concurrency: false },
  async () => {
    const originals = {
      getUcpProductChoice: db.getUcpProductChoice,
      getUcpCart: db.getUcpCart,
      saveUcpCart: db.saveUcpCart,
    };
    let cart = {
      items: [{
        id: 1,
        choiceId: "choice-a",
        selectionToken: "token-a",
        merchant: "himalayawellness",
        merchantName: "Himalaya Wellness",
        productName: "Vitamin C",
        quantity: 1,
      }],
    };
    const choices = {
      "choice-b": {
        id: "choice-b",
        selection_token: "token-b",
        product: {
          merchant: "himalayawellness",
          merchantName: "Himalaya Wellness",
          productName: "Magnesium",
        },
      },
      "choice-c": {
        id: "choice-c",
        selection_token: "token-c",
        product: {
          merchant: "kapiva",
          merchantName: "Kapiva",
          productName: "Amla Juice",
        },
      },
    };
    try {
      db.getUcpProductChoice = async (_userId, choiceId) => choices[choiceId];
      db.getUcpCart = async () => cart;
      db.saveUcpCart = async (_userId, value) => {
        cart = value;
        return cart;
      };

      const sameMerchant = await server.addUcpCartChoice(
        55,
        "choice-b",
        1,
        false
      );
      assert.deepEqual(
        sameMerchant.items.map((item) => item.productName),
        ["Vitamin C", "Magnesium"]
      );
      await assert.rejects(
        server.addUcpCartChoice(55, "choice-c", 1, false),
        (error) => error.code === "merchant_cart_conflict"
      );
      assert.deepEqual(
        cart.items.map((item) => item.productName),
        ["Vitamin C", "Magnesium"]
      );
    } finally {
      Object.assign(db, originals);
    }
  }
);

test(
  "UCP cart becomes abandoned only after more than ten idle minutes",
  { concurrency: false },
  async () => {
    const originals = {
      getUcpCart: db.getUcpCart,
      clearUcpCart: db.clearUcpCart,
    };
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    let updatedAt = new Date(now - 10 * 60 * 1_000).toISOString();
    let clearCount = 0;
    try {
      db.getUcpCart = async () => ({
        items: [{ id: 1, merchant: "himalayawellness" }],
        updatedAt,
      });
      db.clearUcpCart = async () => {
        clearCount += 1;
        return { items: [] };
      };

      const exactlyTenMinutes = await server.activeUcpCartState(55, { now });
      assert.equal(exactlyTenMinutes.abandoned, false);
      assert.equal(clearCount, 0);

      updatedAt = new Date(now - 10 * 60 * 1_000 - 1).toISOString();
      const overTenMinutes = await server.activeUcpCartState(55, { now });
      assert.equal(overTenMinutes.abandoned, true);
      assert.deepEqual(overTenMinutes.cart.items, []);
      assert.equal(clearCount, 1);
    } finally {
      Object.assign(db, originals);
    }
  }
);

test("checkout cleanup only matches the cart captured by that flow", () => {
  const oldFlow = {
    cart_snapshot: [
      { selectionToken: "token-a", quantity: 1 },
      { selectionToken: "token-b", quantity: 2 },
    ],
  };
  assert.equal(
    server.ucpCartMatchesCheckoutFlow({
      items: [
        { selectionToken: "token-b", quantity: 2 },
        { selectionToken: "token-a", quantity: 1 },
      ],
    }, oldFlow),
    true
  );
  assert.equal(
    server.ucpCartMatchesCheckoutFlow({
      items: [{ selectionToken: "new-cart-token", quantity: 1 }],
    }, oldFlow),
    false
  );
});

test(
  "a failed UCP checkout clears the cart instead of leaving stale items",
  { concurrency: false },
  async () => {
    const originals = {
      getUcpCart: db.getUcpCart,
      clearUcpCart: db.clearUcpCart,
    };
    let clearedUserId = null;
    try {
      db.getUcpCart = async () => ({
        items: [
          {
            merchant: "merchant-a",
            selectionToken: "token-a",
            quantity: 1,
          },
          {
            merchant: "merchant-b",
            selectionToken: "token-b",
            quantity: 1,
          },
        ],
      });
      db.clearUcpCart = async (userId) => {
        clearedUserId = userId;
        return { items: [] };
      };
      await assert.rejects(
        server.createUcpCartCheckout(55),
        /one merchant/
      );
      assert.equal(clearedUserId, 55);
    } finally {
      Object.assign(db, originals);
    }
  }
);

test(
  "Telegram cart approval starts and preserves a direct Prava payment session",
  { concurrency: false },
  async () => {
    const originals = {
      configuration: payments.configuration,
      createPaymentSession: payments.createPaymentSession,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getCheckoutFlow: db.getCheckoutFlow,
      transitionCheckoutFlow: db.transitionCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
    };
    const orderId = "11111111-1111-4111-8111-111111111111";
    const flow = {
      id: orderId,
      user_id: 55,
      platform: "ucp",
      status: "UCP_REVIEW",
      created_at: new Date().toISOString(),
      address_id: 1,
      allow_cod_fallback: false,
      price_breakdown: {
        merchant: "himalayawellness",
        merchantName: "Himalaya Wellness",
        merchantUrl: "https://himalayawellness.in",
        market: "IN",
        productName: "Ashwagandha",
        variantName: "60 tablets",
        quantity: 1,
        currency: "INR",
        totalMinor: 54700,
        totalAmount: "547.00",
        autofill: { submitted: true },
      },
      cart_snapshot: [{ selectionToken: "signed-item", quantity: 1 }],
    };
    const savedRecords = [];
    let sessionInput = null;
    try {
      payments.configuration = () => ({
        configured: true,
        environment: "sandbox",
      });
      payments.createPaymentSession = async (input) => {
        sessionInput = input;
        return {
          provider: "prava",
          sessionId: "sess_telegram_direct",
          approvalUrl:
            "https://checkout.prava.space/session/sess_telegram_direct",
          expiresAt: null,
          amount: input.amount,
          currency: input.currency,
        };
      };
      db.getUserById = async () => ({ id: 55, email: "family@example.com" });
      db.getProfile = async () => ({
        user_id: 55,
        primary_parent_phone: "+919900112233",
      });
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_55",
      });
      db.getCheckoutFlow = async () => flow;
      db.transitionCheckoutFlow = async (
        userId,
        checkoutId,
        fromStatus,
        toStatus
      ) => {
        assert.equal(userId, 55);
        assert.equal(checkoutId, orderId);
        assert.equal(fromStatus, "UCP_REVIEW");
        assert.equal(toStatus, "UCP_APPROVING");
        return { ...flow, status: toStatus };
      };
      db.saveCheckoutFlow = async (record) => {
        savedRecords.push(record);
        return {
          id: record.id,
          user_id: record.userId,
          platform: record.platform,
          status: record.status,
          address_id: record.addressId,
          card_brand: record.cardBrand,
          card_last4: record.cardLast4,
          card_failure_count: record.cardFailureCount,
          card_payment_received: record.cardPaymentReceived,
          allow_cod_fallback: record.allowCodFallback,
          fallback_to_cod: record.fallbackToCod,
          payment_route: record.paymentRoute,
          prava_session_id: record.pravaSessionId,
          prava_session_approval_url: record.pravaSessionApprovalUrl,
          prava_charge_status: record.pravaChargeStatus,
          prava_charge_amount: record.pravaChargeAmount,
          price_breakdown: record.priceBreakdown,
          cart_snapshot: record.cartSnapshot,
          failure_message: record.failureMessage,
        };
      };

      const result = await server.decideUcpCartOrder(
        55,
        orderId,
        true,
        {
          paymentFlow: "prava_direct_card",
          returnContext: {
            channel: "telegram",
            chatId: "7783253227",
            botUsername: "TokkoShopperBot",
          },
        }
      );

      assert.equal(result.paymentRoute, "prava_card");
      assert.equal(result.nextAction.type, "prava_card_approval");
      assert.equal(
        result.nextAction.url,
        "https://checkout.prava.space/session/sess_telegram_direct"
      );
      assert.equal(result.merchantHandoffUrl, null);
      assert.equal(sessionInput.cardId, null);
      assert.equal(sessionInput.amount, "547.00");
      assert.equal(sessionInput.currency, "INR");
      const callback = new URL(sessionInput.callbackUrl);
      assert.equal(callback.pathname, "/api/payments/return");
      assert.equal(callback.searchParams.get("channel"), "telegram");
      const returnContext = server.verifyTelegramPravaReturnToken(
        callback.searchParams.get("state")
      );
      assert.equal(returnContext.chatId, "7783253227");
      assert.equal(returnContext.botUsername, "TokkoShopperBot");
      assert.equal(returnContext.stage, "ucp_payment");
      assert.equal(savedRecords.length, 1);
      assert.equal(savedRecords[0].status, "UCP_PRAVA_APPROVAL_REQUIRED");
      assert.equal(savedRecords[0].pravaSessionId, "sess_telegram_direct");
    } finally {
      Object.assign(payments, {
        configuration: originals.configuration,
        createPaymentSession: originals.createPaymentSession,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getCheckoutFlow: originals.getCheckoutFlow,
        transitionCheckoutFlow: originals.transitionCheckoutFlow,
        saveCheckoutFlow: originals.saveCheckoutFlow,
      });
    }
  }
);

test("LINQ never exposes a merchant UCP checkout URL", () => {
  const result = server.linqUcpCheckoutResult({
    approvalRequired: false,
    merchantName: "Kapiva",
    currency: "INR",
    totalAmount: "412.00",
    paymentRoute: "mandate",
    merchantHandoffUrl: "https://merchant.example/checkout/abc",
    checkoutUrl: "https://merchant.example/checkout/nested",
    continueUrl: "https://merchant.example/checkout/continue",
  });
  assert.equal(server.linqReplyLink(result), null);
  assert.equal(result.merchantHandoffUrl, null);
  assert.equal(result.checkoutUrl, null);
  assert.equal(result.continueUrl, null);
  assert.equal(result.checkoutSummary.checkoutUrl, undefined);
  assert.equal(result.checkoutSummary.continueUrl, undefined);
  assert.equal(result.nextAction, null);
  assert.doesNotMatch(server.linqReplyText(result), /https:\/\//);
  assert.doesNotMatch(server.linqReplyText(result), /tappable secure link card/i);

  const prava = server.linqSecurePaymentResult({
    merchantHandoffUrl: "https://merchant.example/checkout/abc",
    nextAction: {
      type: "prava_card_approval",
      url: "https://checkout.prava.space/s/sess_123",
    },
  });
  assert.equal(
    server.linqReplyLink(prava),
    "https://checkout.prava.space/s/sess_123"
  );

  const disguisedMerchant = server.linqSecurePaymentResult({
    nextAction: {
      type: "checkout_redirect",
      label: "Continue",
      url: "https://himalayawellness.in/checkouts/abc",
    },
  });
  assert.equal(disguisedMerchant.nextAction, null);
  assert.equal(server.linqReplyLink(disguisedMerchant), null);
  assert.doesNotMatch(server.linqReplyText(disguisedMerchant), /tappable secure link/i);
});

test("LINQ offers a saved card or a different card for Prava payment", () => {
  const token = hermes.signApproval({
    userId: 55,
    toolName: "select_ucp_saved_card",
    args: {
      tokkoFlowId: "11111111-1111-4111-8111-111111111111",
      paymentMethodId: "9",
    },
  });
  const state = server.linqPendingChoices({
    cardChoices: [{
      token,
      brand: "visa",
      last4: "2259",
    }],
  });
  const choice = server.linqChoiceRequest("CARD 1", state);
  assert.equal(choice.item.selectionType, "ucp_saved_card");
  assert.deepEqual(server.linqApprovalRequest(55, choice), {
    token,
    toolName: "select_ucp_saved_card",
    args: {
      tokkoFlowId: "11111111-1111-4111-8111-111111111111",
      paymentMethodId: "9",
    },
  });

  const differentCardToken = hermes.signApproval({
    userId: 55,
    toolName: "select_ucp_saved_card",
    args: {
      tokkoFlowId: "11111111-1111-4111-8111-111111111111",
      paymentMethodId: null,
    },
  });
  const differentCardState = server.linqPendingChoices({
    cardChoices: [
      {
        type: "ucp_saved_card",
        label: "Visa ending 2259",
        token,
      },
      {
        type: "different_card",
        label: "Pay with a different card",
        token: differentCardToken,
      },
    ],
  });
  assert.equal(
    server.linqChoiceRequest("DIFFERENT CARD", differentCardState).item
      .selectionType,
    "different_card"
  );
  assert.equal(
    server.linqChoiceRequest("use the second card", differentCardState).item
      .selectionType,
    "different_card"
  );
  assert.equal(
    server.linqApprovalRequest(
      55,
      server.linqChoiceRequest("DIFFERENT CARD", differentCardState)
    ).toolName,
    "select_ucp_saved_card"
  );

  const checkout = server.ucpSavedCardResult(
    55,
    {
      tokkoFlowId: "11111111-1111-4111-8111-111111111111",
      merchantName: "Kapiva",
      totalAmount: "53.00",
      totalMinor: 5300,
      cartTotalAmount: "114.00",
      cartTotalMinor: 11400,
      currency: "INR",
    },
    { status: "no_eligible_mandate" },
    [{ id: 9, brand: "visa", last4: "2259" }],
    { allowDifferentCard: true }
  );
  assert.deepEqual(
    checkout.cardChoices.map((item) => item.type),
    ["ucp_saved_card", "different_card"]
  );
  assert.equal(checkout.totalAmount, "114.00");
  assert.equal(
    hermes.verifyApproval(checkout.cardChoices[0].token, 55).args.totalAmount,
    "114.00"
  );
  const differentApproval = hermes.verifyApproval(
    checkout.cardChoices[1].token,
    55
  );
  assert.equal(differentApproval.toolName, "select_ucp_saved_card");
  assert.equal(differentApproval.args.paymentMethodId, null);
  assert.match(
    server.linqUcpCheckoutResult(checkout).message,
    /saved card or a different card/i
  );
});

test(
  "LINQ creates, lists, offers, and charges a non-recurring UCP mandate",
  { concurrency: false },
  async () => {
    const originals = {
      listCards: payments.listCards,
      listMandates: payments.listMandates,
      createPaymentSession: payments.createPaymentSession,
      createTokenizationSession: payments.createTokenizationSession,
      createMandateSession: payments.createMandateSession,
      chargeMandate: payments.chargeMandate,
      getPaymentResult: payments.getPaymentResult,
      revokeSession: payments.revokeSession,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      syncPaymentMethods: db.syncPaymentMethods,
      getCheckoutFlow: db.getCheckoutFlow,
      getUcpCart: db.getUcpCart,
      getLinqHermesBinding: db.getLinqHermesBinding,
      clearUcpCart: db.clearUcpCart,
      saveCheckoutFlow: db.saveCheckoutFlow,
      savePaymentTokenizationSession: db.savePaymentTokenizationSession,
      saveLinqHermesMessage: db.saveLinqHermesMessage,
      saveLinqHermesState: db.saveLinqHermesState,
      sendChatLink: linq.sendChatLink,
      sendChatMessage: linq.sendChatMessage,
    };
    const flowId = "11111111-1111-4111-8111-111111111111";
    const chatId = "8f392755-6865-4b18-880a-227f9d8b458f";
    const checkout = {
      tokkoFlowId: flowId,
      merchant: "himalayawellness",
      merchantName: "Himalaya Wellness",
      merchantUrl: "https://himalayawellness.in",
      market: "IN",
      productName: "Family wellness cart",
      currency: "INR",
      totalMinor: 11400,
      totalAmount: "114.00",
      cartTotalMinor: 11400,
      cartTotalAmount: "114.00",
      totals: [{
        type: "total",
        label: "Cart total payable",
        amountMinor: 11400,
      }],
    };
    let mandateApproved = false;
    let paymentSessionArgs = null;
    let tokenizationSessionArgs = null;
    let mandateSessionArgs = null;
    let mandateSessionCount = 0;
    let revokedSessionCount = 0;
    let mandateChargeArgs = null;
    let newCardSaved = false;
    let cartItems = [{ selectionToken: "checkout-cart-token", quantity: 1 }];
    const savedMessages = [];
    const sentMessages = [];
    const sentLinks = [];
    let savedFlow = {
      id: flowId,
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
      payment_route: "payment_selection_required",
      price_breakdown: checkout,
      cart_snapshot: [{ selectionToken: "checkout-cart-token", quantity: 1 }],
    };
    const persistedFlow = (flow) => ({
      ...savedFlow,
      id: flow.id,
      user_id: flow.userId,
      platform: flow.platform,
      status: flow.status,
      address_id: flow.addressId,
      card_brand: flow.cardBrand || null,
      card_last4: flow.cardLast4 || null,
      card_failure_count: flow.cardFailureCount || 0,
      card_payment_received: flow.cardPaymentReceived === true,
      allow_cod_fallback: flow.allowCodFallback !== false,
      fallback_to_cod: flow.fallbackToCod === true,
      payment_route: flow.paymentRoute || null,
      prava_mandate_id: flow.pravaMandateId || null,
      prava_transaction_id: flow.pravaTransactionId || null,
      prava_charge_reference: flow.pravaChargeReference || null,
      prava_charge_status: flow.pravaChargeStatus || null,
      prava_charge_amount: flow.pravaChargeAmount || null,
      prava_session_id: flow.pravaSessionId || null,
      prava_session_approval_url: flow.pravaSessionApprovalUrl || null,
      price_breakdown: flow.priceBreakdown || {},
      cart_snapshot: flow.cartSnapshot || [],
      failure_message: flow.failureMessage || null,
    });
    try {
      db.getUserById = async () => ({ id: 55, email: "family@example.com" });
      db.getProfile = async () => ({
        user_id: 55,
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
      }, ...(newCardSaved ? [{
        id: 10,
        provider: "prava",
        provider_payment_method_id: "card_new_10",
        brand: "mastercard",
        last4: "4411",
        is_default: false,
      }] : [])];
      db.syncPaymentMethods = async () => db.getPaymentMethods();
      db.getCheckoutFlow = async () => savedFlow;
      db.getUcpCart = async () => ({ items: cartItems });
      db.clearUcpCart = async () => {
        cartItems = [];
        return { items: [] };
      };
      db.getLinqHermesBinding = async () => ({
        user_id: 55,
        to_phone: "+12025551234",
      });
      db.saveCheckoutFlow = async (flow) => {
        savedFlow = persistedFlow(flow);
        return savedFlow;
      };
      payments.listCards = async () => [{
        card_id: "card_saved_9",
        card_brand: "visa",
        card_last4: "2259",
        card_exp_month: 12,
        card_exp_year: 2030,
        is_default: true,
      }];
      payments.listMandates = async () => [{
        id: "mdt_existing",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "any",
        approvedAmount: "200.00",
        remaining: "200.00",
        currency: "INR",
      }, {
        id: "mdt_existing_2",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "any",
        approvedAmount: "300.00",
        remaining: "300.00",
        currency: "INR",
      }, {
        id: "mdt_existing_3",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "any",
        approvedAmount: "400.00",
        remaining: "400.00",
        currency: "INR",
      }, {
        id: "mdt_existing_4",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "any",
        approvedAmount: "500.00",
        remaining: "500.00",
        currency: "INR",
      }, {
        id: "mdt_merchant_scoped",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "listed",
        merchantName: "Himalaya Wellness",
        approvedAmount: "600.00",
        remaining: "600.00",
        currency: "INR",
      }, ...(mandateApproved ? [{
        id: "mdt_new_one_time",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "any",
        approvedAmount: "114.00",
        remaining: "114.00",
        currency: "INR",
        createdAt: "2030-01-01T00:00:00.000Z",
      }] : [])];
      payments.createPaymentSession = async (args) => {
        paymentSessionArgs = args;
        return {
          provider: "prava",
          sessionId: "sess_payment_1",
          approvalUrl: "https://checkout.sandbox.prava.space/s/sess_payment_1",
          expiresAt: "2030-01-01T00:15:00.000Z",
          amount: "114.00",
          currency: "INR",
        };
      };
      payments.createTokenizationSession = async (args) => {
        tokenizationSessionArgs = args;
        return {
          provider: "prava",
          sessionId: "sess_card_enrollment_1",
          approvalUrl: "https://checkout.sandbox.prava.space/s/sess_card_enrollment_1",
          expiresAt: "2030-01-01T00:15:00.000Z",
        };
      };
      db.savePaymentTokenizationSession = async () => null;
      db.saveLinqHermesMessage = async (_chatId, _role, text) => {
        savedMessages.push(text);
        return null;
      };
      db.saveLinqHermesState = async () => null;
      linq.sendChatLink = async (input) => {
        sentLinks.push(input);
        return null;
      };
      linq.sendChatMessage = async (input) => {
        sentMessages.push(input);
        return null;
      };
      payments.createMandateSession = async (args) => {
        mandateSessionArgs = args;
        mandateSessionCount += 1;
        return {
          provider: "prava",
          sessionId: "sess_mandate_1",
          approvalUrl: "https://checkout.sandbox.prava.space/s/sess_mandate_1",
          expiresAt: "2030-01-01T00:15:00.000Z",
          authorizeOnly: true,
          amount: "114.00",
          currency: "INR",
          frequency: "one_time",
        };
      };
      payments.chargeMandate = async (args) => {
        mandateChargeArgs = args;
        return {
          mandateId: args.mandateId,
          transactionId: "txn_mandate_1",
          status: "awaiting_result",
          deduplicated: false,
          credentials: {
            token: "4111111111111111",
            dynamicCvv: "123",
            expiryMonth: "12",
            expiryYear: "2030",
          },
        };
      };
      payments.getPaymentResult = async () => ({ status: "pending" });
      payments.revokeSession = async () => {
        revokedSessionCount += 1;
        return { revoked: true };
      };

      const linqContext = {
        channel: "linq",
        chatId,
        to: "+12025551234",
      };
      const choices = await server.prepareLinqUcpPaymentChoices(
        55,
        checkout,
        linqContext
      );
      assert.equal(choices.mandateCheck.status, "one_time_mandate_available");
      assert.equal(choices.mandateChoices.length, 4);
      assert.deepEqual(
        choices.mandateChoices.map((choice) => choice.mandateId),
        ["mdt_existing", "mdt_existing_2", "mdt_existing_3", "mdt_existing_4"]
      );
      assert.equal(
        server.linqChoiceRequest(
          "use mandate",
          server.linqPendingChoices(choices)
        ).item.selectionType,
        "ucp_mandate"
      );
      assert.deepEqual(
        [...new Set(choices.cardChoices.map((choice) => choice.type))],
        ["ucp_mandate"]
      );
      assert.equal(choices.nextAction.type, "prava_payment_options");
      const pendingPaymentChoices = server.linqPendingChoices(choices);
      assert.equal(pendingPaymentChoices.checkoutId, flowId);
      assert.equal(
        server.linqPendingCheckoutId({
          pending_choices: pendingPaymentChoices,
        }, 55),
        flowId
      );
      const optionsUrl = new URL(choices.nextAction.url);
      assert.equal(optionsUrl.origin, "https://tokko-shopper.vercel.app");
      assert.equal(optionsUrl.pathname, "/api/payments/linq/options");
      const paymentContext = server.verifyLinqPaymentOptionsToken(
        optionsUrl.searchParams.get("state")
      );
      assert.equal(paymentContext.userId, 55);
      assert.equal(paymentContext.checkoutId, flowId);
      assert.equal(paymentContext.chatId, chatId);
      const paymentPage = server.renderLinqPaymentOptionsPage({
        state: optionsUrl.searchParams.get("state"),
        flow: savedFlow,
        cards: [{ id: "9", brand: "visa", last4: "2259" }],
        scriptNonce: "test_nonce_1234567890",
      });
      assert.match(paymentPage, /Pay with a saved card/);
      assert.match(paymentPage, /visa ending 2259/);
      assert.match(paymentPage, /<select[^>]+name="card"/);
      assert.match(paymentPage, /<option value="9">visa ending 2259<\/option>/);
      assert.match(paymentPage, /whether or not this browser already has an active passkey/i);
      assert.match(paymentPage, /action=add_card/);
      assert.match(paymentPage, /Add a new card and create mandate/);
      assert.match(paymentPage, /Creating Prava session/);
      assert.match(paymentPage, /Creating your secure Prava mandate session/);
      assert.match(paymentPage, /separate secure sessions/);

      const direct = await server.startLinqPravaPaymentOption(paymentContext, {
        action: "direct_card",
      });
      assert.equal(direct.nextAction.type, "prava_card_approval");
      assert.equal(paymentSessionArgs.cardId, null);
      const directCallback = new URL(paymentSessionArgs.callbackUrl);
      assert.equal(
        server.verifyLinqPravaReturnToken(
          directCallback.searchParams.get("state")
        ).stage,
        "ucp_payment"
      );
      savedFlow = { ...savedFlow, status: "UCP_APPROVED" };

      const enrollment = await server.startLinqPravaPaymentOption(paymentContext, {
        action: "add_card",
      });
      assert.equal(enrollment.nextAction.type, "prava_card_enrollment");
      const enrollmentCallback = new URL(tokenizationSessionArgs.callbackUrl);
      assert.equal(
        server.verifyLinqPravaReturnToken(
          enrollmentCallback.searchParams.get("state")
        ).stage,
        "ucp_mandate_card_setup"
      );
      assert.equal(
        savedFlow.price_breakdown.pravaCardSetup.purpose,
        "mandate"
      );
      newCardSaved = true;
      const mandateAfterNewCard = await server.handleLinqPravaReturn({
          userId: 55,
          chatId,
          checkoutId: flowId,
          to: "+12025551234",
          stage: "ucp_mandate_card_setup",
        });
      assert.equal(
        mandateAfterNewCard.nextAction.type,
        "prava_mandate_approval"
      );
      assert.equal(
        mandateAfterNewCard.browserRedirectUrl,
        null
      );
      assert.equal(
        sentLinks.at(-1).url,
        "https://checkout.sandbox.prava.space/s/sess_mandate_1"
      );
      assert.match(mandateAfterNewCard.message, /mandate amount to create: INR 114\.00/i);
      assert.match(mandateAfterNewCard.message, /mastercard ending 4411/i);
      assert.equal(mandateSessionArgs.cardId, "card_new_10");
      savedFlow = { ...savedFlow, status: "UCP_APPROVED" };

      const standaloneEnrollment = await server.startLinqSavedCardEnrollment(
        55,
        linqContext
      );
      assert.equal(standaloneEnrollment.status, "CARD_SETUP_REQUIRED");
      assert.equal(
        server.linqPendingChoices(standaloneEnrollment).type,
        "card_enrollment"
      );
      const standaloneCallback = new URL(tokenizationSessionArgs.callbackUrl);
      assert.equal(
        server.verifyLinqPravaReturnToken(
          standaloneCallback.searchParams.get("state")
        ).stage,
        "card_enrollment"
      );

      const setup = await server.startLinqPravaPaymentOption(paymentContext, {
        action: "create_mandate",
        paymentMethodId: "9",
      });
      assert.equal(setup.frequency, "one_time");
      assert.equal(setup.merchantScope, "any");
      assert.equal(setup.mandateSummary.amount, "114.00");
      assert.equal(setup.mandateSummary.currency, "INR");
      assert.deepEqual(setup.mandateSummary.savedCard, {
        brand: "visa",
        last4: "2259",
      });
      assert.match(setup.nextAction.label, /INR 114\.00/i);
      assert.match(setup.nextAction.label, /visa ending 2259/i);
      assert.equal(mandateSessionArgs.frequency, "one_time");
      assert.equal(mandateSessionArgs.merchantScope, "any");
      assert.equal(mandateSessionArgs.amount, "114.00");
      assert.equal(mandateSessionArgs.cardId, "card_saved_9");
      const callback = new URL(mandateSessionArgs.callbackUrl);
      const callbackContext = server.verifyLinqPravaReturnToken(
        callback.searchParams.get("state")
      );
      assert.equal(callbackContext.stage, "ucp_mandate_setup");
      assert.equal(callbackContext.flow, "mandate");
      assert.equal(
        callbackContext.attemptId,
        savedFlow.price_breakdown.channelMandateSetup.attemptId
      );
      assert.equal(
        savedFlow.price_breakdown.channelMandateSetup.paymentMethodId,
        "9"
      );
      assert.equal(
        savedFlow.price_breakdown.channelMandateSetup.expiresAt,
        "2030-01-01T00:15:00.000Z"
      );
      assert.match(
        mandateSessionArgs.externalOrderRef,
        /^tokko_ucp_mdt_[a-f0-9]{40}$/
      );
      const mandateSessionCountBeforeResume = mandateSessionCount;
      const resumedSetup = await server.startLinqPravaPaymentOption(
        paymentContext,
        { action: "create_mandate", paymentMethodId: "9" }
      );
      assert.equal(resumedSetup.resumed, true);
      assert.equal(resumedSetup.status, "PRAVA_SESSION_RESUMED");
      assert.equal(
        resumedSetup.nextAction.url,
        "https://checkout.sandbox.prava.space/s/sess_mandate_1"
      );
      assert.equal(mandateSessionCount, mandateSessionCountBeforeResume);
      const launchPage = server.renderLinqPravaLaunchPage({
        url: resumedSetup.nextAction.url,
        label: resumedSetup.nextAction.label,
        resumed: true,
        mandateSummary: resumedSetup.mandateSummary,
      });
      assert.match(launchPage, /mandate amount/i);
      assert.match(launchPage, /INR 114\.00/i);
      assert.match(launchPage, /visa ending 2259/i);
      assert.doesNotMatch(launchPage, /http-equiv="refresh"/i);
      const firstExternalOrderRef = mandateSessionArgs.externalOrderRef;
      payments.getPaymentResult = async () => ({ status: "failed" });
      const restartedSetup = await server.startLinqPravaPaymentOption(
        paymentContext,
        { action: "create_mandate", paymentMethodId: "9" }
      );
      assert.equal(restartedSetup.resumed, undefined);
      assert.equal(revokedSessionCount, 1);
      assert.equal(mandateSessionCount, mandateSessionCountBeforeResume + 1);
      assert.notEqual(mandateSessionArgs.externalOrderRef, firstExternalOrderRef);

      mandateApproved = true;
      savedMessages.length = 0;
      sentMessages.length = 0;
      const charged = await server.handleLinqPravaReturn({
        userId: 55,
        chatId,
        checkoutId: flowId,
        to: "+12025551234",
        stage: "ucp_mandate_setup",
        attemptId: savedFlow.price_breakdown.channelMandateSetup.attemptId,
      });
      assert.equal(charged.status, "PAYMENT_APPROVED");
      assert.equal(charged.mandate.frequency, "one_time");
      assert.equal(charged.cartCleared, true);
      assert.match(sentMessages[0].text, /prava checkout was successful/i);
      assert.doesNotMatch(sentMessages[0].text, /txn_mandate_1|transaction/i);
      assert.equal(
        sentMessages[1].text,
        "Order creation failed at the merchant end."
      );
      assert.deepEqual(
        savedMessages,
        [sentMessages[0].text, sentMessages[1].text]
      );
      assert.equal(mandateChargeArgs.mandateId, "mdt_new_one_time");
      assert.equal(mandateChargeArgs.amount, "114.00");
      assert.equal(
        mandateChargeArgs.purchaseContext[0].product_details[0].unit_price,
        "114.00"
      );
    } finally {
      Object.assign(payments, {
        listCards: originals.listCards,
        listMandates: originals.listMandates,
        createPaymentSession: originals.createPaymentSession,
        createTokenizationSession: originals.createTokenizationSession,
        createMandateSession: originals.createMandateSession,
        chargeMandate: originals.chargeMandate,
        getPaymentResult: originals.getPaymentResult,
        revokeSession: originals.revokeSession,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getPaymentMethods: originals.getPaymentMethods,
        syncPaymentMethods: originals.syncPaymentMethods,
        getCheckoutFlow: originals.getCheckoutFlow,
        getUcpCart: originals.getUcpCart,
        getLinqHermesBinding: originals.getLinqHermesBinding,
        clearUcpCart: originals.clearUcpCart,
        saveCheckoutFlow: originals.saveCheckoutFlow,
        savePaymentTokenizationSession: originals.savePaymentTokenizationSession,
        saveLinqHermesMessage: originals.saveLinqHermesMessage,
        saveLinqHermesState: originals.saveLinqHermesState,
      });
      Object.assign(linq, {
        sendChatLink: originals.sendChatLink,
        sendChatMessage: originals.sendChatMessage,
      });
    }
  }
);

test("LINQ Prava failures offer retry or cart-clearing return to chat", { concurrency: false }, async () => {
  const originals = {
    getCheckoutFlow: db.getCheckoutFlow,
    getLinqHermesBinding: db.getLinqHermesBinding,
    getUcpCart: db.getUcpCart,
    clearUcpCart: db.clearUcpCart,
    saveCheckoutFlow: db.saveCheckoutFlow,
    saveLinqHermesState: db.saveLinqHermesState,
    saveLinqHermesMessage: db.saveLinqHermesMessage,
    sendChatMessage: linq.sendChatMessage,
  };
  const context = {
    userId: 55,
    chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
    checkoutId: "11111111-1111-4111-8111-111111111111",
    to: "+12025551234",
  };
  let flow = {
    id: context.checkoutId,
    user_id: 55,
    platform: "ucp",
    status: "UCP_PRAVA_FAILED",
    address_id: 1,
    card_brand: "visa",
    card_last4: "2259",
    card_failure_count: 0,
    card_payment_received: false,
    allow_cod_fallback: false,
    fallback_to_cod: false,
    payment_route: "prava_card",
    prava_session_id: "sess_failed",
    prava_session_approval_url: "https://checkout.prava.space/s/sess_failed",
    price_breakdown: { totalAmount: "114.00" },
    cart_snapshot: [{ selectionToken: "cart-token", quantity: 1 }],
  };
  const savedFlows = [];
  const savedStates = [];
  let cartCleared = false;
  try {
    db.getCheckoutFlow = async () => flow;
    db.getLinqHermesBinding = async () => ({
      user_id: 55,
      to_phone: context.to,
    });
    db.getUcpCart = async () => ({
      items: [{ selectionToken: "cart-token", quantity: 1 }],
    });
    db.clearUcpCart = async () => {
      cartCleared = true;
      return { items: [] };
    };
    db.saveCheckoutFlow = async (value) => {
      savedFlows.push(value);
      return value;
    };
    db.saveLinqHermesState = async (_chatId, value) => {
      savedStates.push(value);
      return value;
    };
    db.saveLinqHermesMessage = async () => null;
    linq.sendChatMessage = async () => null;

    const retry = await server.prepareLinqPaymentRetry(
      context,
      new Error("Prava declined this payment")
    );
    assert.equal(cartCleared, false);
    assert.equal(savedFlows[0].status, "UCP_APPROVED");
    assert.equal(savedFlows[0].paymentRoute, "payment_selection_required");
    assert.equal(savedStates[0].pendingChoices.type, "payment_options");
    assert.equal(new URL(retry.retryUrl).pathname, "/api/payments/linq/options");
    assert.equal(
      new URL(retry.returnUrl).pathname,
      "/api/payments/linq/options/exit"
    );
    const failurePage = server.renderLinqPaymentFailurePage(retry);
    assert.match(failurePage, /Retry with another payment method/);
    assert.match(failurePage, /Return to LINQ without placing order/);
    assert.match(failurePage, /No merchant order was placed/);

    flow = { ...flow, status: "UCP_APPROVED" };
    const abandoned = await server.leaveLinqPaymentCheckout(context);
    assert.equal(abandoned.cartCleared, true);
    assert.equal(cartCleared, true);
    assert.match(abandoned.message, /no order was placed/i);
    assert.match(abandoned.message, /cart was cleared/i);
    assert.equal(savedStates.at(-1).pendingChoices, null);
    assert.equal(savedFlows.at(-1).status, "UCP_CANCELED");
  } finally {
    Object.assign(db, {
      getCheckoutFlow: originals.getCheckoutFlow,
      getLinqHermesBinding: originals.getLinqHermesBinding,
      getUcpCart: originals.getUcpCart,
      clearUcpCart: originals.clearUcpCart,
      saveCheckoutFlow: originals.saveCheckoutFlow,
      saveLinqHermesState: originals.saveLinqHermesState,
      saveLinqHermesMessage: originals.saveLinqHermesMessage,
    });
    linq.sendChatMessage = originals.sendChatMessage;
  }
});

test("LINQ onboarding links are signed, expiring Tokko redirects", () => {
  const message = {
    chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
    from: "+919876543210",
    to: "+12025551234",
  };
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const token = server.linqOnboardingToken(message, { now, ttlMs: 60_000 });
  const context = server.verifyLinqOnboardingToken(token, { now: now + 1_000 });
  assert.equal(context.chatId, message.chatId);
  assert.equal(context.from, message.from);
  assert.equal(context.to, message.to);
  const url = new URL(server.linqOnboardingUrl(message, {
    now,
    ttlMs: 60_000,
  }));
  assert.equal(url.origin, "https://tokko-drab.vercel.app");
  assert.equal(url.searchParams.get("linqOnboarding"), token);
  assert.equal(server.linqChatReturnUrl(message.to), "sms:+12025551234");
  assert.throws(
    () => server.verifyLinqOnboardingToken(token, { now: now + 60_001 }),
    /expired/
  );
  assert.throws(
    () => server.verifyLinqOnboardingToken(`${token}x`, { now }),
    /invalid/
  );
  assert.ok(server.matchRoute("GET", "/api/linq/onboarding/context?token=x"));
  assert.ok(server.matchRoute("POST", "/api/linq/onboarding/complete"));
});

test("LINQ Prava callbacks are signed to the family, chat, and UCP flow", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const token = server.linqPravaReturnToken({
    userId: 55,
    chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
    checkoutId: "11111111-1111-4111-8111-111111111111",
    to: "+12025551234",
    stage: "ucp_payment",
    flow: "card",
  }, { now, ttlMs: 60_000 });
  const context = server.verifyLinqPravaReturnToken(token, {
    now: now + 1_000,
  });
  assert.equal(context.userId, 55);
  assert.equal(context.stage, "ucp_payment");
  assert.equal(context.checkoutId, "11111111-1111-4111-8111-111111111111");
  assert.throws(
    () => server.verifyLinqPravaReturnToken(`${token}x`, { now }),
    /invalid/
  );
  assert.throws(
    () => server.verifyLinqPravaReturnToken(token, { now: now + 60_001 }),
    /expired/
  );
});

test(
  "LINQ standalone card enrollment detects only the newly saved Prava card",
  { concurrency: false },
  async () => {
    const originals = {
      listCards: payments.listCards,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      syncPaymentMethods: db.syncPaymentMethods,
    };
    try {
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_55",
      });
      db.getPaymentMethods = async () => [{
        id: 1,
        provider_payment_method_id: "card_old",
        brand: "visa",
        last4: "1111",
      }];
      payments.listCards = async () => [{
        card_id: "card_old",
        card_brand: "visa",
        card_last4: "1111",
        card_exp_month: 12,
        card_exp_year: 2030,
      }, {
        card_id: "card_new",
        card_brand: "mastercard",
        card_last4: "2222",
        card_exp_month: 11,
        card_exp_year: 2031,
      }];
      db.syncPaymentMethods = async () => [{
        id: 1,
        provider_payment_method_id: "card_old",
        brand: "visa",
        last4: "1111",
      }, {
        id: 2,
        provider_payment_method_id: "card_new",
        brand: "mastercard",
        last4: "2222",
      }];

      const result = await server.completeLinqSavedCardEnrollment(55, {
        providerPaymentMethodIdsBefore: ["card_old"],
        expiresAt: "2030-01-01T00:15:00.000Z",
      });
      assert.equal(result.status, "CARD_SAVED");
      assert.equal(result.savedCard.last4, "2222");
    } finally {
      payments.listCards = originals.listCards;
      db.getPaymentCustomer = originals.getPaymentCustomer;
      db.getPaymentMethods = originals.getPaymentMethods;
      db.syncPaymentMethods = originals.syncPaymentMethods;
    }
  }
);

test("LINQ onboarding completion binds and resumes the original chat", { concurrency: false }, async () => {
  const originals = {
    requireUser: auth.requireUser,
    getLinqFamilyCandidatesByPhone: db.getLinqFamilyCandidatesByPhone,
    getProfile: db.getProfile,
    saveLinqAssignment: db.saveLinqAssignment,
    saveLinqHermesBinding: db.saveLinqHermesBinding,
    saveLinqHermesMessage: db.saveLinqHermesMessage,
    sendChatMessage: linq.sendChatMessage,
  };
  const calls = {};
  try {
    auth.requireUser = async () => ({ userId: 55 });
    db.getLinqFamilyCandidatesByPhone = async (phone) => {
      calls.lookupPhone = phone;
      return [{ id: 55, is_account_owner: true }];
    };
    db.getProfile = async () => ({
      user_id: 55,
      linq_phone_number_id: null,
    });
    db.saveLinqAssignment = async (...args) => { calls.assignment = args; };
    db.saveLinqHermesBinding = async (...args) => { calls.binding = args; };
    db.saveLinqHermesMessage = async (...args) => { calls.message = args; };
    linq.sendChatMessage = async (input) => { calls.sent = input; };
    const token = server.linqOnboardingToken({
      chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
      from: "+919876543210",
      to: "+12025551234",
    });
    const result = await server.completeLinqOnboarding({}, token);
    assert.equal(result.returnUrl, "sms:+12025551234");
    assert.equal(calls.lookupPhone, "+919876543210");
    assert.deepEqual(calls.binding, [
      "8f392755-6865-4b18-880a-227f9d8b458f",
      55,
      "+919876543210",
      "+12025551234",
    ]);
    assert.equal(calls.assignment[1].phone_number, "+12025551234");
    assert.equal(calls.sent.chatId, "8f392755-6865-4b18-880a-227f9d8b458f");
    assert.match(calls.sent.text, /back where you left off/i);
  } finally {
    Object.assign(auth, { requireUser: originals.requireUser });
    Object.assign(db, {
      getLinqFamilyCandidatesByPhone: originals.getLinqFamilyCandidatesByPhone,
      getProfile: originals.getProfile,
      saveLinqAssignment: originals.saveLinqAssignment,
      saveLinqHermesBinding: originals.saveLinqHermesBinding,
      saveLinqHermesMessage: originals.saveLinqHermesMessage,
    });
    Object.assign(linq, { sendChatMessage: originals.sendChatMessage });
  }
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

test(
  "LINQ resolves a valid Tokko owner without requiring the configured destination",
  { concurrency: false },
  async () => {
    const originals = {
      getLinqHermesBinding: db.getLinqHermesBinding,
      getLinqFamilyCandidatesByPhone: db.getLinqFamilyCandidatesByPhone,
      resolveLinqUser: db.resolveLinqUser,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      saveLinqHermesBinding: db.saveLinqHermesBinding,
    };
    let lookedUpPhone = null;
    let savedBinding = null;
    try {
      db.getLinqHermesBinding = async () => null;
      db.getLinqFamilyCandidatesByPhone = async (phone) => {
        lookedUpPhone = phone;
        return [{ id: 40, email: "owner@example.com", is_account_owner: true }];
      };
      db.resolveLinqUser = async () => null;
      db.getUserById = async (id) => ({ id });
      db.getProfile = async () => null;
      db.saveLinqHermesBinding = async (...args) => {
        savedBinding = args;
      };

      const user = await server.linqFamilyUser({
        chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
        from: "+919876543210",
        to: "+12025551234",
      });

      assert.equal(user.id, 40);
      assert.equal(lookedUpPhone, "+919876543210");
      assert.deepEqual(savedBinding, [
        "8f392755-6865-4b18-880a-227f9d8b458f",
        40,
        "+919876543210",
        "+12025551234",
      ]);
    } finally {
      Object.assign(db, originals);
    }
  }
);

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
  assert.equal(
    server.telegramMandateReturnMessage("/start payments_mandate_return"),
    true
  );
  assert.equal(
    server.telegramMandateReturnMessage("payments_mandate_return"),
    false
  );
});

test("LINQ Prava payment-option links are signed, expiring, and public", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const paymentContext = {
    userId: 55,
    chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
    checkoutId: "11111111-1111-4111-8111-111111111111",
    to: "+12025551234",
  };
  const token = server.linqPaymentOptionsToken(paymentContext, {
    now,
    ttlMs: 60_000,
  });
  assert.deepEqual(
    {
      ...server.verifyLinqPaymentOptionsToken(token, { now: now + 1_000 }),
      issuedAt: undefined,
      expiresAt: undefined,
    },
    { ...paymentContext, issuedAt: undefined, expiresAt: undefined }
  );
  assert.throws(
    () => server.verifyLinqPaymentOptionsToken(token, { now: now + 60_001 }),
    /expired/
  );
  assert.throws(
    () => server.verifyLinqPaymentOptionsToken(`${token}x`, { now }),
    /invalid/
  );
  assert.ok(server.matchRoute("GET", "/api/payments/linq/options?state=x"));
  assert.ok(server.matchRoute(
    "GET",
    "/api/payments/linq/options/continue?state=x&action=direct_card"
  ));
  const result = server.linqUcpCheckoutResult({
    paymentRoute: "mandate_selection_required",
    merchantName: "Himalaya Wellness",
    currency: "INR",
    totalAmount: "114.00",
    cardChoices: [],
    nextAction: {
      type: "prava_payment_options",
      label: "Use another payment method with Prava",
      url: "https://tokko.example/api/payments/linq/options?state=signed",
    },
  });
  assert.match(result.message, /no active one-time mandate/i);
  assert.equal(
    server.linqReplyLink(result),
    "https://tokko.example/api/payments/linq/options?state=signed"
  );
});

test("LINQ mandate intent exposes only a signed Tokko Shopper setup page", async () => {
  const returnContext = {
    channel: "linq",
    chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
    to: "+12025551234",
  };
  const result = await server.executeHermesTool(
    { tokkoReturnContext: returnContext },
    55,
    "prepare_payment_mandate",
    { amount: "250", frequency: "one_time", merchantScope: "any" }
  );
  assert.equal(result.stage, "hosted_mandate_setup");
  assert.equal(result.cardChoices, undefined);
  assert.equal(result.nextAction.type, "prava_mandate_options");
  const setupUrl = new URL(result.nextAction.url);
  assert.equal(setupUrl.origin, "https://tokko-shopper.vercel.app");
  assert.equal(setupUrl.pathname, "/api/payments/linq/mandate");
  const context = server.verifyLinqMandateSetupToken(
    setupUrl.searchParams.get("state")
  );
  assert.equal(context.userId, 55);
  assert.equal(context.suggestedAmount, "250.00");
  assert.equal(context.frequency, "one_time");
  const page = server.renderLinqMandateSetupPage({
    state: setupUrl.searchParams.get("state"),
    context,
    cards: [{ id: "9", brand: "visa", last4: "2259", isDefault: true }],
  });
  assert.match(page, /Confirm mandate amount/);
  assert.match(page, /INR 250\.00/);
  assert.match(page, /Custom amount/);
  assert.match(page, /name="custom_amount"/);
  assert.match(page, /visa ending 2259/);
  assert.match(page, /Add a new saved card/);
  assert.match(page, /api\/payments\/linq\/mandate\/continue/);
  assert.ok(server.matchRoute("GET", "/api/payments/linq/mandate?state=x"));
  assert.ok(server.matchRoute(
    "GET",
    "/api/payments/linq/mandate/continue?state=x&card=9"
  ));

  const withoutAmount = await server.executeHermesTool(
    { tokkoReturnContext: returnContext },
    55,
    "prepare_payment_mandate",
    {}
  );
  const blankContext = server.verifyLinqMandateSetupToken(
    new URL(withoutAmount.nextAction.url).searchParams.get("state")
  );
  assert.equal(blankContext.suggestedAmount, null);
  assert.match(
    server.renderLinqMandateSetupPage({
      state: "signed",
      context: blankContext,
      cards: [],
    }),
    /Mandate amount in INR/
  );
});

test(
  "LINQ mandate setup opens Prava, returns from new-card enrollment, and then returns to chat",
  { concurrency: false },
  async () => {
    const originals = {
      listCards: payments.listCards,
      listMandates: payments.listMandates,
      createTokenizationSession: payments.createTokenizationSession,
      createMandateSession: payments.createMandateSession,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      syncPaymentMethods: db.syncPaymentMethods,
      getLinqHermesBinding: db.getLinqHermesBinding,
      savePaymentTokenizationSession: db.savePaymentTokenizationSession,
      saveLinqHermesState: db.saveLinqHermesState,
      saveLinqHermesMessage: db.saveLinqHermesMessage,
      sendChatMessage: linq.sendChatMessage,
      sendChatLink: linq.sendChatLink,
    };
    const chatId = "8f392755-6865-4b18-880a-227f9d8b458f";
    const to = "+12025551234";
    let pendingChoices = null;
    let newCardSaved = false;
    let mandateCreated = false;
    let tokenizationArgs = null;
    let mandateArgs = null;
    const sentMessages = [];
    const methods = () => [{
      id: 9,
      provider: "prava",
      provider_payment_method_id: "card_saved_9",
      brand: "visa",
      last4: "2259",
      exp_month: 12,
      exp_year: 2030,
      is_default: true,
    }, ...(newCardSaved ? [{
      id: 10,
      provider: "prava",
      provider_payment_method_id: "card_new_10",
      brand: "mastercard",
      last4: "4411",
      exp_month: 10,
      exp_year: 2031,
      is_default: false,
    }] : [])];
    try {
      db.getUserById = async () => ({ id: 55, email: "family@example.com" });
      db.getProfile = async () => ({
        user_id: 55,
        primary_parent_phone: "+919900112233",
      });
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_55",
      });
      db.getPaymentMethods = async () => methods();
      db.syncPaymentMethods = async () => methods();
      db.getLinqHermesBinding = async () => ({
        user_id: 55,
        to_phone: to,
        pending_choices: pendingChoices,
      });
      db.savePaymentTokenizationSession = async () => null;
      db.saveLinqHermesState = async (_chatId, state) => {
        pendingChoices = state.pendingChoices;
        return state;
      };
      db.saveLinqHermesMessage = async () => null;
      payments.listCards = async () => [{
        card_id: "card_saved_9",
        card_brand: "visa",
        card_last4: "2259",
        card_exp_month: 12,
        card_exp_year: 2030,
        is_default: true,
      }, ...(newCardSaved ? [{
        card_id: "card_new_10",
        card_brand: "mastercard",
        card_last4: "4411",
        card_exp_month: 10,
        card_exp_year: 2031,
        is_default: false,
      }] : [])];
      payments.listMandates = async () => [{
        id: "mdt_existing",
        status: "active",
        currency: "INR",
      }, ...(mandateCreated ? [{
        id: "mdt_new_standalone",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "any",
        approvedAmount: "375.00",
        currency: "INR",
        createdAt: "2030-01-01T00:00:00.000Z",
      }] : [])];
      payments.createTokenizationSession = async (args) => {
        tokenizationArgs = args;
        return {
          sessionId: "sess_card_standalone",
          approvalUrl: "https://checkout.sandbox.prava.space/s/sess_card_standalone",
          expiresAt: "2030-01-01T00:15:00.000Z",
        };
      };
      payments.createMandateSession = async (args) => {
        mandateArgs = args;
        return {
          sessionId: "sess_mandate_standalone",
          approvalUrl: "https://checkout.sandbox.prava.space/s/sess_mandate_standalone",
          expiresAt: "2030-01-01T00:15:00.000Z",
        };
      };
      linq.sendChatMessage = async (input) => {
        sentMessages.push(input.text);
      };
      linq.sendChatLink = async () => null;

      const setupUrl = new URL(
        server.prepareLinqMandateSetupLink(55, { amount: "375" }, {
          channel: "linq",
          chatId,
          to,
        }).nextAction.url
      );
      const setupState = setupUrl.searchParams.get("state");
      const initial = server.verifyLinqMandateSetupToken(setupState);
      const continueUrl = "/api/payments/linq/mandate/continue?"
        + new URLSearchParams({
          state: setupState,
          amount: "375.00",
          card: "9",
        }).toString();
      const continueRoute = server.matchRoute("GET", continueUrl);
      const response = {
        status: null,
        headers: null,
        body: "",
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body = "") {
          this.body += String(body);
        },
      };
      await continueRoute.handler(
        { method: "GET", url: continueUrl },
        response,
        continueRoute.params
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.Location, undefined);
      assert.match(response.headers["Content-Type"], /^text\/html/);
      assert.match(response.body, /http-equiv="refresh"/i);
      assert.match(
        response.body,
        /https:\/\/checkout\.sandbox\.prava\.space\/s\/sess_mandate_standalone/
      );
      assert.match(response.body, /Continue securely with Prava/i);

      const enrollment = await server.startLinqStandaloneMandateCardEnrollment(
        initial,
        server.linqMandateIntentFromSelection(initial, {
          amount: "375.00",
        })
      );
      assert.equal(enrollment.status, "CARD_SETUP_REQUIRED");
      const enrollmentContext = server.verifyLinqPravaReturnToken(
        new URL(tokenizationArgs.callbackUrl).searchParams.get("state")
      );
      assert.equal(enrollmentContext.stage, "linq_mandate_card_enrollment");

      newCardSaved = true;
      const cardReturn = await server.handleLinqPravaReturn(enrollmentContext);
      assert.equal(cardReturn.status, "CARD_SAVED");
      assert.equal(cardReturn.message, null);
      assert.equal(sentMessages.length, 0);
      const resumedPage = new URL(cardReturn.browserRedirectUrl);
      assert.equal(resumedPage.origin, "https://tokko-shopper.vercel.app");
      const resumedContext = server.verifyLinqMandateSetupToken(
        resumedPage.searchParams.get("state")
      );
      assert.equal(resumedContext.selectedCardId, "10");
      assert.equal(resumedContext.suggestedAmount, "375.00");

      await server.startLinqStandaloneMandate(
        resumedContext,
        server.linqMandateIntentFromSelection(resumedContext, {
          custom_amount: "375",
        }),
        resumedContext.selectedCardId
      );
      assert.equal(mandateArgs.cardId, "card_new_10");
      assert.equal(mandateArgs.amount, "375.00");
      const mandateReturnContext = server.verifyLinqPravaReturnToken(
        new URL(mandateArgs.callbackUrl).searchParams.get("state")
      );
      assert.equal(mandateReturnContext.stage, "linq_mandate_setup");

      mandateCreated = true;
      const completed = await server.handleLinqPravaReturn(mandateReturnContext);
      assert.equal(completed.status, "MANDATE_CREATED");
      assert.equal(completed.browserRedirectUrl, null);
      assert.equal(completed.returnUrl, "sms:+12025551234");
      assert.deepEqual(sentMessages, [
        "Prava created mandate successfully, you can continue ordering",
      ]);
      assert.doesNotMatch(sentMessages[0], /2259|4411|visa|mastercard/i);
    } finally {
      Object.assign(payments, {
        listCards: originals.listCards,
        listMandates: originals.listMandates,
        createTokenizationSession: originals.createTokenizationSession,
        createMandateSession: originals.createMandateSession,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getPaymentMethods: originals.getPaymentMethods,
        syncPaymentMethods: originals.syncPaymentMethods,
        getLinqHermesBinding: originals.getLinqHermesBinding,
        savePaymentTokenizationSession: originals.savePaymentTokenizationSession,
        saveLinqHermesState: originals.saveLinqHermesState,
        saveLinqHermesMessage: originals.saveLinqHermesMessage,
      });
      Object.assign(linq, {
        sendChatMessage: originals.sendChatMessage,
        sendChatLink: originals.sendChatLink,
      });
    }
  }
);

test("Telegram Prava payment-option links are signed, expiring, and render Telegram returns", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const paymentContext = {
    userId: 55,
    chatId: "7783253227",
    checkoutId: "11111111-1111-4111-8111-111111111111",
    botUsername: "TokkoBot",
  };
  const token = server.telegramPaymentOptionsToken(paymentContext, {
    now,
    ttlMs: 60_000,
  });
  const verified = server.verifyTelegramPaymentOptionsToken(token, {
    now: now + 1_000,
  });
  assert.equal(verified.channel, "telegram");
  assert.equal(verified.userId, 55);
  assert.equal(verified.chatId, "7783253227");
  assert.equal(verified.checkoutId, paymentContext.checkoutId);
  assert.equal(verified.botUsername, "TokkoBot");
  assert.throws(
    () => server.verifyTelegramPaymentOptionsToken(token, { now: now + 60_001 }),
    /expired/
  );
  assert.throws(
    () => server.verifyTelegramPaymentOptionsToken(`${token}x`, { now }),
    /invalid/
  );
  const url = new URL(server.telegramPaymentOptionsUrl(paymentContext, {
    now,
    ttlMs: 60_000,
  }));
  assert.equal(url.origin, "https://tokko-shopper.vercel.app");
  assert.equal(url.pathname, "/api/payments/telegram/options");
  const page = server.renderLinqPaymentOptionsPage({
    state: token,
    channel: "telegram",
    flow: {
      price_breakdown: {
        merchantName: "Himalaya Wellness",
        currency: "INR",
        totalAmount: "114.00",
        totalMinor: 11400,
      },
    },
    cards: [{ id: "9", brand: "visa", last4: "2259" }],
  });
  assert.match(page, /action="\/api\/payments\/telegram\/options\/continue"/);
  assert.match(page, /existing Telegram chat/i);
  const failurePage = server.renderLinqPaymentFailurePage({
    message: "Card was declined",
    retryUrl: url.toString(),
    returnUrl: "https://t.me/TokkoBot?start=payments_checkout_exit",
    channel: "telegram",
  });
  assert.match(failurePage, /Return to Telegram without placing order/);
  assert.doesNotMatch(failurePage, /Return to LINQ/);
});

test(
  "Telegram mandate return automatically charges the newly created checkout mandate",
  { concurrency: false },
  async () => {
    const originals = {
      getRecentCheckoutFlows: db.getRecentCheckoutFlows,
      getCheckoutFlow: db.getCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
      getPaymentCustomer: db.getPaymentCustomer,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getUcpCart: db.getUcpCart,
      clearUcpCart: db.clearUcpCart,
      listMandates: payments.listMandates,
      chargeMandate: payments.chargeMandate,
    };
    const flowId = "55555555-5555-4555-8555-555555555555";
    let flow = {
      id: flowId,
      user_id: 55,
      platform: "ucp",
      status: "UCP_MANDATE_APPROVAL_REQUIRED",
      price_breakdown: {
        tokkoFlowId: flowId,
        merchantName: "Himalaya Wellness",
        merchantUrl: "https://himalayawellness.in",
        totalMinor: 11400,
        totalAmount: "114.00",
        currency: "INR",
        channelMandateSetup: {
          channel: "telegram",
          chatId: "777",
          frequency: "one_time",
          merchantScope: "any",
          mandateIdsBefore: ["mdt_old"],
        },
      },
      cart_snapshot: [],
    };
    let chargeArgs = null;
    try {
      db.getRecentCheckoutFlows = async () => [flow];
      db.getCheckoutFlow = async () => flow;
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_55",
      });
      db.getUserById = async () => ({ id: 55, email: "family@example.com" });
      db.getProfile = async () => ({
        user_id: 55,
        primary_parent_phone: "+919900112233",
      });
      db.getUcpCart = async () => ({ items: [] });
      db.clearUcpCart = async () => ({ items: [] });
      db.saveCheckoutFlow = async (saved) => {
        flow = {
          ...flow,
          status: saved.status,
          payment_route: saved.paymentRoute,
          prava_mandate_id: saved.pravaMandateId,
          prava_transaction_id: saved.pravaTransactionId,
          prava_charge_reference: saved.pravaChargeReference,
          prava_charge_status: saved.pravaChargeStatus,
          prava_charge_amount: saved.pravaChargeAmount,
          price_breakdown: saved.priceBreakdown,
          cart_snapshot: saved.cartSnapshot,
        };
        return flow;
      };
      payments.listMandates = async () => [{
        id: "mdt_new_any",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "any",
        approvedAmount: "114.00",
        remaining: "114.00",
        currency: "INR",
      }];
      payments.chargeMandate = async (args) => {
        chargeArgs = args;
        return {
          mandateId: args.mandateId,
          transactionId: "txn_telegram_return",
          status: "awaiting_result",
          credentials: { token: "ephemeral-test-token" },
        };
      };

      const result = await server.resumeTelegramUcpOneTimeMandate(55, 777);

      assert.equal(result.status, "PAYMENT_APPROVED");
      assert.equal(result.credentialIssued, true);
      assert.equal(result.mandate.id, "mdt_new_any");
      assert.equal(chargeArgs.mandateId, "mdt_new_any");
      assert.equal(chargeArgs.amount, "114.00");
      assert.match(result.message, /prava checkout was successful/i);
      assert.doesNotMatch(result.message, /transaction|txn_mandate/i);
      assert.equal(
        result.followupMessage,
        "Order creation failed at the merchant end."
      );
    } finally {
      Object.assign(db, {
        getRecentCheckoutFlows: originals.getRecentCheckoutFlows,
        getCheckoutFlow: originals.getCheckoutFlow,
        saveCheckoutFlow: originals.saveCheckoutFlow,
        getPaymentCustomer: originals.getPaymentCustomer,
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getUcpCart: originals.getUcpCart,
        clearUcpCart: originals.clearUcpCart,
      });
      Object.assign(payments, {
        listMandates: originals.listMandates,
        chargeMandate: originals.chargeMandate,
      });
    }
  }
);

test(
  "Telegram saved-card return consumes Prava result, clears cart, and hides transaction details",
  { concurrency: false },
  async () => {
    const originals = {
      getRecentCheckoutFlows: db.getRecentCheckoutFlows,
      getCheckoutFlow: db.getCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
      getUcpCart: db.getUcpCart,
      clearUcpCart: db.clearUcpCart,
      getPaymentResult: payments.getPaymentResult,
    };
    const flowId = "66666666-6666-4666-8666-666666666666";
    let flow = {
      id: flowId,
      user_id: 55,
      platform: "ucp",
      status: "UCP_PRAVA_APPROVAL_REQUIRED",
      payment_route: "prava_card",
      prava_session_id: "sess_telegram_card",
      prava_session_approval_url:
        "https://checkout.prava.space/s/sess_telegram_card",
      price_breakdown: {
        channelPaymentSetup: {
          channel: "telegram",
          chatId: "777",
          botUsername: "TokkoBot",
        },
      },
      cart_snapshot: [{ selectionToken: "checkout-item", quantity: 1 }],
    };
    let cartCleared = false;
    try {
      db.getRecentCheckoutFlows = async () => [flow];
      db.getCheckoutFlow = async () => flow;
      db.getUcpCart = async () => ({
        items: [{ selectionToken: "checkout-item", quantity: 1 }],
      });
      db.clearUcpCart = async () => {
        cartCleared = true;
        return { items: [] };
      };
      db.saveCheckoutFlow = async (saved) => {
        flow = {
          ...flow,
          id: saved.id,
          user_id: saved.userId,
          platform: saved.platform,
          status: saved.status,
          payment_route: saved.paymentRoute,
          prava_session_id: saved.pravaSessionId,
          prava_session_approval_url: saved.pravaSessionApprovalUrl,
          prava_transaction_id: saved.pravaTransactionId,
          prava_charge_status: saved.pravaChargeStatus,
          price_breakdown: saved.priceBreakdown,
          cart_snapshot: saved.cartSnapshot,
        };
        return flow;
      };
      payments.getPaymentResult = async () => ({
        status: "awaiting_result",
        transactions: [{
          status: "awaiting_result",
          line_items: [{
            txn_ref_id: "txn_telegram_card",
            token: "4111111111111111",
            dynamic_cvv: "432",
            expiry_month: "09",
            expiry_year: "2031",
          }],
        }],
      });

      const result = await server.resumeTelegramCheckoutCardReturn(
        55,
        777,
        "TokkoBot"
      );

      assert.equal(result.credentialIssued, true);
      assert.equal(result.cartCleared, true);
      assert.equal(cartCleared, true);
      assert.match(result.message, /prava checkout was successful/i);
      assert.doesNotMatch(result.message, /transaction|txn_telegram_card/i);
      assert.equal(
        result.followupMessage,
        "Order creation failed at the merchant end."
      );
    } finally {
      Object.assign(db, {
        getRecentCheckoutFlows: originals.getRecentCheckoutFlows,
        getCheckoutFlow: originals.getCheckoutFlow,
        saveCheckoutFlow: originals.saveCheckoutFlow,
        getUcpCart: originals.getUcpCart,
        clearUcpCart: originals.clearUcpCart,
      });
      payments.getPaymentResult = originals.getPaymentResult;
    }
  }
);

test(
  "Telegram failed saved-card return offers shared Prava retry without clearing cart",
  { concurrency: false },
  async () => {
    const originals = {
      getRecentCheckoutFlows: db.getRecentCheckoutFlows,
      getCheckoutFlow: db.getCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
      getUcpCart: db.getUcpCart,
      clearUcpCart: db.clearUcpCart,
      getPaymentResult: payments.getPaymentResult,
    };
    const flowId = "77777777-7777-4777-8777-777777777777";
    let flow = {
      id: flowId,
      user_id: 55,
      platform: "ucp",
      status: "UCP_PRAVA_APPROVAL_REQUIRED",
      payment_route: "prava_card",
      prava_session_id: "sess_telegram_failed",
      prava_session_approval_url:
        "https://checkout.prava.space/s/sess_telegram_failed",
      price_breakdown: {
        channelPaymentSetup: {
          channel: "telegram",
          chatId: "777",
          botUsername: "TokkoBot",
        },
      },
      cart_snapshot: [],
    };
    let cartCleared = false;
    try {
      db.getRecentCheckoutFlows = async () => [flow];
      db.getCheckoutFlow = async () => flow;
      db.getUcpCart = async () => ({ items: [] });
      db.clearUcpCart = async () => {
        cartCleared = true;
        return { items: [] };
      };
      db.saveCheckoutFlow = async (saved) => {
        flow = {
          ...flow,
          id: saved.id,
          user_id: saved.userId,
          platform: saved.platform,
          status: saved.status,
          payment_route: saved.paymentRoute,
          prava_session_id: saved.pravaSessionId,
          prava_session_approval_url: saved.pravaSessionApprovalUrl,
          prava_transaction_id: saved.pravaTransactionId,
          prava_charge_status: saved.pravaChargeStatus,
          price_breakdown: saved.priceBreakdown,
          cart_snapshot: saved.cartSnapshot,
        };
        return flow;
      };
      payments.getPaymentResult = async () => ({
        status: "failed",
        transactions: [],
      });

      const result = await server.resumeTelegramCheckoutCardReturn(
        55,
        777,
        "TokkoBot"
      );

      assert.equal(result.credentialIssued, false);
      assert.equal(result.retryPayment, true);
      assert.equal(result.nextAction.type, "prava_payment_options");
      assert.equal(
        new URL(result.nextAction.url).pathname,
        "/api/payments/telegram/options"
      );
      assert.equal(
        new URL(result.returnUrl).pathname,
        "/api/payments/telegram/options/exit"
      );
      assert.equal(cartCleared, false);
    } finally {
      Object.assign(db, {
        getRecentCheckoutFlows: originals.getRecentCheckoutFlows,
        getCheckoutFlow: originals.getCheckoutFlow,
        saveCheckoutFlow: originals.saveCheckoutFlow,
        getUcpCart: originals.getUcpCart,
        clearUcpCart: originals.clearUcpCart,
      });
      payments.getPaymentResult = originals.getPaymentResult;
    }
  }
);

test(
  "Telegram Prava relay returns only the two checkout messages for an existing chat",
  { concurrency: false },
  async () => {
    const originals = {
      getTelegramHermesBinding: db.getTelegramHermesBinding,
      getCheckoutFlow: db.getCheckoutFlow,
      getUcpCart: db.getUcpCart,
      clearUcpCart: db.clearUcpCart,
      saveTelegramHermesMessage: db.saveTelegramHermesMessage,
    };
    const checkoutId = "88888888-8888-4888-8888-888888888888";
    const savedMessages = [];
    try {
      db.getTelegramHermesBinding = async () => ({ user_id: 55 });
      db.getCheckoutFlow = async () => ({
        id: checkoutId,
        user_id: 55,
        platform: "ucp",
        status: "UCP_PRAVA_CREDENTIAL_ISSUED",
        payment_route: "prava_card",
        prava_transaction_id: "txn_must_not_be_relayed",
        price_breakdown: {
          channelPaymentSetup: {
            channel: "telegram",
            chatId: "777",
            botUsername: "TokkoBot",
          },
        },
        cart_snapshot: [{ selectionToken: "relay-item", quantity: 1 }],
      });
      db.getUcpCart = async () => ({
        items: [{ selectionToken: "relay-item", quantity: 1 }],
      });
      db.clearUcpCart = async () => ({ items: [] });
      db.saveTelegramHermesMessage = async (_chatId, _role, message) => {
        savedMessages.push(message);
      };

      const result = await server.handleTelegramPravaReturn({
        channel: "telegram",
        userId: 55,
        chatId: "777",
        checkoutId,
        botUsername: "TokkoBot",
        stage: "ucp_payment",
        flow: "card",
      });

      assert.equal(result.chatId, "777");
      assert.equal(result.botUsername, "TokkoBot");
      assert.equal(
        result.message,
        "Prava checkout was successful, but the order still awaits merchant approval. This cart was cleared."
      );
      assert.equal(
        result.followupMessage,
        "Order creation failed at the merchant end."
      );
      assert.equal("transactionId" in result, false);
      assert.doesNotMatch(JSON.stringify(result), /txn_must_not_be_relayed/);
      assert.deepEqual(savedMessages, [
        result.message,
        result.followupMessage,
      ]);
    } finally {
      Object.assign(db, originals);
    }
  }
);

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
      saveCheckoutFlow: db.saveCheckoutFlow,
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
      db.saveCheckoutFlow = async (flow) => flow;

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

      chargeInput = undefined;
      payments.listMandates = async () => [
        ...[300, 400, 500, 600].map((remaining, index) => ({
          id: `mdt_any_${index + 1}`,
          status: "active",
          state: "available",
          frequency: "one_time",
          merchantScope: "any",
          remaining: remaining.toFixed(2),
          currency: "INR",
        })),
        {
          id: "mdt_listed_not_offered",
          status: "active",
          state: "available",
          frequency: "one_time",
          merchantScope: "listed",
          merchantName: "Himalaya Wellness",
          remaining: "700.00",
          currency: "INR",
        },
      ];
      const telegramResult = await server.createUcpCheckoutWithPayment(
        42,
        { selectionToken: "signed-selection", quantity: 1 },
        {
          channel: "telegram",
          chatId: "7783253227",
          botUsername: "TokkoBot",
        }
      );
      assert.equal(chargeInput, undefined);
      assert.equal(telegramResult.paymentRoute, "mandate_selection_required");
      assert.deepEqual(
        telegramResult.mandateChoices.map((choice) => choice.mandateId),
        ["mdt_any_1", "mdt_any_2", "mdt_any_3", "mdt_any_4"]
      );
      assert.equal(
        new URL(telegramResult.nextAction.url).pathname,
        "/api/payments/telegram/options"
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
        saveCheckoutFlow: originals.saveCheckoutFlow,
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
      createPaymentSession: payments.createPaymentSession,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      getFamilyAddresses: db.getFamilyAddresses,
      getCheckoutFlow: db.getCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
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
      // In-memory checkout-flow store so the agent path can persist a flow and
      // selectUcpSavedCard can look it up (mirrors the real DB round-trip).
      let savedFlow = null;
      db.saveCheckoutFlow = async (flow) => {
        savedFlow = {
          id: flow.id,
          user_id: flow.userId,
          platform: flow.platform,
          status: flow.status,
          address_id: flow.addressId,
          card_brand: flow.cardBrand || null,
          card_last4: flow.cardLast4 || null,
          card_failure_count: 0,
          card_payment_received: false,
          allow_cod_fallback: flow.allowCodFallback !== false,
          fallback_to_cod: false,
          payment_route: flow.paymentRoute || null,
          prava_session_id: flow.pravaSessionId || null,
          prava_session_approval_url: flow.pravaSessionApprovalUrl || null,
          price_breakdown: flow.priceBreakdown || {},
          cart_snapshot: flow.cartSnapshot || [],
        };
        return savedFlow;
      };
      db.getCheckoutFlow = async () => savedFlow;
      payments.createPaymentSession = async () => ({
        provider: "prava",
        sessionId: "sess_79",
        approvalUrl: "https://sandbox.prava.space/approve/sess_79",
        orderId: null,
        expiresAt: null,
        amount: "999.00",
        currency: "INR",
      });

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
      assert.equal(result.cardChoices[1].type, "add_card");
      assert.equal(result.cardChoices[1].label, "Add a new saved card");

      // The agent/Telegram path now persists a flow, so picking the card opens
      // a Prava approval session instead of handing back the raw Shopify URL.
      const selected = await server.selectUcpSavedCard(
        43,
        result.cardChoices[0].token
      );
      assert.equal(selected.paymentRoute, "prava_card");
      assert.equal(selected.savedCard.last4, "4242");
      assert.equal(selected.nextAction.type, "prava_card_approval");
      assert.equal(
        selected.nextAction.url,
        "https://sandbox.prava.space/approve/sess_79"
      );
      assert.notEqual(
        selected.nextAction.url,
        "https://merchant.example/cart/c/card-test"
      );
    } finally {
      Object.assign(ucp, { createCheckout: originals.createCheckout });
      Object.assign(payments, {
        configuration: originals.configuration,
        listCards: originals.listCards,
        listMandates: originals.listMandates,
        createPaymentSession: originals.createPaymentSession,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getPaymentMethods: originals.getPaymentMethods,
        getFamilyAddresses: originals.getFamilyAddresses,
        getCheckoutFlow: originals.getCheckoutFlow,
        saveCheckoutFlow: originals.saveCheckoutFlow,
      });
    }
  }
);

test(
  "Telegram UCP checkout with no mandate exposes the shared Prava payment options",
  { concurrency: false },
  async () => {
    const originals = {
      createCheckout: ucp.createCheckout,
      configuration: payments.configuration,
      listCards: payments.listCards,
      listMandates: payments.listMandates,
      createPaymentSession: payments.createPaymentSession,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      getFamilyAddresses: db.getFamilyAddresses,
      getCheckoutFlow: db.getCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
    };
    try {
      ucp.createCheckout = async () => ({
        merchant: "oziva",
        merchantName: "OZiva",
        merchantUrl: "https://www.oziva.in",
        productName: "Plant Protein",
        variantName: "1 kg",
        variantId: "gid://shopify/ProductVariant/402",
        quantity: 1,
        currency: "INR",
        totalMinor: 99900,
        totalAmount: "999.00",
        totals: [{ type: "total", label: "Total", amountMinor: 99900 }],
        checkoutId: "gid://shopify/Checkout/no-card",
        status: "requires_escalation",
        checkoutUrl: "https://merchant.example/cart/c/no-card",
        continueUrl: "https://merchant.example/cart/c/no-card",
        paymentHandlers: ["dev.shopify.card"],
      });
      payments.configuration = () => ({ configured: true, environment: "sandbox" });
      payments.listCards = async () => [];
      payments.listMandates = async () => [];
      db.getUserById = async () => ({ id: 44, email: "nocard@example.com" });
      db.getProfile = async () => ({
        user_id: 44,
        primary_parent_name: "No Card Parent",
        primary_parent_phone: "+919900112244",
      });
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_44",
      });
      db.getPaymentMethods = async () => [];
      db.getFamilyAddresses = async () => [{
        id: 103,
        label: "Home",
        formatted_address: "1 Lake Road, Kolkata 700029",
        address_line1: "1 Lake Road",
        city: "Kolkata",
        state: "West Bengal",
        postal_code: "700029",
        country_code: "IN",
        contact_name: "No Card Parent",
        contact_phone: "+919900112244",
        is_selected: true,
      }];
      let savedFlow = null;
      db.saveCheckoutFlow = async (flow) => {
        savedFlow = {
          id: flow.id,
          user_id: flow.userId,
          platform: flow.platform,
          status: flow.status,
          address_id: flow.addressId,
          card_brand: flow.cardBrand || null,
          card_last4: flow.cardLast4 || null,
          card_failure_count: 0,
          card_payment_received: false,
          allow_cod_fallback: flow.allowCodFallback !== false,
          fallback_to_cod: false,
          payment_route: flow.paymentRoute || null,
          prava_session_id: flow.pravaSessionId || null,
          prava_session_approval_url: flow.pravaSessionApprovalUrl || null,
          price_breakdown: flow.priceBreakdown || {},
          cart_snapshot: flow.cartSnapshot || [],
        };
        return savedFlow;
      };
      db.getCheckoutFlow = async () => savedFlow;
      let sessionArgs = null;
      payments.createPaymentSession = async (args) => {
        sessionArgs = args;
        return {
          provider: "prava",
          sessionId: "sess_nocard",
          approvalUrl: "https://sandbox.prava.space/approve/sess_nocard",
          orderId: null,
          expiresAt: null,
          amount: "1028.97",
          currency: "INR",
        };
      };

      const result = await server.createUcpCheckoutWithPayment(
        44,
        { selectionToken: "signed-no-card", quantity: 1 },
        {
          channel: "telegram",
          chatId: "7783253227",
          botUsername: "TokkoBot",
        }
      );
      assert.equal(result.paymentRoute, "mandate_selection_required");
      assert.equal(result.nextAction.type, "prava_payment_options");
      const optionsUrl = new URL(result.nextAction.url);
      assert.equal(optionsUrl.pathname, "/api/payments/telegram/options");
      const optionsContext = server.verifyTelegramPaymentOptionsToken(
        optionsUrl.searchParams.get("state")
      );
      assert.equal(optionsContext.userId, 44);
      assert.equal(optionsContext.chatId, "7783253227");
      assert.equal(optionsContext.botUsername, "TokkoBot");
      assert.equal(result.merchantHandoffUrl, null);
      assert.deepEqual(result.cardChoices, []);
      assert.equal(sessionArgs, null);
    } finally {
      Object.assign(ucp, { createCheckout: originals.createCheckout });
      Object.assign(payments, {
        configuration: originals.configuration,
        listCards: originals.listCards,
        listMandates: originals.listMandates,
        createPaymentSession: originals.createPaymentSession,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getPaymentMethods: originals.getPaymentMethods,
        getFamilyAddresses: originals.getFamilyAddresses,
        getCheckoutFlow: originals.getCheckoutFlow,
        saveCheckoutFlow: originals.saveCheckoutFlow,
      });
    }
  }
);

test(
  "a saved card checkout also offers the persisted add-card flow",
  { concurrency: false },
  async () => {
    const originals = {
      createCheckout: ucp.createCheckout,
      configuration: payments.configuration,
      listCards: payments.listCards,
      listMandates: payments.listMandates,
      createPaymentSession: payments.createPaymentSession,
      getUserById: db.getUserById,
      getProfile: db.getProfile,
      getPaymentCustomer: db.getPaymentCustomer,
      getPaymentMethods: db.getPaymentMethods,
      getFamilyAddresses: db.getFamilyAddresses,
      getCheckoutFlow: db.getCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
    };
    try {
      ucp.createCheckout = async () => ({
        merchant: "oziva",
        merchantName: "OZiva",
        merchantUrl: "https://www.oziva.in",
        productName: "Plant Protein",
        variantName: "1 kg",
        variantId: "gid://shopify/ProductVariant/403",
        quantity: 1,
        currency: "INR",
        totalMinor: 99900,
        totalAmount: "999.00",
        totals: [{ type: "total", label: "Total", amountMinor: 99900 }],
        checkoutId: "gid://shopify/Checkout/diff-card",
        status: "requires_escalation",
        checkoutUrl: "https://merchant.example/cart/c/diff-card",
        continueUrl: "https://merchant.example/cart/c/diff-card",
        paymentHandlers: ["dev.shopify.card"],
      });
      payments.configuration = () => ({ configured: true, environment: "sandbox" });
      payments.listCards = async () => [];
      payments.listMandates = async () => [];
      db.getUserById = async () => ({ id: 45, email: "diff@example.com" });
      db.getProfile = async () => ({
        user_id: 45,
        primary_parent_name: "Diff Parent",
        primary_parent_phone: "+919900112255",
      });
      db.getPaymentCustomer = async () => ({
        provider: "prava",
        provider_customer_id: "tokko_family_45",
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
        id: 104,
        label: "Home",
        formatted_address: "1 Lake Road, Kolkata 700029",
        address_line1: "1 Lake Road",
        city: "Kolkata",
        state: "West Bengal",
        postal_code: "700029",
        country_code: "IN",
        contact_name: "Diff Parent",
        contact_phone: "+919900112255",
        is_selected: true,
      }];
      let savedFlow = null;
      db.saveCheckoutFlow = async (flow) => {
        savedFlow = {
          id: flow.id,
          user_id: flow.userId,
          platform: flow.platform,
          status: flow.status,
          address_id: flow.addressId,
          card_brand: flow.cardBrand || null,
          card_last4: flow.cardLast4 || null,
          card_failure_count: 0,
          card_payment_received: false,
          allow_cod_fallback: flow.allowCodFallback !== false,
          fallback_to_cod: false,
          payment_route: flow.paymentRoute || null,
          prava_session_id: flow.pravaSessionId || null,
          prava_session_approval_url: flow.pravaSessionApprovalUrl || null,
          price_breakdown: flow.priceBreakdown || {},
          cart_snapshot: flow.cartSnapshot || [],
        };
        return savedFlow;
      };
      db.getCheckoutFlow = async () => savedFlow;
      let sessionArgs = null;
      payments.createPaymentSession = async (args) => {
        sessionArgs = args;
        return {
          provider: "prava",
          sessionId: "sess_diff",
          approvalUrl: "https://sandbox.prava.space/approve/sess_diff",
          orderId: null,
          expiresAt: null,
          amount: "1028.97",
          currency: "INR",
        };
      };

      const result = await server.createUcpCheckoutWithPayment(45, {
        selectionToken: "signed-diff-card",
        quantity: 1,
      });
      assert.equal(result.paymentRoute, "card_selection_required");
      // The saved card is offered together with the newer save-card flow.
      assert.equal(result.cardChoices[0].last4, "4242");
      const addCard = result.cardChoices.find((c) => c.type === "add_card");
      assert.ok(addCard, "expected an add-and-save card choice");
      assert.ok(addCard.token);

      const approved = hermes.verifyApproval(addCard.token, 45);
      assert.equal(approved.toolName, "create_ucp_saved_card");
      assert.equal(approved.args.tokkoFlowId, result.tokkoFlowId);
      // Saving starts through the dedicated Prava enrollment flow.
      assert.equal(sessionArgs, null);
    } finally {
      Object.assign(ucp, { createCheckout: originals.createCheckout });
      Object.assign(payments, {
        configuration: originals.configuration,
        listCards: originals.listCards,
        listMandates: originals.listMandates,
        createPaymentSession: originals.createPaymentSession,
      });
      Object.assign(db, {
        getUserById: originals.getUserById,
        getProfile: originals.getProfile,
        getPaymentCustomer: originals.getPaymentCustomer,
        getPaymentMethods: originals.getPaymentMethods,
        getFamilyAddresses: originals.getFamilyAddresses,
        getCheckoutFlow: originals.getCheckoutFlow,
        saveCheckoutFlow: originals.saveCheckoutFlow,
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
        id: "11111111-1111-4111-8111-111111111111",
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
        price_breakdown: {
          merchant: "himalayawellness",
          merchantName: "Himalaya Wellness",
          merchantUrl: "https://himalayawellness.in",
          market: "IN",
          productName: "Ashwagandha",
          variantName: "60 tablets",
          variantId: "gid://shopify/ProductVariant/55",
          quantity: 2,
          totalMinor: 5300,
          totalAmount: "53.00",
          cartTotalMinor: 11400,
          cartTotalAmount: "114.00",
          totals: [{
            type: "total",
            label: "Cart total payable",
            amountMinor: 11400,
          }],
          currency: "INR",
          autofill: { submitted: true },
        },
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
          amount: args.amount,
          currency: "INR",
        };
      };
      const token = hermes.signApproval({
        userId: 55,
        toolName: "select_ucp_saved_card",
        args: {
          checkoutId: "gid://shopify/Checkout/x",
          tokkoFlowId: "11111111-1111-4111-8111-111111111111",
          merchant: "himalayawellness",
          merchantName: "Himalaya Wellness",
          totalAmount: "101.97",
          currency: "INR",
          paymentMethodId: "9",
        },
      });
      const result = await server.selectUcpSavedCard(55, token, {
        channel: "linq",
        chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
        to: "+12025551234",
      });
      assert.equal(result.paymentRoute, "prava_card");
      assert.equal(result.nextAction.type, "prava_card_approval");
      assert.equal(
        result.nextAction.url,
        "https://sandbox.prava.space/approve/sess_1"
      );
      assert.notEqual(result.nextAction.url, "https://merchant.example/cart/c/x");
      assert.equal(result.merchantHandoffUrl, null);
      assert.equal(result.savedCard.last4, "2259");
      assert.equal(result.amount, "114.00");
      assert.equal(sessionArgs.cardId, "card_saved_9");
      assert.equal(sessionArgs.amount, "114.00");
      assert.equal(sessionArgs.currency, "INR");
      assert.equal(sessionArgs.phone, "+919900112233");
      assert.equal(sessionArgs.countryCode, "IN");
      assert.equal(
        sessionArgs.purchaseContext[0].merchant_details.name,
        "Himalaya Wellness"
      );
      assert.equal(
        sessionArgs.purchaseContext[0].product_details[0].unit_price,
        "114.00"
      );
      assert.equal(
        sessionArgs.purchaseContext[0].product_details[0].quantity,
        1
      );
      const callback = new URL(sessionArgs.callbackUrl);
      assert.equal(callback.pathname, "/api/payments/return");
      assert.equal(callback.searchParams.get("channel"), "linq");
      const callbackContext = server.verifyLinqPravaReturnToken(
        callback.searchParams.get("state")
      );
      assert.equal(callbackContext.userId, 55);
      assert.equal(callbackContext.stage, "ucp_payment");

      const differentCardToken = hermes.signApproval({
        userId: 55,
        toolName: "select_ucp_saved_card",
        args: {
          tokkoFlowId: "11111111-1111-4111-8111-111111111111",
          merchant: "himalayawellness",
          merchantName: "Himalaya Wellness",
          totalAmount: "101.97",
          currency: "INR",
          paymentMethodId: null,
        },
      });
      const differentCardResult = await server.selectUcpSavedCard(
        55,
        differentCardToken,
        {
          channel: "linq",
          chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
          to: "+12025551234",
        }
      );
      assert.equal(differentCardResult.savedCard, null);
      assert.equal(differentCardResult.nextAction.type, "prava_card_approval");
      assert.match(differentCardResult.nextAction.label, /different card/i);
      assert.equal(sessionArgs.cardId, null);
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

test(
  "LINQ Prava return clears stale approvals and reports payment approval truthfully",
  { concurrency: false },
  async () => {
    const originals = {
      getPaymentResult: payments.getPaymentResult,
      getCheckoutFlow: db.getCheckoutFlow,
      getUcpCart: db.getUcpCart,
      getLinqHermesBinding: db.getLinqHermesBinding,
      clearUcpCart: db.clearUcpCart,
      saveCheckoutFlow: db.saveCheckoutFlow,
      saveLinqHermesMessage: db.saveLinqHermesMessage,
      saveLinqHermesState: db.saveLinqHermesState,
      sendChatLink: linq.sendChatLink,
      sendChatMessage: linq.sendChatMessage,
    };
    let requestedSession = null;
    let savedFlow = null;
    let savedLinqState = null;
    const sentMessages = [];
    const savedMessages = [];
    let clearedCartFor = null;
    try {
      db.getLinqHermesBinding = async () => ({
        user_id: 55,
        to_phone: "+12025551234",
        pending_action: { token: "stale-zeauth" },
        pending_choices: { type: "approval", items: [] },
      });
      db.getCheckoutFlow = async () => ({
        id: "11111111-1111-4111-8111-111111111111",
        user_id: 55,
        platform: "ucp",
        status: "UCP_PRAVA_APPROVAL_REQUIRED",
        address_id: "102",
        card_brand: "visa",
        card_last4: "2259",
        card_failure_count: 0,
        card_payment_received: false,
        allow_cod_fallback: false,
        fallback_to_cod: false,
        payment_route: "prava_card",
        prava_session_id: "sess_ucp_55",
        prava_session_approval_url:
          "https://checkout.prava.space/s/sess_ucp_55",
        prava_charge_amount: "101.97",
        price_breakdown: {},
        cart_snapshot: [{ selectionToken: "checkout-item-token", quantity: 1 }],
      });
      db.getUcpCart = async () => ({
        items: [{ selectionToken: "checkout-item-token", quantity: 1 }],
      });
      db.saveCheckoutFlow = async (flow) => {
        savedFlow = flow;
        return {
          user_id: flow.userId,
          platform: flow.platform,
          status: flow.status,
          address_id: flow.addressId,
          card_brand: flow.cardBrand,
          card_last4: flow.cardLast4,
          card_failure_count: flow.cardFailureCount,
          card_payment_received: flow.cardPaymentReceived,
          allow_cod_fallback: flow.allowCodFallback,
          fallback_to_cod: flow.fallbackToCod,
          payment_route: flow.paymentRoute,
          prava_session_id: flow.pravaSessionId,
          prava_session_approval_url: flow.pravaSessionApprovalUrl,
          prava_transaction_id: flow.pravaTransactionId,
          prava_charge_status: flow.pravaChargeStatus,
          prava_charge_amount: flow.pravaChargeAmount,
          price_breakdown: flow.priceBreakdown,
          cart_snapshot: flow.cartSnapshot,
          id: flow.id,
        };
      };
      db.saveLinqHermesState = async (_chatId, state) => {
        savedLinqState = state;
        return state;
      };
      db.clearUcpCart = async (userId) => {
        clearedCartFor = userId;
        return { user_id: userId, items: [] };
      };
      db.saveLinqHermesMessage = async (_chatId, _role, text) => {
        savedMessages.push(text);
        return null;
      };
      linq.sendChatMessage = async (input) => {
        sentMessages.push(input);
        return null;
      };
      linq.sendChatLink = async () => null;
      payments.getPaymentResult = async (sessionId) => {
        requestedSession = sessionId;
        return {
          session_id: sessionId,
          status: "awaiting_result",
          transactions: [{
            status: "awaiting_result",
            line_items: [{
              txn_ref_id: "txn_ucp_55",
              token: "4111111111111111",
              dynamic_cvv: "432",
              expiry_month: "09",
              expiry_year: "2031",
            }],
          }],
        };
      };

      const result = await server.handleLinqPravaReturn({
        userId: 55,
        chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
        checkoutId: "11111111-1111-4111-8111-111111111111",
        to: "+12025551234",
        stage: "ucp_payment",
      });
      assert.equal(requestedSession, "sess_ucp_55");
      assert.equal(result.credentialIssued, true);
      assert.equal(result.status, "PAYMENT_APPROVED");
      assert.equal(result.orderStatus, "PENDING_MERCHANT_CONFIRMATION");
      assert.equal(result.merchantHandoffUrl, null);
      assert.equal(result.nextAction, null);
      assert.equal(result.cartCleared, true);
      assert.equal(clearedCartFor, 55);
      assert.deepEqual(savedLinqState, {
        pendingAction: null,
        pendingChoices: null,
      });
      assert.equal(sentMessages.length, 2);
      assert.match(sentMessages[0].text, /prava checkout was successful/i);
      assert.match(sentMessages[0].text, /awaits merchant approval/i);
      assert.doesNotMatch(
        sentMessages[0].text,
        /awaiting_result|successfully placed|txn_ucp_55|transaction/i
      );
      assert.equal(
        sentMessages[1].text,
        "Order creation failed at the merchant end."
      );
      assert.match(
        sentMessages[1].idempotencyKey,
        /merchant-order-failed$/
      );
      assert.equal(result.followupMessage, sentMessages[1].text);
      assert.deepEqual(
        savedMessages,
        [sentMessages[0].text, sentMessages[1].text]
      );
      assert.equal(savedFlow.pravaTransactionId, "txn_ucp_55");
      assert.equal(
        result.pravaPaymentResult.sessionResult.transactions[0]
          .line_items[0].token,
        "[REDACTED]"
      );
    } finally {
      Object.assign(payments, {
        getPaymentResult: originals.getPaymentResult,
      });
      Object.assign(db, {
        getCheckoutFlow: originals.getCheckoutFlow,
        getUcpCart: originals.getUcpCart,
        getLinqHermesBinding: originals.getLinqHermesBinding,
        clearUcpCart: originals.clearUcpCart,
        saveCheckoutFlow: originals.saveCheckoutFlow,
        saveLinqHermesMessage: originals.saveLinqHermesMessage,
        saveLinqHermesState: originals.saveLinqHermesState,
      });
      Object.assign(linq, {
        sendChatLink: originals.sendChatLink,
        sendChatMessage: originals.sendChatMessage,
      });
    }
  }
);

test(
  "UCP Prava awaiting_result is exposed as payment processing",
  { concurrency: false },
  async () => {
    const originals = {
      getPaymentResult: payments.getPaymentResult,
      getCheckoutFlow: db.getCheckoutFlow,
      saveCheckoutFlow: db.saveCheckoutFlow,
    };
    try {
      db.getCheckoutFlow = async () => ({
        id: "11111111-1111-4111-8111-111111111111",
        user_id: 55,
        platform: "ucp",
        status: "UCP_PRAVA_APPROVAL_REQUIRED",
        address_id: "102",
        card_brand: "visa",
        card_last4: "2259",
        card_failure_count: 0,
        card_payment_received: false,
        allow_cod_fallback: false,
        fallback_to_cod: false,
        payment_route: "prava_card",
        prava_session_id: "sess_ucp_pending",
        prava_session_approval_url:
          "https://checkout.prava.space/s/sess_ucp_pending",
        prava_charge_amount: "101.97",
        price_breakdown: {},
        cart_snapshot: [],
      });
      db.saveCheckoutFlow = async (flow) => ({
        id: flow.id,
        user_id: flow.userId,
        platform: flow.platform,
        status: flow.status,
        payment_route: flow.paymentRoute,
        prava_session_id: flow.pravaSessionId,
        prava_session_approval_url: flow.pravaSessionApprovalUrl,
        prava_charge_status: flow.pravaChargeStatus,
        price_breakdown: flow.priceBreakdown,
        cart_snapshot: flow.cartSnapshot,
      });
      payments.getPaymentResult = async () => ({
        status: "awaiting_result",
        transactions: [],
      });

      const result = await server.consumeUcpPravaPaymentResult(
        55,
        "11111111-1111-4111-8111-111111111111"
      );
      assert.equal(result.status, "PAYMENT_PROCESSING");
      assert.equal(result.credentialIssued, false);
      assert.equal(result.nextAction.type, "prava_card_approval");
      assert.notEqual(result.status, "AWAITING_RESULT");
    } finally {
      Object.assign(payments, {
        getPaymentResult: originals.getPaymentResult,
      });
      Object.assign(db, {
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

  const checkoutContext = {
    channel: "telegram",
    userId: 42,
    chatId: "7783253227",
    checkoutId: "11111111-1111-4111-8111-111111111111",
    botUsername: "TokkoShopperBot",
    stage: "ucp_payment",
  };
  const checkoutReturn = new URL(
    server.pravaReturnCallback("card", checkoutContext)
  );
  assert.equal(checkoutReturn.searchParams.get("channel"), "telegram");
  assert.equal(checkoutReturn.searchParams.has("bot"), false);
  assert.equal(checkoutReturn.searchParams.has("flow"), false);
  const checkoutState = checkoutReturn.searchParams.get("state");
  const verifiedCheckout = server.verifyTelegramPravaReturnToken(
    checkoutState
  );
  assert.equal(verifiedCheckout.userId, 42);
  assert.equal(verifiedCheckout.chatId, "7783253227");
  assert.equal(verifiedCheckout.checkoutId, checkoutContext.checkoutId);
  assert.equal(verifiedCheckout.stage, "ucp_payment");
  const bridge = new URL(server.telegramPravaBridgeUrl(checkoutState));
  assert.equal(
    bridge.origin,
    "https://telegram-hermes-bridge.vercel.app"
  );
  assert.equal(bridge.pathname, "/api/prava_return");
  assert.equal(bridge.searchParams.has("start"), false);

  const now = Date.parse("2026-08-04T00:00:00.000Z");
  const expiring = server.telegramPravaReturnToken(checkoutContext, {
    now,
    ttlMs: 60_000,
  });
  assert.equal(
    server.verifyTelegramPravaReturnToken(expiring, { now: now + 1_000 })
      .botUsername,
    "TokkoShopperBot"
  );
  assert.throws(
    () => server.verifyTelegramPravaReturnToken(
      expiring,
      { now: now + 60_001 }
    ),
    /expired/
  );
  assert.throws(
    () => server.verifyTelegramPravaReturnToken(`${expiring}x`, { now }),
    /invalid/
  );

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

test("Telegram bot username diagnostics identify the selected source and rejection reason", { concurrency: false }, () => {
  const original = process.env.TELEGRAM_BOT_USERNAME;
  try {
    process.env.TELEGRAM_BOT_USERNAME = "@TokkoEnvironmentBot";
    const diagnostic = server.telegramBotUsernameDiagnostic(
      "Tokko display name",
      "env.TELEGRAM_BOT_USERNAME"
    );
    assert.equal(diagnostic.valid, false);
    assert.equal(diagnostic.endsWithBot, false);
    assert.equal(diagnostic.allowedCharacters, false);
    assert.equal(diagnostic.preview, "Tokko?display?name");

    assert.equal(
      server.telegramBotUsernameFromBody(
        { botUsername: "   " },
        { traceId: "trace-source-test", route: "test" }
      ),
      "TokkoEnvironmentBot"
    );

    assert.throws(
      () => server.telegramBotUsername("Tokko display name", {
        source: "env.TELEGRAM_BOT_USERNAME",
        traceId: "trace-invalid-test",
      }),
      (error) => {
        assert.equal(error.code, "invalid_telegram_bot_username");
        assert.equal(error.publicDetails.source, "env.TELEGRAM_BOT_USERNAME");
        assert.equal(error.publicDetails.endsWithBot, false);
        return true;
      }
    );
  } finally {
    if (original === undefined) {
      delete process.env.TELEGRAM_BOT_USERNAME;
    } else {
      process.env.TELEGRAM_BOT_USERNAME = original;
    }
  }
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
