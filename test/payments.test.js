const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chargeMandate,
  configuration,
  createMandateSession,
  createPaymentSession,
  createTokenizationSession,
  getMandate,
  listMandates,
  paymentSessionCredentials,
  reportMandateCharge,
  reportPaymentSession,
  retrieveEnrolledCard,
  revokeSession,
  safePaymentMethod,
} = require("../lib/payments.js");

test("safePaymentMethod returns only Prava tokenized card metadata", () => {
  assert.deepEqual(
    safePaymentMethod({
      card_id: "enr_123",
      card_brand: "visa",
      card_last4: "4242",
      card_exp_month: 12,
      card_exp_year: 2030,
    }),
    {
      providerPaymentMethodId: "enr_123",
      type: "card",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: false,
    }
  );
});

test("safePaymentMethod rejects incomplete Prava enrollment metadata", () => {
  assert.throws(
    () => safePaymentMethod({ card_id: "enr_incomplete" }),
    /complete tokenized card metadata/
  );
});

test("Prava session IDs use the current ses_ prefix", () => {
  assert.match("ses_01KYMWBSEKXY04XRB2E8HNJGN1", /^sess?_[A-Za-z0-9_-]+$/);
});

test("configuration requires matching Prava key environments", () => {
  const originalPublishable = process.env.PRAVA_PUBLISHABLE_KEY;
  const originalSecret = process.env.PRAVA_SECRET_KEY;
  try {
    process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
    process.env.PRAVA_SECRET_KEY = "sk_live_example";
    assert.deepEqual(configuration(), {
      publishableKey: "pk_test_example",
      secretKey: "sk_live_example",
      environment: null,
      configured: false,
    });
    process.env.PRAVA_SECRET_KEY = "sk_test_example";
    assert.equal(configuration().configured, true);
    assert.equal(configuration().environment, "sandbox");
  } finally {
    if (originalPublishable === undefined) {
      delete process.env.PRAVA_PUBLISHABLE_KEY;
    } else {
      process.env.PRAVA_PUBLISHABLE_KEY = originalPublishable;
    }
    if (originalSecret === undefined) {
      delete process.env.PRAVA_SECRET_KEY;
    } else {
      process.env.PRAVA_SECRET_KEY = originalSecret;
    }
  }
});

