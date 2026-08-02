const { test, expect } = require("@playwright/test");

test("cart survives an unreadable refresh and supports address checkout", async ({
  page,
}) => {
  const selectedAddresses = [];
  const savedAddresses = [
    { id: "home-1", label: "Home", addressLine: "12 Park Street, Kolkata" },
    { id: "office-1", label: "Office", addressLine: "Sector V, Salt Lake" },
  ];
  let addedAddressPayload;
  let confirmedOnlineOrders = 0;
  let confirmedOnlinePayload;
  let paymentStatusChecks = 0;
  const paymentHandoff = {
    mode: "prava_mandate",
    provider: "prava",
    mandateId: "mdt-live",
    transactionId: "txn-live",
    amount: "36.50",
    currency: "INR",
    credentials: {
      token: "4111111111111111",
      dynamicCvv: "321",
      expiryMonth: "12",
      expiryYear: "2030",
    },
    card: { brand: "mastercard", last4: "1111" },
    destination: "zepto_secure_payment_link",
    sentToZepto: false,
    requiresManualEntry: true,
    storage: "memory_only",
  };
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("shop"));
    window.__tokkoGeolocationRequests = 0;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(_success, error) {
          window.__tokkoGeolocationRequests += 1;
          error({ message: "User denied Geolocation" });
        },
      },
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path === "/api/me") {
      return json({
        account: { email: "shopper@example.com" },
        profileComplete: true,
        merchantConnected: true,
        merchantConsent: { consented: true },
        profile: {
          primaryParentName: "Test Shopper",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods: [{
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          isDefault: true,
        }],
      });
    }
    if (path === "/api/addresses" && request.method() === "GET") {
      return json({
        data: {
          saved_addresses: {
            items: savedAddresses,
          },
        },
      });
    }
    if (path === "/api/addresses" && request.method() === "POST") {
      addedAddressPayload = request.postDataJSON();
      savedAddresses.push({
        id: "parents-1",
        label: addedAddressPayload.name,
        formattedAddress: `${addedAddressPayload.flatDetails}, ${addedAddressPayload.shortAddress}`,
      });
      return json({ saved: true });
    }
    if (path === "/api/addresses/select") {
      selectedAddresses.push(request.postDataJSON().addressId);
      return json({ selected: true });
    }
    if (path === "/api/search") {
      return json({
        products: [{
          productVariantId: "milk-variant",
          storeProductId: "milk-store",
          name: "Fresh Milk",
          packSize: "500 ml",
          priceRupees: 32,
        }],
      });
    }
    if (path === "/api/cart" && request.method() === "POST") {
      return json({ message: "Cart updated" });
    }
    if (path === "/api/cart") {
      // This reproduces the Zepto response that previously erased the UI cart.
      return json({ message: "Cart response temporarily unavailable" });
    }
    if (path === "/api/payments/payment-methods") {
      return json({
        paymentMethods: [
          {
            id: "card-1",
            brand: "visa",
            last4: "4242",
            expMonth: 12,
            expYear: 2030,
            isDefault: true,
          },
          {
            id: "card-2",
            brand: "mastercard",
            last4: "1111",
            expMonth: 10,
            expYear: 2031,
            isDefault: false,
          },
        ],
      });
    }
    if (path === "/api/payments/mandates") {
      return json({
        mandates: [{
          id: "mdt-live",
          status: "active",
          state: "available",
          frequency: "monthly",
          merchantName: "Zepto",
          approvedAmount: "100.00",
          remaining: "100.00",
          currency: "INR",
        }],
      });
    }
    if (path === "/api/payment-methods") {
      return json({ methods: "Pay Online (UPI / Cards / Wallets), Cash on Delivery" });
    }
    if (path === "/api/order/online") {
      const input = request.postDataJSON();
      if (input.confirmOrder === true) {
        confirmedOnlineOrders += 1;
        confirmedOnlinePayload = input;
        return json({
          orderId: "recovered-order-1",
          paymentLink: "https://pay.example.test/order-1",
          recoveredOrder: {
            id: "recovered-order-1",
            formattedStatus: "CONFIRMED",
          },
          initialPaymentStatus: { status: "PENDING" },
          paymentStatus: "PENDING",
          cardPaymentReceived: false,
          checkoutFlow: {
            id: input.checkoutId,
            status: "CARD_PAYMENT_PENDING",
            cardFailureCount: 0,
            cardPaymentReceived: false,
          },
          paymentHandoff,
        });
      }
      return json({
        amountToPay: 3650,
        priceBreakdown: {
          currency: "INR",
          source: "zepto_mcp",
          lines: [
            { key: "itemTotal", label: "Item total", amountPaise: 3200 },
            { key: "deliveryCharge", label: "Delivery charge", amountPaise: 300 },
            { key: "gst", label: "GST / taxes", amountPaise: 150 },
          ],
          // Reproduces the null value that the browser previously rendered as ₹0.
          totalPaise: null,
        },
        checkoutFlow: {
          id: input.checkoutId,
          status: "REVIEW_CARD",
          cardFailureCount: 0,
        },
        paymentHandoff,
      });
    }
    if (path === "/api/order/payment-status") {
      paymentStatusChecks += 1;
      return json({ status: "PENDING" });
    }
    if (path === "/api/order") {
      return json({
        amountToPay: 3650,
        priceBreakdown: {
          currency: "INR",
          source: "zepto_mcp",
          lines: [
            { key: "itemTotal", label: "Item total", amountPaise: 3200 },
            { key: "deliveryCharge", label: "Delivery charge", amountPaise: 300 },
            { key: "gst", label: "GST / taxes", amountPaise: 150 },
          ],
          totalPaise: 3650,
        },
      });
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Find something for the family" })).toBeVisible();

  await page.getByPlaceholder("Search milk, fruit, snacks…").fill("milk");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Add to cart" }).click();

  const drawer = page.getByRole("dialog", { name: "Shopping cart and checkout" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "1 item" })).toBeVisible();
  await expect(drawer).toContainText("Fresh Milk");
  await expect(drawer.locator(".shop-cart-quantity")).toContainText("1");

  await drawer.getByRole("button", { name: "Add address" }).click();
  const addressDialog = page.getByRole("dialog", { name: "Add delivery address" });
  await expect(addressDialog).toBeVisible();
  await addressDialog.getByLabel("Address type").selectOption("OTHER");
  await addressDialog.getByLabel("Address label").fill("Parents");
  await addressDialog.getByLabel("Flat / House number").fill("House 18");
  await addressDialog.getByLabel("Area, city, and state").fill("Ballygunge, Kolkata, West Bengal");
  await expect(addressDialog.getByLabel("Latitude (optional)")).toBeEmpty();
  await expect(addressDialog.getByLabel("Longitude (optional)")).toBeEmpty();
  await addressDialog.getByRole("button", { name: "Save to Zepto account" }).click();
  await expect(addressDialog).toBeHidden();
  expect(await page.evaluate(() => window.__tokkoGeolocationRequests)).toBe(0);
  await expect(drawer.getByRole("button", { name: /Parents/ })).toHaveClass(/selected/);
  expect(addedAddressPayload).toMatchObject({
    type: "OTHER",
    name: "Parents",
    flatDetails: "House 18",
    shortAddress: "Ballygunge, Kolkata, West Bengal",
    contactNumber: "+919876543210",
  });
  expect(addedAddressPayload).not.toHaveProperty("latitude");
  expect(addedAddressPayload).not.toHaveProperty("longitude");
  expect(selectedAddresses).toContain("parents-1");

  await drawer.getByRole("button", { name: /Office/ }).click();
  await expect(drawer.getByRole("button", { name: /Office/ })).toHaveClass(/selected/);
  expect(selectedAddresses).toContain("office-1");

  await expect(drawer).toContainText("VISA •••• 4242");
  await expect(drawer).toContainText("MASTERCARD •••• 1111");
  await expect(drawer).toContainText("Review every charge before choosing payment");
  await expect(drawer).toContainText("Complete price breakdown");
  await expect(drawer).toContainText("Total payable₹36.50");
  await expect(drawer).toContainText("Mandate mdt-live can cover this total");
  await drawer.getByRole("button", { name: /MASTERCARD •••• 1111/ }).click();
  await expect(drawer.getByRole("button", { name: /MASTERCARD •••• 1111/ })).toHaveClass(/selected/);
  await drawer.getByRole("button", { name: "Pay online" }).click();
  await expect(drawer).toContainText("Confirm online payment");
  await expect(drawer).toContainText("Complete price breakdown");
  await expect(drawer).toContainText("Item total₹32.00");
  await expect(drawer).toContainText("Delivery charge₹3.00");
  await expect(drawer).toContainText("GST / taxes₹1.50");
  await expect(drawer).toContainText("Total payable₹36.50");
  await drawer.getByRole("button", { name: "Confirm order" }).click();
  await expect(drawer.getByRole("link", { name: "Continue to Zepto card payment" })).toHaveAttribute(
    "href",
    "https://pay.example.test/order-1"
  );
  await expect(drawer).toContainText("MASTERCARD •••• 1111");
  await expect(drawer).toContainText(
    "Prava issued this credential for ₹36.50 at Zepto"
  );
  await expect(drawer.locator('input[value="4111111111111111"]')).toBeVisible();
  await expect(drawer.locator('input[value="12/2030"]')).toBeVisible();
  await expect(drawer.locator('input[value="321"]')).toBeVisible();
  await expect(drawer).toContainText("Prava issued a single-use credential");
  expect(confirmedOnlineOrders).toBe(1);
  expect(confirmedOnlinePayload.mandateId).toBe("mdt-live");
  expect(confirmedOnlinePayload).not.toHaveProperty("testCardToken");
  expect(paymentStatusChecks).toBe(0);
  await drawer.getByRole("button", { name: "Check Zepto payment status" }).click();
  await expect(drawer).toContainText("Payment is pending");
  expect(paymentStatusChecks).toBe(1);

  await drawer.getByRole("button", { name: "Close cart" }).click();
  await expect(page.getByRole("button", { name: /1 item View cart/ })).toBeVisible();
});

