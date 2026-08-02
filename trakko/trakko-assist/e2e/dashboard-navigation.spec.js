const { test, expect } = require("@playwright/test");

test("Cards is visible and Alerts opens real account state", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("overview"));
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
          dependents: [{
            id: 9,
            name: "Family Member",
            phone: "+919900112233",
            relationshipToUser: "Mother",
          }],
        },
        paymentMethods: [],
      });
    }
    if (path === "/api/orders") return json({ orders: [] });
    if (path === "/api/checkout/activity") {
      return json({
        checkoutFlows: [{
          id: "failed-checkout",
          status: "CARD_PAYMENT_FAILED",
          cardFailureCount: 1,
          failureMessage: "Card payment was not received.",
        }],
      });
    }
    if (path === "/api/config") {
      return json({
        pravaConfigured: true,
        pravaPublishableKey: "pk_test_example",
      });
    }
    if (path === "/api/payments/payment-methods") {
      return json({ paymentMethods: [] });
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Cards", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Shop on Zepto", exact: true })
  ).toHaveCount(0);
  await page
    .locator(".dashboard-heading")
    .getByRole("button", { name: /Alerts/ })
    .click();
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
  await expect(page.getByText("Payment needs attention")).toBeVisible();
  await expect(page.getByText("No saved card")).toBeVisible();

  await page.getByRole("button", { name: "Cards", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Add the family card" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create secure card session" })
  ).toBeVisible();
});
