const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const targetUrl = process.env.TOKKO_TEST_URL || "http://127.0.0.1:5173";
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const phoneSuffix = String(Date.now() % 100000000).padStart(8, "0");

  try {
    await page.goto(targetUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.setItem("tokko-flow-version", "scroll-v3");
      localStorage.setItem("tokko-view", JSON.stringify("login"));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /create an account/i }).click();
    await page.getByLabel("Email").fill(`tokko.repo.${suffix}@example.com`);
    await page.getByLabel("Password").fill("TokkoBrowserTest!2026");
    await page.getByRole("button", { name: "Create account", exact: true }).click();

    await page.getByLabel("Full name").fill("Tokko Repo Guardian");
    await page.getByLabel("Phone number without country code").fill(`98${phoneSuffix}`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await page.getByRole("button", { name: "Add dependent", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Tokko Repo Mother");
    await page.getByLabel("Relationship").selectOption("Mother");
    await page.getByLabel("Tokko Repo Mother phone").fill(`97${phoneSuffix}`);
    await page.getByRole("button", { name: /save family and continue/i }).click();

    await page.getByRole("heading", { name: "Add the family card" }).waitFor();
    const me = await page.evaluate(() => fetch("/api/me").then((response) => response.json()));
    console.log({
      profile: me.profile?.primaryParentName,
      dependents: me.profile?.dependents?.length,
      consent: me.merchantConsent?.consented,
      paymentConfigured: me.paymentConfigured,
    });
    await page
      .getByRole("button", { name: "Open secure card form", exact: true })
      .click();
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return text.includes("to Allowed Domains in the Prava dashboard")
          || text.includes("Secure card form ready.");
      },
      null,
      { timeout: 30000 }
    );
    const pravaState = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes("Secure card form ready.")
        ? "secure form ready"
        : "allowed-domain recovery shown";
    });
    console.log("PRAVA_STATE", pravaState);
    await page.screenshot({
      path: "/private/tmp/tokko-integrated-card-step.png",
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