test("three sandbox Pay online clicks reach terminal failures and request COD consent", async ({
  page,
}) => {
  let sandboxConfirmations = 0;
  let checkoutId = null;

  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("shop"));
    localStorage.setItem("tokko-zepto-cart:+919876543210", JSON.stringify([{
      productVariantId: "milk-variant",
      storeProductId: "milk-store",
      name: "Fresh Milk",
      quantity: 1,
      price: 3200,
      priceRupees: 32,
    }]));
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/me") {
      return json({
        account: { email: "shopper@example.com" },
        profileComplete: true,
        merchantConnected: true,
        merchantConsent: { consented: true },
        profile: {
          primaryParentName: "Test Shopper",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods: [{
          id: "card-1",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          isDefault: true,
        }],
      });
    }
    if (path === "/api/addresses") {
      return json({
        data: {
          saved_addresses: {
            items: [{
              id: "home-1",
              label: "Home",
              addressLine: "12 Park Street, Kolkata",
            }],
          },
        },
      });
    }
    if (path === "/api/cart") {
      return json({
        items: [{
          productVariantId: "milk-variant",
          storeProductId: "milk-store",
          name: "Fresh Milk",
          quantity: 1,
          price: 3200,
        }],
      });
    }
    if (path === "/api/addresses/select") {
      return json({ selected: true });
    }
    if (path === "/api/payments/payment-methods") {
      return json({
        paymentMethods: [{
          id: "card-1",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          isDefault: true,
        }],
      });
    }
    if (path === "/api/payments/mandates") {
      return json({
        mandates: [{
          id: "mdt-sandbox",
          status: "active",
          state: "available",
          merchantName: "Zepto",
          approvedAmount: "100.00",
          remaining: "100.00",
          currency: "INR",
        }],
      });
    }
    if (path === "/api/payment-methods") {
      return json({
        methods: "Pay Online (Cards), Cash on Delivery",
      });
    }
    if (path === "/api/order" && request.method() === "POST") {
      return json({
        amountToPay: 3200,
        priceBreakdown: {
          currency: "INR",
          lines: [{
            key: "itemTotal",
            label: "Item total",
            amountPaise: 3200,
          }],
          totalPaise: 3200,
        },
      });
    }
    if (path === "/api/order/online") {
      const input = request.postDataJSON();
      checkoutId = input.checkoutId;
      if (input.confirmOrder === true) {
        sandboxConfirmations += 1;
        const requiresCod = sandboxConfirmations >= 3;
        return json({
          orderId: `zepto-sandbox-order-${sandboxConfirmations}`,
          paymentStatus: "FAILED",
          sandbox: true,
          sandboxZeptoAttempt: true,
          sandboxTerminal: true,
          cardPaymentReceived: false,
          checkoutFlow: {
            id: checkoutId,
            status: requiresCod
              ? "COD_PERMISSION_REQUIRED"
              : "SANDBOX_ZEPTO_PAYMENT_FAILED",
            sandboxPaymentAttempt: true,
            allowCodFallback: true,
            cardFailureCount: sandboxConfirmations,
            failureMessage: requiresCod
              ? "Card payment was not received after three real attempts. No Cash on Delivery order has been created."
              : "Tokko closed the sandbox payment attempt as failed after Zepto returned pending; no card payment was received.",
          },
          paymentHandoff: null,
          pravaPaymentResult: {
            provider: "prava",
            flow: "mandate_charge",
            mandateId: "mdt-sandbox",
            transactionId: `txn-sandbox-${sandboxConfirmations}`,
            chargeStatus: "DECLINED",
            credentialIssued: true,
            merchantPaymentStatus: "FAILED",
          },
        });
      }
      return json({
        amountToPay: 3200,
        pravaEnvironment: "sandbox",
        priceBreakdown: {
          currency: "INR",
          lines: [{
            key: "itemTotal",
            label: "Item total",
            amountPaise: 3200,
          }],
          totalPaise: 3200,
        },
        checkoutFlow: {
          id: checkoutId,
          status: "REVIEW_CARD",
          cardFailureCount: sandboxConfirmations,
        },
      });
    }
    return json({});
  });

  await page.goto("/");
  await page.getByRole("button", { name: /1 item View cart/ }).click();
  const drawer = page.getByRole("dialog", {
    name: "Shopping cart and checkout",
  });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await drawer.getByRole("button", { name: "Pay online" }).click();
    await expect(drawer).toContainText(
      `Terminal sandbox attempt ${attempt} of 3`
    );
    await expect(drawer).toContainText(
      `"transactionId": "txn-sandbox-${attempt}"`
    );
  }
  await drawer.getByRole("button", { name: "Pay online" }).click();
  await expect(drawer).toContainText("Three card attempts failed");
  await expect(drawer).toContainText(
    "Do you permit Tokko to place this cart with Cash on Delivery now?"
  );
  await expect(
    drawer.getByRole("button", { name: "Yes, place COD order" })
  ).toBeVisible();
  expect(sandboxConfirmations).toBe(3);
});

