const { test, expect } = require("@playwright/test");

test("Hermes shows Prava card approval after mandate routing and continues", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("assistant"));
  });
  let chatCalls = 0;
  let continuationCalls = 0;
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
          merchantAuthPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          dependents: [],
        },
        paymentMethods: [{
          id: 7,
          provider: "prava",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2031,
          isDefault: true,
        }],
      });
    }
    if (path === "/api/config") {
      return json({
        pravaConfigured: true,
        pravaPublishableKey: "pk_test_example",
        hermesConfigured: true,
      });
    }
    if (path === "/api/orders") return json({ orders: [] });
    if (path === "/api/checkout/activity") return json({ checkoutFlows: [] });
    if (path === "/api/payments/payment-methods") {
      return json({ paymentMethods: [] });
    }
    if (path === "/api/payments/mandates") return json({ mandates: [] });
    if (path === "/api/hermes/chat") {
      chatCalls += 1;
      if (chatCalls === 1) {
        return json({
          message:
            "ready to place the cart using mandate first, then prava card, then cash on delivery. good to send?",
          tools: [],
          pendingAction: {
            token: "signed-checkout-action",
            toolName: "checkout_current_cart",
            description:
              "place the current zepto cart using mandate first, then prava card, then cash on delivery",
            expiresInSeconds: 600,
          },
        });
      }
      return json({
        message:
          "i checked 2 prava mandates, but none could cover the full total. i started a normal transaction with the saved card; approve it once with your prava passkey below.",
        tools: [{ name: "checkout_current_cart", status: "completed" }],
        pendingAction: null,
        nextAction: {
          type: "prava_card_approval",
          label: "Approve Card With Prava",
          url: "https://checkout.prava.space/s/ses_test_checkout",
          checkoutId: "11111111-1111-4111-8111-111111111111",
        },
      });
    }
    if (path === "/api/hermes/checkout/continue") {
      continuationCalls += 1;
      return json({
        message:
          "prava approved the normal card transaction and issued a single-use credential. continue with zepto’s secure payment step below.",
        tools: [{ name: "checkout_current_cart", status: "completed" }],
        nextAction: {
          type: "zepto_card_payment",
          label: "Continue To Zepto Payment",
          url: "https://pay.example.test/zepto-order-1",
          checkoutId: "11111111-1111-4111-8111-111111111111",
          paymentHandoff: {
            credentials: {
              token: "4111111111111111",
              dynamicCvv: "321",
              expiryMonth: "12",
              expiryYear: "2031",
            },
          },
        },
      });
    }
    return json({});
  });

  await page.goto("/");
  await page.getByLabel("Message Tokko").fill("place the current cart at home");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Yes, approve" }).click();

  await expect(
    page.getByRole("link", { name: "Approve Card With Prava" })
  ).toHaveAttribute(
    "href",
    "https://checkout.prava.space/s/ses_test_checkout"
  );
  await page.getByRole("button", { name: "I Approved, Continue" }).click();
  await expect(page.getByText("4111111111111111")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue To Zepto Payment" })
  ).toHaveAttribute("href", "https://pay.example.test/zepto-order-1");
  expect(continuationCalls).toBe(1);
});
