const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const baseUrl = process.env.TOKKO_TEST_URL || "https://zepto-shop.vercel.app";
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const phoneSuffix = String(Date.now() % 100000000).padStart(8, "0");

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.setItem("tokko-flow-version", "scroll-v3");
      localStorage.setItem("tokko-view", JSON.stringify("login"));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /create an account/i }).click();
    await page.getByLabel("Email").fill(`tokko.relationship.${suffix}@example.com`);
    await page.getByLabel("Password").fill("TokkoBrowserTest!2026");
    await page.getByRole("button", { name: "Create account", exact: true }).click();

    await page.getByLabel("Full name").fill("Relationship Test Owner");
    await page
      .getByLabel("Phone number without country code")
      .fill(`+91 98${phoneSuffix}`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await page.getByRole("button", { name: "Add dependent", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Relationship Test Member");
    await page
      .locator(".dependent-form-card select")
      .first()
      .selectOption("Other dependent");
    const otherRelationship = page.getByLabel("Relationship Test Member relationship");
    await otherRelationship.waitFor({ state: "visible" });
    await otherRelationship.fill("Cousin");
    await page.getByLabel("Relationship Test Member phone").fill(`097${phoneSuffix}`);
    await page.getByRole("button", { name: /save family and continue/i }).click();

    await page.getByRole("heading", { name: "Add the family card" }).waitFor();
    const state = await page.evaluate(() =>
      fetch("/api/me").then((response) => response.json())
    );
    const relationship = state.profile?.dependents?.[0]?.relationshipToUser;
    if (relationship !== "Cousin") {
      throw new Error(`Expected Cousin to persist, received ${relationship}`);
    }
    const expectedParentPhone = `+9198${phoneSuffix}`;
    if (state.profile?.primaryParentPhone !== expectedParentPhone) {
      throw new Error(
        `Expected ${expectedParentPhone}, received ${state.profile?.primaryParentPhone}`
      );
    }
    console.log({
      fieldVisible: true,
      persistedRelationship: relationship,
      normalizedParentPhone: state.profile.primaryParentPhone,
      productionUrl: baseUrl,
    });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