test("checkout offers the focused Prava card flow when no card is saved", async ({
  page,
}) => {
  let paymentMethodCalls = 0;
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("shop"));
    localStorage.setItem("tokko-zepto-cart:+919876543210", JSON.stringify([{
      productVariantId: "milk-variant",
      storeProductId: "milk-store",
      name: "Fresh Milk",
      quantity: 1,
      priceRupees: 32,
    }]));
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path === "/api/me") {
      return json({
        account: { email: "shopper@example.com" },
        profileComplete: true,
        merchantConnected: true,
        merchantConsent: { consented: true },
        profile: {
          primaryParentName: "Test Shopper",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods: [],
      });
    }
    if (path === "/api/addresses") {
      return json({
        addresses: [{
          id: "home-1",
          label: "Home",
          formattedAddress: "12 Park Street, Kolkata",
        }],
      });
    }
    if (path === "/api/addresses/select") return json({ selected: true });
    if (path === "/api/cart") {
      // A failed merchant payment may transiently return an empty live cart.
      // Tokko must retain its recorded cart until an order ID is confirmed.
      return json({ items: [], isEmpty: true });
    }
    if (path === "/api/payments/payment-methods") {
      paymentMethodCalls += 1;
      return json({
        paymentMethods: paymentMethodCalls >= 2
          ? [{
              id: "reconciled-card",
              brand: "visa",
              last4: "4242",
              expMonth: 12,
              expYear: 2030,
              isDefault: true,
            }]
          : [],
      });
    }
    if (path === "/api/payments/mandates") {
      return json({
        mandates: [{
          id: "mdt-fallback-test",
          status: "active",
          state: "available",
          frequency: "monthly",
          merchantName: "Zepto",
          approvedAmount: "100.00",
          remaining: "100.00",
          currency: "INR",
        }],
      });
    }
    if (path === "/api/payment-methods") {
      return json({ methods: "Cash on Delivery" });
    }
    if (path === "/api/config") {
      return json({
        pravaConfigured: true,
        pravaPublishableKey: "pk_test_browser",
      });
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: /1 item View cart/ }).click();
  const drawer = page.getByRole("dialog", { name: "Shopping cart and checkout" });
  await expect(drawer.getByRole("button", { name: "Add card with Prava" })).toBeVisible();
  await drawer.getByRole("button", { name: "Add card with Prava" }).click();
  await expect(page.getByRole("heading", { name: "Saved family cards" })).toBeVisible();
  await expect(page.locator(".saved-payment-method-list")).toContainText("VISA •••• 4242");
  await expect(page.getByRole("button", { name: "Return to checkout" })).toBeVisible();
});

