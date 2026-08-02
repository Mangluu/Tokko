const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  incomingMessage,
  selectHealthyNumber,
  sendChatMessage,
  verifyWebhook,
} = require("../lib/linq.js");

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

test("incomingMessage reads the 2026 message.received envelope", () => {
  assert.deepEqual(incomingMessage({
    event_type: "message.received",
    webhook_version: "2026-02-03",
    data: {
      id: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
      direction: "inbound",
      chat: {
        id: "8f392755-6865-4b18-880a-227f9d8b458f",
        is_group: false,
        owner_handle: { handle: "+12025551234" },
      },
      sender_handle: { handle: "+12025559876", service: "iMessage" },
      parts: [{ type: "text", value: "  find vitamin c  " }],
      service: "iMessage",
    },
  }), {
    chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
    messageId: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
    from: "+12025559876",
    to: "+12025551234",
    text: "find vitamin c",
    service: "iMessage",
  });
});

test("incomingMessage reads the legacy envelope and ignores outbound messages", () => {
  const legacy = {
    event_type: "message.received",
    data: {
      chat_id: "8f392755-6865-4b18-880a-227f9d8b458f",
      from: "+12025559876",
      recipient_phone: "+12025551234",
      is_from_me: false,
      is_group: false,
      service: "SMS",
      message: {
        id: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
        parts: [{ type: "text", value: "hello" }],
      },
    },
  };
  assert.equal(incomingMessage(legacy).text, "hello");
  legacy.data.is_from_me = true;
  assert.equal(incomingMessage(legacy), null);
});

test("sendChatMessage posts an idempotent text part to the existing chat", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.LINQ_API_KEY;
  let captured;
  process.env.LINQ_API_KEY = "test-linq-key";
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      json: async () => ({ message: { id: "sent-message" } }),
    };
  };
  try {
    const result = await sendChatMessage({
      chatId: "8f392755-6865-4b18-880a-227f9d8b458f",
      text: "Tokko reply",
      idempotencyKey: "tokko-event-1",
    });
    assert.equal(result.id, "sent-message");
    assert.equal(
      captured.url,
      "https://api.linqapp.com/api/partner/v3/chats/8f392755-6865-4b18-880a-227f9d8b458f/messages"
    );
    assert.deepEqual(JSON.parse(captured.options.body), {
      message: {
        parts: [{ type: "text", value: "Tokko reply" }],
        idempotency_key: "tokko-event-1",
      },
    });
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.LINQ_API_KEY;
    else process.env.LINQ_API_KEY = previousKey;
  }
});
