const { test, expect } = require("@playwright/test");

test("switching delivery country asks before clearing an incompatible cart", async ({
  page,
}) => {
  const selectionBodies = [];
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("assistant"));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(body),
    });
    if (path === "/api/me") return json({
      account: { email: "address-switch@example.com" }, profileComplete: true,
      profile: { primaryParentName: "Shopper", primaryParentPhone: "+919876543210", dependents: [] },
      paymentMethods: [],
    });
    if (path === "/api/orders") return json({ orders: [] });
    if (path === "/api/checkout/activity") return json({ checkoutFlows: [] });
    if (path === "/api/addresses" && request.method() === "GET") return json({
      addresses: [
        { id: "301", label: "Kolkata", countryCode: "IN", formattedAddress: "Park Street, Kolkata", selected: true },
        { id: "302", label: "New York", countryCode: "US", formattedAddress: "Broadway, New York", selected: false },
      ],
      selectedAddress: { id: "301", label: "Kolkata", countryCode: "IN", formattedAddress: "Park Street, Kolkata" },
    });
    if (path === "/api/addresses/select") {
      const body = request.postDataJSON();
      selectionBodies.push(body);
      if (body.addressId === "302" && body.replaceCart !== true) return json({
        error: "The India cart is incompatible with this US address.",
        code: "cart_delivery_country_conflict",
        conflict: { cartCountry: "IN", targetCountry: "US", currentMerchantName: "Himalaya Wellness" },
      }, 409);
      return json({ selected: true, cartCleared: body.replaceCart === true, selectedAddress: { id: body.addressId } });
    }
    return json({});
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto("/");
  await page.locator(".shopper-address-options label").filter({ hasText: "New York" }).click();
  await expect(page.getByText(/selected and the incompatible cart was cleared/i)).toBeVisible();
  expect(selectionBodies).toEqual([
    { addressId: "302" },
    { addressId: "302", replaceCart: true },
  ]);
});

test("country-incompatible cart can be cleared and the original search is retried", async ({
  page,
}) => {
  let searchCalls = 0;
  let cartClears = 0;
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("assistant"));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    if (path === "/api/me") return json({
      account: { email: "country-switch@example.com" },
      profileComplete: true,
      profile: { primaryParentName: "Test Shopper", primaryParentPhone: "+919876543210", dependents: [] },
      paymentMethods: [],
    });
    if (path === "/api/orders") return json({ orders: [] });
    if (path === "/api/checkout/activity") return json({ checkoutFlows: [] });
    if (path === "/api/addresses" && request.method() === "GET") return json({
      addresses: [{
        id: "201",
        label: "New York",
        formattedAddress: "12 Broadway, New York, NY 10004",
        countryCode: "US",
        selected: true,
      }],
      selectedAddress: {
        id: "201",
        label: "New York",
        formattedAddress: "12 Broadway, New York, NY 10004",
        countryCode: "US",
      },
    });
    if (path === "/api/addresses/select") return json({
      selected: true,
      selectedAddress: { id: "201", label: "New York", countryCode: "US" },
    });
    if (path === "/api/merchants/ucp/cart" && request.method() === "DELETE") {
      cartClears += 1;
      return json({ removedCount: 1, cart: { itemCount: 0, items: [], merchantGroups: [] } });
    }
    if (path === "/api/hermes/chat") {
      searchCalls += 1;
      if (searchCalls === 1) return json({
        message: "Your India cart is incompatible with the selected US address.",
        cartSummary: {
          itemCount: 1,
          items: [{ id: "50", productName: "Neem Face Wash", quantity: 1 }],
          merchantGroups: [{ merchant: "himalayawellness", merchantName: "Himalaya Wellness" }],
        },
        cartCountryConflict: {
          code: "cart_delivery_country_conflict",
          cartCountry: "IN",
          targetCountry: "US",
          retryQuery: "men's face wash",
        },
      });
      return json({
        message: "i found one preferred option for men's face wash.",
        productChoices: [{
          choiceId: "44444444-4444-4444-8444-444444444444",
          selectionToken: "signed-us-choice",
          merchant: "global_ucp",
          merchantName: "US Wellness",
          market: "US",
          productName: "Men's Daily Face Wash",
          variantName: "150 ml",
          price: 12,
          currency: "USD",
          available: true,
          imageUrl: "https://cdn.example/us-face-wash.jpg",
        }],
      });
    }
    return json({});
  });

  await page.goto("/");
  await page.locator(".shopper-address-options label").filter({ hasText: "New York" }).click();
  await page.getByLabel("Message Tokko").fill("men's face wash");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Cart does not match this delivery country")).toBeVisible();
  await page.getByRole("button", { name: "Clear Cart & Retry" }).click();
  await expect(page.getByText("Men's Daily Face Wash")).toBeVisible();
  expect(cartClears).toBe(1);
  expect(searchCalls).toBe(2);
});

