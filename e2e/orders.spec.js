const { test, expect } = require("@playwright/test");

test("Ask Tokko uses Hermes for Zepto reads and confirms writes", async ({ page }) => {
  let chatCalls = 0;
  const chatLanguages = [];
  const transcriptionLanguages = [];
  const selectedAddresses = [];
  let addedAddressPayload = null;
  const savedAddresses = [{
    id: "home-address-id",
    label: "Home",
    formattedAddress: "12 Park Street, Kolkata",
  }];
  await page.addInitScript(() => {
    localStorage.setItem("tokko-flow-version", "scroll-v3");
    localStorage.setItem("tokko-view", JSON.stringify("dashboard"));
    localStorage.setItem("tokko-dashboard-page", JSON.stringify("assistant"));
    class MockMediaRecorder {
      static isTypeSupported() {
        return true;
      }
      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || "audio/webm";
        this.state = "inactive";
      }
      start() {
        this.state = "recording";
        this.onstart?.();
        setTimeout(() => {
          this.ondataavailable?.({
            data: new Blob(
              ["recorded voice command bytes for browser transcription"],
              { type: this.mimeType }
            ),
          });
          this.stop();
        }, 5);
      }
      stop() {
        if (this.state !== "recording") return;
        this.state = "inactive";
        this.onstop?.();
      }
    }
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: MockMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
    });
    window.__tokkoHermesGeolocationRequests = 0;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition() {
          window.__tokkoHermesGeolocationRequests += 1;
          throw new Error("Hermes must not request browser geolocation");
        },
      },
    });
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
        paymentMethods: [],
      });
    }
    if (path === "/api/addresses" && request.method() === "GET") {
      return json({ addresses: savedAddresses });
    }
    if (path === "/api/addresses" && request.method() === "POST") {
      addedAddressPayload = request.postDataJSON();
      savedAddresses.push({
        id: "parents-address-id",
        label: addedAddressPayload.name,
        formattedAddress: `${addedAddressPayload.flatDetails}, ${addedAddressPayload.shortAddress}`,
      });
      return json({ saved: true, addresses: savedAddresses });
    }
    if (path === "/api/addresses/select") {
      selectedAddresses.push(request.postDataJSON().addressId);
      return json({ selected: true, storeContextActivated: true });
    }
    if (path === "/api/hermes/chat") {
      chatCalls += 1;
      const body = request.postDataJSON();
      chatLanguages.push(body.language);
      const latest = body.messages?.at(-1)?.content || "";
      const reconnectTurn = (body.messages || []).some((message) =>
        /reconnect zepto/i.test(message.content || "")
      );
      if (/^\d{6}$/.test(latest)) {
        return json({
          message: "done, zepto is reconnected.",
          tools: [{ name: "verify_zepto_reconnect", status: "completed" }],
          pendingAction: null,
        });
      }
      if (body.approvalToken) {
        if (reconnectTurn) {
          return json({
            message: "i sent a zepto otp to the selected family phone ending ••••3210. reply here with the six-digit code within 10 minutes.",
            tools: [{ name: "start_zepto_reconnect", status: "completed" }],
            pendingAction: null,
          });
        }
        return json({
          message: "done, i saved home to your linked zepto account.",
          tools: [{ name: "add_saved_address", status: "completed" }],
          pendingAction: null,
        });
      }
      if (/reconnect zepto/i.test(latest)) {
        return json({
          message: "ready to send a zepto login otp. good to send?",
          tools: [],
          pendingAction: {
            token: "signed-reconnect-approval-token",
            toolName: "start_zepto_reconnect",
            description: "send a zepto login otp to the selected family phone",
            expiresInSeconds: 600,
          },
        });
      }
      if (latest.includes("saved addresses")) {
        return json({
          message: "you have one saved address: home, park street, kolkata.",
          tools: [{ name: "list_saved_addresses", status: "completed" }],
          pendingAction: null,
        });
      }
      return json({
        message: "ready to save this address. good to send?",
        tools: [],
        pendingAction: {
          token: "signed-approval-token",
          toolName: "add_saved_address",
          description: "save this address to the linked zepto account: home",
          expiresInSeconds: 600,
        },
      });
    }
    if (path === "/api/hermes/transcribe") {
      const body = request.postDataJSON();
      transcriptionLanguages.push(body.language);
      return json({
        transcript: "find bananas",
        language: body.language,
      });
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ask Tokko" })).toBeVisible();
  await expect(page.getByText("Zepto linked")).toBeVisible();
  await expect(page.getByText("which delivery address should i use for this shop?", { exact: false })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Use Home for shopping" })).toBeVisible();
  await expect(
    page.getByLabel("Tokko response and voice language")
  ).toHaveValue("en-IN");
  await expect(page.getByRole("button", { name: "Read response aloud" }).first())
    .toBeVisible();

  await page.getByRole("button", { name: "Add new" }).click();
  const addressDialog = page.getByRole("dialog", { name: "Add a new address" });
  await addressDialog.getByLabel("Address type").selectOption("OTHER");
  await addressDialog.getByLabel("Address label").fill("Parents");
  await addressDialog.getByLabel("Flat / House number").fill("House 18");
  await addressDialog.getByLabel("Area, city, and state").fill("Ballygunge, Kolkata, West Bengal");
  await addressDialog.getByRole("button", { name: "Save to Zepto account" }).click();
  await expect(addressDialog).toBeHidden();
  await expect(page.getByRole("checkbox", { name: "Use Parents for shopping" })).toBeChecked();
  expect(addedAddressPayload).toMatchObject({
    type: "OTHER",
    name: "Parents",
    flatDetails: "House 18",
    shortAddress: "Ballygunge, Kolkata, West Bengal",
    contactNumber: "+919876543210",
  });
  expect(addedAddressPayload).not.toHaveProperty("latitude");
  expect(addedAddressPayload).not.toHaveProperty("longitude");
  expect(await page.evaluate(() => window.__tokkoHermesGeolocationRequests)).toBe(0);
  await page
    .getByRole("button", { name: /saved addresses/i })
    .click();
  await expect(
    page.getByText("you have one saved address: home, park street, kolkata.")
  ).toBeVisible();
  await expect(page.getByText("checking saved addresses")).toBeVisible();

  await page
    .getByLabel("Tokko response and voice language")
    .selectOption("hi-IN");
  await page.getByRole("button", { name: "Start voice command" }).click();
  await expect(page.getByLabel("Message Tokko")).toHaveValue("find bananas");
  expect(transcriptionLanguages).toEqual(["hi-IN"]);
  await page
    .getByLabel("Message Tokko")
    .fill("save home as 12a park street, kolkata");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Ready for your approval")).toBeVisible();
  await page.getByRole("button", { name: "Yes, approve" }).click();
  await expect(
    page.getByText("done, i saved home to your linked zepto account.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Zepto linked · reconnect" }).click();
  await expect(page.getByText("send a zepto login otp to the selected family phone")).toBeVisible();
  await page.getByRole("button", { name: "Yes, approve" }).click();
  await expect(page.getByText(/reply here with the six-digit code/i)).toBeVisible();
  await page.getByLabel("Message Tokko").fill("123456");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("done, zepto is reconnected.")).toBeVisible();
  await expect(page.getByText("verifying zepto otp")).toBeVisible();
  expect(chatCalls).toBe(6);
  expect(chatLanguages).toEqual([
    "en-IN",
    "hi-IN",
    "hi-IN",
    "hi-IN",
    "hi-IN",
    "hi-IN",
  ]);
});
