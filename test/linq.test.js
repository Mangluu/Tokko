const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectHealthyNumber, verifyWebhook } = require("../lib/linq.js");

test("selectHealthyNumber is stable and excludes critical lines", () => {
  const numbers = [
    {
      id: "critical",
      phone_number: "+12025550000",
      health_status: { status: "CRITICAL" },
    },
    {
      id: "healthy",
      phone_number: "+12025550001",
      health_status: { status: "HEALTHY" },
    },
  ];
  assert.equal(selectHealthyNumber(numbers, "family-1").id, "healthy");
  assert.equal(selectHealthyNumber(numbers, "family-1").id, "healthy");
});

test("verifyWebhook validates the Standard Webhooks signature and age", () => {
  const key = crypto.randomBytes(32);
  const secret = `whsec_${key.toString("base64")}`;
  const rawBody = '{"type":"message.received"}';
  const timestamp = "1000";
  const messageId = "evt_123";
  const signature = crypto
    .createHmac("sha256", key)
    .update(`${messageId}.${timestamp}.${rawBody}`)
    .digest("base64");
  const headers = {
    "webhook-id": messageId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
  assert.equal(verifyWebhook(secret, rawBody, headers, 1001), true);
  assert.equal(verifyWebhook(secret, rawBody, headers, 1400), false);
});
