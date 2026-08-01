const { test, expect } = require("@playwright/test");

test("Cards shows multiple saved methods and keeps Add another available", async ({ page }) => {
  const paymentMethods = [
    {
      id: 11,
      provider: "prava",
      type: "card",
      brand: "visa",
      last4: "1111",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    },
    {
      id: 12,
      provider: "prava",
      type: "card",
      brand: "mastercard",
      last4: "4444",
      expMonth: 11,
      expYear: 2031,
      isDefault: false,
    },
  ];
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("card"));
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
        account: { email: "cards@example.com" },
        profileComplete: true,
        merchantConnected: true,
        merchantConsent: { consented: true },
        profile: {
          primaryParentName: "Card Owner",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods,
      });
    }
    if (path === "/api/config") {
      return json({
        pravaConfigured: true,
        pravaPublishableKey: "pk_test_example",
      });
    }
    if (path === "/api/payments/payment-methods") {
      return json({ paymentMethods });
    }
    if (
      path === "/api/payments/tokenization-session" &&
      request.method() === "POST"
    ) {
      return json({
        provider: "prava",
        sessionId: "sess_card_browser",
        approvalUrl: "https://checkout.sandbox.prava.space/card/test-session",
        expiresAt: "2030-01-01T00:15:00Z",
      }, 201);
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Saved family cards" })
  ).toBeVisible();
  await expect(page.getByText("VISA •••• 1111")).toBeVisible();
  await expect(page.getByText("MASTERCARD •••• 4444")).toBeVisible();
  await expect(page.getByText("2 saved")).toBeVisible();
  await page.getByRole("button", { name: "Add another card" }).click();
  await expect(
    page.getByRole("button", { name: "Create secure card session" })
  ).toBeVisible();
  await expect(page.locator("#prava-card-element")).toHaveCount(0);
  await page.getByRole("button", { name: "Create secure card session" }).click();
  await expect(
    page.getByRole("link", { name: "Open Prava card setup" })
  ).toHaveAttribute(
    "href",
    "https://checkout.sandbox.prava.space/card/test-session"
  );
  await expect(
    page.getByRole("link", { name: "Open Prava card setup" })
  ).toHaveAttribute("target", "_blank");
  await expect(page.getByText("VISA •••• 1111")).toBeVisible();
  await expect(page.getByText("MASTERCARD •••• 4444")).toBeVisible();
});

test("Prava hosted callback returns to Cards and refreshes masked methods", async ({ page }) => {
  const paymentMethods = [{
    id: 21,
    provider: "prava",
    type: "card",
    brand: "visa",
    last4: "7789",
    expMonth: 12,
    expYear: 2030,
    isDefault: true,
  }];
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("overview"));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    if (path === "/api/me") {
      return json({
        account: { email: "cards@example.com" },
        profileComplete: true,
        merchantConnected: true,
        merchantConsent: { consented: true },
        profile: {
          primaryParentName: "Card Owner",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods,
      });
    }
    if (path === "/api/config") {
      return json({ pravaConfigured: true });
    }
    if (path === "/api/payments/payment-methods") {
      return json({ paymentMethods });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });

  await page.goto("/?pravaCard=return");
  await expect(
    page.getByRole("heading", { name: "Saved family cards" })
  ).toBeVisible();
  await expect(page.getByText("VISA •••• 7789")).toBeVisible();
  await expect(page).not.toHaveURL(/pravaCard=/);
});
