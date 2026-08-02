const { test, expect } = require("@playwright/test");

test("signup finalizes locally when Clerk reports the OTP was already verified", async ({ page }) => {
  let authenticated = false;
  let signupCalls = 0;
  let verifyPayload = null;

  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("login"));
    window.__tokkoClerkEmail = {
      async start() {
        return { signUpId: "sua_browser123456789" };
      },
      async resend({ signUpId }) {
        return { signUpId };
      },
      async verify({ signUpId, code }) {
        window.__tokkoVerifiedEmailCode = code;
        throw {
          errors: [{
            code: "verification_already_verified",
            longMessage: "This verification has already been verified.",
          }],
        };
      },
    };
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
      if (!authenticated) return json({ error: "Authentication required" }, 401);
      return json({
        account: { email: "new.shopper@example.com" },
        profileComplete: false,
        merchantConnected: false,
        profile: {
          primaryParentName: "",
          primaryParentPhone: "",
          dependents: [],
        },
        paymentMethods: [],
      });
    }
    if (path === "/api/auth/signup") {
      signupCalls += 1;
      return json({
        verificationRequired: true,
        challengeId: "signup_browser_challenge_123456789",
        email: "ne*********@example.com",
        expiresInSeconds: 600,
      }, 202);
    }
    if (path === "/api/auth/signup/verify") {
      verifyPayload = request.postDataJSON();
      authenticated = true;
      return json({
        account: { email: "new.shopper@example.com" },
      }, 201);
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "New to Tokko? Create an account" }).click();
  await page.getByLabel("Email").fill("new.shopper@example.com");
  await page.getByLabel("Password").fill("TokkoEmailOtp!2026");
  await page.getByRole("button", { name: "Send email code" }).click();

  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByText("ne*********@example.com", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Six-digit email code")).toBeVisible();
  expect(signupCalls).toBe(1);
  expect(authenticated).toBe(false);

  await page.getByLabel("Six-digit email code").fill("123456");
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
  expect(verifyPayload).toEqual({
    challengeId: "signup_browser_challenge_123456789",
    email: "new.shopper@example.com",
    clerkSignUpId: "sua_browser123456789",
  });
  expect(await page.evaluate(() => window.__tokkoVerifiedEmailCode)).toBe("123456");
  expect(authenticated).toBe(true);
});

test("signup resumes a verified Clerk attempt after a browser refresh", async ({ page }) => {
  let authenticated = false;
  let verifyPayload = null;

  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("login"));
    window.__tokkoClerkEmail = {
      async start() {
        return {
          signUpId: "sua_resumed123456789",
          alreadyVerified: true,
        };
      },
      async resend({ signUpId }) {
        return { signUpId };
      },
      async verify() {
        throw new Error("A resumed verified signup must not request another OTP");
      },
    };
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
      if (!authenticated) return json({ error: "Authentication required" }, 401);
      return json({
        account: { email: "resumed@example.com" },
        profileComplete: false,
        merchantConnected: false,
        profile: {
          primaryParentName: "",
          primaryParentPhone: "",
          dependents: [],
        },
        paymentMethods: [],
      });
    }
    if (path === "/api/auth/signup") {
      return json({
        verificationRequired: true,
        challengeId: "signup_resumed_challenge_123456789",
        email: "re*****@example.com",
        expiresInSeconds: 600,
      }, 202);
    }
    if (path === "/api/auth/signup/verify") {
      verifyPayload = request.postDataJSON();
      authenticated = true;
      return json({ account: { email: "resumed@example.com" } }, 201);
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "New to Tokko? Create an account" }).click();
  await page.getByLabel("Email").fill("resumed@example.com");
  await page.getByLabel("Password").fill("TokkoEmailOtp!2026");
  await page.getByRole("button", { name: "Send email code" }).click();

  await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
  await expect(page.getByLabel("Six-digit email code")).toHaveCount(0);
  expect(verifyPayload).toEqual({
    challengeId: "signup_resumed_challenge_123456789",
    email: "resumed@example.com",
    clerkSignUpId: "sua_resumed123456789",
  });
});

test("existing-account login remains password-only", async ({ page }) => {
  let loginPayload = null;
  let authenticated = false;

  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("login"));
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
      if (!authenticated) return json({ error: "Authentication required" }, 401);
      return json({
        account: { email: "existing@example.com" },
        profileComplete: true,
        merchantConnected: false,
        merchantConsent: { consented: false },
        profile: {
          primaryParentName: "Existing Shopper",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods: [],
      });
    }
    if (path === "/api/auth/login") {
      loginPayload = request.postDataJSON();
      authenticated = true;
      return json({ account: { email: "existing@example.com" } });
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("existing@example.com");
  await page.getByLabel("Password").fill("ExistingPassword!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Good morning, Existing/ })).toBeVisible();
  await expect(page.getByLabel("Six-digit email code")).toHaveCount(0);
  expect(loginPayload).toEqual({
    email: "existing@example.com",
    password: "ExistingPassword!2026",
  });
});

test("existing account can sign in with a linked phone and password", async ({ page }) => {
  let loginPayload = null;
  let authenticated = false;

  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("login"));
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
      if (!authenticated) return json({ error: "Authentication required" }, 401);
      return json({
        account: { email: "family@example.com" },
        profileComplete: true,
        merchantConnected: false,
        merchantConsent: { consented: false },
        profile: {
          primaryParentName: "Family Shopper",
          primaryParentPhone: "+919876543210",
          merchantAuthSubjectType: "account_holder",
          merchantAuthPhone: "+919876543210",
          dependents: [],
        },
        paymentMethods: [],
      });
    }
    if (path === "/api/auth/login") {
      loginPayload = request.postDataJSON();
      authenticated = true;
      return json({ account: { email: "family@example.com" } });
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Phone number", exact: true }).click();
  await page.getByLabel("Login country code").selectOption("+91");
  await page.getByLabel("Login phone number").fill("98765 43210");
  await page.getByLabel("Password").fill("ExistingPassword!2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByRole("heading", { name: /Good morning, Family/ })).toBeVisible();
  expect(loginPayload).toEqual({
    phone: "+919876543210",
    password: "ExistingPassword!2026",
  });
});
