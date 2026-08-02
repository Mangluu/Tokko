const crypto = require("node:crypto");

const API_BASE =
  process.env.LINQ_API_BASE_URL || "https://api.linqapp.com/api/partner/v3";

function apiKey() {
  if (!process.env.LINQ_API_KEY) {
    throw Object.assign(new Error("LINQ_API_KEY is not configured"), { status: 503 });
  }
  return process.env.LINQ_API_KEY;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data?.error?.message || data?.message || `LINQ request failed (${response.status})`;
    throw Object.assign(new Error(message), {
      status: response.status,
      details: data,
      provider: "linq",
    });
  }
  return data;
}

async function listPhoneNumbers() {
  const data = await request("/phone_numbers");
  return Array.isArray(data.phone_numbers) ? data.phone_numbers : [];
}

function selectHealthyNumber(numbers, stableKey) {
  const usable = numbers.filter(
    (number) => number?.phone_number &&
      !["CRITICAL"].includes(number?.health_status?.status)
  );
  if (!usable.length) {
    throw Object.assign(new Error("No usable LINQ phone number is provisioned"), {
      status: 503,
    });
  }
  const digest = crypto.createHash("sha256").update(String(stableKey)).digest();
  return usable[digest.readUInt32BE(0) % usable.length];
}

async function assignPhoneNumber(stableKey) {
  if (process.env.LINQ_PHONE_NUMBER) {
    return {
      id: process.env.LINQ_PHONE_NUMBER_ID || "configured",
      phone_number: process.env.LINQ_PHONE_NUMBER,
      health_status: { status: "UNKNOWN" },
    };
  }
  return selectHealthyNumber(await listPhoneNumbers(), stableKey);
}

async function createOnboardingChat({ from, to, primaryParentName, idempotencyKey }) {
  const data = await request("/chats", {
    method: "POST",
    body: JSON.stringify({
      from,
      to: [to],
      message: {
        parts: [
          {
            type: "text",
            value:
              `Hi ${primaryParentName}, your Tokko family profile is ready. ` +
              "Reply here whenever you want to use Tokko by text.",
          },
        ],
        idempotency_key: idempotencyKey,
      },
    }),
  });
  return data.chat || data;
}

async function sendChatMessage({ chatId, text, idempotencyKey }) {
  const normalizedChatId = String(chatId || "").trim();
  const normalizedText = String(text || "").trim().slice(0, 10_000);
  if (!/^[0-9a-f-]{36}$/i.test(normalizedChatId)) {
    throw Object.assign(new Error("A valid LINQ chat id is required"), { status: 400 });
  }
  if (!normalizedText) {
    throw Object.assign(new Error("LINQ message text is required"), { status: 400 });
  }
  const data = await request(`/chats/${encodeURIComponent(normalizedChatId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        parts: [{ type: "text", value: normalizedText }],
        ...(idempotencyKey
          ? { idempotency_key: String(idempotencyKey).slice(0, 255) }
          : {}),
      },
    }),
  });
  return data.message || data;
}

async function sendChatLink({ chatId, url, idempotencyKey }) {
  const normalizedChatId = String(chatId || "").trim();
  const normalizedUrl = String(url || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(normalizedChatId)) {
    throw Object.assign(new Error("A valid LINQ chat id is required"), { status: 400 });
  }
  if (!/^https:\/\/[^\s]{1,2039}$/i.test(normalizedUrl)) {
    throw Object.assign(new Error("A valid HTTPS LINQ link is required"), { status: 400 });
  }
  const data = await request(`/chats/${encodeURIComponent(normalizedChatId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        parts: [{ type: "link", value: normalizedUrl }],
        ...(idempotencyKey
          ? { idempotency_key: String(idempotencyKey).slice(0, 255) }
          : {}),
      },
    }),
  });
  return data.message || data;
}

function incomingMessage(event) {
  const eventType = String(event?.event_type || event?.type || "").trim();
  if (eventType !== "message.received") return null;
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const direction = String(data.direction || "").toLowerCase();
  if (direction && direction !== "inbound") return null;
  if (data.is_from_me === true) return null;
  const chat = data.chat && typeof data.chat === "object" ? data.chat : {};
  if (chat.is_group === true || data.is_group === true) return null;
  const parts = Array.isArray(data.parts)
    ? data.parts
    : Array.isArray(data.message?.parts)
      ? data.message.parts
      : [];
  const text = parts
    .filter((part) => part?.type === "text" && typeof part.value === "string")
    .map((part) => part.value.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 6_000);
  const result = {
    chatId: String(chat.id || data.chat_id || "").trim(),
    messageId: String(data.id || data.message?.id || "").trim(),
    from: String(
      data.sender_handle?.handle || data.from_handle?.handle || data.from || ""
    ).trim(),
    to: String(
      chat.owner_handle?.handle
        || data.recipient_handle?.handle
        || data.recipient_phone
        || ""
    ).trim(),
    text,
    service: String(data.service || data.sender_handle?.service || "").trim() || null,
  };
  if (!/^[0-9a-f-]{36}$/i.test(result.chatId)) return null;
  if (!/^\+[1-9]\d{7,14}$/.test(result.from)) return null;
  if (!/^\+[1-9]\d{7,14}$/.test(result.to)) return null;
  if (!result.text) return null;
  return result;
}

function verifyWebhook(secret, rawBody, headers, nowSeconds = Date.now() / 1000) {
  if (!secret) return false;
  const messageId = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"] || "";
  const timestampNumber = Number(timestamp);
  if (!messageId || !timestamp || !Number.isFinite(timestampNumber)) return false;
  if (Math.abs(nowSeconds - timestampNumber) > 300) return false;

  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(encodedSecret, "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${messageId}.${timestamp}.${rawBody}`)
    .digest();

  return signature.split(" ").some((candidate) => {
    if (!candidate.startsWith("v1,")) return false;
    try {
      const actual = Buffer.from(candidate.slice(3), "base64");
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  });
}

module.exports = {
  assignPhoneNumber,
  createOnboardingChat,
  incomingMessage,
  listPhoneNumbers,
  selectHealthyNumber,
  sendChatLink,
  sendChatMessage,
  verifyWebhook,
};
