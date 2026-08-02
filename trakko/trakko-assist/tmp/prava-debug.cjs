const { chromium } = require("playwright");

const BASE_URL = "https://zepto-shop.vercel.app";

function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `tokko.prava.debug.${suffix}@example.com`;
  const phoneSuffix = String(Date.now() % 100000000).padStart(8, "0");
  const parentPhone = `+9198${phoneSuffix}`;
  const dependentPhone = `+9197${phoneSuffix}`;

  page.on("response", (response) => {
    if (response.url().includes("prava.space")) {
      console.log("PRAVA_RESPONSE", response.status(), safeUrl(response.url()));
      if (response.url().endsWith("/preview") && response.status() >= 400) {
        response
          .text()
          .then((body) => {
            console.log("PRAVA_PREVIEW_ERROR", {
              responseId: response.headers()["x-response-id"] || null,
              body: body.slice(0, 1000),
            });
          })
          .catch(() => {});
      }
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("prava.space")) {
      console.log(
        "PRAVA_REQUEST_FAILED",
        safeUrl(request.url()),
        request.failure()?.errorText
      );
    }
  });
  page.on("console", (message) => {
    if (/prava|session|preview/i.test(message.text())) {
      console.log("BROWSER_CONSOLE", message.type(), message.text());
    }
  });

  try {
    let response = await context.request.post("/api/auth/signup", {
      data: { email, password: "TokkoBrowserTest!2026" },
    });
    console.log("SIGNUP", response.status());

    response = await context.request.put("/api/onboarding/profile", {
      data: {
        primaryParentName: "Prava Debug Guardian",
        primaryParentPhone: parentPhone,
        dependents: [
          {
            name: "Prava Debug Dependent",
            phone: dependentPhone,
            relationshipToUser: "Child",
          },
        ],
        merchantAuthPhone: parentPhone,
        merchantAuthSubjectType: "account_holder",
      },
    });
    console.log("PROFILE", response.status());

    await page.goto("/", { waitUntil: "domcontentloaded" });
    const details = await page.evaluate(async () => {
      const config = await fetch("/api/config").then((item) => item.json());
      const response = await fetch("/api/payments/tokenization-session", {
        method: "POST",
      });
      const session = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(session));
      document.body.innerHTML = '<div id="prava-debug"></div>';
      const { PravaSDK } = await import("/vendor/prava-sdk.js");
      window.__pravaDebug = { sdk: new PravaSDK({ publishableKey: config.pravaPublishableKey }) };
      window.__pravaDebug.promise = window.__pravaDebug.sdk.collectPAN({
        sessionToken: session.sessionToken,
        iframeUrl: session.iframeUrl,
        container: "#prava-debug",
        onError: (error) => {
          window.__pravaDebug.error = error;
        },
      }).catch((error) => {
        window.__pravaDebug.error = error;
      });
      const iframeUrl = new URL(session.iframeUrl);
      return {
        sessionId: session.sessionId,
        iframeOrigin: iframeUrl.origin,
        iframePath: iframeUrl.pathname,
        expiresAt: session.expiresAt,
      };
    });
    console.log("SESSION", details);

    await page.waitForTimeout(8000);
    console.log(
      "SDK_ERROR",
      await page.evaluate(() => window.__pravaDebug?.error || null)
    );
    await page.screenshot({
      path: "/private/tmp/prava-session-preview.png",
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