test("COD keeps the cart until Zepto confirms a new order ID", async ({ page }) => {
  let confirmedAttempts = 0;
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("shop"));
    localStorage.setItem("tokko-zepto-cart:+919876543210", JSON.stringify([{
      productVariantId: "milk-variant",
      storeProductId: "milk-store",
      name: "Fresh Milk",
      quantity: 1,
      priceRupees: 32,
    }]));
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path === "/api/me") {
      return json({
        account: { email: "shopper@example.com" },
        profileComplete: true,
        merchantConnected: true,
        merchantConsent: { consented: true },
        profile: {
          primaryParentName: "Test Shopper",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods: [],
      });
    }
    if (path === "/api/addresses") {
      return json({
        addresses: [{
          id: "home-1",
          label: "Home",
          addressLine: "12 Park Street, Kolkata",
        }],
      });
    }
    if (path === "/api/addresses/select") return json({ selected: true });
    if (path === "/api/cart") {
      return json({ message: "Cart response temporarily unavailable" });
    }
    if (path === "/api/payments/payment-methods") {
      return json({ paymentMethods: [] });
    }
    if (path === "/api/payment-methods") {
      return json({ methods: "Cash on Delivery" });
    }
    if (path === "/api/order") {
      const input = request.postDataJSON();
      if (input.confirmOrder === true) {
        confirmedAttempts += 1;
        return json(
          confirmedAttempts === 1
            ? { orderId: null, orderLookupPending: true }
            : {
                orderId: "cod-order-1",
                recoveredOrder: {
                  id: "cod-order-1",
                  formattedStatus: "CONFIRMED",
                },
              }
        );
      }
      return json({ amountToPay: 3200 });
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: /1 item View cart/ }).click();
  const drawer = page.getByRole("dialog", { name: "Shopping cart and checkout" });
  await drawer.getByRole("button", { name: "Cash on Delivery" }).click();
  await drawer.getByRole("button", { name: "Confirm order" }).click();
  await expect(drawer).toContainText("Your cart was kept");
  await expect(page.getByRole("button", { name: /1 item View cart/ })).toBeVisible();

  await drawer.getByRole("button", { name: "Cash on Delivery" }).click();
  await drawer.getByRole("button", { name: "Confirm order" }).click();
  await expect(drawer).toContainText(
    "Cash on Delivery order cod-order-1 was confirmed by Zepto"
  );
  await expect(page.getByRole("button", { name: /1 item View cart/ })).toHaveCount(0);
  expect(confirmedAttempts).toBe(2);
});