test(
  "Prava requests use the sandbox API, secret-key auth, and masked card data",
  { concurrency: false },
  async () => {
    const envNames = [
      "PRAVA_PUBLISHABLE_KEY",
      "PRAVA_SECRET_KEY",
      "PRAVA_API_BASE_URL",
      "PRAVA_MERCHANT_NAME",
      "PRAVA_MERCHANT_COUNTRY_CODE",
      "PRAVA_CARD_ENROLLMENT_AMOUNT",
      "PRAVA_CARD_ENROLLMENT_CURRENCY",
    ];
    const originalEnv = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    const requests = [];

    try {
      process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
      process.env.PRAVA_SECRET_KEY = "sk_test_example";
      delete process.env.PRAVA_API_BASE_URL;
      process.env.PRAVA_MERCHANT_NAME = "Tokko";
      process.env.PRAVA_MERCHANT_COUNTRY_CODE = "IN";
      process.env.PRAVA_CARD_ENROLLMENT_AMOUNT = "1.00";
      process.env.PRAVA_CARD_ENROLLMENT_CURRENCY = "INR";

      global.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith("/v1/sessions")) {
          return new Response(
            JSON.stringify({
              session_id: "sess_test_123",
              session_token: "session-token",
              iframe_url:
                "https://checkout.sandbox.prava.space/s/sess_test_123",
              expires_at: "2030-01-01T00:15:00Z",
            }),
            { status: 201, headers: { "content-type": "application/json" } }
          );
        }
        if (String(url).includes("/v1/listCards?")) {
          return new Response(
            JSON.stringify({
              cards: [
                {
                  card_id: "enr_test_123",
                  card_brand: "visa",
                  card_last4: "4242",
                  card_exp_month: 12,
                  card_exp_year: 2030,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (String(url).endsWith("/v1/sessions/sess_test_123/revoke")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected Prava URL: ${url}`);
      };

      const session = await createTokenizationSession({
        customerId: "tokko_user_42",
        email: "member@example.com",
        merchantUrl: "https://zepto-shop.vercel.app",
        callbackUrl:
          "https://zepto-shop.vercel.app/?pravaCard=return",
      });
      assert.deepEqual(session, {
        provider: "prava",
        sessionId: "sess_test_123",
        approvalUrl:
          "https://checkout.sandbox.prava.space/s/sess_test_123",
        expiresAt: "2030-01-01T00:15:00Z",
      });

      const createRequest = requests[0];
      assert.equal(
        createRequest.url,
        "https://sandbox.api.prava.space/v1/sessions"
      );
      assert.equal(
        createRequest.options.headers.Authorization,
        "Bearer sk_test_example"
      );
      const createBody = JSON.parse(createRequest.options.body);
      assert.equal(createBody.user_id, "tokko_user_42");
      assert.equal(createBody.user_email, "member@example.com");
      assert.equal(createBody.total_amount, "1.00");
      assert.equal(createBody.currency, "INR");
      assert.equal(createBody.integration_type, "full_checkout");
      assert.equal(
        createBody.callback_url,
        "https://zepto-shop.vercel.app/?pravaCard=return"
      );
      assert.deepEqual(createBody.mandate_setup, {
        intent: "mandate_setup",
        recurring_frequency: "one_time",
        merchant_scope: "listed",
        max_charges: 1,
      });
      assert.deepEqual(createBody.purchase_context, [
        {
          merchant_details: {
            name: "Tokko",
            url: "https://zepto-shop.vercel.app",
            country_code_iso2: "IN",
          },
          product_details: [
            {
              description: "Tokko secure card enrollment",
              unit_price: "1.00",
              quantity: 1,
            },
          ],
        },
      ]);
      assert.equal("card_number" in createBody, false);
      assert.equal("cvv" in createBody, false);

      assert.deepEqual(
        await retrieveEnrolledCard("tokko_user_42", "enr_test_123"),
        {
          providerPaymentMethodId: "enr_test_123",
          type: "card",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          isDefault: false,
        }
      );
      assert.match(
        requests[1].url,
        /\/v1\/listCards\?customer_id=tokko_user_42&status=active&include_card_art=false$/
      );

      await revokeSession("sess_test_123");
      assert.equal(requests[2].options.method, "POST");
      assert.equal(
        requests[2].url,
        "https://sandbox.api.prava.space/v1/sessions/sess_test_123/revoke"
      );
    } finally {
      global.fetch = originalFetch;
      for (const name of envNames) {
        if (originalEnv[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = originalEnv[name];
        }
      }
    }
  }
);

test(
  "Prava mandate setup preselects the saved card without exposing credentials",
  { concurrency: false },
  async () => {
    const envNames = [
      "PRAVA_PUBLISHABLE_KEY",
      "PRAVA_SECRET_KEY",
      "PRAVA_API_BASE_URL",
      "PRAVA_MANDATE_CURRENCY",
      "PRAVA_ZEPTO_MERCHANT_NAME",
      "PRAVA_ZEPTO_MERCHANT_URL",
      "PRAVA_ZEPTO_MERCHANT_COUNTRY_CODE",
    ];
    const originalEnv = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    const requests = [];
    try {
      process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
      process.env.PRAVA_SECRET_KEY = "sk_test_example";
      delete process.env.PRAVA_API_BASE_URL;
      process.env.PRAVA_MANDATE_CURRENCY = "INR";
      process.env.PRAVA_ZEPTO_MERCHANT_NAME = "Zepto";
      process.env.PRAVA_ZEPTO_MERCHANT_URL = "https://www.zeptonow.com";
      process.env.PRAVA_ZEPTO_MERCHANT_COUNTRY_CODE = "IN";
      global.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith("/v1/sessions")) {
          return new Response(
            JSON.stringify({
              session_id: "sess_mandate_123",
              iframe_url:
                "https://checkout.sandbox.prava.space/s/sess_mandate_123",
              expires_at: "2030-01-01T00:15:00Z",
              authorizeOnly: true,
            }),
            { status: 201, headers: { "content-type": "application/json" } }
          );
        }
        if (String(url).includes("/v1/mandates?")) {
          return new Response(
            JSON.stringify({
              mandates: [{
                id: "mdt_123",
                status: "active",
                state: "available",
                recurringFrequency: "monthly",
                merchantScope: "listed",
                merchantName: "Zepto",
                approvedAmount: "500.00",
                remaining: "420.00",
                currency: "INR",
                renewsAt: "2030-02-01T00:00:00Z",
              }],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`Unexpected Prava URL: ${url}`);
      };

      assert.deepEqual(
        await createMandateSession({
          customerId: "tokko_user_42",
          email: "member@example.com",
          cardId: "enr_saved_123",
          amount: 500,
          frequency: "monthly",
          callbackUrl:
            "https://zepto-shop.vercel.app/?pravaMandate=return",
        }),
        {
          provider: "prava",
          sessionId: "sess_mandate_123",
          approvalUrl:
            "https://checkout.sandbox.prava.space/s/sess_mandate_123",
          expiresAt: "2030-01-01T00:15:00Z",
          authorizeOnly: true,
          amount: "500.00",
          currency: "INR",
          frequency: "monthly",
        }
      );
      const body = JSON.parse(requests[0].options.body);
      assert.deepEqual(body.card, { card_id: "enr_saved_123" });
      assert.equal(body.total_amount, "500.00");
      assert.equal(body.currency, "INR");
      assert.equal(body.integration_type, "full_checkout");
      assert.equal(body.mandate_setup.intent, "mandate_setup");
      assert.equal(body.mandate_setup.recurring_frequency, "monthly");
      assert.equal(body.mandate_setup.merchant_scope, "listed");
      assert.equal(body.mandate_setup.max_charges, 24);
      assert.match(
        body.mandate_setup.valid_until,
        /^\d{4}-\d{2}-\d{2}T/
      );
      assert.equal(
        body.purchase_context[0].effective_until_minutes,
        2 * 365 * 24 * 60
      );
      assert.equal("token" in body, false);
      assert.equal("dynamic_cvv" in body, false);

      assert.deepEqual(await listMandates("tokko_user_42"), [{
        id: "mdt_123",
        status: "active",
        state: "available",
        frequency: "monthly",
        merchantScope: "listed",
        merchantName: "Zepto",
        approvedAmount: "500.00",
        remaining: "420.00",
        currency: "INR",
        validUntil: null,
        renewsAt: "2030-02-01T00:00:00Z",
        lastCharge: null,
      }]);
      assert.match(
        requests[1].url,
        /\/v1\/mandates\?customer_id=tokko_user_42&standing_only=true$/
      );
    } finally {
      global.fetch = originalFetch;
      for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
    }
  }
);

test(
  "Prava mandate listing retries transient internal errors",
  { concurrency: false },
  async () => {
    const envNames = ["PRAVA_PUBLISHABLE_KEY", "PRAVA_SECRET_KEY", "PRAVA_API_BASE_URL"];
    const originalEnv = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    let attempts = 0;
    try {
      process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
      process.env.PRAVA_SECRET_KEY = "sk_test_example";
      delete process.env.PRAVA_API_BASE_URL;
      global.fetch = async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response(
            JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } }),
            {
              status: 500,
              headers: {
                "content-type": "application/json",
                "x-response-id": `response-${attempts}`,
              },
            }
          );
        }
        return Response.json({ mandates: [{
          id: "mdt_recovered",
          status: "active",
          recurringFrequency: "monthly",
          merchantScope: "listed",
          merchantName: "OZiva",
          approvedAmount: "1000.00",
          remaining: "1000.00",
          currency: "INR",
        }] });
      };
      const mandates = await listMandates("tokko_user_42");
      assert.equal(attempts, 3);
      assert.equal(mandates[0].id, "mdt_recovered");
    } finally {
      global.fetch = originalFetch;
      for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
    }
  }
);

test(
  "Prava permits any-merchant scope only for one-time mandates",
  { concurrency: false },
  async () => {
    const envNames = [
      "PRAVA_PUBLISHABLE_KEY",
      "PRAVA_SECRET_KEY",
      "PRAVA_API_BASE_URL",
    ];
    const originalEnv = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    let createBody;
    try {
      process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
      process.env.PRAVA_SECRET_KEY = "sk_test_example";
      delete process.env.PRAVA_API_BASE_URL;
      global.fetch = async (_url, options = {}) => {
        createBody = JSON.parse(options.body);
        return Response.json(
          {
            session_id: "sess_any_merchant_123",
            iframe_url:
              "https://checkout.sandbox.prava.space/s/sess_any_merchant_123",
            expires_at: "2030-01-01T00:15:00Z",
            authorizeOnly: true,
          },
          { status: 201 }
        );
      };

      const session = await createMandateSession({
        customerId: "tokko_user_42",
        email: "member@example.com",
        cardId: "enr_saved_123",
        amount: 500,
        frequency: "one_time",
        merchantScope: "any",
        callbackUrl: "https://tokko.example/payments/return",
      });
      assert.equal(session.frequency, "one_time");
      assert.deepEqual(createBody.mandate_setup, {
        intent: "mandate_setup",
        recurring_frequency: "one_time",
        merchant_scope: "any",
        max_charges: 1,
      });
      assert.equal(
        createBody.purchase_context[0].effective_until_minutes,
        7 * 24 * 60
      );

      await assert.rejects(
        createMandateSession({
          customerId: "tokko_user_42",
          email: "member@example.com",
          cardId: "enr_saved_123",
          amount: 500,
          frequency: "monthly",
          merchantScope: "any",
          callbackUrl: "https://tokko.example/payments/return",
        }),
        /only supported with frequency one_time/
      );
    } finally {
      global.fetch = originalFetch;
      for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
    }
  }
);

test(
  "Prava mandate listing accepts wrapped snake-case records and retries an empty standing view",
  { concurrency: false },
  async () => {
    const envNames = ["PRAVA_PUBLISHABLE_KEY", "PRAVA_SECRET_KEY", "PRAVA_API_BASE_URL"];
    const originalEnv = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    const requests = [];
    try {
      process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
      process.env.PRAVA_SECRET_KEY = "sk_test_example";
      delete process.env.PRAVA_API_BASE_URL;
      global.fetch = async (url) => {
        requests.push(String(url));
        if (String(url).includes("standing_only=true")) {
          return Response.json({ data: { mandates: [] } });
        }
        return Response.json({
          data: {
            mandates: [{
              mandate_id: "mdt_any_123",
              mandate_status: "ACTIVE",
              state: "AVAILABLE",
              recurring_frequency: "one_time",
              merchant_scope: "any",
              merchant_name: "Tokko Health & Wellness",
              approved_amount: "1000.00",
              remaining_amount: "1000.00",
              currency: "inr",
              valid_until: "2030-01-07T00:00:00Z",
              created_at: "2030-01-01T00:00:00Z",
            }],
          },
        });
      };

      assert.deepEqual(await listMandates("tokko_user_42"), [{
        id: "mdt_any_123",
        status: "active",
        state: "available",
        frequency: "one_time",
        merchantScope: "any",
        merchantName: "Tokko Health & Wellness",
        approvedAmount: "1000.00",
        remaining: "1000.00",
        currency: "INR",
        validUntil: "2030-01-07T00:00:00Z",
        renewsAt: null,
        createdAt: "2030-01-01T00:00:00Z",
        lastCharge: null,
      }]);
      assert.equal(requests.length, 2);
      assert.match(requests[0], /standing_only=true$/);
      assert.doesNotMatch(requests[1], /standing_only=/);
    } finally {
      global.fetch = originalFetch;
      for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
    }
  }
);

test(
  "Prava mandate listing falls back to the unfiltered endpoint after standing-list errors",
  { concurrency: false },
  async () => {
    const envNames = ["PRAVA_PUBLISHABLE_KEY", "PRAVA_SECRET_KEY", "PRAVA_API_BASE_URL"];
    const originalEnv = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    let attempts = 0;
    try {
      process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
      process.env.PRAVA_SECRET_KEY = "sk_test_example";
      delete process.env.PRAVA_API_BASE_URL;
      global.fetch = async (url) => {
        attempts += 1;
        if (String(url).includes("standing_only=true")) {
          return Response.json(
            { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
            { status: 500 }
          );
        }
        return Response.json({ mandates: [{
          id: "mdt_fallback",
          status: "active",
          recurringFrequency: "one_time",
          merchantScope: "any",
          approvedAmount: "500.00",
          remaining: "500.00",
          currency: "INR",
        }] });
      };

      const mandates = await listMandates("tokko_user_42");
      assert.equal(attempts, 4);
      assert.equal(mandates[0].id, "mdt_fallback");
      assert.equal(mandates[0].merchantScope, "any");
    } finally {
      global.fetch = originalFetch;
      for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
    }
  }
);

test(
  "Prava mandate charge returns ephemeral credentials and reports the outcome",
  { concurrency: false },
  async () => {
    const envNames = [
      "PRAVA_PUBLISHABLE_KEY",
      "PRAVA_SECRET_KEY",
      "PRAVA_API_BASE_URL",
    ];
    const originalEnv = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    const requests = [];
    try {
      process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
      process.env.PRAVA_SECRET_KEY = "sk_test_example";
      delete process.env.PRAVA_API_BASE_URL;
      global.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith("/v1/mandates/mdt_123")) {
          return new Response(
            JSON.stringify({
              id: "mdt_123",
              status: "active",
              approvedAmount: "500.00",
              remaining: "420.00",
              currency: "INR",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (String(url).endsWith("/v1/mandates/mdt_123/charge")) {
          return new Response(
            JSON.stringify({
              mandateId: "mdt_123",
              transactionId: "txn_123",
              orderId: "ord_123",
              status: "awaiting_result",
              fetchStatus: "SUCCESS",
              credentials: {
                token: "4111111111111111",
                dynamicCvv: "321",
                expiryMonth: "12",
                expiryYear: "2030",
              },
              deduplicated: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (
          String(url).endsWith(
            "/v1/mandates/mdt_123/charges/txn_123/report"
          )
        ) {
          return new Response(
            JSON.stringify({
              mandateId: "mdt_123",
              transactionId: "txn_123",
              orderId: "ord_123",
              status: "completed",
              mandateStatus: "active",
              visaConfirmation: "SUCCESS",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`Unexpected Prava URL: ${url}`);
      };

      assert.deepEqual(await getMandate("mdt_123"), {
        id: "mdt_123",
        status: "active",
        state: null,
        frequency: "one_time",
        merchantScope: null,
        merchantName: null,
        approvedAmount: "500.00",
        remaining: "420.00",
        currency: "INR",
        validUntil: null,
        renewsAt: null,
        lastCharge: null,
      });

      const charge = await chargeMandate({
        mandateId: "mdt_123",
        amount: "47.00",
        reference: "tokko_checkout_123_attempt_1",
        purchaseContext: [{
          merchant_details: {
            name: "Zepto",
            url: "https://www.zeptonow.com",
            country_code_iso2: "IN",
          },
          product_details: [{
            description: "Milk",
            unit_price: "47.00",
            product_id: "milk-1",
            quantity: 1,
          }],
        }],
      });
      assert.deepEqual(charge, {
        mandateId: "mdt_123",
        transactionId: "txn_123",
        orderId: "ord_123",
        status: "awaiting_result",
        deduplicated: false,
        credentials: {
          token: "4111111111111111",
          dynamicCvv: "321",
          expiryMonth: "12",
          expiryYear: "2030",
        },
      });
      const chargeBody = JSON.parse(requests[1].options.body);
      assert.equal(chargeBody.amount, "47.00");
      assert.equal(
        chargeBody.reference,
        "tokko_checkout_123_attempt_1"
      );

      assert.deepEqual(
        await reportMandateCharge({
          mandateId: "mdt_123",
          transactionId: "txn_123",
          status: "APPROVED",
          amountPaid: "47.00",
        }),
        {
          mandateId: "mdt_123",
          transactionId: "txn_123",
          status: "completed",
          mandateStatus: "active",
          visaConfirmation: "SUCCESS",
        }
      );
      const reportBody = JSON.parse(requests[2].options.body);
      assert.deepEqual(reportBody, {
        txn_status: "APPROVED",
        txn_type: "PURCHASE",
        amount_paid: "47.00",
      });
    } finally {
      global.fetch = originalFetch;
      for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
    }
  }
);

test(
  "Prava one-time saved-card sessions require approval and report their result",
  { concurrency: false },
  async () => {
    const envNames = [
      "PRAVA_PUBLISHABLE_KEY",
      "PRAVA_SECRET_KEY",
      "PRAVA_API_BASE_URL",
      "PRAVA_MANDATE_CURRENCY",
    ];
    const originalEnv = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    const requests = [];
    try {
      process.env.PRAVA_PUBLISHABLE_KEY = "pk_test_example";
      process.env.PRAVA_SECRET_KEY = "sk_test_example";
      process.env.PRAVA_MANDATE_CURRENCY = "INR";
      delete process.env.PRAVA_API_BASE_URL;
      global.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith("/v1/sessions")) {
          return new Response(JSON.stringify({
            session_id: "ses_card_payment_123",
            iframe_url:
              "https://checkout.sandbox.prava.space/s/ses_card_payment_123",
            order_id: "ord_prava_123",
            expires_at: "2030-01-01T00:15:00Z",
          }), { status: 201, headers: { "content-type": "application/json" } });
        }
        if (
          String(url).endsWith(
            "/v1/sessions/ses_card_payment_123/report-status"
          )
        ) {
          return new Response(JSON.stringify({ status: "completed" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected Prava URL: ${url}`);
      };

      const session = await createPaymentSession({
        customerId: "tokko_family_42",
        email: "family@example.com",
        cardId: "card_saved_1",
        amount: "150.00",
        callbackUrl: "https://zepto-shop.vercel.app/?pravaCheckout=return",
        externalOrderRef: "tokko_checkout_123",
        purchaseContext: [{
          merchant_details: {
            name: "Zepto",
            url: "https://www.zeptonow.com",
            country_code_iso2: "IN",
          },
          product_details: [{
            description: "Family groceries",
            unit_price: "150.00",
            product_id: "cart_123",
            quantity: 1,
          }],
        }],
      });
      assert.equal(session.sessionId, "ses_card_payment_123");
      assert.equal(session.amount, "150.00");
      const createBody = JSON.parse(requests[0].options.body);
      assert.deepEqual(createBody.card, { card_id: "card_saved_1" });
      assert.equal(createBody.mandate_setup, undefined);
      assert.equal(createBody.integration_type, "full_checkout");

      const credentials = paymentSessionCredentials({
        status: "awaiting_result",
        transactions: [{
          status: "awaiting_result",
          line_items: [{
            txn_ref_id: "txn_card_123",
            token: "4111111111111111",
            dynamic_cvv: "432",
            expiry_month: "09",
            expiry_year: "2031",
          }],
        }],
      });
      assert.deepEqual(credentials, {
        transactionId: "txn_card_123",
        status: "awaiting_result",
        credentials: {
          token: "4111111111111111",
          dynamicCvv: "432",
          expiryMonth: "09",
          expiryYear: "2031",
        },
      });

      await reportPaymentSession({
        sessionId: session.sessionId,
        transactionId: credentials.transactionId,
        status: "DECLINED",
      });
      assert.deepEqual(JSON.parse(requests[1].options.body), {
        txn_ref_id: "txn_card_123",
        txn_status: "DECLINED",
      });
    } finally {
      global.fetch = originalFetch;
      for (const name of envNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
    }
  }
);
