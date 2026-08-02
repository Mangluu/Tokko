const { test, expect } = require("@playwright/test");

const TEST_PASSWORD = "TokkoBrowserTest!2026";

function testIdentity() {
  const suffix =
    process.env.E2E_RUN_ID ||
    `${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  const phoneSuffix = String(Date.now() % 100_000_000).padStart(8, "0");
  return {
    email: `tokko.browser.${suffix}@example.com`,
    parentPhone: `+9198${phoneSuffix}`,
    dependentPhone: `+9197${phoneSuffix}`,
    secondDependentPhone: `+9196${phoneSuffix}`,
    thirdDependentPhone: `+9195${phoneSuffix}`,
  };
}

test("website signup accepts local phone numbers and account-holder Zepto auth", async ({
  page,
}) => {
  const identity = testIdentity();
  const configResponse = await page.request.get("/api/config");
  const config = await configResponse.json();

  await page.goto("/");
  await expect(page).toHaveTitle("Tokko");
  await expect(page.locator(".login-box h1")).toHaveText("Tokko");
  await expect(page.locator(".login-box h1")).toHaveCSS(
    "color",
    "rgb(109, 40, 217)"
  );
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(248, 245, 252)"
  );
  await expect(
    page.locator('#add-address-form [name="formattedAddress"]')
  ).toHaveCount(0);
  await expect(
    page.locator('#add-address-form [name="buildingName"]')
  ).not.toHaveAttribute("required", "");
  const parsedAddress = await page.evaluate(() =>
    parseMcpAddressText(
      'Found 1 saved address(es):\n\n1. Home: Example Road, Kolkata\n\n---\nAddress IDs:\n1. "Home" → ID: internal-address-id'
    )
  );
  expect(parsedAddress.addresses).toEqual([
    {
      id: "internal-address-id",
      label: "Home",
      formattedAddress: "Example Road, Kolkata",
    },
  ]);
  expect(JSON.stringify(parsedAddress.addresses)).not.toContain("Address IDs:");
  const parsedProduct = await page.evaluate(() =>
    parseMcpProductText(
      'Found 1 product for "milk":\n\n1. Amul Milk - ₹32 (1 pack (500 ml))\n\n---\nProduct IDs:\n[1] pvid: product-1, spid: store-product-1'
    )
  );
  expect(parsedProduct.products).toEqual([
    {
      name: "Amul Milk",
      priceRupees: 32,
      packSize: "1 pack (500 ml)",
      productVariantId: "product-1",
      storeProductId: "store-product-1",
    },
  ]);
  expect(parsedProduct.message).toBeNull();
  const structuredProductCard = await page.evaluate(() => {
    searchResultItems = [
      {
        productVariantId: "product-image-1",
        storeProductId: "store-product-image-1",
        name: "Zepto Structured Milk",
        price: 3000,
        mrp: 3400,
        packSize: "500 ml",
        availableQuantity: 10,
        imageUrl: "https://cdn.zeptonow.com/example/product.jpg",
      },
    ];
    renderProductResults();
    const card = document.querySelector("#search-results .product-card");
    return {
      image: card.querySelector("img")?.src,
      name: card.querySelector(".p-name")?.textContent,
      price: card.querySelector(".p-price")?.textContent,
      availability: card.querySelector(".product-availability")?.textContent,
    };
  });
  expect(structuredProductCard).toEqual({
    image: "https://cdn.zeptonow.com/example/product.jpg",
    name: "Zepto Structured Milk",
    price: "₹30.00",
    availability: "10 available",
  });
  const parsedCart = await page.evaluate(() =>
    parseMcpCartText(
      "🛒 Cart Items (1 item)\n\n      1. Amul Milk - ₹32 (Qty: 2)\n   pvid: product-1, spid: store-product-1"
    )
  );
  expect(parsedCart.items).toEqual([
    {
      name: "Amul Milk",
      label: "Amul Milk",
      priceRupees: 32,
      quantity: 2,
      productVariantId: "product-1",
      storeProductId: "store-product-1",
    },
  ]);
  const onlineOrder = await page.evaluate(() =>
    onlineOrderDetails(
      "Order ID: order-123\nPayment Link: https://pay.example.test/order-123"
    )
  );
  expect(onlineOrder).toEqual({
    orderId: "order-123",
    paymentLink: "https://pay.example.test/order-123",
  });
  expect(
    await page.evaluate(() =>
      paymentStatusFrom("Payment Status: FAILED")
    )
  ).toBe("FAILED");
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.locator('#email-auth-form input[name="email"]').fill(identity.email);
  await page
    .locator('#email-auth-form input[name="password"]')
    .fill(TEST_PASSWORD);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();

  const form = page.locator("#family-profile-form");
  await expect(form).toBeVisible();
  await expect(form.getByRole("button", { name: "Add dependent" })).toBeVisible();
  await expect(form.locator(".dependent-editor")).toHaveCount(1);

  await form
    .locator('[name="primaryParentName"]')
    .fill("Browser Test Guardian");
  await form
    .locator('[name="primaryParentCountryCode"]')
    .selectOption("+91");
  await form
    .locator('[name="primaryParentLocalPhone"]')
    .fill(identity.parentPhone.slice(3));
  const firstDependent = form.locator(".dependent-editor").nth(0);
  await firstDependent
    .locator('[data-dependent-field="name"]')
    .fill("Browser Test Dependent");
  await firstDependent
    .locator('[data-dependent-field="phone"]')
    .fill(identity.dependentPhone.slice(3));
  await firstDependent
    .locator('[data-dependent-field="relationshipToUser"]')
    .selectOption("Other dependent");
  await expect(
    firstDependent.locator('[data-dependent-field="otherRelationship"]')
  ).toBeVisible();
  await firstDependent
    .locator('[data-dependent-field="otherRelationship"]')
    .fill("Niece");

  await form.getByRole("button", { name: "Add dependent" }).click();
  await expect(form.locator(".dependent-editor")).toHaveCount(2);
  const secondDependent = form.locator(".dependent-editor").nth(1);
  await secondDependent
    .locator('[data-dependent-field="name"]')
    .fill("Browser Test Mother");
  await secondDependent
    .locator('[data-dependent-field="phone"]')
    .fill(identity.secondDependentPhone.slice(3));
  await secondDependent
    .locator('[data-dependent-field="relationshipToUser"]')
    .selectOption("Mother");

  await form.locator("[data-account-holder-merchant]").check();
  await expect(page.locator("#merchant-dependent-phone")).toHaveText(
    `(${identity.parentPhone})`
  );
  await form.locator('[name="merchantConsent"]').check();
  await form
    .getByRole("button", { name: "Save details and consent" })
    .click();

  await expect(page.locator("#profile-status")).toHaveText(
    "Details and consent saved."
  );
  await expect(page.locator("#onboarding-family-summary")).toBeVisible();
  await expect(page.locator("#onboarding-family-summary")).toContainText(
    "Browser Test Guardian"
  );
  await expect(page.locator("#onboarding-family-summary")).toContainText(
    "Browser Test Dependent"
  );
  await expect(page.locator("#onboarding-family-summary")).toContainText("Niece");
  await expect(page.locator("#onboarding-family-summary")).toContainText(
    "Browser Test Mother"
  );
  await expect(page.locator("#onboarding-family-summary")).toContainText("Mother");
  await expect(page.locator("#onboarding-family-summary")).toContainText(
    "Selected for Zepto authentication"
  );
  await expect(page.locator("#payment-onboarding")).toBeVisible();
  await expect(page.locator("#merchant-onboarding")).toHaveCount(0);
  await expect(
    page.locator("#onboarding-screen").getByText("Connect Zepto", { exact: true })
  ).toHaveCount(0);
  if (config.pravaConfigured) {
    await expect(page.locator("#payment-controls")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Prava hosted card setup" })
    ).toBeVisible();
  } else {
    await expect(page.locator("#payment-unavailable-note")).toBeVisible();
    await expect(page.locator("#payment-controls")).toBeHidden();
  }

  await page
    .getByRole("button", { name: "Continue to family account" })
    .click();
  await expect(page.locator("#app-screen")).toHaveClass(/active/);
  await expect(page.locator("#view-platforms")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select Zepto", exact: true })
  ).toBeVisible();
  await expect(page.locator('.nav-btn[data-view="search"]')).toBeHidden();
  await expect(page.locator('.nav-btn[data-view="cart"]')).toBeHidden();
  await expect(page.locator('#cart-badge')).toBeHidden();
  await page.getByRole("button", { name: "Family", exact: true }).click();
  await expect(page.locator("#view-family")).toContainText(
    "Browser Test Dependent"
  );

  await page.evaluate(async () => {
    onboardingState.paymentConfigured = true;
    await openCardSetup();
  });
  await expect(page.locator("#onboarding-screen")).toHaveClass(/payment-focus/);
  await expect(page.locator("#payment-onboarding")).toBeVisible();
  await expect(page.locator("#family-onboarding-card")).toBeHidden();
  await expect(page.locator("#onboarding-family-summary")).toBeHidden();
  await expect(page.locator("#onboarding-title")).toHaveText(
    "Your secure shopper wallet"
  );
  await page.waitForTimeout(550);
  await page.screenshot({
    path: "test-results/card-setup-focused.png",
    fullPage: true,
  });
  await page.evaluate(
    (configured) => {
      onboardingState.paymentConfigured = configured;
    },
    config.pravaConfigured
  );
  await page.getByRole("button", { name: "Back to shopper" }).click();
  await expect(page.locator("#view-family")).toBeVisible();

  await page
    .getByRole("button", { name: "Add or manage dependents", exact: true })
    .click();
  await expect(form).toBeVisible();
  await expect(page.locator("#payment-onboarding")).toBeHidden();
  await expect(form.locator(".dependent-editor")).toHaveCount(2);
  await form.getByRole("button", { name: "Add dependent" }).click();
  await expect(form.locator(".dependent-editor")).toHaveCount(3);
  const thirdDependent = form.locator(".dependent-editor").nth(2);
  await thirdDependent
    .locator('[data-dependent-field="name"]')
    .fill("Browser Test Father");
  await thirdDependent
    .locator('[data-dependent-field="phone"]')
    .fill(identity.thirdDependentPhone.slice(3));
  await thirdDependent
    .locator('[data-dependent-field="relationshipToUser"]')
    .selectOption("Father");
  await form
    .getByRole("button", { name: "Save details and consent" })
    .click();
  await expect(page.locator("#profile-status")).toHaveText(
    "Details and consent saved."
  );
  await page.getByRole("button", { name: "Back to shopper", exact: true }).click();
  await page.getByRole("button", { name: "Family", exact: true }).click();
  await expect(page.locator("#view-family")).toContainText(
    "Browser Test Father"
  );
  await page.getByRole("button", { name: "Platforms", exact: true }).click();
  await page.evaluate(() => {
    onboardingState.merchantConnected = true;
    renderZeptoAccount(onboardingState);
  });
  await expect(
    page.getByRole("button", { name: "Reconnect via OTP", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Open Zepto", exact: true }).click();
  await expect(page.locator("#view-search")).toBeVisible();
  await expect(page.locator("#search-address-list")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use current location" })
  ).toBeVisible();
  await page.waitForTimeout(650);
  await page.screenshot({
    path: "test-results/zepto-personal-shopper.png",
    fullPage: true,
  });
  await expect(page.locator("#online-payment-btn")).toHaveText(
    "Pay Online (UPI / Cards / Wallets)"
  );
  await expect(page.locator("#cod-payment-btn")).toHaveText(
    "Cash on Delivery"
  );
  await page.getByRole("button", { name: "Family" }).click();
  if (config.pravaConfigured) {
    await expect(page.locator("#family-payment-summary")).toContainText(
      "No card saved"
    );
  } else {
    await expect(page.locator("#family-payment-summary")).toContainText(
      "Card saving is unavailable"
    );
    await expect(page.locator("#add-tokenized-card-btn")).toBeVisible();
    await expect(page.locator("#add-tokenized-card-btn")).toBeDisabled();
  }

  await page.waitForTimeout(550);
  await page.screenshot({
    path: "test-results/website-onboarding-complete.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(page.locator("#email-auth-form")).toBeVisible();
  await page.locator('#email-auth-form input[name="email"]').fill(identity.email);
  await page
    .locator('#email-auth-form input[name="password"]')
    .fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#view-platforms")).toBeVisible();
  await expect(page.locator('.nav-btn[data-view="search"]')).toBeHidden();
  await page.getByRole("button", { name: "Family", exact: true }).click();
  await expect(page.locator("#view-family")).toBeVisible();
  await expect(page.locator("#view-family")).toContainText(
    "Browser Test Dependent"
  );
  await expect(page.locator("#view-family")).toContainText(
    "Browser Test Mother"
  );
  const restoredState = await page.evaluate(() =>
    fetch("/api/me").then((response) => response.json())
  );
  expect(restoredState.profile.primaryParentPhone).toBe(identity.parentPhone);
  expect(restoredState.profile.merchantAuthSubjectType).toBe("account_holder");
  expect(restoredState.profile.dependents).toHaveLength(3);
});