test("three failed card attempts require COD consent and appear on the dashboard", async ({
  page,
}) => {
  let cardAttempts = 0;
  let checkoutId = null;
  let codApproved = false;
  const completedFlow = () => ({
    id: checkoutId,
    status: "COD_FALLBACK_CONFIRMED",
    card: { brand: "visa", last4: "4242" },
    cardFailureCount: 3,
    cardPaymentReceived: false,
    fallbackToCod: true,
    orderId: "cod-fallback-3",
    priceBreakdown: {
      currency: "INR",
      source: "zepto_mcp",
      totalPaise: 3650,
    },
    failureMessage:
      "Card payment was not received after three attempts. Zepto confirmed the Cash on Delivery fallback.",
    updatedAt: "2026-07-29T15:00:00.000Z",
  });

  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("shop"));
    localStorage.setItem("tokko-zepto-cart:+919876543210", JSON.stringify([{
      productVariantId: "milk-variant",
      storeProductId: "milk-store",
      name: "Fresh Milk",
      quantity: 1,
      priceRupees: 32,
    }]));
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path === "/api/me") {
      return json({
        account: { email: "shopper@example.com" },
        profileComplete: true,
        merchantConnected: true,
        merchantConsent: { consented: true },
        profile: {
          primaryParentName: "Test Shopper",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods: [{
          id: "card-1",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          isDefault: true,
        }],
      });
    }
    if (path === "/api/addresses") {
      return json({
        addresses: [{
          id: "home-1",
          label: "Home",
          addressLine: "12 Park Street, Kolkata",
        }],
      });
    }
    if (path === "/api/addresses/select") return json({ selected: true });
    if (path === "/api/cart") {
      return json({ items: [], isEmpty: true });
    }
    if (path === "/api/payments/payment-methods") {
      return json({
        paymentMethods: [{
          id: "card-1",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          isDefault: true,
        }],
      });
    }
    if (path === "/api/payments/mandates") {
      return json({
        mandates: [{
          id: "mdt-fallback-test",
          status: "active",
          state: "available",
          frequency: "monthly",
          merchantName: "Zepto",
          approvedAmount: "100.00",
          remaining: "100.00",
          currency: "INR",
        }],
      });
    }
    if (path === "/api/payment-methods") {
      return json({ methods: "Pay Online (Cards), Cash on Delivery" });
    }
    if (path === "/api/order/online") {
      const input = request.postDataJSON();
      checkoutId = input.checkoutId;
      if (input.confirmOrder !== true) {
        return json({
          priceBreakdown: {
            currency: "INR",
            source: "zepto_mcp",
            lines: [{
              key: "itemTotal",
              label: "Item total",
              amountPaise: 3200,
            }],
            totalPaise: 3650,
          },
          checkoutFlow: {
            id: checkoutId,
            status: "REVIEW_CARD",
            cardFailureCount: 0,
          },
        });
      }
      cardAttempts += 1;
      if (cardAttempts < 3) {
        return json({
          orderId: null,
          paymentStatus: "FAILED",
          cardPaymentReceived: false,
          checkoutFlow: {
            id: checkoutId,
            status: "CARD_PAYMENT_FAILED",
            card: { brand: "visa", last4: "4242" },
            cardFailureCount: cardAttempts,
            cardPaymentReceived: false,
          },
        });
      }
      return json({
        orderId: null,
        paymentStatus: "FAILED",
        cardPaymentReceived: false,
        checkoutFlow: {
          ...completedFlow(),
          status: "COD_PERMISSION_REQUIRED",
          fallbackToCod: false,
          orderId: null,
          failureMessage:
            "Card payment was not received after three real attempts. No Cash on Delivery order has been created.",
        },
      });
    }
    if (path === "/api/order/cod-decision") {
      const input = request.postDataJSON();
      codApproved = input.approve === true;
      return json({
        approved: codApproved,
        orderId: codApproved ? "cod-fallback-3" : null,
        checkoutFlow: codApproved
          ? completedFlow()
          : {
              ...completedFlow(),
              status: "COD_FALLBACK_DECLINED",
              fallbackToCod: false,
              orderId: null,
            },
      });
    }
    if (path === "/api/checkout/activity") {
      return json({ checkoutFlows: codApproved ? [completedFlow()] : [] });
    }
    if (path === "/api/orders") return json({ orders: [] });
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: /1 item View cart/ }).click();
  const drawer = page.getByRole("dialog", { name: "Shopping cart and checkout" });
  await drawer.getByRole("button", { name: "Pay online" }).click();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await drawer.getByRole("button", { name: "Confirm order" }).click();
    await expect(drawer).toContainText(
      `Card payment was not received (attempt ${attempt} of 3)`
    );
    await expect(page.getByRole("button", { name: /1 item View cart/ })).toBeVisible();
  }

  await drawer.getByRole("button", { name: "Confirm order" }).click();
  await expect(drawer).toContainText(
    "Three card attempts failed"
  );
  await expect(drawer).toContainText("Tokko has not created a COD order");
  await expect(page.getByRole("button", { name: /1 item View cart/ })).toBeVisible();
  expect(codApproved).toBe(false);
  await drawer.getByRole("button", { name: "Yes, place COD order" }).click();
  await expect(drawer).toContainText(
    "Cash on Delivery order cod-fallback-3 was confirmed by Zepto after your approval."
  );
  await expect(page.getByRole("button", { name: /1 item View cart/ })).toHaveCount(0);
  expect(codApproved).toBe(true);
  expect(cardAttempts).toBe(3);

  await drawer.getByRole("button", { name: "Close cart" }).click();
  await page.getByRole("button", { name: "Overview" }).click();
  const activity = page.locator(".checkout-activity-section");
  await expect(activity).toContainText("Card payment not received");
  await expect(activity).toContainText("3 of 3 card attempts failed");
  await expect(activity).toContainText("Fallback succeeded · COD order cod-fallback-3");
});