test("personal shopper shows a quote, confirms price, and opens only Prava", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("assistant"));
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    if (path === "/api/me") {
      return json({
        account: { email: "shopper@example.com" },
        profileComplete: true,
        merchantConnected: false,
        profile: {
          primaryParentName: "Test Shopper",
          primaryParentPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods: [],
      });
    }
    if (path === "/api/orders") return json({ orders: [] });
    if (path === "/api/checkout/activity") return json({ checkoutFlows: [] });
    if (path === "/api/addresses" && request.method() === "GET") {
      return json({
        addresses: [{
          id: "101",
          label: "Parents",
          formattedAddress: "12 Park Street, Kolkata 700016",
          selected: true,
        }],
        selectedAddress: {
          id: "101",
          label: "Parents",
          formattedAddress: "12 Park Street, Kolkata 700016",
        },
      });
    }
    if (path === "/api/addresses/select") {
      expect(request.postDataJSON()).toEqual({ addressId: "101" });
      return json({
        selectedAddress: {
          id: "101",
          label: "Parents",
          formattedAddress: "12 Park Street, Kolkata 700016",
        },
      });
    }
    if (path === "/api/hermes/chat") {
      return json({
        message: "i found these live wellness options, grouped by delivery market and currency, with the lowest price first inside each group.",
        tools: [{ name: "search_wellness_merchants", status: "completed" }],
        productQuery: "ashwagandha",
        productPagination: { offset: 0, limit: 50, nextOffset: 2, hasMore: true },
        productChoices: [
          {
            choiceId: "11111111-1111-4111-8111-111111111111",
            merchant: "himalayawellness",
            merchantName: "Himalaya Wellness",
            productName: "Ashwagandha",
            variantName: "60 N",
            optionText: "60 N",
            price: 260,
            currency: "INR",
            available: true,
            imageUrl: "https://cdn.example/ashwagandha.jpg",
            selectionToken: "signed-lowest-selection",
          },
          {
            choiceId: "22222222-2222-4222-8222-222222222222",
            merchant: "oziva",
            merchantName: "OZiva",
            productName: "Ashwagandha Plus",
            variantName: "60 capsules",
            optionText: "60 capsules",
            price: 499,
            currency: "INR",
            available: true,
            imageUrl: "https://cdn.example/ashwagandha-plus.jpg",
            selectionToken: "signed-second-selection",
          },
        ],
      });
    }
    if (path === "/api/merchants/ucp/search") {
      const body = request.postDataJSON();
      expect(body).toEqual({ query: "ashwagandha", limit: 10, offset: 2 });
      return json({
        query: "ashwagandha",
        products: [{
          merchant: "oziva",
          merchantName: "OZiva",
          productName: "Ashwagandha Gummies",
          variantName: "30 gummies",
          price: 599,
          currency: "INR",
          available: true,
          imageUrl: "https://cdn.example/ashwagandha-gummies.jpg",
          selectionToken: "signed-third-selection",
        }],
        merchants: [],
        pagination: { offset: 2, limit: 50, nextOffset: 3, hasMore: false },
      });
    }
    if (path === "/api/merchants/ucp/cart/items") {
      expect(request.postDataJSON().choiceId).toBe("11111111-1111-4111-8111-111111111111");
      return json({
        added: true,
        cart: {
          itemCount: 1,
          lockedMerchant: "himalayawellness",
          items: [{ id: "41", productName: "Ashwagandha", variantName: "60 N", quantity: 1 }],
          merchantGroups: [{ merchant: "himalayawellness", merchantName: "Himalaya Wellness" }],
        },
      }, 201);
    }
    if (path === "/api/merchants/ucp/cart/checkout") {
      return json({
        orderId: "33333333-3333-4333-8333-333333333333",
        merchant: "himalayawellness",
        merchantName: "Himalaya Wellness",
        currency: "INR",
        totalAmount: "267.80",
        quote: {
          totals: [
            { type: "subtotal", label: "Items", amountMinor: 21100 },
            { type: "fulfillment", label: "Shipping", amountMinor: 4900 },
            { type: "forex", label: "Foreign exchange charge (3%)", amountMinor: 780 },
            { type: "total", label: "Total payable", amountMinor: 26780 },
          ],
          shippingQuoted: true,
          deliveryWindow: { description: "Standard", earliest: "3 days", latest: "5 days" },
          forex: {
            returnedByMerchant: false,
            appliedByTokko: true,
            ratePercent: 3,
            baseAmountMinor: 26000,
            amountMinor: 780,
            lines: [],
          },
          reconciles: true,
        },
      }, 201);
    }
    if (path.endsWith("/decision")) {
      expect(request.postDataJSON()).toEqual({ proceed: true });
      return json({
        paymentOptions: {
          eligibleMandates: [],
          eligibleMandateCount: 0,
          recommendedMandate: null,
          savedCards: [{ id: "7", brand: "visa", last4: "4242", isDefault: true }],
        },
      });
    }
    if (path.endsWith("/payment")) return json({
      tokenIssued: false,
      pravaCheckoutUrl: "https://collect.prava.space/session-test",
      nextAction: {
        type: "prava_card_approval",
        label: "Approve Card With Prava",
        url: "https://collect.prava.space/session-test",
      },
    });
    return json({});
  });

  await page.goto("/");
  await expect(page.getByText("India + US wellness UCPs")).toBeVisible();
  await expect(page.getByText("Choose delivery address", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message Tokko")).toBeEnabled();
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByLabel("Delivery country code")).toBeVisible();
  await page.getByLabel("Delivery country code").selectOption("US");
  await expect(page.getByLabel("Delivery country code")).toHaveValue("US");
  await page.getByLabel("Delivery country code").selectOption("OTHER");
  await expect(page.getByLabel("Other delivery country code")).toBeVisible();
  await page.getByLabel("Other delivery country code").fill("FR");
  await expect(page.getByLabel("Delivery contact country calling code")).toBeVisible();
  await page.getByRole("button", { name: "Close address form" }).click();
  const composerLayout = await page.locator(".shopper-composer").evaluate((composer) => {
    const textarea = composer.querySelector("textarea");
    const actions = composer.querySelector(".shopper-composer-actions");
    return {
      composerWidth: composer.getBoundingClientRect().width,
      textareaWidth: textarea.getBoundingClientRect().width,
      actionCount: actions?.querySelectorAll("button").length || 0,
    };
  });
  expect(composerLayout.textareaWidth).toBeGreaterThan(composerLayout.composerWidth * 0.5);
  expect(composerLayout.actionCount).toBe(3);
  await page.locator(".shopper-address-options label").filter({ hasText: "12 Park Street" }).click();
  await expect(page.getByText(/delivery address confirmed: 12 Park Street/i)).toBeVisible();
  await expect(page.getByLabel("Message Tokko")).toBeEnabled();

  await page.getByRole("button", { name: "Reselect" }).click();
  await expect(page.getByLabel("Message Tokko")).toBeEnabled();
  await page.locator(".shopper-address-options label").filter({ hasText: "12 Park Street" }).click();
  await page.getByLabel("Message Tokko").fill("find ashwagandha");
  await page.getByRole("button", { name: "Send message" }).click();

  const products = page.locator(".ucp-product-card");
  await expect(products).toHaveCount(2);
  await expect(products.first()).toContainText("₹260");
  await expect(products.locator("img")).toHaveCount(2);

  await page.reload();
  await expect(page.getByText("find ashwagandha", { exact: true })).toBeVisible();
  await expect(
    page.getByText("i found these live wellness options, grouped by delivery market and currency, with the lowest price first inside each group.", { exact: true })
  ).toBeVisible();
  await expect(page.getByLabel("Message Tokko")).toBeEnabled();
  await expect(page.locator(".shopper-address-options")).toHaveCount(0);

  await page.getByLabel("Message Tokko").fill("find ashwagandha");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(products).toHaveCount(2);
  await page.getByRole("button", { name: "Show 10 more" }).click();
  await expect(products).toHaveCount(3);
  await products.first().getByRole("button", { name: "Add & review price" }).click();
  await expect(page.getByRole("region", { name: "Current wellness cart" })).toContainText("Ashwagandha");
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Empty Cart" })).toBeVisible();
  await expect(page.getByText("Shipping", { exact: true })).toBeVisible();
  await expect(page.getByText("₹49.00", { exact: true })).toBeVisible();
  await expect(page.getByText("Foreign exchange charge (3%)", { exact: true })).toBeVisible();
  await expect(page.getByText("₹7.80", { exact: true })).toBeVisible();
  await expect(page.getByText("₹267.80", { exact: true })).toBeVisible();
  await expect(page.getByText(/mandate coverage uses the final total payable/i)).toBeVisible();
  await expect(page.getByText(/Standard to 3 days to 5 days/)).toBeVisible();
  await expect(page.locator('a[href*="merchant.example"]')).toHaveCount(0);
  const storedHistory = await page.evaluate(() =>
    sessionStorage.getItem("tokko-shopper-session-messages-v1") || ""
  );
  expect(storedHistory).not.toContain("merchant.example");
  await page.getByRole("button", { name: "Proceed With Order" }).click();
  const paymentFlow = page.getByLabel("Choose Prava payment flow");
  await expect(paymentFlow.getByText("Mandates", { exact: true })).toBeVisible();
  await expect(paymentFlow.getByText("Saved Cards", { exact: true })).toBeVisible();
  await paymentFlow.getByText("Saved Cards", { exact: true }).click();
  await page.getByRole("button", { name: /Default Card.*4242/i }).click();
  await expect(
    page.getByRole("link", { name: "Approve Card With Prava" })
  ).toHaveAttribute("href", "https://collect.prava.space/session-test");
});
