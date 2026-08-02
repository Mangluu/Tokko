const { test, expect } = require("@playwright/test");

test("saved card can start a real Prava mandate approval", async ({ page }) => {
  let createPayload;
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("mandates"));
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
    if (path === "/api/payments/mandates" && request.method() === "GET") {
      return json({ mandates: [] });
    }
    if (path === "/api/payments/mandates/session") {
      createPayload = request.postDataJSON();
      return json({
        provider: "prava",
        sessionId: "sess_mandate_browser",
        approvalUrl: "https://pay.prava.space/approve/test-mandate",
        authorizeOnly: true,
        amount: "1000.00",
        currency: "INR",
        frequency: "monthly",
      }, 201);
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Prava mandate" })).toBeVisible();
  await expect(page.locator("body")).toContainText("VISA •••• 4242");
  await page.getByRole("button", { name: "₹1000" }).click();
  await page.getByRole("button", { name: "Create and approve mandate" }).click();
  await expect(page.getByRole("link", { name: "Open Prava approval" })).toHaveAttribute(
    "href",
    "https://pay.prava.space/approve/test-mandate"
  );
  await expect(page.getByRole("link", { name: "Open Prava approval" })).toHaveAttribute(
    "target",
    "_self"
  );
  expect(createPayload).toEqual({
    paymentMethodId: "card-1",
    amount: 1000,
    frequency: "monthly",
    returnContext: { channel: "web", page: "mandates" },
  });
});

test("multiple active mandates are shown as one cumulative balance", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("mandates"));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
        mandates: [
          {
            id: "mandate-50",
            status: "active",
            state: "available",
            frequency: "monthly",
            merchantName: "Zepto",
            approvedAmount: "50.00",
            remaining: "50.00",
            currency: "INR",
          },
          {
            id: "mandate-100",
            status: "active",
            state: "available",
            frequency: "monthly",
            merchantName: "Zepto",
            approvedAmount: "100.00",
            remaining: "100.00",
            currency: "INR",
          },
        ],
      });
    }
    if (path === "/api/orders") return json({ orders: [] });
    if (path === "/api/checkout/activity") {
      return json({ checkoutFlows: [] });
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "2 active Zepto mandates" })
  ).toBeVisible();
  await expect(page.getByText("Combined available").locator("..")).toContainText(
    "₹150"
  );
  await expect(page.getByText("Total authorized").locator("..")).toContainText(
    "₹150"
  );
  await expect(page.locator(".active-mandate-breakdown")).toContainText("₹50");
  await expect(page.locator(".active-mandate-breakdown")).toContainText("₹100");

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".mandate-summary")).toContainText("₹150");
});

test("mandates default to five and open one-month history in a separate tab", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("mandates"));
  });
  const currentMandates = Array.from({ length: 5 }, (_, index) => ({
    id: `mandate-${index + 1}`,
    status: "active",
    state: "available",
    frequency: "monthly",
    merchantName: "Zepto",
    approvedAmount: "100.00",
    remaining: "100.00",
    currency: "INR",
    createdAt: `2026-07-${String(31 - index).padStart(2, "0")}T12:00:00.000Z`,
  }));
  const historyMandates = [
    ...currentMandates,
    {
      id: "mandate-6",
      status: "paused",
      frequency: "weekly",
      merchantName: "OZiva",
      approvedAmount: "250.00",
      remaining: "200.00",
      currency: "INR",
      updatedAt: "2026-07-10T12:00:00.000Z",
    },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/me") {
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
    if (url.pathname === "/api/payments/payment-methods") {
      return json({ paymentMethods: [] });
    }
    if (url.pathname === "/api/payments/mandates") {
      if (url.searchParams.get("view") === "history") {
        return json({
          view: "history",
          mandates: historyMandates,
          totalCount: 6,
          displayedCount: 6,
          hasMore: false,
          historyDays: 30,
        });
      }
      return json({
        view: "summary",
        mandates: currentMandates,
        summary: {
          totalCount: 7,
          activeCount: 7,
          approvedAmount: 700,
          remaining: 700,
          currency: "INR",
          frequency: "monthly",
          merchantName: "Zepto",
        },
        totalCount: 7,
        displayedCount: 5,
        hasMore: true,
        historyDays: 30,
      });
    }
    return json({ error: `Unhandled mocked route: ${url.pathname}` }, 404);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "7 active Zepto mandates" })).toBeVisible();
  await expect(page.locator(".active-mandate-breakdown > div")).toHaveCount(5);
  await expect(page.locator(".mandate-list-footer")).toContainText(
    "Showing 5 of 7 active mandates"
  );
  await expect(page.getByText("Combined available").locator("..")).toContainText("₹700");

  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.getByRole("tab", { name: "30-day history" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.locator(".mandate-history-list > div")).toHaveCount(6);
  await expect(page.locator(".mandate-history-card")).toContainText("OZiva");
});
