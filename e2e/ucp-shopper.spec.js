const { test, expect } = require("@playwright/test");

test("personal shopper shows lowest-price UCP products and opens merchant checkout", async ({
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
      expect(body).toEqual({ query: "ashwagandha", limit: 50, offset: 2 });
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
    if (path === "/api/merchants/ucp/checkout") {
      const body = request.postDataJSON();
      if (body.selectionToken === "signed-second-selection") {
        return json({
          merchant: "oziva",
          merchantName: "OZiva",
          productName: "Ashwagandha Plus",
          currency: "INR",
          totalAmount: "499.00",
          paymentRoute: "card_selection_required",
          merchantHandoffUrl: "https://merchant.example/checkouts/card-test",
          mandateCheck: {
            checkedMandateCount: 2,
            status: "card_selection_required",
          },
          cardChoices: [{
            id: "7",
            brand: "visa",
            last4: "4242",
            isDefault: true,
            token: "signed-card-choice",
          }],
        }, 201);
      }
      expect(body.selectionToken).toBe("signed-lowest-selection");
      return json({
        merchant: "himalayawellness",
        merchantName: "Himalaya Wellness",
        productName: "Ashwagandha",
        currency: "INR",
        totalAmount: "260.00",
        paymentRoute: "mandate",
        merchantHandoffUrl: "https://merchant.example/checkouts/secure-test",
        paymentUrl: null,
        mandateCheck: {
          checkedMandateCount: 2,
          status: "credential_issued",
        },
        paymentHandoff: {
          mode: "prava_mandate",
          credentials: {
            token: "4111111111111111",
            expiryMonth: "12",
            expiryYear: "2030",
            dynamicCvv: "321",
          },
        },
        totals: [
          { type: "subtotal", label: "Items", amountMinor: 21100 },
          { type: "fulfillment", label: "Shipping", amountMinor: 4900 },
          { type: "total", label: "Total", amountMinor: 26000 },
        ],
        shippingQuoted: true,
        destinationSelected: true,
        phoneAccepted: true,
        reconciles: true,
      }, 201);
    }
    if (path === "/api/merchants/ucp/payment-choice") {
      expect(request.postDataJSON()).toEqual({ token: "signed-card-choice" });
      return json({
        merchant: "oziva",
        merchantName: "OZiva",
        currency: "INR",
        totalAmount: "499.00",
        paymentRoute: "prava_card",
        savedCard: { id: "7", brand: "visa", last4: "4242", isDefault: true },
        nextAction: {
          type: "merchant_ucp_checkout",
          label: "Continue to OZiva checkout",
          url: "https://merchant.example/checkouts/card-test",
          paymentSelection: {
            selected: true,
            route: "prava_card",
            displayLabel: "visa •••• 4242",
            merchantInstrumentSelected: false,
          },
        },
      });
    }
    return json({});
  });

  await page.goto("/");
  await expect(page.getByText("India + US wellness UCPs")).toBeVisible();
  await expect(page.getByText("Choose delivery address", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message Tokko")).toBeDisabled();
  await page.locator(".shopper-address-options label").filter({ hasText: "12 Park Street" }).click();
  await expect(page.getByText(/delivery address confirmed: 12 Park Street/i)).toBeVisible();
  await expect(page.getByLabel("Message Tokko")).toBeEnabled();

  await page.getByRole("button", { name: "Reselect" }).click();
  await expect(page.getByLabel("Message Tokko")).toBeDisabled();
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
  await page.getByRole("button", { name: "Show 50 more" }).click();
  await expect(products).toHaveCount(3);
  await products.first().getByRole("button", { name: "Select & checkout" }).click();

  await expect(
    page.getByRole("link", { name: "Continue to Himalaya Wellness checkout" })
  ).toHaveAttribute("href", "https://merchant.example/checkouts/secure-test");
  await expect(page.getByText("4111111111111111")).toBeVisible();
  await expect(page.getByText("Shipping", { exact: true })).toBeVisible();
  await expect(page.getByText("₹49.00", { exact: true })).toBeVisible();
  await expect(
    page.getByText("https://merchant.example/checkouts/secure-test")
  ).toBeVisible();
  const storedHistory = await page.evaluate(() =>
    sessionStorage.getItem("tokko-shopper-session-messages-v1") || ""
  );
  expect(storedHistory).not.toContain("4111111111111111");

  await products.nth(1).getByRole("button", { name: "Select & checkout" }).click();
  await expect(page.getByRole("button", { name: /visa.*4242/i })).toBeVisible();
  await page.getByRole("button", { name: /visa.*4242/i }).click();
  await expect(
    page.getByRole("link", { name: "Continue to OZiva checkout" })
  ).toHaveAttribute("href", "https://merchant.example/checkouts/card-test");
});
