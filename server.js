const http = require("node:http");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./lib/db.js");
const auth = require("./lib/auth.js");
const checkout = require("./lib/checkout.js");
const emailVerification = require("./lib/email-verification.js");
const geocoding = require("./lib/geocoding.js");
const hermes = require("./lib/hermes.js");
const linq = require("./lib/linq.js");
const payments = require("./lib/payments.js");
const platforms = require("./lib/platforms.js");
const ucp = require("./lib/ucp.js");
const validation = require("./lib/validation.js");
const websiteAuth = require("./lib/website-auth.js");

const PORT = Number(process.env.PORT || 3456);
const BASE_URL =
  process.env.BASE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://localhost:${PORT}`);
const CONSENT_POLICY_VERSION =
  process.env.CONSENT_POLICY_VERSION || "2026-07-27";
const MERCHANT_CONSENT_TEXT =
  "I consent to Tokko using the selected phone number solely to authenticate " +
  "with the selected merchant. I understand that I can revoke this consent.";
const EXTERNAL_ZEPTO_TOOLS = new Set([
  "list_saved_addresses",
  "get_location_serviceability",
  "select_store",
  "add_saved_address",
  "select_saved_address",
  "search_products",
  "get_product_details",
  "view_cart",
  "update_cart",
  "get_payment_methods",
  "create_order",
  "create_online_payment_order",
  "check_payment_status",
  "list_order_history",
  "get_order_detail",
  "get_past_order_items",
]);
const HERMES_CHECKOUT_TOOL = {
  name: "checkout_current_cart",
  description:
    "Place the current Zepto cart using Tokko's payment policy. Tokko first checks every active Prava mandate and uses the smallest single mandate that covers the full order total. If none covers it, Tokko starts a normal one-time Prava transaction with the saved card and passkey approval. If neither online route can be used and COD fallback is allowed, Tokko places Cash on Delivery.",
  inputSchema: {
    type: "object",
    properties: {
      userAddressId: {
        type: "string",
        description: "The internal ID of the confirmed saved Zepto address.",
      },
      allowCodFallback: {
        type: "boolean",
        description: "Whether the approved checkout may fall back to COD.",
      },
    },
    required: ["userAddressId"],
  },
};
const HERMES_ZEPTO_RECONNECT_TOOL = {
  name: "start_zepto_reconnect",
  description:
    "Send or resend a Zepto login OTP to the family phone already selected and consented for merchant authentication. Use this whenever the user asks to connect, reconnect, reauthenticate, refresh login, or resend the Zepto OTP.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};
const HERMES_UCP_SEARCH_TOOL = {
  name: "search_wellness_merchants",
  description:
    "Search every live health-and-wellness UCP catalogue in Hermes merchant memory for the selected India or US delivery market, then return the three lowest-priced matches. A selected delivery address is required.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The user's product or wellness need in concise catalogue wording.",
      },
      market: {
        type: "string",
        enum: ["IN", "US"],
        description: "Delivery market derived from the selected saved address.",
      },
    },
    required: ["query"],
  },
};
const HERMES_UCP_CHECKOUT_TOOL = {
  name: "create_wellness_checkout",
  description:
    "Create checkout for the exact UCP product selected from Trakko's health-and-wellness search. Trakko submits the selected shipping destination and E.164 phone, uses the merchant's item, shipping, discount, tax, fee, and total lines, then checks active Prava mandates against that authoritative total.",
  inputSchema: {
    type: "object",
    properties: {
      selectionToken: {
        type: "string",
        description: "The opaque selectionToken returned with the chosen search result.",
      },
      quantity: {
        type: "integer",
        description: "Selected quantity, from 1 to 20. Defaults to 1.",
      },
    },
    required: ["selectionToken"],
  },
};
const HERMES_MANDATE_TOOL = {
  name: "prepare_payment_mandate",
  description:
    "Prepare Prava mandate setup and return masked saved-card choices plus an add-new-card choice. Use this when the user asks to create, set up, or approve a payment mandate. Never choose a card on the user's behalf.",
  inputSchema: {
    type: "object",
    properties: {
      amount: {
        type: "string",
        description: "Per-charge mandate cap as a positive decimal amount.",
      },
      frequency: {
        type: "string",
        enum: ["one_time", "weekly", "monthly", "yearly"],
        description: "Defaults to one_time.",
      },
      merchantScope: {
        type: "string",
        enum: ["any", "listed"],
        description:
          "Defaults to any for one_time and listed for recurring mandates.",
      },
    },
    required: ["amount"],
  },
};

const routes = [];
let applicationInitialization = null;

function routeAuth(pattern) {
  if (
    pattern === "/api/health" ||
    pattern === "/api/config" ||
    pattern === "/api/auth/signup" ||
    pattern === "/api/auth/signup/verify" ||
    pattern === "/api/auth/clerk/session" ||
    pattern === "/api/auth/login" ||
    pattern === "/api/auth/logout" ||
    pattern === "/api/payments/return" ||
    pattern === "/.well-known/ucp"
  ) {
    return "public";
  }
  if (pattern.startsWith("/api/webhooks/")) return "signed_webhook";
  if (pattern.startsWith("/api/integrations/telegram/")) return "service";
  if (pattern.startsWith("/api/v1/")) return "service";
  return "website_session";
}

function routeGroup(pattern) {
  if (pattern.startsWith("/api/auth/")) return "authentication";
  if (pattern.includes("/system/") || pattern === "/api/health" || pattern === "/api/config") {
    return "system";
  }
  if (pattern.includes("/linq/") || pattern.includes("/webhooks/linq")) return "linq";
  if (pattern.includes("/hermes")) return "hermes";
  if (pattern.includes("/payment")) return "payments";
  if (pattern.includes("/merchant/") || pattern.includes("zepto-status")) {
    return "merchant_auth";
  }
  if (pattern.includes("/onboarding") || pattern === "/api/me") return "onboarding";
  return "shopping";
}

function route(method, pattern, handler) {
  routes.push({
    method,
    pattern,
    handler,
    auth: routeAuth(pattern),
    group: routeGroup(pattern),
  });
}

function matchRoute(method, url) {
  const pathname = new URL(url, "http://localhost").pathname;
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const patternParts = candidate.pattern.split("/");
    const urlParts = pathname.split("/");
    if (patternParts.length !== urlParts.length) continue;
    const params = {};
    let matches = true;
    for (let index = 0; index < patternParts.length; index += 1) {
      if (patternParts[index].startsWith(":")) {
        params[patternParts[index].slice(1)] = decodeURIComponent(urlParts[index]);
      } else if (patternParts[index] !== urlParts[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return { handler: candidate.handler, params };
  }
  return null;
}

function readRawBody(req) {
  if (req.rawBody !== undefined) return Promise.resolve(req.rawBody);
  if (req.body !== undefined && req.readableEnded) {
    const supplied =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    req.rawBody = supplied;
    return Promise.resolve(supplied);
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1_000_000) {
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      req.rawBody = body;
      resolve(body);
    });
    req.on("error", reject);
  });
}

async function parseBody(req) {
  if (req.parsedBody !== undefined) return req.parsedBody;
  if (req.body && typeof req.body === "object" && req.readableEnded) {
    req.parsedBody = req.body;
    return req.parsedBody;
  }
  const rawBody = await readRawBody(req);
  if (!rawBody) {
    req.parsedBody = {};
    return req.parsedBody;
  }
  try {
    req.parsedBody = JSON.parse(rawBody);
    return req.parsedBody;
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function getQuery(req) {
  return Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendRedirect(res, location, status = 303) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    Location: location,
    "X-Content-Type-Options": "nosniff",
  });
  res.end();
}

function secureRequest(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "");
  return protocol === "https" || BASE_URL.startsWith("https://");
}

function publicAccount(user) {
  return {
    email: user.email || null,
    authChannel: user.auth_channel,
  };
}

function publicDeliveryPreference(preference) {
  if (!preference) return null;
  return {
    platform: preference.platform_slug,
    addressId: preference.address_id,
    label: preference.label || null,
    formattedAddress: preference.formatted_address,
    confirmedAt: preference.confirmed_at,
  };
}

function publicFamilyAddress(address) {
  if (!address) return null;
  return {
    id: String(address.id),
    addressId: String(address.id),
    label: address.label,
    formattedAddress: address.formatted_address,
    addressLine1: address.address_line1 || null,
    addressLine2: address.address_line2 || null,
    city: address.city || null,
    state: address.state || null,
    postalCode: address.postal_code || null,
    countryCode: address.country_code || "IN",
    contactName: address.contact_name || null,
    contactPhone: address.contact_phone || null,
    memberIds: (address.member_ids || []).map(String),
    selected: address.is_selected === true,
    createdAt: address.created_at || null,
    updatedAt: address.updated_at || null,
  };
}

function familyAddressInput(value = {}, { requireContact = false } = {}) {
  const field = (key, max = 300) => {
    const result = String(value[key] || "").trim();
    return result ? result.slice(0, max) : null;
  };
  const label = field("label", 80) || field("name", 80) || field("type", 30) || "Home";
  const addressLine1 = field("addressLine1", 300) || field("flatDetails", 300);
  const addressLine2 = field("addressLine2", 300) || field("buildingName", 300);
  const city = field("city", 120);
  const state = field("state", 120);
  const postalCode = field("postalCode", 20);
  const shortAddress = field("shortAddress", 500);
  const floor = field("floor", 80);
  const landmark = field("landmark", 180);
  const suppliedFormatted = field("formattedAddress", 1_000);
  const formattedAddress = suppliedFormatted || [
    addressLine1,
    addressLine2,
    floor ? `Floor ${floor}` : null,
    landmark ? `Near ${landmark}` : null,
    shortAddress,
    city,
    state,
    postalCode,
  ].filter(Boolean).join(", ");
  if (!formattedAddress || formattedAddress.length < 5) {
    throw Object.assign(new Error("A complete delivery address is required"), {
      status: 400,
    });
  }
  const countryCode = String(value.countryCode || "IN").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw Object.assign(new Error("countryCode must use a two-letter code"), {
      status: 400,
    });
  }
  const contactName = field("contactName", 160);
  const contactPhone = value.contactPhone || value.contactNumber
    ? validation.e164(value.contactPhone || value.contactNumber, "contactPhone")
    : null;
  if (requireContact && (!contactName || !contactPhone)) {
    throw Object.assign(
      new Error("A delivery contact name and phone number are required"),
      { status: 400 }
    );
  }
  return {
    label,
    formattedAddress,
    addressLine1: addressLine1 || suppliedFormatted,
    addressLine2,
    city: city || shortAddress,
    state,
    postalCode,
    countryCode,
    contactName,
    contactPhone,
  };
}

function familyAddressPayload(rows) {
  const addresses = (Array.isArray(rows) ? rows : []).map(publicFamilyAddress);
  return {
    addresses,
    selectedAddress: addresses.find((address) => address.selected) || null,
  };
}

const CARE_APPROVAL_MODES = new Set(["ask_every_time", "auto_essentials"]);
const CARE_CATEGORIES = new Set([
  "medicines",
  "wellness",
  "personal_care",
  "devices",
  "nutrition",
]);

function optionalMoney(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    throw Object.assign(new Error(`${field} must be between 0 and 1,000,000`), {
      status: 400,
    });
  }
  return Math.round(amount * 100) / 100;
}

function careRulesInput(value = {}) {
  const approvalMode = String(value.approvalMode || "ask_every_time").trim();
  if (!CARE_APPROVAL_MODES.has(approvalMode)) {
    throw Object.assign(new Error("Choose a valid purchase approval mode"), {
      status: 400,
    });
  }
  const currency = String(value.currency || "INR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw Object.assign(new Error("currency must use a three-letter code"), {
      status: 400,
    });
  }
  const monthlyCap = optionalMoney(value.monthlyCap, "monthlyCap");
  const perOrderCap = optionalMoney(value.perOrderCap, "perOrderCap");
  if (approvalMode === "auto_essentials" && (!monthlyCap || !perOrderCap)) {
    throw Object.assign(
      new Error("Automatic essentials need both monthly and per-order limits"),
      { status: 400 }
    );
  }
  if (monthlyCap && perOrderCap && perOrderCap > monthlyCap) {
    throw Object.assign(
      new Error("The per-order limit cannot exceed the monthly limit"),
      { status: 400 }
    );
  }
  const allowedCategories = [...new Set(
    (Array.isArray(value.allowedCategories) ? value.allowedCategories : [])
      .map((item) => String(item).trim().toLowerCase())
      .filter((item) => CARE_CATEGORIES.has(item))
  )];
  const blockedItems = [...new Set(
    (Array.isArray(value.blockedItems) ? value.blockedItems : [])
      .map((item) => String(item).trim().slice(0, 80))
      .filter(Boolean)
  )].slice(0, 30);
  if (approvalMode === "auto_essentials" && allowedCategories.length === 0) {
    throw Object.assign(
      new Error("Choose at least one category for automatic essentials"),
      { status: 400 }
    );
  }
  return {
    approvalMode,
    monthlyCap: approvalMode === "auto_essentials" ? monthlyCap : null,
    perOrderCap: approvalMode === "auto_essentials" ? perOrderCap : null,
    currency,
    repeatKnownEssentials:
      approvalMode === "auto_essentials" && value.repeatKnownEssentials === true,
    allowedCategories:
      approvalMode === "auto_essentials" ? allowedCategories : [],
    blockedItems,
  };
}

function publicCareRules(rules) {
  if (!rules) return null;
  const numberOrNull = (value) =>
    value === null || value === undefined ? null : Number(value);
  return {
    approvalMode: rules.approval_mode,
    monthlyCap: numberOrNull(rules.monthly_cap),
    perOrderCap: numberOrNull(rules.per_order_cap),
    currency: rules.currency || "INR",
    repeatKnownEssentials: rules.repeat_known_essentials === true,
    allowedCategories: rules.allowed_categories || [],
    blockedItems: rules.blocked_items || [],
    updatedAt: rules.updated_at || null,
  };
}

function preferenceInput(value = {}, current = null) {
  const pick = (key, column, fallback) =>
    typeof value[key] === "boolean" ? value[key] : current?.[column] ?? fallback;
  return {
    decisionAlerts: pick("decisionAlerts", "decision_alerts", true),
    deliveryUpdates: pick("deliveryUpdates", "delivery_updates", true),
    weeklyDigest: pick("weeklyDigest", "weekly_digest", false),
  };
}

function publicPreferences(preferences) {
  const values = preferenceInput({}, preferences);
  return {
    ...values,
    updatedAt: preferences?.updated_at || null,
  };
}

function decisionRequestInput(value = {}) {
  const requiredText = (key, max) => {
    const text = String(value[key] || "").trim();
    if (!text) {
      throw Object.assign(new Error(`${key} is required`), { status: 400 });
    }
    return text.slice(0, max);
  };
  const optionalText = (key, max) => {
    const text = String(value[key] || "").trim();
    return text ? text.slice(0, max) : null;
  };
  const requestType = String(value.requestType || "purchase_approval").trim();
  if (!new Set([
    "purchase_approval",
    "substitution",
    "address_confirmation",
    "safety_stop",
  ]).has(requestType)) {
    throw Object.assign(new Error("requestType is invalid"), { status: 400 });
  }
  const numericId = (key) => {
    if (value[key] === undefined || value[key] === null || value[key] === "") {
      return null;
    }
    const id = Number(value[key]);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw Object.assign(new Error(`${key} is invalid`), { status: 400 });
    }
    return id;
  };
  const amount = optionalMoney(value.amount, "amount");
  const currency = String(value.currency || "INR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw Object.assign(new Error("currency must use a three-letter code"), {
      status: 400,
    });
  }
  let expiresAt = null;
  if (value.expiresAt) {
    const parsed = new Date(value.expiresAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw Object.assign(new Error("expiresAt must be in the future"), {
        status: 400,
      });
    }
    expiresAt = parsed.toISOString();
  }
  const jsonObject = (key) =>
    value[key] && typeof value[key] === "object" && !Array.isArray(value[key])
      ? value[key]
      : {};
  return {
    id: nodeCrypto.randomUUID(),
    memberId: numericId("memberId"),
    addressId: numericId("addressId"),
    requestType,
    title: requiredText("title", 180),
    originalRequest: optionalText("originalRequest", 1_000),
    merchantName: optionalText("merchantName", 160),
    product: jsonObject("product"),
    amount,
    currency,
    reasonCode: optionalText("reasonCode", 60),
    reasonText: requiredText("reasonText", 1_000),
    paymentContext: jsonObject("paymentContext"),
    actionContext: jsonObject("actionContext"),
    expiresAt,
  };
}

function publicDecision(decision) {
  if (!decision) return null;
  return {
    id: decision.id,
    memberId: decision.member_id ? String(decision.member_id) : null,
    memberName: decision.member_name || null,
    requestType: decision.request_type,
    status: decision.status,
    title: decision.title,
    originalRequest: decision.original_request || null,
    merchantName: decision.merchant_name || null,
    product: decision.product || {},
    amount: decision.amount === null ? null : Number(decision.amount),
    currency: decision.currency,
    addressId: decision.address_id ? String(decision.address_id) : null,
    addressLabel: decision.address_label || null,
    formattedAddress: decision.formatted_address || null,
    reasonCode: decision.reason_code || null,
    reasonText: decision.reason_text,
    resolution: decision.resolution || null,
    resolutionNote: decision.resolution_note || null,
    expiresAt: decision.expires_at || null,
    resolvedAt: decision.resolved_at || null,
    createdAt: decision.created_at,
    updatedAt: decision.updated_at,
  };
}

function publicActivity(event) {
  return {
    id: String(event.id),
    eventType: event.event_type,
    title: event.title,
    detail: event.detail || null,
    entityType: event.entity_type || null,
    entityId: event.entity_id || null,
    metadata: event.metadata || {},
    createdAt: event.created_at,
  };
}

async function createBrowserSession(req, res, user, status = 200) {
  const token = websiteAuth.createSessionToken();
  await db.createWebsiteSession(
    Number(user.id),
    websiteAuth.hashSessionToken(token),
    websiteAuth.sessionExpiresAt()
  );
  sendJson(
    res,
    status,
    { account: publicAccount(user) },
    { "Set-Cookie": websiteAuth.sessionCookie(token, secureRequest(req)) }
  );
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function serveStatic(res, requestPath) {
  const publicRoot = path.resolve(__dirname, "public");
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const absolute = path.resolve(publicRoot, relative);
  if (
    absolute !== publicRoot &&
    !absolute.startsWith(`${publicRoot}${path.sep}`)
  ) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  fs.readFile(absolute, (error, data) => {
    if (error) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Cache-Control": relative === "index.html" ? "no-cache" : "public, max-age=3600",
      "Content-Type": MIME[path.extname(relative)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  });
}

function publicProfile(profile) {
  if (!profile) return null;
  const merchantAuthPhone =
    profile.merchant_auth_phone || profile.offspring_phone;
  const merchantAuthSubjectType =
    profile.merchant_auth_subject_type || "dependent";
  const dependents = Array.isArray(profile.dependents)
    ? profile.dependents.map((dependent) => ({
          id: Number(dependent.id),
          name: dependent.name,
          phone: dependent.phone,
          relationshipToUser: dependent.relationship_to_user,
          age:
            dependent.age === null || dependent.age === undefined
              ? null
              : Number(dependent.age),
          gender: dependent.gender || null,
          isMerchantAuthSubject:
            dependent.is_merchant_auth_subject === true ||
            dependent.is_merchant_auth_subject === "t",
        }))
    : profile.offspring_phone
      ? [
          {
            name: profile.offspring_name,
            phone: profile.offspring_phone,
            relationshipToUser: profile.dependent_relationship,
            age: null,
            gender: null,
            isMerchantAuthSubject:
              merchantAuthSubjectType === "dependent" &&
              merchantAuthPhone === profile.offspring_phone,
          },
        ]
      : [];
  return {
    primaryParentName: profile.primary_parent_name,
    primaryParentPhone: profile.primary_parent_phone,
    primaryParentAge:
      profile.primary_parent_age === null ||
      profile.primary_parent_age === undefined
        ? null
        : Number(profile.primary_parent_age),
    primaryParentGender: profile.primary_parent_gender || null,
    secondaryParentName: profile.secondary_parent_name,
    secondaryParentPhone: profile.secondary_parent_phone,
    dependents,
    merchantAuthPhone,
    merchantAuthSubjectType,
    merchantAuthDependentPhone:
      merchantAuthSubjectType === "dependent" ? merchantAuthPhone : null,
    dependentName: profile.offspring_name,
    dependentPhone: profile.offspring_phone,
    dependentRelationship: profile.dependent_relationship,
    // Temporary response aliases for existing API consumers.
    offspringName: profile.offspring_name,
    offspringPhone: profile.offspring_phone,
    onboardingSource: profile.onboarding_source,
    linqPhoneNumber: profile.linq_phone_number,
  };
}

function publicPaymentMethod(paymentMethod) {
  return {
    id: paymentMethod.id,
    provider: paymentMethod.provider,
    type: paymentMethod.type,
    brand: paymentMethod.brand,
    last4: paymentMethod.last4,
    expMonth: Number(paymentMethod.exp_month),
    expYear: Number(paymentMethod.exp_year),
    isDefault:
      paymentMethod.is_default === true || paymentMethod.is_default === "t",
  };
}

function canonicalPravaCustomerId(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("A valid family user ID is required"), {
      status: 400,
    });
  }
  return `tokko_family_${id}`;
}

async function getOrCreateFamilyPaymentCustomer(userId) {
  const existing = await db.getPaymentCustomer(userId);
  if (existing) return existing;
  return db.savePaymentCustomer(
    userId,
    "prava",
    canonicalPravaCustomerId(userId)
  );
}

function parseOnboardingId(value) {
  const userId = Number(value);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw Object.assign(new Error("Invalid onboarding id"), { status: 400 });
  }
  return userId;
}

async function resolveOnboardingUserId(value) {
  if (/^[1-9]\d*$/.test(String(value || ""))) {
    return parseOnboardingId(value);
  }
  const phone = validation.e164(value, "family phone");
  const matches = await db.getFamilyUsersByPhone(phone);
  if (matches.length === 0) {
    throw Object.assign(new Error("No family contains this phone number"), {
      status: 404,
    });
  }
  if (matches.length > 1) {
    throw Object.assign(
      new Error("This phone number belongs to more than one family"),
      { status: 409 }
    );
  }
  return Number(matches[0].id);
}

function telegramChatIdentifier(body) {
  const nestedMessage =
    body?.message && typeof body.message === "object"
      ? body.message
      : body?.edited_message && typeof body.edited_message === "object"
        ? body.edited_message
        : null;
  const value =
    body?.telegramChatId ??
    body?.chatId ??
    body?.chat_id ??
    nestedMessage?.chat?.id;
  const chatId = String(value ?? "").trim();
  if (!/^-?\d{1,20}$/.test(chatId)) {
    throw Object.assign(new Error("telegramChatId is required"), {
      status: 400,
    });
  }
  return chatId;
}

async function telegramFamilyUser(body, chatId) {
  const binding = await db.getTelegramHermesBinding(chatId);
  let requestedUser = null;
  const requestedUserId = body?.userId ?? body?.familyUserId;
  const requestedEmail = String(body?.familyEmail || "").trim();
  const requestedPhone = String(body?.familyPhone || "").trim();
  const defaultEmail = String(
    process.env.TELEGRAM_DEFAULT_FAMILY_EMAIL || ""
  ).trim();
  if (requestedUserId !== undefined && requestedUserId !== null) {
    const userId = parseOnboardingId(requestedUserId);
    requestedUser = await db.getUserById(userId);
  } else if (requestedEmail) {
    requestedUser = await db.getUserByEmail(requestedEmail);
  } else if (requestedPhone) {
    const userId = await resolveOnboardingUserId(requestedPhone);
    requestedUser = await db.getUserById(userId);
  } else if (defaultEmail) {
    requestedUser = await db.getUserByEmail(defaultEmail);
  }
  if (
    binding &&
    requestedUser &&
    Number(binding.user_id) !== Number(requestedUser.id)
  ) {
    throw Object.assign(
      new Error("This Telegram chat is already linked to another Trakko family"),
      { status: 409 }
    );
  }
  const user = requestedUser || (binding
    ? await db.getUserById(Number(binding.user_id))
    : null);
  if (!user) {
    throw Object.assign(
      new Error(
        "Telegram chat is not linked. Supply familyEmail, familyPhone, or familyUserId on the first request."
      ),
      { status: 404 }
    );
  }
  const nestedMessage =
    body?.message && typeof body.message === "object" ? body.message : null;
  const username =
    body?.telegramUsername || nestedMessage?.from?.username || null;
  await db.saveTelegramHermesBinding(chatId, Number(user.id), username);
  return user;
}

function safeIntegrationSecret(actual, expected) {
  const actualHash = nodeCrypto.createHash("sha256").update(actual).digest();
  const expectedHash = nodeCrypto.createHash("sha256").update(expected).digest();
  return nodeCrypto.timingSafeEqual(actualHash, expectedHash);
}

async function requireTelegramIntegration(req) {
  const supplied = String(
    req.headers["x-telegram-bot-api-secret-token"] || ""
  );
  const configured = String(process.env.TELEGRAM_WEBHOOK_SECRET || "");
  if (supplied && configured && safeIntegrationSecret(supplied, configured)) {
    return { type: "telegram_webhook_secret" };
  }
  return auth.requireService(req);
}

async function assertFamilyPhoneForUser(userId, phone) {
  if (!phone) return null;
  const normalized = validation.e164(phone, "familyPhone");
  const matches = await db.getFamilyUsersByPhone(normalized);
  if (matches.length !== 1 || Number(matches[0].id) !== Number(userId)) {
    throw Object.assign(
      new Error("This phone number is not linked to the signed-in family"),
      { status: 403 }
    );
  }
  return normalized;
}

async function getUserState(userId, clerkUserId = null) {
  const [
    user,
    profile,
    paymentMethods,
    paymentCustomer,
    familyAddresses,
    careRules,
    preferences,
    pendingDecisions,
  ] = await Promise.all([
    db.getUserById(userId),
    db.getProfile(userId),
    db.getPaymentMethods(userId, "prava"),
    db.getPaymentCustomer(userId),
    db.getFamilyAddresses(userId),
    db.getCareRules(userId),
    db.getUserPreferences(userId),
    db.getDecisionRequests(userId, { status: "pending", limit: 100 }),
  ]);
  const paymentConfigured = payments.configuration().configured;
  const publicAddresses = familyAddressPayload(familyAddresses);
  const publicRules = publicCareRules(careRules);
  const familyComplete = Boolean(
    profile && Array.isArray(profile.dependents) && profile.dependents.length > 0
  );
  const deliveryComplete = Boolean(publicAddresses.selectedAddress);
  const spendingComplete = Boolean(publicRules);
  const cardReady = paymentMethods.length > 0;
  // Mandates live at Prava and are checked at order time. Do not claim that
  // automatic ordering is ready from a saved card alone.
  const autoOrderReady = false;
  const state = {
    userId: Number(user.id),
    clerkUserId,
    account: publicAccount(user),
    customerId:
      paymentCustomer?.provider_customer_id
      || canonicalPravaCustomerId(userId),
    profile: publicProfile(profile),
    profileComplete: familyComplete,
    familyComplete,
    merchantConsent: {
      merchant: "zepto",
      consented: false,
      policyVersion: CONSENT_POLICY_VERSION,
    },
    paymentMethods: paymentMethods.map(publicPaymentMethod),
    hasPaymentMethod: paymentMethods.length > 0,
    paymentConfigured,
    paymentProvider: "prava",
    paymentRequired: false,
    paymentComplete: true,
    merchantConnected: false,
    ...publicAddresses,
    deliveryPreference: publicAddresses.selectedAddress,
    deliveryComplete,
    careRules: publicRules,
    spendingComplete,
    preferences: publicPreferences(preferences),
    pendingDecisionCount: pendingDecisions.length,
    cardReady,
    autoOrderReady,
    automaticPayments: {
      cardReady,
      mandateStatus: publicRules?.approvalMode === "auto_essentials"
        ? "check_required"
        : "not_required",
    },
    setup: {
      familyComplete,
      deliveryComplete,
      spendingComplete,
      approvalMode: publicRules?.approvalMode || null,
      cardReady,
      autoOrderReady,
    },
  };
  state.onboardingComplete = familyComplete && deliveryComplete && spendingComplete;
  return state;
}

async function saveMerchantConsent({
  userId,
  consented,
  source,
  clerkUserId = null,
}) {
  if (typeof consented !== "boolean") {
    throw Object.assign(new Error("consented must be true or false"), { status: 400 });
  }
  const [profile, platform] = await Promise.all([
    db.getProfile(userId),
    db.getPlatformBySlug("zepto"),
  ]);
  if (!profile) {
    throw Object.assign(new Error("Complete the family profile first"), { status: 409 });
  }
  if (!platform) {
    throw Object.assign(new Error("Zepto platform is not configured"), { status: 503 });
  }
  const subjectPhone = profile.merchant_auth_phone || profile.offspring_phone;
  const existingConsent = await db.getMerchantAuthConsent(
    userId,
    Number(platform.id),
    auth.MERCHANT_AUTH_PURPOSE
  );
  if (
    consented &&
    existingConsent?.subject_phone &&
    existingConsent.subject_phone !== subjectPhone
  ) {
    await db.clearToken(userId, Number(platform.id));
    await db.clearDeliveryPreference(userId, "zepto");
  }
  const record = await db.setMerchantAuthConsent({
    userId,
    platformId: Number(platform.id),
    subjectPhone,
    purpose: auth.MERCHANT_AUTH_PURPOSE,
    consented,
    consentText: `${MERCHANT_CONSENT_TEXT} Number: ${subjectPhone}.`,
    policyVersion: CONSENT_POLICY_VERSION,
    source,
    actorClerkUserId: clerkUserId,
  });
  if (!consented) {
    await db.setConsent(userId, Number(platform.id), false);
    await db.clearToken(userId, Number(platform.id));
    await db.clearDeliveryPreference(userId, "zepto");
  }
  return record;
}

function telegramBotUsername(value) {
  const username = String(value || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{3,30}bot$/i.test(username)) {
    throw Object.assign(
      new Error("A valid Telegram bot username ending in bot is required"),
      { status: 400 }
    );
  }
  return username;
}

function pravaReturnCallback(flow, returnContext = {}) {
  const type = flow === "mandate" ? "mandate" : "card";
  const callbackBase = BASE_URL.startsWith("https://")
    ? BASE_URL
    : process.env.PRAVA_MERCHANT_URL || "https://tokko-drab.vercel.app";
  if (returnContext?.channel === "telegram") {
    const callbackUrl = new URL("/api/payments/return", callbackBase);
    callbackUrl.searchParams.set("channel", "telegram");
    callbackUrl.searchParams.set(
      "bot",
      telegramBotUsername(returnContext.botUsername)
    );
    callbackUrl.searchParams.set("flow", type);
    return callbackUrl.toString();
  }

  const callbackUrl = new URL(callbackBase);
  callbackUrl.searchParams.set(
    type === "mandate" ? "pravaMandate" : "pravaCard",
    "return"
  );
  return callbackUrl.toString();
}

async function createTokenizationSessionForUser(userId, input = {}) {
  const [profile, user, customer] = await Promise.all([
    db.getProfile(userId),
    db.getUserById(userId),
    getOrCreateFamilyPaymentCustomer(userId),
  ]);
  if (!profile) {
    throw Object.assign(new Error("Complete the family profile first"), { status: 409 });
  }
  if (!user?.email) {
    throw Object.assign(
      new Error("An account email is required for Prava card tokenization"),
      { status: 409 }
    );
  }
  const providerCustomerId = customer.provider_customer_id;
  const merchantUrl =
    process.env.PRAVA_MERCHANT_URL ||
    (BASE_URL.startsWith("https://")
      ? BASE_URL
      : "https://tokko-drab.vercel.app");
  const callbackUrl = pravaReturnCallback("card", input.returnContext);
  const session = await payments.createTokenizationSession({
    customerId: providerCustomerId,
    email: user.email,
    merchantUrl,
    callbackUrl,
  });
  await db.savePaymentTokenizationSession(
    userId,
    "prava",
    session.sessionId,
    session.expiresAt
  );
  return { ...session, customerId: providerCustomerId };
}

async function syncPravaPaymentMethodsForUser(userId) {
  const stored = await db.getPaymentMethods(userId, "prava");
  const customer = await db.getPaymentCustomer(userId);
  if (!customer || customer.provider !== "prava") return stored;
  try {
    const cards = await payments.listCards(customer.provider_customer_id);
    const validCards = [];
    for (const card of cards) {
      try {
        validCards.push(payments.safePaymentMethod(card));
      } catch (error) {
        console.warn(
          `[payments] Ignoring incomplete Prava card metadata for user ${userId}:`,
          error.message
        );
      }
    }
    if (validCards.length === 0) return stored;
    return db.syncPaymentMethods(
      userId,
      "prava",
      customer.provider_customer_id,
      validCards
    );
  } catch (error) {
    console.error(
      `[payments] Could not synchronize Prava cards for user ${userId}:`,
      error.message
    );
    return stored;
  }
}

async function pravaMandateIdentity(userId) {
  const [user, profile, customer] = await Promise.all([
    db.getUserById(userId),
    db.getProfile(userId),
    db.getPaymentCustomer(userId),
  ]);
  if (!profile) {
    throw Object.assign(new Error("Complete the family profile first"), {
      status: 409,
    });
  }
  if (!user?.email) {
    throw Object.assign(
      new Error("An account email is required for a Prava mandate"),
      { status: 409 }
    );
  }
  if (!customer || customer.provider !== "prava") {
    throw Object.assign(
      new Error("Save a card with Prava before creating a mandate"),
      { status: 409 }
    );
  }
  return {
    email: user.email,
    customerId: customer.provider_customer_id,
  };
}

async function createPravaMandateForUser(userId, input) {
  const [{ email, customerId }, methods] = await Promise.all([
    pravaMandateIdentity(userId),
    db.getPaymentMethods(userId, "prava"),
  ]);
  const selected = methods.find(
    (method) => String(method.id) === String(input.paymentMethodId)
  );
  if (!selected?.provider_payment_method_id) {
    throw Object.assign(new Error("Select a saved Prava card"), {
      status: 404,
    });
  }
  const callbackUrl = pravaReturnCallback("mandate", input.returnContext);
  return payments.createMandateSession({
    customerId,
    email,
    cardId: selected.provider_payment_method_id,
    amount: input.amount,
    frequency: input.frequency,
    merchantScope: input.merchantScope ?? input.merchant_scope,
    callbackUrl,
  });
}

function telegramMandateIntent(input = {}) {
  const value = Number(input.amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error("A positive mandate amount is required"), {
      status: 400,
    });
  }
  const frequency = String(input.frequency || "one_time").trim().toLowerCase();
  if (!["one_time", "weekly", "monthly", "yearly"].includes(frequency)) {
    throw Object.assign(
      new Error("frequency must be one_time, weekly, monthly, or yearly"),
      { status: 400 }
    );
  }
  const merchantScope = String(
    input.merchantScope
      ?? input.merchant_scope
      ?? (frequency === "one_time" ? "any" : "listed")
  ).trim().toLowerCase();
  if (!["any", "listed"].includes(merchantScope)) {
    throw Object.assign(new Error("merchantScope must be any or listed"), {
      status: 400,
    });
  }
  if (merchantScope === "any" && frequency !== "one_time") {
    throw Object.assign(
      new Error("merchantScope any is only supported with frequency one_time"),
      { status: 400 }
    );
  }
  return {
    amount: value.toFixed(2),
    frequency,
    merchantScope,
  };
}

async function prepareTelegramMandateChoices(userId, input = {}) {
  const intent = telegramMandateIntent(input);
  const methods = await syncPravaPaymentMethodsForUser(userId);
  const cardChoices = methods.map((method) => {
    const card = publicPaymentMethod(method);
    return {
      ...card,
      type: "saved_card",
      label: `${card.brand || "Card"} •••• ${card.last4}${
        card.isDefault ? " (default)" : ""
      }`,
      token: hermes.signApproval({
        userId,
        toolName: "create_mandate_with_saved_card",
        args: {
          ...intent,
          paymentMethodId: String(card.id),
        },
      }),
    };
  });
  cardChoices.push({
    type: "add_card",
    label: "Add a new saved card",
    token: hermes.signApproval({
      userId,
      toolName: "create_mandate_with_new_card",
      args: intent,
    }),
  });
  return {
    stage: "choose_card",
    mandate: intent,
    cardChoices,
  };
}

function telegramBotUsernameFromBody(body = {}) {
  return telegramBotUsername(
    body.botUsername
      || body.telegramBotUsername
      || process.env.TELEGRAM_BOT_USERNAME
  );
}

async function startTelegramMandateChoice(userId, chatId, body = {}) {
  const approved = hermes.verifyApproval(String(body.token || ""), userId);
  const returnContext = {
    channel: "telegram",
    botUsername: telegramBotUsernameFromBody(body),
  };
  if (approved.toolName === "create_mandate_with_saved_card") {
    const intent = telegramMandateIntent(approved.args);
    const session = await createPravaMandateForUser(userId, {
      ...intent,
      paymentMethodId: approved.args.paymentMethodId,
      returnContext,
    });
    return {
      stage: "mandate_approval",
      mandate: intent,
      approvalUrl: session.approvalUrl,
      nextAction: {
        type: "prava_mandate_approval",
        label: "Approve mandate with Prava",
        url: session.approvalUrl,
      },
      session,
    };
  }
  if (approved.toolName !== "create_mandate_with_new_card") {
    throw Object.assign(new Error("This is not a mandate card choice"), {
      status: 400,
    });
  }
  const intent = telegramMandateIntent(approved.args);
  const methods = await syncPravaPaymentMethodsForUser(userId);
  const session = await createTokenizationSessionForUser(userId, {
    returnContext,
  });
  await db.saveTelegramMandateFlow(chatId, userId, {
    ...intent,
    botUsername: returnContext.botUsername,
    providerPaymentMethodIdsBefore: methods
      .map((method) => method.provider_payment_method_id)
      .filter(Boolean),
    tokenizationSessionId: session.sessionId,
    expiresAt: session.expiresAt,
    createdAt: new Date().toISOString(),
  });
  return {
    stage: "card_approval",
    mandate: intent,
    approvalUrl: session.approvalUrl,
    autoCreateMandateAfterCard: true,
    nextAction: {
      type: "prava_card_enrollment",
      label: "Add card securely with Prava",
      url: session.approvalUrl,
    },
    session,
  };
}

async function resumeTelegramMandateAfterCard(userId, chatId) {
  const pending = await db.getTelegramMandateFlow(chatId, userId);
  if (!pending) {
    throw Object.assign(new Error("No pending Telegram mandate setup was found"), {
      status: 404,
    });
  }
  const expiry = new Date(pending.expiresAt || "").getTime();
  if (Number.isFinite(expiry) && expiry < Date.now()) {
    await db.clearTelegramMandateFlow(chatId, userId);
    throw Object.assign(
      new Error("The pending card setup expired. Start mandate setup again."),
      { status: 410 }
    );
  }
  const before = new Set(
    (Array.isArray(pending.providerPaymentMethodIdsBefore)
      ? pending.providerPaymentMethodIdsBefore
      : []).map(String)
  );
  let selected = null;
  for (let attempt = 0; attempt < 4 && !selected; attempt += 1) {
    const methods = await syncPravaPaymentMethodsForUser(userId);
    selected = methods.find(
      (method) =>
        method.provider_payment_method_id
        && !before.has(String(method.provider_payment_method_id))
    ) || null;
    if (!selected && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  if (!selected) {
    throw Object.assign(
      new Error(
        "The new card is not available yet. Finish Prava card setup, then return to this chat again."
      ),
      { status: 409 }
    );
  }
  const intent = telegramMandateIntent(pending);
  const session = await createPravaMandateForUser(userId, {
    ...intent,
    paymentMethodId: selected.id,
    returnContext: {
      channel: "telegram",
      botUsername: telegramBotUsername(pending.botUsername),
    },
  });
  await db.clearTelegramMandateFlow(chatId, userId);
  return {
    stage: "mandate_approval",
    mandate: intent,
    paymentMethod: publicPaymentMethod(selected),
    approvalUrl: session.approvalUrl,
    nextAction: {
      type: "prava_mandate_approval",
      label: "Approve mandate with Prava",
      url: session.approvalUrl,
    },
    session,
  };
}

async function completePaymentSetup(userId, sessionId, enrollmentId) {
  if (
    typeof sessionId !== "string" ||
    !/^sess?_[A-Za-z0-9_-]+$/.test(sessionId) ||
    typeof enrollmentId !== "string" ||
    enrollmentId.length < 3 ||
    enrollmentId.length > 255
  ) {
    throw Object.assign(
      new Error("A valid Prava sessionId and enrollmentId are required"),
      { status: 400 }
    );
  }
  const [customer, tokenizationSession] = await Promise.all([
    db.getPaymentCustomer(userId),
    db.getPaymentTokenizationSession(userId, "prava", sessionId),
  ]);
  if (!customer || customer.provider !== "prava") {
    throw Object.assign(new Error("No Prava customer exists for this user"), {
      status: 409,
    });
  }
  if (!tokenizationSession) {
    throw Object.assign(new Error("Prava tokenization session is invalid or expired"), {
      status: 403,
    });
  }
  const paymentMethod = await payments.retrieveEnrolledCard(
    customer.provider_customer_id,
    enrollmentId,
    { attempts: 10, delayMs: 1_000 }
  );
  const saved = await db.savePaymentMethod(
    userId,
    "prava",
    customer.provider_customer_id,
    paymentMethod
  );
  await db.completePaymentTokenizationSession(userId, "prava", sessionId);
  await payments.revokeSession(sessionId).catch((error) => {
    console.warn(
      `[payments] Card was saved but Prava session ${sessionId} could not be revoked:`,
      error.message
    );
  });
  return publicPaymentMethod(saved);
}

async function toolRoute(req, res, platformSlug, toolName, args) {
  try {
    sendJson(
      res,
      200,
      await auth.withPlatformTool(req, platformSlug, toolName, args)
    );
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
}

function zeptoResultText(value) {
  return typeof value === "string" ? value : JSON.stringify(value || {});
}

function requireSuccessfulZeptoTool(value, toolName) {
  const directError =
    value?.error?.message ||
    value?.error ||
    value?.data?.error?.message ||
    value?.data?.error;
  const text = zeptoResultText(value).trim();
  const textError = text.match(/^(?:Error|Failed|Failure):\s*(.+)$/is)?.[1];
  if (directError || textError) {
    throw Object.assign(
      new Error(String(directError || textError).trim()),
      { status: 422, toolName }
    );
  }
  return value;
}

function zeptoAddressId(value) {
  const direct =
    value?.addressId ||
    value?.address_id ||
    value?.userAddressId ||
    value?.user_address_id ||
    value?.address?.id ||
    value?.address?.addressId ||
    value?.data?.addressId ||
    value?.data?.address_id ||
    value?.result?.addressId ||
    value?.result?.address_id;
  return String(
    direct ||
    zeptoResultText(value).match(
      /\b(?:user\s+)?address\s+id\s*:\s*["']?([a-z0-9-]+)/i
    )?.[1] ||
    ""
  ).trim() || null;
}

function zeptoOrderId(value) {
  const text = zeptoResultText(value);
  return (
    value?.orderId ||
    value?.order_id ||
    value?.id ||
    value?.order?.id ||
    value?.order?.orderId ||
    value?.data?.orderId ||
    value?.data?.order_id ||
    value?.data?.id ||
    value?.result?.orderId ||
    value?.result?.order_id ||
    value?.result?.id ||
    text.match(/Order\s*ID:\s*\**\s*([A-Za-z0-9_-]+)/i)?.[1] ||
    null
  );
}

function zeptoPaymentLink(value) {
  const supplied =
    value?.paymentLink ||
    value?.paymentUrl ||
    value?.payment_url ||
    value?.url ||
    value?.order?.paymentLink ||
    value?.order?.paymentUrl ||
    value?.data?.paymentLink ||
    value?.data?.paymentUrl ||
    value?.result?.paymentLink ||
    value?.result?.paymentUrl;
  const matched =
    zeptoResultText(value).match(/https?:\/\/[^\s<>"']+/i)?.[0] || "";
  const link = String(supplied || matched).replace(/[)\].,]+$/, "");
  return /^https:\/\//i.test(link) ? link : null;
}

function zeptoOrderRows(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (
      value.some((entry) =>
        entry &&
        typeof entry === "object" &&
        (entry.id || entry.orderId || entry.order_id || entry.code)
      )
    ) {
      return value;
    }
    for (const entry of value) {
      const nested = zeptoOrderRows(entry, depth + 1);
      if (nested.length) return nested;
    }
    return [];
  }
  if (typeof value !== "object") return [];
  for (const key of ["orders", "items", "data", "result", "history"]) {
    if (value[key] !== undefined) {
      const nested = zeptoOrderRows(value[key], depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}

function zeptoOrderRowId(order) {
  return order?.id || order?.orderId || order?.order_id || null;
}

function zeptoPaymentStatus(value) {
  const direct =
    value?.paymentStatus ||
    value?.status ||
    value?.data?.paymentStatus ||
    value?.data?.status;
  if (direct) return String(direct).toUpperCase();
  const text = zeptoResultText(value).toUpperCase();
  return (
    [
      "CANCELLED",
      "CANCELED",
      "FAILED",
      "SUCCESS",
      "COMPLETED",
      "PAID",
      "PENDING",
      "PROCESSING",
    ].find((status) => text.includes(status)) || "UNKNOWN"
  );
}

function checkoutId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id
    )
  ) {
    throw Object.assign(new Error("A valid checkoutId is required"), {
      status: 400,
    });
  }
  return id;
}

function merchantOrderInput(input, confirmOrder) {
  return {
    userAddressId: String(input.userAddressId || "").trim(),
    confirmOrder,
    useZeptoCash: input.useZeptoCash === true,
    riderTip: Number.isFinite(Number(input.riderTip))
      ? Number(input.riderTip)
      : 0,
  };
}

function checkoutFlow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    addressId: row.address_id,
    card: row.card_last4
      ? { brand: row.card_brand || "Card", last4: row.card_last4 }
      : null,
    cardFailureCount: Number(row.card_failure_count || 0),
    cardPaymentReceived: row.card_payment_received === true,
    allowCodFallback: row.allow_cod_fallback !== false,
    fallbackToCod: row.fallback_to_cod === true,
    paymentRoute: row.payment_route || null,
    sandboxPaymentAttempt: row.sandbox_payment_attempt === true,
    cardOrderId: row.card_order_id,
    orderId: row.zepto_order_id,
    pravaCharge: row.prava_mandate_id
      ? {
          mandateId: row.prava_mandate_id,
          transactionId: row.prava_transaction_id,
          reference: row.prava_charge_reference,
          status: row.prava_charge_status,
          amount: row.prava_charge_amount,
          currency: "INR",
          reportedAt: row.prava_charge_reported_at,
        }
      : null,
    pravaSession: row.prava_session_id
      ? {
          sessionId: row.prava_session_id,
          approvalUrl: row.prava_session_approval_url || null,
        }
      : null,
    priceBreakdown: row.price_breakdown || {},
    cartItems: Array.isArray(row.cart_snapshot)
      ? row.cart_snapshot.map((item) => ({
          name: item.name || item.label || "Item",
          quantity: Number(item.quantity || 0),
        }))
      : [],
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function redactedPravaResult(value) {
  if (Array.isArray(value)) return value.map(redactedPravaResult);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const normalized = key.replace(/[_-]/g, "").toLowerCase();
      if (
        [
          "token",
          "pan",
          "cardnumber",
          "dynamiccvv",
          "cvv",
          "cryptogram",
        ].includes(normalized)
      ) {
        return [key, entry ? "[REDACTED]" : entry];
      }
      return [key, redactedPravaResult(entry)];
    })
  );
}

function pravaResultSnapshot(row, extra = {}) {
  if (
    !row?.prava_mandate_id
    && !row?.prava_session_id
    && !extra.sessionResult
  ) return null;
  return {
    provider: "prava",
    environment: payments.configuration().environment,
    flow: row?.prava_mandate_id
      ? "mandate_charge"
      : row?.payment_route === "prava_card"
        ? "card_payment_session"
        : "tokenization_session",
    checkoutId: row?.id || null,
    mandateId: row?.prava_mandate_id || null,
    transactionId: row?.prava_transaction_id || null,
    sessionId: row?.prava_session_id || null,
    reference: row?.prava_charge_reference || null,
    amount: row?.prava_charge_amount || null,
    currency: row?.prava_charge_amount ? "INR" : null,
    chargeStatus: row?.prava_charge_status || null,
    reportedAt: row?.prava_charge_reported_at || null,
    credentialIssued: Boolean(row?.prava_transaction_id),
    merchantPaymentStatus: extra.merchantPaymentStatus || null,
    reportResult: extra.reportResult
      ? redactedPravaResult(extra.reportResult)
      : null,
    mandateResult: extra.mandateResult || null,
    sessionResult: extra.sessionResult
      ? redactedPravaResult(extra.sessionResult)
      : null,
    note:
      "Prava mandate charges return a one-time credential from the charge API. " +
      "The session payment-result API applies to Prava payment sessions; " +
      "the credential values are redacted from this diagnostic result.",
  };
}

function flowRecord(row, changes = {}) {
  const changed = (key, current) =>
    Object.hasOwn(changes, key) ? changes[key] : current;
  return {
    id: row.id,
    userId: Number(row.user_id),
    platform: row.platform || "zepto",
    status: changes.status ?? row.status,
    addressId: changes.addressId ?? row.address_id,
    cardBrand: changes.cardBrand ?? row.card_brand,
    cardLast4: changes.cardLast4 ?? row.card_last4,
    cardFailureCount:
      changes.cardFailureCount ?? Number(row.card_failure_count || 0),
    cardPaymentReceived:
      changes.cardPaymentReceived ?? row.card_payment_received === true,
    allowCodFallback:
      changes.allowCodFallback ?? row.allow_cod_fallback !== false,
    fallbackToCod:
      changes.fallbackToCod ?? row.fallback_to_cod === true,
    paymentRoute:
      changes.paymentRoute ?? row.payment_route,
    sandboxPaymentAttempt:
      changes.sandboxPaymentAttempt ?? row.sandbox_payment_attempt === true,
    cardOrderId: changed("cardOrderId", row.card_order_id),
    zeptoOrderId: changed("zeptoOrderId", row.zepto_order_id),
    lastFailedOrderId:
      changed("lastFailedOrderId", row.last_failed_order_id),
    pravaMandateId:
      changed("pravaMandateId", row.prava_mandate_id),
    pravaTransactionId:
      changed("pravaTransactionId", row.prava_transaction_id),
    pravaChargeReference:
      changed("pravaChargeReference", row.prava_charge_reference),
    pravaChargeStatus:
      changed("pravaChargeStatus", row.prava_charge_status),
    pravaChargeAmount:
      changed("pravaChargeAmount", row.prava_charge_amount),
    pravaChargeReportedAt:
      changed("pravaChargeReportedAt", row.prava_charge_reported_at),
    pravaSessionId:
      changed("pravaSessionId", row.prava_session_id),
    pravaSessionApprovalUrl:
      changed("pravaSessionApprovalUrl", row.prava_session_approval_url),
    priceBreakdown: changes.priceBreakdown ?? row.price_breakdown ?? {},
    cartSnapshot: changes.cartSnapshot ?? row.cart_snapshot ?? [],
    failureMessage: changed("failureMessage", row.failure_message),
  };
}

function pravaPaymentHandoff(row, charge, options = {}) {
  if (!row?.id || !charge?.credentials) return null;
  const sandbox = options.sandbox === true;
  const zeptoAttempt = options.zeptoAttempt === true;
  return {
    mode: "prava_mandate",
    provider: "prava",
    sandbox,
    mandateId: charge.mandateId,
    transactionId: charge.transactionId,
    amount: row.prava_charge_amount,
    currency: "INR",
    credentials: charge.credentials,
    card: row.card_last4
      ? {
          brand: row.card_brand || "Card",
          last4: row.card_last4,
        }
      : null,
    destination: sandbox && !zeptoAttempt
      ? "sandbox_inspection_only"
      : "zepto_secure_payment_link",
    sentToZepto: false,
    requiresManualEntry: !sandbox || zeptoAttempt,
    automaticInsertion: false,
    automationReason:
      "Prava's documented Browser Harness requires a Shopify UCP checkout. " +
      "The Zepto MCP hosted-payment API does not accept card credentials.",
    storage: "memory_only",
  };
}

function pravaSessionPaymentHandoff(row, payment, options = {}) {
  if (!row?.id || !row?.prava_session_id || !payment?.credentials) return null;
  return {
    mode: "prava_card",
    provider: "prava",
    sandbox: options.sandbox === true,
    sessionId: row.prava_session_id,
    transactionId: payment.transactionId,
    amount: row.prava_charge_amount,
    currency: "INR",
    credentials: payment.credentials,
    card: row.card_last4
      ? { brand: row.card_brand || "Card", last4: row.card_last4 }
      : null,
    destination: "zepto_secure_payment_link",
    sentToZepto: false,
    requiresManualEntry: true,
    automaticInsertion: false,
    automationReason:
      "Zepto MCP returns a hosted payment page but no card-credential input.",
    storage: "memory_only",
  };
}

function positiveBreakdownAmount(breakdown) {
  const totalPaise = Number(breakdown?.totalPaise);
  if (!Number.isFinite(totalPaise) || totalPaise <= 0) return null;
  return (Math.round(totalPaise) / 100).toFixed(2);
}

async function exactZeptoOrderBreakdown(req, confirmed) {
  const candidates = [];
  if (confirmed.orderId) {
    const orderDetail = await auth.withPlatformTool(
      req,
      "zepto",
      "get_order_detail",
      { orderId: confirmed.orderId }
    ).catch(() => null);
    if (orderDetail) candidates.push(orderDetail);
  }
  candidates.push(confirmed.merchantResult);
  for (const candidate of candidates) {
    const breakdown = checkout.zeptoPriceBreakdown(candidate);
    if (positiveBreakdownAmount(breakdown)) return breakdown;
  }
  throw Object.assign(
    new Error(
      "Zepto did not return a positive final payable amount. Tokko did not request a Prava credential."
    ),
    { status: 409 }
  );
}

function zeptoPurchaseContext(row, amount) {
  const products = (Array.isArray(row.cart_snapshot) ? row.cart_snapshot : [])
    .map((item, index) => {
      const unitPrice = Number(item?.price);
      const quantity = Math.max(1, Math.round(Number(item?.quantity || 1)));
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
      return {
        description: String(item.name || item.label || "Zepto item").slice(
          0,
          200
        ),
        unit_price: (unitPrice / 100).toFixed(2),
        product_id: String(
          item.productVariantId || `zepto_item_${index + 1}`
        ).slice(0, 50),
        quantity,
      };
    })
    .filter(Boolean);
  return [{
    merchant_details: {
      name: process.env.PRAVA_ZEPTO_MERCHANT_NAME || "Zepto",
      url:
        process.env.PRAVA_ZEPTO_MERCHANT_URL ||
        "https://www.zeptonow.com",
      country_code_iso2:
        process.env.PRAVA_ZEPTO_MERCHANT_COUNTRY_CODE || "IN",
    },
    product_details: products.length
      ? products
      : [{
          description: "Zepto grocery order",
          unit_price: amount,
          product_id: `zepto_${String(row.id).replace(/-/g, "").slice(0, 32)}`,
          quantity: 1,
        }],
  }];
}

function usablePravaMandatesForAmount(mandates, amount) {
  const amountValue = Number(amount);
  return (Array.isArray(mandates) ? mandates : [])
    .filter((mandate) => {
      const remaining = Number(
        mandate.remaining ?? mandate.approvedAmount
      );
      const active =
        String(mandate.status || "").toLowerCase() === "active"
        || String(mandate.state || "").toLowerCase() === "available";
      const zeptoScoped =
        !mandate.merchantName || /zepto/i.test(mandate.merchantName);
      return (
        active
        && zeptoScoped
        && String(mandate.currency || "").toUpperCase() === "INR"
        && Number.isFinite(remaining)
        && remaining >= amountValue
      );
    })
    .sort(
      (left, right) =>
        Number(left.remaining ?? left.approvedAmount)
        - Number(right.remaining ?? right.approvedAmount)
    );
}

function merchantIdentityMatches(mandate, merchantName, merchantUrl) {
  if (String(mandate?.merchantScope || "").toLowerCase() === "any") return true;
  const configured = String(mandate?.merchantName || "").trim().toLowerCase();
  if (!configured) return true;
  const requestedName = String(merchantName || "").trim().toLowerCase();
  let requestedHost = "";
  try {
    requestedHost = new URL(String(merchantUrl || "")).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    requestedHost = "";
  }
  const compact = (value) => value.replace(/[^a-z0-9]/g, "");
  return (
    compact(configured) === compact(requestedName)
    || (requestedHost && compact(configured) === compact(requestedHost))
    || (requestedName && compact(configured).includes(compact(requestedName)))
  );
}

function usablePravaMandatesForMerchant(mandates, amount, merchantName, merchantUrl) {
  const amountValue = Number(amount);
  return (Array.isArray(mandates) ? mandates : [])
    .filter((mandate) => {
      const remaining = Number(mandate.remaining ?? mandate.approvedAmount);
      const active =
        String(mandate.status || "").toLowerCase() === "active"
        || String(mandate.state || "").toLowerCase() === "available";
      return (
        active
        && String(mandate.currency || "").toUpperCase() === "INR"
        && Number.isFinite(remaining)
        && remaining >= amountValue
        && merchantIdentityMatches(mandate, merchantName, merchantUrl)
      );
    })
    .sort(
      (left, right) =>
        Number(left.remaining ?? left.approvedAmount)
        - Number(right.remaining ?? right.approvedAmount)
    );
}

function ucpPurchaseContext(checkoutResult) {
  const quantity = Math.max(1, Math.round(Number(checkoutResult.quantity || 1)));
  const resolvedUnitPrice = Number(checkoutResult.totalAmount || 0) / quantity;
  const productId = nodeCrypto
    .createHash("sha256")
    .update(String(checkoutResult.variantId || checkoutResult.checkoutId || "ucp-product"))
    .digest("hex")
    .slice(0, 40);
  return [{
    merchant_details: {
      name: String(checkoutResult.merchantName || "UCP merchant").slice(0, 200),
      url: checkoutResult.merchantUrl,
      country_code_iso2: "IN",
    },
    product_details: [{
      description: [checkoutResult.productName, checkoutResult.variantName]
        .filter(Boolean)
        .join(" - ")
        .slice(0, 200),
      unit_price: resolvedUnitPrice.toFixed(2),
      product_id: `ucp_${productId}`,
      quantity,
    }],
  }];
}

function pravaUcpPaymentHandoff(checkoutResult, charge) {
  return {
    mode: "prava_mandate",
    provider: "prava",
    sandbox: payments.configuration().environment !== "production",
    mandateId: charge.mandateId,
    transactionId: charge.transactionId,
    amount: checkoutResult.totalAmount,
    currency: checkoutResult.currency,
    credentials: charge.credentials,
    destination: "shopify_ucp_checkout_handoff",
    sentToMerchant: false,
    requiresManualEntry: true,
    automaticInsertion: false,
    automationReason:
      "The public Prava mandate Charge API mints the token, while its Browser Harness checkout endpoint is not part of the public REST API used by Tokko.",
    storage: "memory_only",
  };
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) =>
      entry !== null && entry !== undefined && String(entry).trim() !== ""
    )
  );
}

function splitContactName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ") || null,
  };
}

function structuredIndianAddress(address) {
  const formatted = String(address?.formatted_address || "").trim();
  const parts = formatted.split(",").map((part) => part.trim()).filter(Boolean);
  const countryCode = String(address?.country_code || "IN").trim().toUpperCase();
  const postalPattern = countryCode === "US"
    ? /\b\d{5}(?:-\d{4})?\b/
    : /\b[1-9]\d{5}\b/;
  const postalCode = String(address?.postal_code || "").trim()
    || formatted.match(postalPattern)?.[0]
    || null;
  const suppliedState = String(address?.state || "").trim();
  const inferredState = !suppliedState && parts.length > 1
    ? parts.at(-1).replace(postalCode || "", "").trim()
    : null;
  let locality = String(address?.city || "").trim();
  let localityParts = locality
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!locality || (postalCode && locality.includes(postalCode)) || locality.includes(",")) {
    localityParts = (locality || formatted)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const postalIndex = localityParts.findIndex((part) =>
      postalCode && part.includes(postalCode)
    );
    const candidate = postalIndex >= 0
      ? localityParts[postalIndex]
      : localityParts.length > 1
        ? localityParts.at(-2)
        : localityParts[0];
    locality = String(candidate || "").replace(postalCode || "", "").trim();
  }
  const localityPostalIndex = localityParts.findIndex((part) =>
    postalCode && part.includes(postalCode)
  );
  const areaParts = localityPostalIndex > 0
    ? localityParts.slice(0, localityPostalIndex)
    : [];
  const addressLine1 = String(address?.address_line1 || "").trim();
  const addressLine2 = String(address?.address_line2 || "").trim();
  const extendedAddress = [...new Set([addressLine2, ...areaParts].filter(Boolean))]
    .join(", ") || null;
  return {
    streetAddress: addressLine1 || formatted,
    extendedAddress,
    locality: locality || null,
    state: suppliedState || inferredState || null,
    postalCode,
    countryCode,
  };
}

function ucpCheckoutIdentity(user, profile, address) {
  if (!address) {
    throw Object.assign(
      new Error("Select a Trakko delivery address before creating checkout"),
      { status: 409 }
    );
  }
  const contactName =
    address.contact_name
    || profile?.primary_parent_name
    || String(user?.email || "").split("@")[0];
  const { firstName, lastName } = splitContactName(contactName);
  const phone =
    address.contact_phone
    || profile?.primary_parent_phone
    || null;
  const structuredAddress = structuredIndianAddress(address);
  const buyer = compactObject({
    first_name: firstName,
    last_name: lastName,
    email: user?.email || null,
    phone_number: phone,
  });
  const destination = compactObject({
    id: `tokko_address_${address.id}`,
    first_name: firstName,
    last_name: lastName,
    street_address: structuredAddress.streetAddress,
    extended_address: structuredAddress.extendedAddress,
    address_locality: structuredAddress.locality,
    address_region: structuredAddress.state,
    postal_code: structuredAddress.postalCode,
    address_country: structuredAddress.countryCode,
    phone_number: phone,
  });
  return {
    buyer,
    destination,
    autofill: {
      submitted: true,
      addressId: String(address.id),
      addressLabel: address.label || null,
      formattedAddress: address.formatted_address,
      email: user?.email || null,
      phoneLast4: phone ? String(phone).replace(/\D/g, "").slice(-4) : null,
    },
  };
}

function publicUcpCard(card) {
  return {
    id: String(card.id),
    brand: card.brand || "card",
    last4: card.last4,
    isDefault: card.is_default === true || card.isDefault === true,
  };
}

function publicUcpCheckoutSummary(checkout) {
  if (!checkout) return null;
  return {
    currency: checkout.currency || "INR",
    totalAmount: checkout.totalAmount || null,
    cartTotalAmount: checkout.cartTotalAmount || checkout.totalAmount || null,
    merchantTotalAmount: checkout.merchantTotalAmount || null,
    shippingAmount: checkout.shippingAmount || "0.00",
    forexAmount: checkout.forexAmount || "0.00",
    forex: checkout.forex || null,
    totals: Array.isArray(checkout.totals) ? checkout.totals : [],
    shippingOptions: Array.isArray(checkout.shippingOptions)
      ? checkout.shippingOptions
      : [],
    shippingQuoted: checkout.shippingQuoted === true,
    destinationSelected: checkout.destinationSelected === true,
    phoneAccepted: checkout.phoneAccepted === true,
    autofill: checkout.autofill || null,
    reconciles: checkout.reconciles,
  };
}

function ucpSavedCardResult(userId, baseResult, mandateCheck, cards) {
  const values = Array.isArray(cards) ? cards : [];
  if (!values.length) {
    return {
      ...baseResult,
      mandateCheck,
      paymentSelection: {
        policy: "active_mandate_then_saved_card",
        selected: false,
        merchantInstrumentSelected: false,
        reason: "no_eligible_mandate_or_saved_card",
      },
    };
  }
  return {
    ...baseResult,
    paymentRoute: "card_selection_required",
    mandateCheck: {
      ...mandateCheck,
      status: mandateCheck.status === "charge_failed"
        ? "charge_failed_card_selection_required"
        : "card_selection_required",
    },
    savedCards: values.map(publicUcpCard),
    cardChoices: values.map((card) => ({
      ...publicUcpCard(card),
      token: hermes.signApproval({
        userId,
        toolName: "select_ucp_saved_card",
        args: {
          checkoutId: baseResult.checkoutId,
          merchant: baseResult.merchant,
          merchantName: baseResult.merchantName,
          merchantHandoffUrl: baseResult.merchantHandoffUrl,
          totalAmount: baseResult.totalAmount,
          currency: baseResult.currency,
          paymentMethodId: String(card.id),
        },
      }),
    })),
    paymentSelection: {
      policy: "active_mandate_then_saved_card",
      required: true,
      selected: false,
      route: "prava_card",
      merchantInstrumentSelected: false,
      reason: "eligible_mandate_unavailable_choose_a_saved_card",
    },
  };
}

async function selectUcpSavedCard(userId, token) {
  const approved = hermes.verifyApproval(token, userId);
  if (approved.toolName !== "select_ucp_saved_card") {
    throw Object.assign(new Error("This is not a saved-card selection"), {
      status: 400,
    });
  }
  const input = approved.args;
  const methods = await syncPravaPaymentMethodsForUser(userId);
  const selected = methods.find((method) =>
    String(method.id) === String(input.paymentMethodId)
  );
  if (!selected) {
    throw Object.assign(new Error("This saved Prava card is no longer available"), {
      status: 404,
    });
  }
  if (!/^https:\/\//.test(String(input.merchantHandoffUrl || ""))) {
    throw Object.assign(new Error("The merchant checkout link is no longer valid"), {
      status: 409,
    });
  }
  const savedCard = publicUcpCard(selected);
  const paymentSelection = {
    policy: "active_mandate_then_saved_card",
    selected: true,
    route: "prava_card",
    displayLabel: `${savedCard.brand} •••• ${savedCard.last4}`,
    merchantInstrumentSelected: false,
    reason: "merchant_did_not_advertise_a_prava_compatible_payment_handler",
  };
  return {
    checkoutId: input.checkoutId,
    merchant: input.merchant,
    merchantName: input.merchantName,
    merchantHandoffUrl: input.merchantHandoffUrl,
    totalAmount: input.totalAmount,
    currency: input.currency,
    paymentRoute: "prava_card",
    savedCard,
    paymentSelection,
    nextAction: {
      type: "merchant_ucp_checkout",
      label: `Continue to ${input.merchantName} checkout`,
      url: input.merchantHandoffUrl,
      paymentSelection,
    },
  };
}

const UCP_FOREX_RATE_PERCENT = 3;

function withUcpCheckoutCharges(checkoutResult) {
  const value = checkoutResult || {};
  const amount = (candidate) => {
    const number = Math.round(Number(candidate));
    return Number.isFinite(number) ? number : 0;
  };
  const subtotalMinor = amount(value.subtotalMinor || value.itemsSubtotalMinor);
  const shippingMinor = amount(value.shippingMinor);
  const taxMinor = amount(value.taxMinor);
  const feeMinor = amount(value.feeMinor);
  const discountMinor = amount(value.discountMinor);
  const discountAdjustment = discountMinor > 0 ? -discountMinor : discountMinor;
  const componentTotalMinor = subtotalMinor
    ? subtotalMinor + shippingMinor + taxMinor + feeMinor + discountAdjustment
    : 0;
  const merchantTotalMinor = Math.max(
    amount(value.totalMinor),
    componentTotalMinor
  );
  if (merchantTotalMinor <= 0) {
    throw Object.assign(new Error("Merchant checkout total is unavailable"), {
      status: 502,
    });
  }
  const forexMinor = Math.round(
    merchantTotalMinor * UCP_FOREX_RATE_PERCENT / 100
  );
  const cartTotalMinor = merchantTotalMinor + forexMinor;
  const totals = (Array.isArray(value.totals) ? value.totals : [])
    .filter((entry) => !["total", "forex"].includes(String(entry?.type || "")));
  if (!totals.some((entry) => entry.type === "fulfillment")) {
    totals.push({
      type: "fulfillment",
      label: "Total shipping",
      amountMinor: shippingMinor,
    });
  }
  totals.push({
    type: "forex",
    label: `Forex charge (${UCP_FOREX_RATE_PERCENT}%)`,
    amountMinor: forexMinor,
  });
  totals.push({
    type: "total",
    label: "Cart total payable",
    amountMinor: cartTotalMinor,
  });
  return {
    ...value,
    totals,
    merchantTotalMinor,
    merchantTotalAmount: (merchantTotalMinor / 100).toFixed(2),
    shippingMinor,
    shippingAmount: (shippingMinor / 100).toFixed(2),
    forexMinor,
    forexAmount: (forexMinor / 100).toFixed(2),
    forex: {
      appliedByTokko: true,
      ratePercent: UCP_FOREX_RATE_PERCENT,
      baseAmountMinor: merchantTotalMinor,
      amountMinor: forexMinor,
    },
    totalMinor: cartTotalMinor,
    totalAmount: (cartTotalMinor / 100).toFixed(2),
    cartTotalMinor,
    cartTotalAmount: (cartTotalMinor / 100).toFixed(2),
    reconciles: true,
  };
}

async function createUcpCheckoutQuote(userId, input = {}) {
  const [user, profile, addresses] = await Promise.all([
    db.getUserById(userId),
    db.getProfile(userId),
    db.getFamilyAddresses(userId),
  ]);
  const selectedAddress = addresses.find((address) => address.is_selected) || null;
  const checkoutIdentity = ucpCheckoutIdentity(user, profile, selectedAddress);
  const selectionInput = Array.isArray(input.items)
    ? input.items.map((item) => ({
        selectionToken: item?.selectionToken,
        quantity: item?.quantity,
      }))
    : input.selectionToken;
  const merchantCheckout = await ucp.createCheckout(selectionInput, {
    quantity: input.quantity,
    baseUrl: BASE_URL,
    buyer: checkoutIdentity.buyer,
    destination: checkoutIdentity.destination,
  });
  const checkoutResult = withUcpCheckoutCharges(merchantCheckout);
  const merchantHandoffUrl = checkoutResult.continueUrl;
  const baseResult = {
    ...checkoutResult,
    merchantHandoffUrl,
    paymentUrl: null,
    paymentLink: null,
    paymentUrlAvailable: false,
    paymentUrlStatus: "not_returned_by_shopify_ucp_general_access",
    paymentRoute: "merchant_checkout",
    paymentHandoff: null,
    autofill: checkoutIdentity.autofill,
    paymentSelection: {
      policy: "active_mandate_then_saved_card",
      selected: false,
      merchantInstrumentSelected: false,
      reason: "payment_route_not_resolved",
    },
    mandateCheck: {
      checked: false,
      checkedMandateCount: 0,
      activeMandateCount: 0,
      eligibleMandateCount: 0,
      status: "not_checked",
    },
  };
  return baseResult;
}

async function resolveUcpCheckoutPayment(userId, baseResult) {
  const checkoutResult = baseResult;
  const merchantHandoffUrl = checkoutResult.merchantHandoffUrl;
  if (!payments.configuration().configured) {
    return {
      ...baseResult,
      mandateCheck: {
        ...baseResult.mandateCheck,
        status: "prava_not_configured",
      },
    };
  }
  const savedCards = await syncPravaPaymentMethodsForUser(userId);
  let identity;
  try {
    identity = await pravaMandateIdentity(userId);
  } catch (error) {
    return ucpSavedCardResult(
      userId,
      baseResult,
      {
        ...baseResult.mandateCheck,
        status: "no_prava_customer",
        message: error.message,
      },
      savedCards
    );
  }
  let mandates;
  try {
    mandates = await payments.listMandates(identity.customerId);
  } catch (error) {
    return ucpSavedCardResult(
      userId,
      baseResult,
      {
        ...baseResult.mandateCheck,
        checked: true,
        status: "check_failed",
        message: error.message,
      },
      savedCards
    );
  }
  const active = mandates.filter((mandate) =>
    String(mandate.status || "").toLowerCase() === "active"
    || String(mandate.state || "").toLowerCase() === "available"
  );
  const eligible = usablePravaMandatesForMerchant(
    mandates,
    checkoutResult.totalAmount,
    checkoutResult.merchantName,
    checkoutResult.merchantUrl
  );
  const mandateCheck = {
    checked: true,
    checkedMandateCount: mandates.length,
    activeMandateCount: active.length,
    eligibleMandateCount: eligible.length,
    status: eligible.length ? "eligible_mandate_found" : "no_eligible_mandate",
  };
  if (!eligible.length) {
    return ucpSavedCardResult(userId, baseResult, mandateCheck, savedCards);
  }

  const selectedMandate = eligible[0];
  const chargeReference = `tokko_ucp_${nodeCrypto
    .createHash("sha256")
    .update(`${checkoutResult.checkoutId}:${selectedMandate.id}`)
    .digest("hex")
    .slice(0, 40)}`;
  let charge;
  try {
    charge = await payments.chargeMandate({
      mandateId: selectedMandate.id,
      amount: checkoutResult.totalAmount,
      reference: chargeReference,
      purchaseContext: ucpPurchaseContext(checkoutResult),
    });
  } catch (error) {
    return ucpSavedCardResult(
      userId,
      baseResult,
      {
        ...mandateCheck,
        status: "charge_failed",
        selectedMandateId: selectedMandate.id,
        message: error.message,
      },
      savedCards
    );
  }
  const paymentHandoff = pravaUcpPaymentHandoff(checkoutResult, charge);
  return {
    ...baseResult,
    paymentRoute: "mandate",
    paymentHandoff,
    paymentSelection: {
      policy: "active_mandate_then_saved_card",
      selected: true,
      route: "mandate",
      displayLabel: "Active Prava mandate",
      merchantInstrumentSelected: false,
      reason: "merchant_did_not_advertise_a_prava_compatible_payment_handler",
    },
    mandateCheck: {
      ...mandateCheck,
      status: "credential_issued",
      selectedMandateId: charge.mandateId,
      transactionId: charge.transactionId,
      deduplicated: charge.deduplicated === true,
    },
    nextAction: {
      type: "merchant_ucp_checkout",
      label: `Continue to ${checkoutResult.merchantName} checkout`,
      url: merchantHandoffUrl,
      paymentHandoff,
    },
  };
}

async function createUcpCheckoutWithPayment(userId, input = {}) {
  return resolveUcpCheckoutPayment(
    userId,
    await createUcpCheckoutQuote(userId, input)
  );
}

const MANDATE_DISPLAY_LIMIT = 5;
const MANDATE_HISTORY_DAYS = 30;

function mandateActivityTime(mandate) {
  const values = [
    mandate?.updatedAt,
    mandate?.createdAt,
    mandate?.lastCharge?.at,
    ...(Array.isArray(mandate?.charges)
      ? mandate.charges.map((charge) => charge?.createdAt)
      : []),
  ]
    .map((value) => new Date(value || "").getTime())
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function mandateStatusPriority(mandate) {
  const status = String(mandate?.status || "").toLowerCase();
  const state = String(mandate?.state || "").toLowerCase();
  if (status === "active" || state === "available") return 0;
  if (["pending", "requires_action", "processing"].includes(status)) return 1;
  return 2;
}

function sortedMandatesForDisplay(values) {
  return (Array.isArray(values) ? values : [])
    .map((mandate, index) => ({ mandate, index }))
    .sort((left, right) => {
      const priority =
        mandateStatusPriority(left.mandate) -
        mandateStatusPriority(right.mandate);
      if (priority) return priority;
      const leftTime = mandateActivityTime(left.mandate);
      const rightTime = mandateActivityTime(right.mandate);
      if (leftTime !== null || rightTime !== null) {
        return Number(rightTime || 0) - Number(leftTime || 0);
      }
      return left.index - right.index;
    })
    .map(({ mandate }) => mandate);
}

function publicMandateSummary(values) {
  const all = Array.isArray(values) ? values : [];
  const active = all.filter((mandate) =>
    String(mandate?.status || "").toLowerCase() === "active" ||
    String(mandate?.state || "").toLowerCase() === "available"
  );
  const currency = String(active[0]?.currency || "INR").toUpperCase();
  const compatible = active.filter(
    (mandate) => String(mandate?.currency || "INR").toUpperCase() === currency
  );
  const amount = (field) => compatible.reduce((total, mandate) => {
    const value = Number(
      field === "remaining"
        ? mandate?.remaining ?? mandate?.approvedAmount
        : mandate?.approvedAmount
    );
    return total + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  const frequencies = [...new Set(
    compatible.map((mandate) => mandate?.frequency).filter(Boolean)
  )];
  const merchants = [...new Set(
    compatible.map((mandate) => mandate?.merchantName).filter(Boolean)
  )];
  const renewals = compatible
    .map((mandate) => new Date(mandate?.renewsAt || "").getTime())
    .filter(Number.isFinite);
  return {
    totalCount: all.length,
    activeCount: compatible.length,
    approvedAmount: amount("approvedAmount"),
    remaining: amount("remaining"),
    currency,
    frequency:
      frequencies.length === 1 ? frequencies[0] : frequencies.length ? "mixed" : null,
    merchantName:
      merchants.length === 1 ? merchants[0] : merchants.length ? "Combined merchants" : null,
    renewsAt: renewals.length
      ? new Date(Math.min(...renewals)).toISOString()
      : null,
  };
}

function mandateListPayload(values, query = {}, now = Date.now()) {
  const all = sortedMandatesForDisplay(values);
  const summary = publicMandateSummary(all);
  const history = String(query.view || "").toLowerCase() === "history";
  if (!history) {
    return {
      view: "summary",
      mandates: all.slice(0, MANDATE_DISPLAY_LIMIT),
      summary,
      totalCount: all.length,
      displayedCount: Math.min(all.length, MANDATE_DISPLAY_LIMIT),
      hasMore: all.length > MANDATE_DISPLAY_LIMIT,
      historyDays: MANDATE_HISTORY_DAYS,
    };
  }
  const requestedDays = Number.parseInt(query.days, 10);
  const days = Math.min(
    Math.max(Number.isFinite(requestedDays) ? requestedDays : MANDATE_HISTORY_DAYS, 1),
    MANDATE_HISTORY_DAYS
  );
  const periodStart = now - days * 24 * 60 * 60 * 1_000;
  const mandates = all
    .filter((mandate) => {
      const activity = mandateActivityTime(mandate);
      return activity !== null && activity >= periodStart && activity <= now;
    })
    .sort(
      (left, right) =>
        Number(mandateActivityTime(right) || 0) -
        Number(mandateActivityTime(left) || 0)
    );
  return {
    view: "history",
    mandates,
    summary,
    totalCount: mandates.length,
    displayedCount: mandates.length,
    hasMore: false,
    historyDays: days,
    periodStart: new Date(periodStart).toISOString(),
  };
}

function tokkoPaymentRoute({ mandates, paymentMethods, amount }) {
  const usableMandates = usablePravaMandatesForAmount(mandates, amount);
  if (usableMandates.length) {
    return {
      route: "mandate",
      mandate: usableMandates[0],
      checkedMandateCount: Array.isArray(mandates) ? mandates.length : 0,
    };
  }
  const cards = Array.isArray(paymentMethods) ? paymentMethods : [];
  const card =
    cards.find((method) => method.is_default === true || method.isDefault === true)
    || cards[0]
    || null;
  if (card) {
    return {
      route: "prava_card",
      card,
      checkedMandateCount: Array.isArray(mandates) ? mandates.length : 0,
    };
  }
  return {
    route: "cod",
    checkedMandateCount: Array.isArray(mandates) ? mandates.length : 0,
  };
}

async function selectPravaMandateForAmount(userId, requestedId, amount) {
  const { customerId } = await pravaMandateIdentity(userId);
  const mandates = await payments.listMandates(customerId);
  const usable = usablePravaMandatesForAmount(mandates, amount);
  if (requestedId) {
    const selected = usable.find(
      (mandate) => String(mandate.id) === String(requestedId)
    );
    if (!selected) {
      throw Object.assign(
        new Error(
          "The selected Prava mandate is not active or cannot cover this Zepto total."
        ),
        { status: 409 }
      );
    }
    return selected;
  }
  if (!usable.length) {
    throw Object.assign(
      new Error(
        "No single active Prava mandate can cover this Zepto total. Choose Cash on Delivery or create a larger mandate."
      ),
      { status: 409 }
    );
  }
  return usable[0];
}

async function startHermesPravaCardSession({
  userId,
  flow,
  card,
  amount,
}) {
  const { email, customerId } = await pravaMandateIdentity(userId);
  if (!card?.provider_payment_method_id) {
    throw Object.assign(new Error("No saved Prava card is available"), {
      status: 409,
    });
  }
  const callbackBase = BASE_URL.startsWith("https://")
    ? BASE_URL
    : process.env.PRAVA_MERCHANT_URL || "https://zepto-shop.vercel.app";
  const callbackUrl = new URL(callbackBase);
  callbackUrl.searchParams.set("pravaCheckout", "return");
  callbackUrl.searchParams.set("checkoutId", flow.id);
  const session = await payments.createPaymentSession({
    customerId,
    email,
    cardId: card.provider_payment_method_id,
    amount,
    callbackUrl: callbackUrl.toString(),
    externalOrderRef: `tokko_checkout_${String(flow.id).replace(/-/g, "")}`,
    purchaseContext: zeptoPurchaseContext(flow, amount),
  });
  const saved = await db.saveCheckoutFlow(
    flowRecord(flow, {
      status: "PRAVA_CARD_APPROVAL_REQUIRED",
      paymentRoute: "prava_card",
      cardBrand: card.brand,
      cardLast4: card.last4,
      pravaMandateId: "",
      pravaTransactionId: "",
      pravaChargeReference: "",
      pravaChargeStatus: "PASSKEY_REQUIRED",
      pravaChargeAmount: amount,
      pravaChargeReportedAt: null,
      pravaSessionId: session.sessionId,
      pravaSessionApprovalUrl: session.approvalUrl,
      failureMessage: null,
    })
  );
  return {
    paymentRoute: "prava_card",
    status: "PASSKEY_REQUIRED",
    checkedMandateCount: Number(flow.checkedMandateCount || 0),
    amount,
    currency: "INR",
    card: {
      brand: card.brand || "Card",
      last4: card.last4,
    },
    checkoutFlow: checkoutFlow(saved),
    nextAction: {
      type: "prava_card_approval",
      label: "Approve Card With Prava",
      url: session.approvalUrl,
      checkoutId: flow.id,
    },
  };
}

async function hermesCodFallback(req, flow, reason) {
  if (flow.allow_cod_fallback === false) {
    throw Object.assign(
      new Error(`${reason} Cash on Delivery fallback is disabled.`),
      { status: 409 }
    );
  }
  const fallback = await placeCodFallback(req, flow, { reason });
  return {
    paymentRoute: "cod",
    status: fallback.confirmed.orderId
      ? "COD_CONFIRMED"
      : "COD_UNCONFIRMED",
    checkedMandateCount: Number(flow.checkedMandateCount || 0),
    orderId: fallback.confirmed.orderId,
    checkoutFlow: checkoutFlow(fallback.saved),
  };
}

async function executeHermesCheckoutPolicy(req, userId, args = {}) {
  const addressId = String(args.userAddressId || "").trim();
  if (!addressId) {
    throw Object.assign(new Error("Choose a saved Zepto address first"), {
      status: 400,
    });
  }
  const allowCodFallback = args.allowCodFallback !== false;
  const orderInput = merchantOrderInput(
    {
      userAddressId: addressId,
      useZeptoCash: false,
      riderTip: 0,
    },
    false
  );
  const cartResult = await auth.withPlatformTool(
    req,
    "zepto",
    "view_cart",
    {}
  );
  const cartSnapshot = checkout.zeptoCartSnapshot(cartResult);
  if (!cartSnapshot.length) {
    throw Object.assign(new Error("The Zepto cart is empty"), { status: 409 });
  }
  await auth.withPlatformTool(req, "zepto", "get_payment_methods", {});
  let preview;
  try {
    preview = requireSuccessfulZeptoTool(
      await auth.withPlatformTool(
        req,
        "zepto",
        "create_online_payment_order",
        orderInput
      ),
      "create_online_payment_order"
    );
  } catch (error) {
    const initial = await db.saveCheckoutFlow({
      id: crypto.randomUUID(),
      userId,
      status: "PAYMENT_ROUTING",
      addressId,
      cardFailureCount: 0,
      cardPaymentReceived: false,
      allowCodFallback,
      fallbackToCod: false,
      paymentRoute: "cod",
      priceBreakdown: {},
      cartSnapshot,
      failureMessage: error.message,
    });
    return hermesCodFallback(
      req,
      initial,
      `Zepto online payment could not be prepared: ${error.message}.`
    );
  }
  const priceBreakdown = checkout.zeptoPriceBreakdown(preview);
  const amount = positiveBreakdownAmount(priceBreakdown);
  if (!amount) {
    throw Object.assign(
      new Error("Zepto did not return a positive payable total"),
      { status: 409 }
    );
  }
  const [paymentMethods, identity] = await Promise.all([
    syncPravaPaymentMethodsForUser(userId),
    pravaMandateIdentity(userId).catch(() => null),
  ]);
  let mandates = [];
  let mandateCheckError = null;
  if (identity?.customerId) {
    try {
      mandates = await payments.listMandates(identity.customerId);
    } catch (error) {
      mandateCheckError = error.message;
    }
  }
  const selectedRoute = tokkoPaymentRoute({
    mandates,
    paymentMethods,
    amount,
  });
  const selectedCard =
    selectedRoute.card
    || paymentMethods.find((method) => method.is_default === true)
    || paymentMethods[0]
    || null;
  let flow = await db.saveCheckoutFlow({
    id: crypto.randomUUID(),
    userId,
    status: "PAYMENT_ROUTING",
    addressId,
    cardBrand: selectedCard?.brand || null,
    cardLast4: selectedCard?.last4 || null,
    cardFailureCount: 0,
    cardPaymentReceived: false,
    allowCodFallback,
    fallbackToCod: false,
    paymentRoute: selectedRoute.route,
    priceBreakdown,
    cartSnapshot,
    failureMessage: mandateCheckError,
  });
  flow.checkedMandateCount = selectedRoute.checkedMandateCount;

  const startCardOrCod = async (reason) => {
    flow.checkedMandateCount = selectedRoute.checkedMandateCount;
    if (selectedCard) {
      try {
        return await startHermesPravaCardSession({
          userId,
          flow,
          card: selectedCard,
          amount,
        });
      } catch (error) {
        return hermesCodFallback(
          req,
          flow,
          `${reason} The normal Prava card transaction could not start: ${error.message}.`
        );
      }
    }
    return hermesCodFallback(
      req,
      flow,
      `${reason} No saved Prava card is available.`
    );
  };

  if (selectedRoute.route !== "mandate") {
    return selectedRoute.route === "prava_card"
      ? startCardOrCod(
          "No active Prava mandate could cover the full order amount."
        )
      : hermesCodFallback(
          req,
          flow,
          "No active mandate or saved Prava card could cover this order."
        );
  }

  let charge;
  const chargeReference =
    `tokko_hermes_${String(flow.id).replace(/-/g, "")}`;
  try {
    charge = await payments.chargeMandate({
      mandateId: selectedRoute.mandate.id,
      amount,
      reference: chargeReference,
      purchaseContext: zeptoPurchaseContext(flow, amount),
    });
  } catch (error) {
    return startCardOrCod(
      `The selected active mandate could not issue a payment credential: ${error.message}.`
    );
  }
  flow = await db.saveCheckoutFlow(
    flowRecord(flow, {
      status: "CARD_PAYMENT_PENDING",
      paymentRoute: "mandate",
      pravaMandateId: charge.mandateId,
      pravaTransactionId: charge.transactionId,
      pravaChargeReference: chargeReference,
      pravaChargeStatus: "CREDENTIAL_ISSUED",
      pravaChargeAmount: amount,
      pravaChargeReportedAt: null,
      failureMessage: null,
    })
  );
  let confirmed;
  try {
    confirmed = await confirmedZeptoOrder(
      req,
      "create_online_payment_order",
      { ...orderInput, confirmOrder: true }
    );
  } catch (error) {
    const reported = await reportPravaPaymentForFlow(flow, "DECLINED");
    flow = reported.row;
    return startCardOrCod(
      `Zepto rejected the mandate-backed online order: ${error.message}.`
    );
  }
  const paymentLink = zeptoPaymentLink(confirmed.merchantResult);
  if (!confirmed.orderId || !paymentLink) {
    const reported = await reportPravaPaymentForFlow(flow, "DECLINED");
    flow = reported.row;
    return startCardOrCod(
      "Zepto did not return both an online order ID and secure payment link."
    );
  }
  const initialStatus = await auth.withPlatformTool(
    req,
    "zepto",
    "check_payment_status",
    { orderId: confirmed.orderId, poll: false }
  ).catch(() => null);
  const paymentStatus = zeptoPaymentStatus(initialStatus);
  if (["FAILED", "CANCELLED", "CANCELED"].includes(paymentStatus)) {
    const reported = await reportPravaPaymentForFlow(flow, "DECLINED");
    flow = reported.row;
    return startCardOrCod(
      `Zepto reported the mandate-backed payment ${paymentStatus.toLowerCase()}.`
    );
  }
  if (["SUCCESS", "COMPLETED", "PAID"].includes(paymentStatus)) {
    const reported = await reportPravaPaymentForFlow(flow, "APPROVED");
    const saved = await db.saveCheckoutFlow(
      flowRecord(reported.row, {
        status: "CARD_PAYMENT_RECEIVED",
        cardPaymentReceived: true,
        cardOrderId: confirmed.orderId,
        zeptoOrderId: confirmed.orderId,
        failureMessage: reported.error,
      })
    );
    return {
      paymentRoute: "mandate",
      status: "PAID",
      checkedMandateCount: selectedRoute.checkedMandateCount,
      mandateId: charge.mandateId,
      amount,
      orderId: confirmed.orderId,
      checkoutFlow: checkoutFlow(saved),
    };
  }
  flow = await db.saveCheckoutFlow(
    flowRecord(flow, {
      status: "CARD_PAYMENT_PENDING",
      cardOrderId: confirmed.orderId,
      failureMessage: null,
    })
  );
  return {
    paymentRoute: "mandate",
    status: paymentStatus,
    checkedMandateCount: selectedRoute.checkedMandateCount,
    mandateId: charge.mandateId,
    amount,
    currency: "INR",
    orderId: confirmed.orderId,
    paymentLink,
    paymentHandoff: pravaPaymentHandoff(flow, charge, {
      sandbox: payments.configuration().environment !== "production",
      zeptoAttempt: true,
    }),
    checkoutFlow: checkoutFlow(flow),
    nextAction: {
      type: "zepto_card_payment",
      label: "Continue To Zepto Payment",
      url: paymentLink,
      checkoutId: flow.id,
      paymentHandoff: pravaPaymentHandoff(flow, charge, {
        sandbox: payments.configuration().environment !== "production",
        zeptoAttempt: true,
      }),
    },
  };
}

async function continueHermesPravaCardCheckout(req, userId, requestedId) {
  const id = checkoutId(requestedId);
  let flow = await db.getCheckoutFlow(userId, id);
  if (!flow || flow.payment_route !== "prava_card" || !flow.prava_session_id) {
    throw Object.assign(
      new Error("No Prava card approval is waiting for this checkout"),
      { status: 404 }
    );
  }
  const sessionResult = await payments.getPaymentResult(flow.prava_session_id);
  const payment = payments.paymentSessionCredentials(sessionResult);
  if (!payment) {
    const failed = /failed|declined|cancelled|canceled|expired/i.test(
      String(sessionResult?.status || "")
    );
    if (failed) {
      return hermesCodFallback(
        req,
        flow,
        "The normal Prava card transaction did not complete."
      );
    }
    return {
      paymentRoute: "prava_card",
      status: String(sessionResult?.status || "PASSKEY_REQUIRED").toUpperCase(),
      amount: flow.prava_charge_amount,
      checkoutFlow: checkoutFlow(flow),
      pravaPaymentResult: pravaResultSnapshot(flow, { sessionResult }),
      nextAction: {
        type: "prava_card_approval",
        label: "Approve Card With Prava",
        url: flow.prava_session_approval_url,
        checkoutId: flow.id,
      },
    };
  }
  flow = await db.saveCheckoutFlow(
    flowRecord(flow, {
      status: "CARD_PAYMENT_PENDING",
      pravaTransactionId: payment.transactionId,
      pravaChargeStatus: "CREDENTIAL_ISSUED",
      pravaChargeReportedAt: null,
      failureMessage: null,
    })
  );
  await auth.withPlatformTool(req, "zepto", "get_payment_methods", {});
  let confirmed;
  try {
    confirmed = await confirmedZeptoOrder(
      req,
      "create_online_payment_order",
      merchantOrderInput(
        {
          userAddressId: flow.address_id,
          useZeptoCash: false,
          riderTip: 0,
        },
        true
      )
    );
  } catch (error) {
    const reported = await reportPravaPaymentForFlow(flow, "DECLINED");
    return hermesCodFallback(
      req,
      reported.row,
      `Zepto rejected the normal Prava card order: ${error.message}.`
    );
  }
  const paymentLink = zeptoPaymentLink(confirmed.merchantResult);
  if (!confirmed.orderId || !paymentLink) {
    const reported = await reportPravaPaymentForFlow(flow, "DECLINED");
    return hermesCodFallback(
      req,
      reported.row,
      "Zepto did not return both an online order ID and secure payment link."
    );
  }
  flow = await db.saveCheckoutFlow(
    flowRecord(flow, {
      status: "CARD_PAYMENT_PENDING",
      cardOrderId: confirmed.orderId,
      failureMessage: null,
    })
  );
  const initialStatus = await auth.withPlatformTool(
    req,
    "zepto",
    "check_payment_status",
    { orderId: confirmed.orderId, poll: false }
  ).catch(() => null);
  const paymentStatus = zeptoPaymentStatus(initialStatus);
  if (["FAILED", "CANCELLED", "CANCELED"].includes(paymentStatus)) {
    const reported = await reportPravaPaymentForFlow(flow, "DECLINED");
    return hermesCodFallback(
      req,
      reported.row,
      `Zepto reported the normal card payment ${paymentStatus.toLowerCase()}.`
    );
  }
  if (["SUCCESS", "COMPLETED", "PAID"].includes(paymentStatus)) {
    const reported = await reportPravaPaymentForFlow(flow, "APPROVED");
    const saved = await db.saveCheckoutFlow(
      flowRecord(reported.row, {
        status: "CARD_PAYMENT_RECEIVED",
        cardPaymentReceived: true,
        cardOrderId: confirmed.orderId,
        zeptoOrderId: confirmed.orderId,
        failureMessage: reported.error,
      })
    );
    return {
      paymentRoute: "prava_card",
      status: "PAID",
      amount: flow.prava_charge_amount,
      orderId: confirmed.orderId,
      checkoutFlow: checkoutFlow(saved),
      pravaPaymentResult: pravaResultSnapshot(saved, {
        sessionResult,
        reportResult: reported.report,
      }),
    };
  }
  const handoff = pravaSessionPaymentHandoff(flow, payment, {
    sandbox: payments.configuration().environment !== "production",
  });
  return {
    paymentRoute: "prava_card",
    status: paymentStatus,
    amount: flow.prava_charge_amount,
    currency: "INR",
    orderId: confirmed.orderId,
    paymentLink,
    paymentHandoff: handoff,
    checkoutFlow: checkoutFlow(flow),
    pravaPaymentResult: pravaResultSnapshot(flow, { sessionResult }),
    nextAction: {
      type: "zepto_card_payment",
      label: "Continue To Zepto Payment",
      url: paymentLink,
      checkoutId: flow.id,
      paymentHandoff: handoff,
    },
  };
}

async function reportPravaChargeForFlow(row, status) {
  if (!row?.prava_mandate_id || !row?.prava_transaction_id) {
    return { row, report: null, error: null };
  }
  if (
    row.prava_charge_reported_at
    && row.prava_charge_status === status
  ) {
    return { row, report: null, error: null };
  }
  try {
    const report = await payments.reportMandateCharge({
      mandateId: row.prava_mandate_id,
      transactionId: row.prava_transaction_id,
      status,
      ...(status === "APPROVED" && row.prava_charge_amount
        ? { amountPaid: row.prava_charge_amount }
        : {}),
    });
    const saved = await db.saveCheckoutFlow(
      flowRecord(row, {
        pravaChargeStatus: status,
        pravaChargeReportedAt: new Date().toISOString(),
      })
    );
    return { row: saved, report, error: null };
  } catch (error) {
    const saved = await db.saveCheckoutFlow(
      flowRecord(row, {
        pravaChargeStatus: `${status}_REPORT_FAILED`,
      })
    );
    return { row: saved, report: null, error: error.message };
  }
}

async function reportPravaPaymentForFlow(row, status) {
  if (row?.prava_mandate_id) {
    return reportPravaChargeForFlow(row, status);
  }
  if (!row?.prava_session_id || !row?.prava_transaction_id) {
    return { row, report: null, error: null };
  }
  if (
    row.prava_charge_reported_at
    && row.prava_charge_status === status
  ) {
    return { row, report: null, error: null };
  }
  try {
    const report = await payments.reportPaymentSession({
      sessionId: row.prava_session_id,
      transactionId: row.prava_transaction_id,
      status,
      ...(status === "APPROVED" && row.prava_charge_amount
        ? { amountPaid: row.prava_charge_amount }
        : {}),
    });
    const saved = await db.saveCheckoutFlow(
      flowRecord(row, {
        pravaChargeStatus: status,
        pravaChargeReportedAt: new Date().toISOString(),
      })
    );
    return { row: saved, report, error: null };
  } catch (error) {
    const saved = await db.saveCheckoutFlow(
      flowRecord(row, {
        pravaChargeStatus: `${status}_REPORT_FAILED`,
      })
    );
    return { row: saved, report: null, error: error.message };
  }
}

async function recoverNewZeptoOrder(req, beforeIds) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    const history = await auth.withPlatformTool(
      req,
      "zepto",
      "list_order_history",
      { limit: 10, pageNumber: 1 }
    );
    const recovered = zeptoOrderRows(history).find((order) => {
      const id = zeptoOrderRowId(order);
      return id && !beforeIds.has(String(id));
    });
    if (recovered) return recovered;
  }
  return null;
}

async function confirmedZeptoOrder(req, toolName, input) {
  const historyBefore = await auth.withPlatformTool(
    req,
    "zepto",
    "list_order_history",
    { limit: 10, pageNumber: 1 }
  ).catch(() => ({ orders: [] }));
  const beforeIds = new Set(
    zeptoOrderRows(historyBefore)
      .map(zeptoOrderRowId)
      .filter(Boolean)
      .map(String)
  );
  const merchantResult = requireSuccessfulZeptoTool(
    await auth.withPlatformTool(req, "zepto", toolName, input),
    toolName
  );
  let orderId = zeptoOrderId(merchantResult);
  let recoveredOrder = null;
  if (!orderId) {
    recoveredOrder = await recoverNewZeptoOrder(req, beforeIds);
    orderId = zeptoOrderRowId(recoveredOrder);
  }
  return {
    merchantResult,
    orderId: orderId ? String(orderId) : null,
    recoveredOrder,
  };
}

async function restoreZeptoCart(req, snapshot) {
  if (!Array.isArray(snapshot) || !snapshot.length) return;
  const liveCart = await auth.withPlatformTool(
    req,
    "zepto",
    "view_cart",
    {}
  ).catch(() => null);
  if (checkout.zeptoCartSnapshot(liveCart).length) return;
  await auth.withPlatformTool(req, "zepto", "update_cart", {
    deviceId: "tokko-checkout",
    cartItems: snapshot,
  });
}

async function saveFailedCardAttempt(row, message, orderId = null) {
  const alreadyCounted =
    orderId && row.last_failed_order_id === String(orderId);
  const failureCount =
    Number(row.card_failure_count || 0) + (alreadyCounted ? 0 : 1);
  return db.saveCheckoutFlow(
    flowRecord(row, {
      status: "CARD_PAYMENT_FAILED",
      cardFailureCount: failureCount,
      cardPaymentReceived: false,
      cardOrderId: orderId ? String(orderId) : row.card_order_id,
      lastFailedOrderId: orderId
        ? String(orderId)
        : `attempt-${failureCount}`,
      failureMessage: message,
    })
  );
}

async function saveCardAttemptSetupFailure(row, message, orderId = null) {
  return db.saveCheckoutFlow(
    flowRecord(row, {
      status: "CARD_ATTEMPT_NOT_STARTED",
      cardPaymentReceived: false,
      cardOrderId: orderId ? String(orderId) : row.card_order_id,
      fallbackToCod: false,
      failureMessage:
        `${message} This was not counted as one of the three payment attempts ` +
        "because Prava did not issue a transaction that reached Zepto payment.",
    })
  );
}

async function placeCodFallback(req, row, options = {}) {
  await restoreZeptoCart(req, row.cart_snapshot);
  await auth.withPlatformTool(req, "zepto", "get_payment_methods", {});
  const confirmed = await confirmedZeptoOrder(
    req,
    "create_order",
    merchantOrderInput(
      { userAddressId: row.address_id, useZeptoCash: false, riderTip: 0 },
      true
    )
  );
  const saved = await db.saveCheckoutFlow(
    flowRecord(row, {
      status: confirmed.orderId
        ? "COD_FALLBACK_CONFIRMED"
        : "COD_FALLBACK_UNCONFIRMED",
      cardPaymentReceived: false,
      fallbackToCod: true,
      zeptoOrderId: confirmed.orderId,
      failureMessage: confirmed.orderId
        ? options.reason
          ? `${options.reason} Zepto confirmed the Cash on Delivery fallback.`
          : "Card payment was not received after three attempts. Zepto confirmed the Cash on Delivery fallback."
        : options.reason
          ? `${options.reason} Zepto has not confirmed a Cash on Delivery order ID.`
          : "Card payment was not received after three attempts, but Zepto has not confirmed a Cash on Delivery order ID.",
    })
  );
  return { confirmed, saved };
}

async function applyCodFallbackIfRequired(_req, row) {
  if (
    Number(row.card_failure_count || 0) < 3
    || row.allow_cod_fallback === false
  ) {
    return { row, codResult: null };
  }
  const awaitingConsent = await db.saveCheckoutFlow(
    flowRecord(row, {
      status: "COD_PERMISSION_REQUIRED",
      cardPaymentReceived: false,
      fallbackToCod: false,
      failureMessage:
        "Card payment was not received after three real attempts. " +
        "No Cash on Delivery order has been created. Choose whether Tokko may place one.",
    })
  );
  return { row: awaitingConsent, codResult: null };
}

async function applyCardFailureOutcome(req, row) {
  if (
    row.sandbox_payment_attempt === true
    && Number(row.card_failure_count || 0) < 3
  ) {
    const saved = await db.saveCheckoutFlow(
      flowRecord(row, {
        status: "SANDBOX_ZEPTO_PAYMENT_FAILED",
        cardPaymentReceived: false,
        fallbackToCod: false,
        failureMessage:
          row.failure_message
          || "Zepto did not accept the Prava sandbox credential.",
      })
    );
    return { row: saved, codResult: null };
  }
  return applyCodFallbackIfRequired(req, row);
}

async function closeSandboxPaymentAttempt(
  req,
  row,
  message,
  orderId = null
) {
  const reported = await reportPravaPaymentForFlow(row, "DECLINED");
  const failed = await saveFailedCardAttempt(
    reported.row,
    message,
    orderId
  );
  const fallback = await applyCardFailureOutcome(req, failed);
  return {
    row: fallback.row,
    codResult: fallback.codResult,
    pravaReportError: reported.error,
    pravaReportResult: reported.report,
  };
}

function savedAddressInput(body) {
  const text = (value) => String(value || "").trim();
  const requiredText = (key, label) => {
    const value = text(body[key]);
    if (!value) {
      throw Object.assign(new Error(`${label} is required`), { status: 400 });
    }
    return value;
  };
  const suppliedLatitude = String(body.latitude ?? "").trim();
  const suppliedLongitude = String(body.longitude ?? "").trim();
  if (Boolean(suppliedLatitude) !== Boolean(suppliedLongitude)) {
    throw Object.assign(
      new Error("Enter both latitude and longitude, or leave both blank"),
      { status: 400 }
    );
  }
  const coordinates = suppliedLatitude
    ? geocoding.coordinatePair(suppliedLatitude, suppliedLongitude)
    : null;
  if (suppliedLatitude && !coordinates) {
    throw Object.assign(
      new Error("Enter valid coordinates, or leave both latitude and longitude blank"),
      { status: 400 }
    );
  }
  const type = text(body.type).toUpperCase();
  if (!["HOME", "WORK", "OTHER"].includes(type)) {
    throw Object.assign(new Error("Address type must be HOME, WORK, or OTHER"), {
      status: 400,
    });
  }
  const name = requiredText("name", "Address label");
  const flatDetails = requiredText("flatDetails", "Flat / House number");
  const shortAddress = requiredText("shortAddress", "Area, city, and state");
  const suppliedBuilding = text(body.buildingName);
  const buildingName = suppliedBuilding || "Independent house";
  const floor = text(body.floor);
  const landmark = text(body.landmark);
  const contactName = requiredText("contactName", "Delivery contact name");
  let contactNumber = requiredText(
    "contactNumber",
    "Delivery contact phone number"
  ).replace(/[\s()-]/g, "");
  if (/^\d{10}$/.test(contactNumber)) contactNumber = `+91${contactNumber}`;
  if (/^91\d{10}$/.test(contactNumber)) contactNumber = `+${contactNumber}`;
  if (!/^\+91[6-9]\d{9}$/.test(contactNumber)) {
    throw Object.assign(
      new Error("Zepto delivery contact must be a valid 10-digit Indian mobile number"),
      { status: 400 }
    );
  }
  const formattedAddress =
    text(body.formattedAddress) ||
    [
      flatDetails,
      buildingName,
      floor ? `Floor ${floor}` : "",
      landmark ? `Near ${landmark}` : "",
      shortAddress,
    ]
      .filter(Boolean)
      .join(", ");
  return {
    type,
    name,
    flatDetails,
    buildingName,
    floor: floor || undefined,
    landmark: landmark || undefined,
    latitude: coordinates?.latitude,
    longitude: coordinates?.longitude,
    formattedAddress,
    shortAddress,
    contactName,
    contactNumber,
    buildingType:
      text(body.buildingType) ||
      (suppliedBuilding
        ? "BUILDING_TYPE_SOCIETY"
        : "BUILDING_TYPE_HOUSE"),
  };
}

function zeptoAddressLocationContext(value, requestedAddressId = "") {
  const objects = [];
  const visit = (entry, depth = 0) => {
    if (depth > 7 || !entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child, depth + 1);
      return;
    }
    objects.push(entry);
    for (const child of Object.values(entry)) visit(child, depth + 1);
  };
  visit(value);
  const requested = String(requestedAddressId || "").trim();
  const matching = requested
    ? objects.filter((entry) =>
        [
          entry.id,
          entry._id,
          entry.addressId,
          entry.address_id,
          entry.userAddressId,
          entry.user_address_id,
        ].some((candidate) => String(candidate || "").trim() === requested)
      )
    : [];
  const candidates = [...matching, ...objects];
  const finite = (candidate) => {
    if (candidate === null || candidate === undefined || candidate === "") {
      return null;
    }
    const number = Number(candidate);
    return Number.isFinite(number) ? number : null;
  };
  const latitude = candidates
    .map((entry) => finite(entry.latitude ?? entry.lat))
    .find((entry) => entry !== null) ?? null;
  const longitude = candidates
    .map((entry) => finite(
      entry.longitude ?? entry.lng ?? entry.lon ?? entry.long
    ))
    .find((entry) => entry !== null) ?? null;
  const structuredStoreId = candidates
    .map((entry) => String(
      entry.primaryStoreId ||
      entry.primary_store_id ||
      entry.storeId ||
      entry.store_id ||
      ""
    ).trim())
    .find(Boolean);
  const textStoreId = zeptoResultText(value).match(
    /\bprimary\s+store\s+id\s*:\s*([a-z0-9-]+)/i
  )?.[1] || "";
  return {
    latitude,
    longitude,
    storeId: structuredStoreId || textStoreId,
  };
}

async function selectZeptoAddressContextUsing(callTool, addressId) {
  const selectedId = String(addressId || "").trim();
  if (!selectedId) {
    throw Object.assign(new Error("addressId is required"), { status: 400 });
  }
  const selected = requireSuccessfulZeptoTool(
    await callTool("select_saved_address", { addressId: selectedId }),
    "select_saved_address"
  );
  let context = zeptoAddressLocationContext(selected, selectedId);
  if (context.latitude === null || context.longitude === null) {
    await new Promise((resolve) => setTimeout(resolve, 650));
    const addresses = await callTool("list_saved_addresses", {});
    context = {
      ...context,
      ...zeptoAddressLocationContext(addresses, selectedId),
    };
  }
  if (context.latitude === null || context.longitude === null) {
    return {
      selected: true,
      addressId: selectedId,
      storeContextActivated: false,
      warning:
        "Zepto selected the address but did not return coordinates for store refresh.",
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 650));
  const serviceability = requireSuccessfulZeptoTool(
    await callTool("get_location_serviceability", {
      latitude: context.latitude,
      longitude: context.longitude,
    }),
    "get_location_serviceability"
  );
  const serviceabilityContext = zeptoAddressLocationContext(serviceability);
  const storeId = serviceabilityContext.storeId || context.storeId;
  if (!storeId) {
    return {
      selected: true,
      addressId: selectedId,
      latitude: context.latitude,
      longitude: context.longitude,
      storeContextActivated: false,
      warning:
        "Zepto confirmed the delivery area but did not return a primary store.",
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 650));
  requireSuccessfulZeptoTool(
    await callTool("select_store", {
      storeId,
      latitude: context.latitude,
      longitude: context.longitude,
    }),
    "select_store"
  );
  return {
    selected: true,
    addressId: selectedId,
    latitude: context.latitude,
    longitude: context.longitude,
    storeContextActivated: true,
  };
}

async function selectZeptoAddressContextForUser(userId, addressId) {
  return selectZeptoAddressContextUsing(
    (toolName, args) =>
      auth.withPlatformToolForUser(userId, "zepto", toolName, args),
    addressId
  );
}

function zeptoSavedAddressRows(value) {
  const addressBook = new Map();
  hermes.captureAddresses(value, addressBook);
  return [...addressBook.entries()].map(([id, readable], index) => {
    const separator = readable.indexOf(":");
    const candidateLabel = separator > 0 ? readable.slice(0, separator).trim() : "";
    return {
      id,
      label:
        candidateLabel && candidateLabel.length <= 40
          ? candidateLabel
          : `Saved address ${index + 1}`,
      formattedAddress: readable,
    };
  });
}

async function listZeptoAddressesForUser(userId) {
  const result = requireSuccessfulZeptoTool(
    await auth.withPlatformToolForUser(
      userId,
      "zepto",
      "list_saved_addresses",
      {}
    ),
    "list_saved_addresses"
  );
  return zeptoSavedAddressRows(result);
}

async function confirmZeptoAddressForUser(userId, addressId, addressIndex = null) {
  const addresses = await listZeptoAddressesForUser(userId);
  const numericIndex = Number(addressIndex);
  const selected = String(addressId || "").trim()
    ? addresses.find(
        (address) => String(address.id) === String(addressId).trim()
      )
    : addressIndex !== null
      && addressIndex !== undefined
      && Number.isInteger(numericIndex)
      && numericIndex >= 0
      ? addresses[numericIndex]
      : null;
  if (!selected) {
    throw Object.assign(
      new Error("Choose one of the saved Zepto addresses shown by Tokko"),
      { status: 404 }
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 650));
  const context = await selectZeptoAddressContextForUser(userId, selected.id);
  const preference = await db.saveDeliveryPreference(userId, {
    platformSlug: "zepto",
    addressId: selected.id,
    label: selected.label,
    formattedAddress: selected.formattedAddress,
  });
  await db.upsertHermesMemory(userId, {
    type: "delivery_preference",
    cue: "confirmed delivery address",
    value: { address: selected.formattedAddress },
    confidence: 1,
  });
  hermes.invalidateLocationSensitiveReadCache(userId);
  return {
    confirmed: true,
    selectedAddress: publicDeliveryPreference(preference),
    context,
  };
}

route("GET", "/.well-known/ucp", async (_req, res) => {
  sendJson(res, 200, ucp.agentProfile(BASE_URL).document, {
    "Cache-Control": "public, max-age=300, s-maxage=300",
  });
});

route("GET", "/api/merchants/ucp", async (req, res) => {
  await auth.requireUser(req);
  sendJson(res, 200, { merchants: await ucp.status() });
});

route("POST", "/api/merchants/ucp/search", async (req, res) => {
  await auth.requireUser(req);
  const body = await parseBody(req);
  sendJson(
    res,
    200,
    await ucp.searchAll(body.query, {
      limit: body.limit,
      offset: body.offset,
      market: body.market,
      baseUrl: BASE_URL,
    })
  );
});

route("POST", "/api/merchants/ucp/checkout", async (req, res) => {
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  sendJson(
    res,
    201,
    await createUcpCheckoutWithPayment(user.userId, body)
  );
});

route("POST", "/api/merchants/ucp/payment-choice", async (req, res) => {
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  sendJson(
    res,
    200,
    await selectUcpSavedCard(user.userId, String(body.token || ""))
  );
});

route("GET", "/api/health", async (_req, res) => {
  await db.initialize();
  sendJson(res, 200, { ok: true });
});

route("POST", "/api/auth/signup", async (req, res) => {
  const body = await parseBody(req);
  const email = websiteAuth.normalizeEmail(body.email);
  const existing = await db.getUserByEmail(email);
  if (existing?.password_hash) {
    throw Object.assign(
      new Error("An account with this email already exists"),
      { status: 409 }
    );
  }
  const passwordHash = await websiteAuth.hashPassword(body.password);
  const challengeId = websiteAuth.createEmailSignupChallengeId();
  await db.createEmailSignupChallenge({
    id: challengeId,
    email,
    passwordHash,
    expiresAt: websiteAuth.emailOtpExpiresAt(),
  });
  sendJson(res, 202, {
    verificationRequired: true,
    verificationProvider: "clerk",
    challengeId,
    email: websiteAuth.maskEmail(email),
    expiresInSeconds: websiteAuth.EMAIL_OTP_TTL_SECONDS,
  });
});

route("POST", "/api/auth/signup/verify", async (req, res) => {
  const body = await parseBody(req);
  const challengeId =
    typeof body.challengeId === "string" ? body.challengeId.trim() : "";
  const clerkSignUpId =
    typeof body.clerkSignUpId === "string"
      ? body.clerkSignUpId.trim()
      : "";
  if (
    !/^signup_[A-Za-z0-9_-]{20,}$/.test(challengeId) ||
    !/^sua_[A-Za-z0-9]+$/.test(clerkSignUpId)
  ) {
    throw Object.assign(
      new Error("A valid signup challenge and Clerk verification are required"),
      { status: 400 }
    );
  }
  const email = websiteAuth.normalizeEmail(body.email);
  const verifiedSignup = await emailVerification.verifyCompletedSignup(
    clerkSignUpId,
    email
  );
  const user = await db.completeEmailSignupChallenge(
    challengeId,
    {
      email,
      clerkUserId: verifiedSignup.clerkUserId,
    }
  );
  await createBrowserSession(req, res, user, 201);
});

route("POST", "/api/auth/login", async (req, res) => {
  const body = await parseBody(req);
  const password = typeof body.password === "string" ? body.password : "";
  const phoneLogin = Boolean(
    body.phone || body.countryCode || body.localPhone
  );
  let user = null;
  if (phoneLogin) {
    const phone = validation.phoneInput(
      body.phone,
      body.countryCode,
      body.localPhone,
      "phone"
    );
    const matches = await db.getFamilyUsersByPhone(phone);
    // A family phone must resolve to exactly one account. Ambiguous and
    // unknown values deliberately receive the same response.
    if (matches.length === 1) {
      user = await db.getUserById(Number(matches[0].id));
    }
  } else {
    const email = websiteAuth.normalizeEmail(body.email);
    user = await db.getUserByEmail(email);
  }
  let valid = false;
  if (user?.password_hash) {
    valid = await websiteAuth.verifyPassword(password, user.password_hash);
  } else {
    // Keep unknown-email attempts computationally similar to a real password check.
    await websiteAuth.hashPassword(
      password.length >= 10 ? password : "invalid-password-value"
    );
  }
  if (!valid) {
    throw Object.assign(
      new Error(
        phoneLogin
          ? "Invalid phone number or password"
          : "Invalid email or password"
      ),
      { status: 401 }
    );
  }
  await db.touchUserLogin(Number(user.id));
  await createBrowserSession(req, res, user);
});

route("POST", "/api/auth/clerk/session", async (req, res) => {
  const { identity, email } = await auth.authenticateClerkUser(req);
  const user = await db.getOrCreateWebsiteUser(identity.userId, email);
  await createBrowserSession(req, res, user);
});

route("GET", "/api/auth/session", async (req, res) => {
  const user = await auth.requireUser(req);
  sendJson(res, 200, { account: publicAccount(user) });
});

route("POST", "/api/auth/logout", async (req, res) => {
  const token = websiteAuth.getSessionToken(req);
  if (token) {
    await db.deleteWebsiteSession(websiteAuth.hashSessionToken(token));
  }
  sendJson(
    res,
    200,
    { signedOut: true },
    {
      "Set-Cookie": websiteAuth.expiredSessionCookie(secureRequest(req)),
    }
  );
});

route("GET", "/api/config", async (_req, res) => {
  const pravaConfiguration = payments.configuration();
  const emailConfiguration = emailVerification.configuration();
  const hermesConfiguration = hermes.configuration();
  sendJson(res, 200, {
    websiteAuthentication: "google_or_email_password",
    googleOAuthConfigured: emailConfiguration.configured,
    signupEmailVerification: "otp",
    signupEmailVerificationConfigured: emailConfiguration.configured,
    clerkPublishableKey: emailConfiguration.publishableKey || null,
    pravaPublishableKey: pravaConfiguration.publishableKey || null,
    pravaConfigured: pravaConfiguration.configured,
    pravaEnvironment: pravaConfiguration.environment,
    linqConfigured: Boolean(
      process.env.LINQ_API_KEY || process.env.LINQ_PHONE_NUMBER
    ),
    hermesConfigured: hermesConfiguration.configured,
    hermesProvider: hermesConfiguration.provider,
    hermesModel: hermesConfiguration.model,
    hermesRuntime: hermesConfiguration.runtime,
    hermesPolicyVersion: hermes.TRAKKO_POLICY_VERSION,
    hermesEndpointUrl: `${BASE_URL}/api/integrations/telegram/hermes`,
    consentPolicyVersion: CONSENT_POLICY_VERSION,
  });
});

route("GET", "/api/v1/system/apis", async (req, res) => {
  await auth.requireService(req);
  const apiRoutes = routes
    .filter((entry) => entry.pattern.startsWith("/api/"))
    .map(({ method, pattern, auth: authMode, group }) => ({
      method,
      path: pattern,
      auth: authMode,
      group,
    }))
    .sort((left, right) =>
      `${left.group}:${left.path}:${left.method}`.localeCompare(
        `${right.group}:${right.path}:${right.method}`
      )
    );
  sendJson(res, 200, {
    version: "v1",
    routeCount: apiRoutes.length,
    routes: apiRoutes,
  });
});

route("GET", "/api/v1/system/db", async (req, res) => {
  await auth.requireService(req);
  sendJson(res, 200, {
    database: await db.getDiagnostics(),
    configuration: {
      clerk: Boolean(
        process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY
      ),
      prava: payments.configuration().configured,
      linq: Boolean(process.env.LINQ_API_KEY),
      linqWebhook: Boolean(process.env.LINQ_WEBHOOK_SECRET),
      hermes: hermes.configuration().configured,
      zeptoOAuth: Boolean(
        process.env.ZEPTO_OAUTH_CLIENT_ID ||
          platforms.getOAuthClientId("zepto")
      ),
      baseUrl: BASE_URL,
    },
  });
});

route(
  "GET",
  "/api/v1/integrations/telegram/bindings/:chatId",
  async (req, res, params) => {
    await auth.requireService(req);
    const chatId = telegramChatIdentifier({ chatId: params.chatId });
    const binding = await db.getTelegramHermesBinding(chatId);
    if (!binding) {
      return sendJson(res, 404, { error: "Telegram chat is not linked" });
    }
    const [profile, paymentCustomer] = await Promise.all([
      db.getProfile(Number(binding.user_id)),
      db.getPaymentCustomer(Number(binding.user_id)),
    ]);
    sendJson(res, 200, {
      userId: Number(binding.user_id),
      customerId:
        paymentCustomer?.provider_customer_id
        || canonicalPravaCustomerId(Number(binding.user_id)),
      familyPhone: profile?.primary_parent_phone || null,
    });
  }
);

route(
  "PUT",
  "/api/v1/integrations/telegram/bindings/:chatId",
  async (req, res, params) => {
    await auth.requireService(req);
    const chatId = telegramChatIdentifier({ chatId: params.chatId });
    const body = await parseBody(req);
    const familyReference =
      body.familyUserId ?? body.userId ?? body.familyPhone;
    if (familyReference === undefined || familyReference === null) {
      throw Object.assign(new Error("familyUserId is required"), {
        status: 400,
      });
    }
    const userId = await resolveOnboardingUserId(familyReference);
    await db.saveTelegramHermesBinding(
      chatId,
      userId,
      body.telegramUsername || null
    );
    const state = await getUserState(userId);
    sendJson(res, 200, {
      userId,
      customerId: state.customerId,
      familyPhone: state.profile?.primaryParentPhone || null,
    });
  }
);

route(
  "GET",
  "/api/v1/integrations/telegram/bindings/:chatId/address-session",
  async (req, res, params) => {
    await auth.requireService(req);
    const chatId = telegramChatIdentifier({ chatId: params.chatId });
    const session = await db.getTelegramAddressSession(chatId);
    if (!session) {
      return sendJson(res, 404, { error: "Telegram chat is not linked" });
    }
    const confirmed = Boolean(session.selected_address_id && session.formatted_address);
    sendJson(res, 200, {
      confirmed,
      selectedAddress: confirmed
        ? {
            addressId: String(session.selected_address_id),
            label: session.label || "Delivery address",
            formattedAddress: session.formatted_address,
          }
        : null,
    });
  }
);

route(
  "POST",
  "/api/v1/integrations/telegram/bindings/:chatId/address-session",
  async (req, res, params) => {
    await auth.requireService(req);
    const chatId = telegramChatIdentifier({ chatId: params.chatId });
    const binding = await db.getTelegramHermesBinding(chatId);
    if (!binding) {
      return sendJson(res, 404, { error: "Telegram chat is not linked" });
    }
    const body = await parseBody(req);
    if (body.reset === true) {
      await db.resetTelegramAddressSession(chatId);
      return sendJson(res, 200, { confirmed: false, selectedAddress: null });
    }
    if (body.awaitingAddress === true) {
      await db.resetTelegramAddressSession(chatId);
      return sendJson(res, 200, {
        confirmed: false,
        awaitingAddress: true,
        selectedAddress: null,
      });
    }
    if (body.awaitingAddress === false) {
      return sendJson(res, 200, {
        confirmed: false,
        awaitingAddress: false,
        selectedAddress: null,
      });
    }
    const addressId = String(body.addressId || "").trim();
    if (!/^[1-9]\d*$/.test(addressId)) {
      throw Object.assign(new Error("addressId is required"), { status: 400 });
    }
    const selected = await db.selectFamilyAddress(Number(binding.user_id), addressId);
    if (!selected) {
      return sendJson(res, 404, { error: "Tokko address not found" });
    }
    const session = await db.confirmTelegramAddressSession(chatId, addressId);
    if (!session) {
      return sendJson(res, 409, { error: "Could not confirm this Telegram address session" });
    }
    sendJson(res, 200, {
      confirmed: true,
      selectedAddress: publicFamilyAddress(selected),
    });
  }
);

route("GET", "/api/v1/system/db/records", async (req, res) => {
  await auth.requireService(req);
  const requestedLimit = Number.parseInt(getQuery(req).limit, 10) || 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 50);
  const userIds = await db.getRecentUserIds(limit);
  const records = await Promise.all(
    userIds.map((userId) => getUserState(userId))
  );
  sendJson(res, 200, {
    count: records.length,
    records,
    omitted:
      "Password hashes, session tokens, raw card details, and merchant tokens are never returned.",
  });
});

route("GET", "/api/me", async (req, res) => {
  const user = await auth.requireUser(req);
  sendJson(res, 200, await getUserState(user.userId, user.clerkUserId));
});

route("PUT", "/api/onboarding/profile", async (req, res) => {
  const user = await auth.requireUser(req);
  const input = validation.websiteOnboardingInput(await parseBody(req));
  let userId = Number(user.userId);
  if (input.primaryParentPhone) {
    const linkedUser = await db.linkWebsiteUserPhone(
      user.userId,
      {
        clerkUserId: user.clerkUserId,
        email: user.email,
      },
      input.primaryParentPhone
    );
    userId = Number(linkedUser.id);
  }
  await db.saveProfile(userId, input, "website");
  await db.recordActivityEvent(userId, {
    eventType: "family_updated",
    title: "Family circle updated",
    detail: `${input.dependents.length} member${input.dependents.length === 1 ? "" : "s"} ready for Tokko`,
    entityType: "family",
    metadata: { memberCount: input.dependents.length },
  });
  sendJson(res, 200, await getUserState(userId, user.clerkUserId));
});

route("PUT", "/api/onboarding/merchant-consent", async (req, res) => {
  const user = await auth.requireUser(req);
  const { consented } = await parseBody(req);
  await saveMerchantConsent({
    userId: user.userId,
    consented,
    source: "website",
    clerkUserId: user.clerkUserId,
  });
  sendJson(res, 200, await getUserState(user.userId, user.clerkUserId));
});

route("GET", "/api/payments/return", async (req, res) => {
  const query = getQuery(req);
  if (query.channel === "telegram") {
    const bot = telegramBotUsername(query.bot);
    const payload =
      query.flow === "mandate"
        ? "payments_mandate_return"
        : "payments_card_return";
    return sendRedirect(
      res,
      `https://t.me/${encodeURIComponent(bot)}?start=${payload}`
    );
  }
  return sendRedirect(res, `${BASE_URL}/`);
});

route("POST", "/api/payments/tokenization-session", async (req, res) => {
  const user = await auth.requireUser(req);
  const input = await parseBody(req);
  sendJson(
    res,
    201,
    await createTokenizationSessionForUser(user.userId, input)
  );
});

route("POST", "/api/payments/payment-methods", async (req, res) => {
  const user = await auth.requireUser(req);
  const { sessionId, enrollmentId } = await parseBody(req);
  sendJson(res, 201, {
    paymentMethod: await completePaymentSetup(
      user.userId,
      sessionId,
      enrollmentId
    ),
  });
});

route("GET", "/api/payments/payment-methods", async (req, res) => {
  const user = await auth.requireUser(req);
  const familyPhone =
    getQuery(req).familyPhone || req.headers["x-tokko-family-phone"];
  await assertFamilyPhoneForUser(user.userId, familyPhone);
  const [methods, customer] = await Promise.all([
    syncPravaPaymentMethodsForUser(user.userId),
    getOrCreateFamilyPaymentCustomer(user.userId),
  ]);
  sendJson(res, 200, {
    customerId: customer.provider_customer_id,
    paymentMethods: methods.map(publicPaymentMethod),
    ...(familyPhone ? { familyPhone } : {}),
  });
});

route("GET", "/api/payments/mandates", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const { customerId } = await pravaMandateIdentity(user.userId);
    const mandates = await payments.listMandates(customerId);
    sendJson(res, 200, mandateListPayload(mandates, getQuery(req)));
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
});

route("GET", "/api/payments/payment-results", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const query = getQuery(req);
    const familyPhone =
      query.familyPhone || req.headers["x-tokko-family-phone"];
    await assertFamilyPhoneForUser(user.userId, familyPhone);
    const requestedLimit = Math.min(
      Math.max(Number.parseInt(query.limit, 10) || 3, 1),
      10
    );
    const sessionRows = await db.getRecentPaymentTokenizationSessions(
      user.userId,
      "prava",
      requestedLimit
    );
    const sessionResults = await Promise.all(
      sessionRows.map(async (session) => {
        try {
          const result = await payments.getPaymentResult(session.session_id);
          return {
            sessionId: session.session_id,
            createdAt: session.created_at,
            completedAt: session.completed_at,
            expiresAt: session.expires_at,
            result: redactedPravaResult(result),
          };
        } catch (error) {
          return {
            sessionId: session.session_id,
            createdAt: session.created_at,
            completedAt: session.completed_at,
            expiresAt: session.expires_at,
            error: error.message,
          };
        }
      })
    );
    let flow = null;
    let mandateResult = null;
    if (query.checkoutId) {
      const id = checkoutId(query.checkoutId);
      flow = await db.getCheckoutFlow(user.userId, id);
      if (!flow) {
        throw Object.assign(new Error("Checkout flow was not found"), {
          status: 404,
        });
      }
      if (flow.prava_mandate_id) {
        mandateResult = await payments
          .getMandate(flow.prava_mandate_id)
          .catch((error) => ({ error: error.message }));
      }
    }
    sendJson(res, 200, {
      checkoutFlow: checkoutFlow(flow),
      mandateResult,
      pravaPaymentResult: pravaResultSnapshot(flow, { mandateResult }),
      sessionResults,
      credentialsRedacted: true,
      note:
        "Payment-session results and mandate-charge results are separate Prava flows. " +
        "Virtual PAN, dynamic CVV, and cryptogram values are redacted here.",
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
});

route("POST", "/api/payments/mandates/session", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const input = await parseBody(req);
    sendJson(
      res,
      201,
      await createPravaMandateForUser(user.userId, input)
    );
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
});

route("POST", "/api/merchant/zepto/connect/start", async (req, res) => {
  const user = await auth.requireUser(req);
  sendJson(
    res,
    200,
    await auth.startMerchantAuth(user.userId, "zepto", BASE_URL)
  );
});

route("POST", "/api/merchant/zepto/connect/verify", async (req, res) => {
  const user = await auth.requireUser(req);
  const { pendingId, otp } = await parseBody(req);
  if (
    typeof pendingId !== "string" ||
    typeof otp !== "string" ||
    !/^\d{6}$/.test(otp)
  ) {
    return sendJson(res, 400, { error: "pendingId and a 6-digit OTP are required" });
  }
  sendJson(res, 200, await auth.verifyMerchantAuth(user.userId, pendingId, otp));
});

route("POST", "/api/v1/onboarding", async (req, res) => {
  await auth.requireService(req);
  const body = await parseBody(req);
  const input = validation.onboardingInput(body);
  const accountEmail = validation.optionalEmail(
    body.accountEmail ?? body.email,
    "accountEmail"
  );
  const user = await db.upsertExternalUser(
    input.primaryParentPhone,
    accountEmail,
    "telegram"
  );
  const userId = Number(user.id);
  const profile = await db.saveProfile(userId, input, "telegram");
  const requestedConsent =
    body.consent?.useSelectedPhoneForMerchantAuth === true ||
    body.consent?.useAccountHolderPhoneForMerchantAuth === true ||
    body.consent?.useDependentPhoneForMerchantAuth === true ||
    body.consent?.useOffspringPhoneForMerchantAuth === true;
  await saveMerchantConsent({
    userId,
    consented: requestedConsent,
    source: "telegram",
  });
  sendJson(res, 201, {
    userId,
    customerId: (
      await getOrCreateFamilyPaymentCustomer(userId)
    ).provider_customer_id,
    accountEmail,
    onboardingSource: "telegram",
    profile: publicProfile(profile),
    merchantConsent: {
      merchant: "zepto",
      consented: requestedConsent,
      policyVersion: CONSENT_POLICY_VERSION,
    },
  });
});

route("POST", "/api/v1/linq/onboard", async (req, res) => {
  await auth.requireService(req);
  if (!process.env.LINQ_API_KEY && !process.env.LINQ_PHONE_NUMBER) {
    throw Object.assign(
      new Error("LINQ onboarding is disabled for this deployment"),
      { status: 503 }
    );
  }
  const body = await parseBody(req);
  const input = validation.onboardingInput(body);
  const accountEmail = validation.optionalEmail(
    body.accountEmail ?? body.email,
    "accountEmail"
  );
  const user = await db.upsertLinqUser(
    input.primaryParentPhone,
    accountEmail
  );
  let profile = await db.saveProfile(Number(user.id), input, "linq");

  let assignment = profile.linq_phone_number
    ? {
        id: profile.linq_phone_number_id,
        phone_number: profile.linq_phone_number,
      }
    : await linq.assignPhoneNumber(user.id);
  if (!profile.linq_phone_number) {
    profile = await db.saveLinqAssignment(Number(user.id), assignment);
  }

  const requestedConsent =
    body.consent?.useSelectedPhoneForMerchantAuth === true ||
    body.consent?.useAccountHolderPhoneForMerchantAuth === true ||
    body.consent?.useDependentPhoneForMerchantAuth === true ||
    body.consent?.useOffspringPhoneForMerchantAuth === true;
  await saveMerchantConsent({
    userId: Number(user.id),
    consented: requestedConsent,
    source: "linq",
  });

  let welcomeMessage = { sent: Boolean(profile.linq_chat_id) };
  if (body.sendWelcomeMessage !== false && !profile.linq_chat_id) {
    try {
      const chat = await linq.createOnboardingChat({
        from: assignment.phone_number,
        to: input.primaryParentPhone,
        primaryParentName: input.primaryParentName,
        idempotencyKey: `plantri-onboard-${user.id}`,
      });
      profile = await db.saveLinqAssignment(
        Number(user.id),
        assignment,
        chat.id || null
      );
      welcomeMessage = { sent: true, chatId: chat.id || null };
    } catch (error) {
      console.error("[linq] welcome message failed:", error.message);
      welcomeMessage = { sent: false, error: error.message };
    }
  }

  sendJson(res, 201, {
    userId: Number(user.id),
    customerId: (
      await getOrCreateFamilyPaymentCustomer(Number(user.id))
    ).provider_customer_id,
    accountEmail,
    onboardingSource: "linq",
    linqNumber: assignment.phone_number,
    profile: publicProfile(profile),
    merchantConsent: {
      merchant: "zepto",
      consented: requestedConsent,
      policyVersion: CONSENT_POLICY_VERSION,
    },
    welcomeMessage,
  });
});

route("GET", "/api/v1/onboarding/:id", async (req, res, params) => {
  await auth.requireService(req);
  const userId = await resolveOnboardingUserId(params.id);
  const user = await db.getUserById(userId);
  if (!user) return sendJson(res, 404, { error: "Onboarding not found" });
  sendJson(res, 200, await getUserState(userId));
});

route(
  "PUT",
  "/api/v1/onboarding/:id/merchant-consent",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const { consented } = await parseBody(req);
    await saveMerchantConsent({ userId, consented, source: "external_api" });
    sendJson(res, 200, await getUserState(userId));
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/payment/tokenization-session",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const input = await parseBody(req);
    sendJson(
      res,
      201,
      await createTokenizationSessionForUser(userId, input)
    );
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/payment-methods",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const [methods, customer] = await Promise.all([
      syncPravaPaymentMethodsForUser(userId),
      getOrCreateFamilyPaymentCustomer(userId),
    ]);
    sendJson(res, 200, {
      userId,
      customerId: customer.provider_customer_id,
      paymentMethods: methods.map(publicPaymentMethod),
    });
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/payment/mandates",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const { customerId } = await pravaMandateIdentity(userId);
    const mandates = await payments.listMandates(customerId);
    sendJson(res, 200, {
      userId,
      customerId,
      ...mandateListPayload(mandates, getQuery(req)),
    });
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/payment/mandates/session",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const input = await parseBody(req);
    sendJson(
      res,
      201,
      await createPravaMandateForUser(userId, input)
    );
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/payment/complete",
  async (req, res, params) => {
    await auth.requireService(req);
    const { sessionId, enrollmentId } = await parseBody(req);
    const userId = await resolveOnboardingUserId(params.id);
    sendJson(res, 201, {
      paymentMethod: await completePaymentSetup(
        userId,
        sessionId,
        enrollmentId
      ),
    });
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchant/zepto/connect/start",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    sendJson(
      res,
      200,
      await auth.startMerchantAuth(
        userId,
        "zepto",
        BASE_URL
      )
    );
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchant/zepto/connect/verify",
  async (req, res, params) => {
    await auth.requireService(req);
    const { pendingId, otp } = await parseBody(req);
    if (
      typeof pendingId !== "string" ||
      typeof otp !== "string" ||
      !/^\d{6}$/.test(otp)
    ) {
      return sendJson(res, 400, {
        error: "pendingId and a 6-digit OTP are required",
      });
    }
    const userId = await resolveOnboardingUserId(params.id);
    sendJson(
      res,
      200,
      await auth.verifyMerchantAuth(
        userId,
        pendingId,
        otp
      )
    );
  }
);

route("GET", "/api/v1/linq/resolve", async (req, res) => {
  await auth.requireService(req);
  const query = getQuery(req);
  const from = validation.e164(query.from, "from");
  const to = validation.e164(query.to, "to");
  const resolved = await db.resolveLinqUser(from, to);
  if (!resolved) return sendJson(res, 404, { error: "LINQ user not found" });
  sendJson(res, 200, {
    userId: Number(resolved.id),
    from,
    linqNumber: resolved.linq_phone_number,
  });
});

route(
  "POST",
  "/api/v1/onboarding/:id/merchant/zepto/tools/:toolName",
  async (req, res, params) => {
    await auth.requireService(req);
    if (!EXTERNAL_ZEPTO_TOOLS.has(params.toolName)) {
      return sendJson(res, 404, { error: "Zepto tool is not exposed" });
    }
    const userId = await resolveOnboardingUserId(params.id);
    const user = await db.getUserById(userId);
    if (!user) return sendJson(res, 404, { error: "Onboarding not found" });
    const args = await parseBody(req);
    sendJson(
      res,
      200,
      await auth.withPlatformToolForUser(
        userId,
        "zepto",
        params.toolName,
        args
      )
    );
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/search",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    if (!(await db.getUserById(userId))) {
      return sendJson(res, 404, { error: "Onboarding not found" });
    }
    const body = await parseBody(req);
    sendJson(
      res,
      200,
      await persistUcpProductChoices(
        userId,
        await ucp.searchAll(body.query, {
          limit: body.limit,
          offset: body.offset,
          market: body.market,
          baseUrl: BASE_URL,
        })
      )
    );
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/merchants/ucp/cart",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    sendJson(res, 200, publicUcpCart(await db.getUcpCart(userId)));
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/cart/items",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const body = await parseBody(req);
    try {
      const cart = await addUcpCartChoice(
        userId,
        String(body.choiceId || ""),
        body.quantity,
        body.replaceCart === true
      );
      sendJson(res, 200, { added: true, cart: publicUcpCart(cart) });
    } catch (error) {
      sendJson(res, error.status || 500, {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.conflict ? { conflict: error.conflict } : {}),
      });
    }
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/cart/checkout",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const body = await parseBody(req);
    const cart = await db.getUcpCart(userId);
    const items = Array.isArray(cart.items) ? cart.items : [];
    if (!items.length) {
      throw Object.assign(new Error("Your cart is empty"), { status: 409 });
    }
    const merchants = new Set(
      items.map((item) => String(item.merchant || "").trim().toLowerCase())
    );
    if (merchants.size !== 1 || merchants.has("")) {
      throw Object.assign(
        new Error("Checkout requires a cart containing one merchant"),
        { status: 409 }
      );
    }
    const cartMerchant = [...merchants][0];
    const requestedMerchant = String(body.merchant || "").trim().toLowerCase();
    if (requestedMerchant && requestedMerchant !== cartMerchant) {
      throw Object.assign(
        new Error("The checkout merchant does not match the current cart"),
        { status: 409 }
      );
    }
    const checkout = await createUcpCheckoutQuote(userId, {
      items: items.map((item) => ({
        selectionToken: item.selectionToken,
        quantity: item.quantity,
      })),
    });
    const orderId = nodeCrypto.randomUUID();
    await db.saveCheckoutFlow({
      id: orderId,
      userId,
      platform: "ucp",
      status: "UCP_REVIEW",
      addressId: checkout.autofill?.addressId || null,
      allowCodFallback: false,
      priceBreakdown: checkout,
      cartSnapshot: items.map((item) => ({
        selectionToken: item.selectionToken,
        quantity: item.quantity,
      })),
    });
    sendJson(res, 201, {
      ...checkout,
      orderId,
      approvalRequired: true,
      confirmationRequired: true,
      merchantHandoffUrl: null,
      checkoutUrl: null,
      continueUrl: null,
      nextAction: null,
    });
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/orders/:orderId/decision",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const orderId = checkoutId(params.orderId);
    const body = await parseBody(req);
    if (typeof body.proceed !== "boolean") {
      throw Object.assign(new Error("proceed must be true or false"), {
        status: 400,
      });
    }
    const flow = await db.getCheckoutFlow(userId, orderId);
    if (!flow || flow.platform !== "ucp") {
      throw Object.assign(new Error("Checkout quote not found"), { status: 404 });
    }
    if (Date.now() - new Date(flow.created_at).getTime() > 30 * 60 * 1_000) {
      if (flow.status === "UCP_REVIEW") {
        await db.transitionCheckoutFlow(
          userId,
          orderId,
          "UCP_REVIEW",
          "UCP_EXPIRED"
        );
      }
      throw Object.assign(new Error("Checkout quote expired. Open the cart again."), {
        status: 410,
      });
    }
    if (body.proceed === false) {
      if (flow.status === "UCP_CANCELED") {
        return sendJson(res, 200, { canceled: true, orderId });
      }
      const canceled = await db.transitionCheckoutFlow(
        userId,
        orderId,
        "UCP_REVIEW",
        "UCP_CANCELED"
      );
      if (!canceled) {
        throw Object.assign(new Error("This checkout can no longer be canceled"), {
          status: 409,
        });
      }
      return sendJson(res, 200, { canceled: true, orderId });
    }
    const claimed = await db.transitionCheckoutFlow(
      userId,
      orderId,
      "UCP_REVIEW",
      "UCP_APPROVING"
    );
    if (!claimed) {
      throw Object.assign(new Error("This checkout was already decided"), {
        status: 409,
      });
    }
    try {
      const result = await resolveUcpCheckoutPayment(
        userId,
        claimed.price_breakdown
      );
      await db.saveCheckoutFlow(
        flowRecord(claimed, {
          status: "UCP_APPROVED",
          paymentRoute: result.paymentRoute,
          failureMessage: null,
        })
      );
      return sendJson(res, 200, {
        ...result,
        orderId,
        approvalRequired: false,
        confirmationRequired: false,
      });
    } catch (error) {
      await db.saveCheckoutFlow(
        flowRecord(claimed, {
          status: "UCP_REVIEW",
          failureMessage: error.message,
        })
      );
      throw error;
    }
  }
);

route(
  "DELETE",
  "/api/v1/onboarding/:id/merchants/ucp/cart",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const cart = await db.clearUcpCart(userId);
    sendJson(res, 200, { cleared: true, cart: publicUcpCart(cart) });
  }
);

route(
  "DELETE",
  "/api/v1/onboarding/:id/merchants/ucp/cart/items/:itemId",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const cart = await db.getUcpCart(userId);
    const items = Array.isArray(cart.items) ? cart.items : [];
    const removedItem = items.find(
      (item) => String(item.id) === String(params.itemId)
    );
    if (!removedItem) {
      return sendJson(res, 404, { error: "Cart item not found" });
    }
    const saved = await db.saveUcpCart(userId, {
      items: items.filter((item) => String(item.id) !== String(params.itemId)),
    });
    sendJson(res, 200, {
      removed: true,
      removedItem: publicUcpCart({ items: [removedItem] }).items[0],
      cart: publicUcpCart(saved),
    });
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/addresses",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    await db.clearDeliveryPreference(userId, "zepto");
    sendJson(res, 200, familyAddressPayload(await db.getFamilyAddresses(userId)));
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/addresses",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const address = await db.createFamilyAddress(
      userId,
      familyAddressInput(await parseBody(req))
    );
    sendJson(res, 201, {
      saved: true,
      savedAddress: publicFamilyAddress(address),
      ...familyAddressPayload(await db.getFamilyAddresses(userId)),
    });
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/addresses/select",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const { addressId } = await parseBody(req);
    const selected = await db.selectFamilyAddress(userId, addressId);
    if (!selected) return sendJson(res, 404, { error: "Tokko address not found" });
    sendJson(res, 200, {
      selected: true,
      selectedAddress: publicFamilyAddress(selected),
      ...familyAddressPayload(await db.getFamilyAddresses(userId)),
    });
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/merchant/zepto/addresses",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const preference = await db.getDeliveryPreference(userId, "zepto");
    if (preference) {
      return sendJson(res, 200, {
        confirmed: true,
        selectedAddress: publicDeliveryPreference(preference),
        addresses: [],
      });
    }
    return sendJson(res, 200, {
      confirmed: false,
      selectedAddress: null,
      addresses: await listZeptoAddressesForUser(userId),
    });
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchant/zepto/address/confirm",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const { addressId, addressIndex } = await parseBody(req);
    sendJson(
      res,
      200,
      await confirmZeptoAddressForUser(userId, addressId, addressIndex)
    );
  }
);

route("POST", "/api/webhooks/linq", async (req, res) => {
  const rawBody = await readRawBody(req);
  if (
    !linq.verifyWebhook(
      process.env.LINQ_WEBHOOK_SECRET,
      rawBody,
      req.headers
    )
  ) {
    return sendJson(res, 401, { error: "Invalid LINQ webhook signature" });
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return sendJson(res, 400, { error: "Invalid webhook JSON" });
  }
  const eventId = req.headers["webhook-id"] || event.id || event.event_id;
  const eventType = event.type || event.event_type || null;
  if (!eventId) return sendJson(res, 400, { error: "Webhook event id is missing" });
  const isNew = await db.recordWebhookEvent("linq", eventId, eventType);
  sendJson(res, 200, { received: true, duplicate: !isNew });
});

route("GET", "/api/zepto-status", async (req, res) => {
  const user = await auth.requireUser(req);
  const state = await getUserState(user.userId, user.clerkUserId);
  sendJson(res, 200, { connected: state.merchantConnected });
});

route("GET", "/api/platforms", async (req, res) => {
  const user = await auth.requireUser(req);
  const allPlatforms = await db.getAllPlatforms();
  const consents = await db.getUserConsents(user.userId);
  const consented = new Set(
    consents
      .filter((entry) => entry.consented === true)
      .map((entry) => entry.slug)
  );
  sendJson(res, 200, {
    platforms: allPlatforms.map((platform) => ({
      slug: platform.slug,
      name: platform.name,
      connected: consented.has(platform.slug),
    })),
  });
});

route("GET", "/api/addresses", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    return sendJson(
      res,
      200,
      familyAddressPayload(await db.getFamilyAddresses(user.userId))
    );
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message });
  }
});
route("POST", "/api/addresses", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const body = await parseBody(req);
    const address = await db.createFamilyAddress(
      user.userId,
      familyAddressInput(body, { requireContact: true })
    );
    await db.assignFamilyAddress(user.userId, address.id, body.memberIds);
    await db.recordActivityEvent(user.userId, {
      eventType: "address_added",
      title: `${address.label} address added`,
      detail: address.formatted_address,
      entityType: "address",
      entityId: address.id,
    });
    const addresses = await db.getFamilyAddresses(user.userId);
    return sendJson(res, 201, {
      saved: true,
      reflected: true,
      savedAddressId: String(address.id),
      savedAddress: publicFamilyAddress(
        addresses.find((entry) => String(entry.id) === String(address.id))
      ),
      ...familyAddressPayload(addresses),
    });
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }
});
route("PUT", "/api/addresses/:id", async (req, res, params) => {
  try {
    const user = await auth.requireUser(req);
    const body = await parseBody(req);
    const updated = await db.updateFamilyAddress(
      user.userId,
      params.id,
      familyAddressInput(body, { requireContact: true })
    );
    if (!updated) return sendJson(res, 404, { error: "Tokko address not found" });
    await db.assignFamilyAddress(user.userId, params.id, body.memberIds);
    await db.recordActivityEvent(user.userId, {
      eventType: "address_updated",
      title: `${updated.label} address updated`,
      detail: updated.formatted_address,
      entityType: "address",
      entityId: params.id,
    });
    return sendJson(
      res,
      200,
      familyAddressPayload(await db.getFamilyAddresses(user.userId))
    );
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }
});
route("DELETE", "/api/addresses/:id", async (req, res, params) => {
  try {
    const user = await auth.requireUser(req);
    const removed = await db.deleteFamilyAddress(user.userId, params.id);
    if (!removed) return sendJson(res, 404, { error: "Tokko address not found" });
    await db.recordActivityEvent(user.userId, {
      eventType: "address_removed",
      title: "Delivery address removed",
      entityType: "address",
      entityId: params.id,
    });
    return sendJson(
      res,
      200,
      familyAddressPayload(await db.getFamilyAddresses(user.userId))
    );
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }
});
route("POST", "/api/addresses/select", async (req, res) => {
  const { addressId } = await parseBody(req);
  try {
    const user = await auth.requireUser(req);
    const selected = await db.selectFamilyAddress(user.userId, addressId);
    if (!selected) return sendJson(res, 404, { error: "Tokko address not found" });
    await db.recordActivityEvent(user.userId, {
      eventType: "address_selected",
      title: `${selected.label} set as default`,
      detail: selected.formatted_address,
      entityType: "address",
      entityId: selected.id,
    });
    return sendJson(res, 200, {
      selected: true,
      selectedAddress: publicFamilyAddress(selected),
      ...familyAddressPayload(await db.getFamilyAddresses(user.userId)),
    });
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }
});
route("GET", "/api/care-rules", async (req, res) => {
  const user = await auth.requireUser(req);
  sendJson(res, 200, { careRules: publicCareRules(await db.getCareRules(user.userId)) });
});
route("PUT", "/api/care-rules", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const rules = await db.saveCareRules(
      user.userId,
      careRulesInput(await parseBody(req))
    );
    await db.recordActivityEvent(user.userId, {
      eventType: "care_rules_updated",
      title: rules.approval_mode === "auto_essentials"
        ? "Automatic essentials configured"
        : "Approval required for every order",
      detail: rules.approval_mode === "auto_essentials"
        ? `${rules.currency} ${Number(rules.per_order_cap)} per order · ${rules.currency} ${Number(rules.monthly_cap)} monthly`
        : "Tokko will ask before every purchase",
      entityType: "care_rules",
    });
    sendJson(res, 200, { careRules: publicCareRules(rules) });
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
  }
});
route("GET", "/api/preferences", async (req, res) => {
  const user = await auth.requireUser(req);
  sendJson(res, 200, {
    preferences: publicPreferences(await db.getUserPreferences(user.userId)),
  });
});
route("PUT", "/api/preferences", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const current = await db.getUserPreferences(user.userId);
    const preferences = await db.saveUserPreferences(
      user.userId,
      preferenceInput(await parseBody(req), current)
    );
    sendJson(res, 200, { preferences: publicPreferences(preferences) });
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
  }
});
route("GET", "/api/decisions", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const query = getQuery(req);
    const status = !query.status || query.status === "all" ? null : query.status;
    if (status && !new Set(["pending", "resolved", "expired"]).has(status)) {
      throw Object.assign(new Error("status is invalid"), { status: 400 });
    }
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 50, 1), 100);
    const decisions = await db.getDecisionRequests(user.userId, { status, limit });
    sendJson(res, 200, { decisions: decisions.map(publicDecision) });
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
  }
});
route("POST", "/api/decisions/:id/resolve", async (req, res, params) => {
  try {
    const user = await auth.requireUser(req);
    const body = await parseBody(req);
    const resolution = String(body.resolution || "").trim();
    if (!new Set(["approve", "decline"]).has(resolution)) {
      throw Object.assign(new Error("resolution must be approve or decline"), {
        status: 400,
      });
    }
    const note = String(body.note || "").trim().slice(0, 500) || null;
    const current = (await db.getDecisionRequests(user.userId, { limit: 100 }))
      .find((entry) => entry.id === params.id);
    if (current?.request_type === "safety_stop" && resolution === "approve") {
      throw Object.assign(
        new Error("A safety stop cannot be approved; review or decline the request"),
        { status: 409 }
      );
    }
    const result = await db.resolveDecisionRequest(
      user.userId,
      params.id,
      resolution,
      note
    );
    if (result.outcome === "not_found") {
      return sendJson(res, 404, { error: "Decision request not found" });
    }
    if (result.outcome === "conflict") {
      return sendJson(res, 409, {
        error: "This request was already resolved differently",
        decision: publicDecision(result.decision),
      });
    }
    if (result.outcome === "expired") {
      return sendJson(res, 409, {
        error: "This request has expired",
        decision: publicDecision(result.decision),
      });
    }
    if (result.outcome === "resolved") {
      await db.recordActivityEvent(user.userId, {
        eventType: `decision_${resolution}d`,
        title: resolution === "approve" ? "Request approved" : "Request declined",
        detail: current?.title || null,
        entityType: "decision",
        entityId: params.id,
        metadata: { resolution },
      });
    }
    sendJson(res, 200, {
      outcome: result.outcome,
      decision: publicDecision(result.decision),
    });
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
  }
});
route("GET", "/api/activity", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const limit = Math.min(
      Math.max(Number.parseInt(getQuery(req).limit, 10) || 50, 1),
      100
    );
    sendJson(res, 200, {
      activity: (await db.getActivityEvents(user.userId, limit)).map(publicActivity),
    });
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
  }
});
route("POST", "/api/v1/decisions", async (req, res) => {
  try {
    await auth.requireService(req);
    const body = await parseBody(req);
    let user = null;
    if (body.userId || body.familyUserId) {
      user = await db.getUserById(parseOnboardingId(body.userId || body.familyUserId));
    } else if (body.email || body.familyEmail) {
      user = await db.getUserByEmail(body.email || body.familyEmail);
    } else if (body.phone || body.familyPhone) {
      const userId = await resolveOnboardingUserId(body.phone || body.familyPhone);
      user = await db.getUserById(userId);
    }
    if (!user) {
      throw Object.assign(
        new Error("A valid userId, email, or family phone is required"),
        { status: 404 }
      );
    }
    const input = decisionRequestInput(body);
    const decision = await db.createDecisionRequest(Number(user.id), input);
    if (!decision) {
      throw Object.assign(
        new Error("The selected family member or address was not found"),
        { status: 404 }
      );
    }
    await db.recordActivityEvent(Number(user.id), {
      eventType: "decision_requested",
      title: input.title,
      detail: input.reasonText,
      entityType: "decision",
      entityId: input.id,
      metadata: { requestType: input.requestType },
    });
    sendJson(res, 201, { decision: publicDecision(decision) });
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
  }
});
route("POST", "/api/location/serviceability", async (req, res) => {
  const { latitude, longitude } = await parseBody(req);
  if (
    !Number.isFinite(Number(latitude)) ||
    !Number.isFinite(Number(longitude))
  ) {
    return sendJson(res, 400, {
      error: "Numeric latitude and longitude are required",
    });
  }
  return toolRoute(req, res, "zepto", "get_location_serviceability", {
    latitude: Number(latitude),
    longitude: Number(longitude),
  });
});
route("GET", "/api/search", (req, res) => {
  const search = getQuery(req);
  const query = search.q;
  if (!query) return sendJson(res, 400, { error: "Missing ?q= param" });
  const pageNumber =
    search.pageNumber === undefined
      ? 0
      : Number.parseInt(search.pageNumber, 10);
  if (!Number.isInteger(pageNumber) || pageNumber < 0) {
    return sendJson(res, 400, {
      error: "pageNumber must be a non-negative integer",
    });
  }
  return toolRoute(req, res, "zepto", "search_products", {
    query,
    pageNumber,
  });
});
route("GET", "/api/product/:id", (req, res, params) =>
  toolRoute(req, res, "zepto", "get_product_details", {
    product_variant_id: params.id,
  })
);
route("GET", "/api/cart", (req, res) =>
  toolRoute(req, res, "zepto", "view_cart", {})
);
route("POST", "/api/cart", async (req, res) =>
  toolRoute(req, res, "zepto", "update_cart", await parseBody(req))
);
route("GET", "/api/payment-methods", async (req, res) => {
  try {
    const merchantResult = requireSuccessfulZeptoTool(
      await auth.withPlatformTool(req, "zepto", "get_payment_methods", {}),
      "get_payment_methods"
    );
    const availability =
      checkout.zeptoOnlinePaymentAvailability(merchantResult);
    const response =
      merchantResult
      && typeof merchantResult === "object"
      && !Array.isArray(merchantResult)
        ? { ...merchantResult }
        : { merchantResult };
    sendJson(res, 200, {
      ...response,
      // An unknown-but-successful MCP shape must not incorrectly disable the
      // Zepto secure payment-link path. Only an explicit COD-only response does.
      onlinePaymentAvailable: availability !== false,
      onlinePaymentAvailabilityConfirmed: availability !== null,
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
});
route("POST", "/api/order", async (req, res) => {
  try {
    const input = await parseBody(req);
    const merchantInput = merchantOrderInput(input, input.confirmOrder === true);
    if (input.confirmOrder !== true) {
      const user = await auth.requireUser(req);
      const cartResult = await auth.withPlatformTool(
        req,
        "zepto",
        "view_cart",
        {}
      );
      await auth.withPlatformTool(req, "zepto", "get_payment_methods", {});
      const preview = requireSuccessfulZeptoTool(
        await auth.withPlatformTool(
          req,
          "zepto",
          "create_order",
          merchantInput
        ),
        "create_order"
      );
      const priceBreakdown = checkout.zeptoPriceBreakdown(preview);
      let savedFlow = null;
      if (input.checkoutId) {
        const id = checkoutId(input.checkoutId);
        const existing = await db.getCheckoutFlow(user.userId, id);
        savedFlow = await db.saveCheckoutFlow(
          existing
            ? flowRecord(existing, {
                status: "REVIEW_COD",
                addressId: merchantInput.userAddressId,
                priceBreakdown,
                cartSnapshot: checkout.zeptoCartSnapshot(cartResult),
                failureMessage: null,
              })
            : {
                id,
                userId: user.userId,
                status: "REVIEW_COD",
                addressId: merchantInput.userAddressId,
                cardFailureCount: 0,
                cardPaymentReceived: false,
                allowCodFallback: true,
                fallbackToCod: false,
                priceBreakdown,
                cartSnapshot: checkout.zeptoCartSnapshot(cartResult),
              }
        );
      }
      const response =
        preview && typeof preview === "object"
          ? { ...preview }
          : { merchantResult: preview };
      return sendJson(res, 200, {
        ...response,
        priceBreakdown,
        checkoutFlow: checkoutFlow(savedFlow),
      });
    }
    const user = await auth.requireUser(req);
    if (input.checkoutId) {
      const existing = await db.getCheckoutFlow(
        user.userId,
        checkoutId(input.checkoutId)
      );
      if (existing?.status === "COD_PERMISSION_REQUIRED") {
        throw Object.assign(
          new Error(
            "Explicit COD approval is required through /api/order/cod-decision"
          ),
          { status: 409 }
        );
      }
    }
    const confirmed = await confirmedZeptoOrder(
      req,
      "create_order",
      merchantInput
    );
    let savedFlow = null;
    if (input.checkoutId) {
      const id = checkoutId(input.checkoutId);
      const existing = await db.getCheckoutFlow(user.userId, id);
      if (!existing) {
        throw Object.assign(new Error("Checkout preview expired"), {
          status: 409,
        });
      }
      savedFlow = await db.saveCheckoutFlow(
        flowRecord(existing, {
          status: confirmed.orderId ? "COD_CONFIRMED" : "COD_UNCONFIRMED",
          cardPaymentReceived: false,
          zeptoOrderId: confirmed.orderId,
          failureMessage: confirmed.orderId
            ? null
            : "Zepto has not confirmed an order ID. The cart was retained.",
        })
      );
    }
    const response =
      confirmed.merchantResult &&
      typeof confirmed.merchantResult === "object"
        ? { ...confirmed.merchantResult }
        : { merchantResult: confirmed.merchantResult };
    return sendJson(res, 200, {
      ...response,
      orderId: confirmed.orderId,
      recoveredOrder: confirmed.recoveredOrder,
      orderLookupPending: !confirmed.orderId,
      checkoutFlow: checkoutFlow(savedFlow),
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message });
  }
});
route("POST", "/api/order/online", async (req, res) => {
  try {
    const input = await parseBody(req);
    const user = await auth.requireUser(req);
    const pravaEnvironment = payments.configuration().environment;
    const sandboxPaymentAttempt =
      pravaEnvironment !== "production";
    const merchantInput = merchantOrderInput(input, input.confirmOrder === true);
    if (input.confirmOrder !== true) {
      const cartResult = await auth.withPlatformTool(
        req,
        "zepto",
        "view_cart",
        {}
      );
      await auth.withPlatformTool(req, "zepto", "get_payment_methods", {});
      const preview = requireSuccessfulZeptoTool(
        await auth.withPlatformTool(
          req,
          "zepto",
          "create_online_payment_order",
          merchantInput
        ),
        "create_online_payment_order"
      );
      const priceBreakdown = checkout.zeptoPriceBreakdown(preview);
      let savedFlow = null;
      if (input.checkoutId) {
        const id = checkoutId(input.checkoutId);
        const methods = await db.getPaymentMethods(user.userId, "prava");
        const selected =
          methods.find(
            (method) => String(method.id) === String(input.paymentMethodId)
          )
          || methods.find((method) => method.is_default === true)
          || methods[0];
        if (!selected) {
          throw Object.assign(
            new Error("No tokenized Prava card is saved"),
            { status: 409 }
          );
        }
        const existing = await db.getCheckoutFlow(user.userId, id);
        savedFlow = await db.saveCheckoutFlow(
          existing
            ? flowRecord(existing, {
                status: "REVIEW_CARD",
                addressId: merchantInput.userAddressId,
                cardBrand: selected.brand,
                cardLast4: selected.last4,
                pravaMandateId:
                  String(input.mandateId || "").trim() || null,
                sandboxPaymentAttempt,
                allowCodFallback:
                  input.allowCodFallback !== false,
                priceBreakdown,
                cartSnapshot: checkout.zeptoCartSnapshot(cartResult),
                failureMessage: null,
              })
            : {
                id,
                userId: user.userId,
                status: "REVIEW_CARD",
                addressId: merchantInput.userAddressId,
                cardBrand: selected.brand,
                cardLast4: selected.last4,
                pravaMandateId:
                  String(input.mandateId || "").trim() || null,
                sandboxPaymentAttempt,
                cardFailureCount: 0,
                cardPaymentReceived: false,
                allowCodFallback:
                  input.allowCodFallback !== false,
                fallbackToCod: false,
                priceBreakdown,
                cartSnapshot: checkout.zeptoCartSnapshot(cartResult),
              }
        );
      }
      const response =
        preview && typeof preview === "object"
          ? { ...preview }
          : { merchantResult: preview };
      return sendJson(res, 200, {
        ...response,
        priceBreakdown,
        pravaEnvironment,
        checkoutFlow: checkoutFlow(savedFlow),
        paymentHandoff: null,
      });
    }
    const id = input.checkoutId ? checkoutId(input.checkoutId) : null;
    let flow = id ? await db.getCheckoutFlow(user.userId, id) : null;
    if (!id || !flow) {
      throw Object.assign(new Error("Checkout preview expired"), {
        status: 409,
      });
    }
    const paymentConfiguration = payments.configuration();
    const sandboxZeptoAttempt =
      paymentConfiguration.environment !== "production";
    if (sandboxZeptoAttempt) {
      flow = await db.saveCheckoutFlow(
        flowRecord(flow, {
          sandboxPaymentAttempt: true,
          allowCodFallback: input.allowCodFallback !== false,
          fallbackToCod: false,
        })
      );
    }
    if (
      [
        "CARD_PAYMENT_PENDING",
        "SANDBOX_ZEPTO_PAYMENT_PENDING",
        "CARD_PAYMENT_RECEIVED",
        "COD_FALLBACK_CONFIRMED",
      ].includes(flow.status)
    ) {
      throw Object.assign(
        new Error("Resolve the current payment attempt before trying again"),
        { status: 409 }
      );
    }
    if (
      Number(flow.card_failure_count || 0) >= 3
      && !["CARD_PAYMENT_RECEIVED", "COD_FALLBACK_CONFIRMED"].includes(
        flow.status
      )
    ) {
      throw Object.assign(
        new Error(
          "Three card attempts have failed. Choose whether to place this order with Cash on Delivery."
        ),
        { status: 409 }
      );
    }
    const previewAmount = positiveBreakdownAmount(flow.price_breakdown);
    if (!previewAmount) {
      throw Object.assign(
        new Error(
          "Zepto did not return a positive checkout preview. Refresh the cart before confirming online payment."
        ),
        { status: 409 }
      );
    }
    const requestedMandateId =
      String(input.mandateId || flow.prava_mandate_id || "").trim() || null;
    const previewMandate = await selectPravaMandateForAmount(
      user.userId,
      requestedMandateId,
      previewAmount
    );
    let charge = null;
    let chargeAmount = null;
    let chargeReference = null;
    if (sandboxZeptoAttempt) {
      chargeAmount = previewAmount;
      chargeReference =
        `tokko_sandbox_zepto_${String(flow.id).replace(/-/g, "")}_a` +
        `${Number(flow.card_failure_count || 0) + 1}`;
      try {
        charge = await payments.chargeMandate({
          mandateId: previewMandate.id,
          amount: chargeAmount,
          reference: chargeReference,
          purchaseContext: zeptoPurchaseContext(flow, chargeAmount),
        });
      } catch (error) {
        flow = await saveCardAttemptSetupFailure(
          flow,
          `Prava did not issue a payment credential: ${error.message}`
        );
        return sendJson(res, 200, {
          orderId: null,
          paymentStatus: "FAILED",
          sandbox: true,
          sandboxZeptoAttempt: true,
          sandboxTerminal: false,
          cardPaymentReceived: false,
          checkoutFlow: checkoutFlow(flow),
          codFallbackOrderId: null,
          paymentHandoff: null,
          pravaPaymentResult: pravaResultSnapshot(flow, {
            merchantPaymentStatus: "NOT_ATTEMPTED",
          }),
        });
      }
      flow = await db.saveCheckoutFlow(
        flowRecord(flow, {
          status: "SANDBOX_ZEPTO_PAYMENT_PENDING",
          cardPaymentReceived: false,
          sandboxPaymentAttempt: true,
          allowCodFallback: flow.allow_cod_fallback !== false,
          pravaMandateId: charge.mandateId,
          pravaTransactionId: charge.transactionId,
          pravaChargeReference: chargeReference,
          pravaChargeStatus: "CREDENTIAL_ISSUED",
          pravaChargeAmount: chargeAmount,
          pravaChargeReportedAt: null,
          failureMessage:
            "Prava issued a fresh sandbox credential. Tokko is now attempting the Zepto online order.",
        })
      );
    }
    let confirmed;
    try {
      confirmed = await confirmedZeptoOrder(
        req,
        "create_online_payment_order",
        merchantInput
      );
    } catch (error) {
      if (!flow) throw error;
      if (sandboxZeptoAttempt && charge) {
        const terminal = await closeSandboxPaymentAttempt(
          req,
          flow,
          `Sandbox attempt reached Zepto, but Zepto rejected the online order: ${error.message}`
        );
        flow = terminal.row;
        return sendJson(res, 200, {
          orderId: null,
          paymentStatus: "FAILED",
          sandbox: true,
          sandboxZeptoAttempt: true,
          sandboxTerminal: true,
          cardPaymentReceived: false,
          orderLookupPending: false,
          checkoutFlow: checkoutFlow(flow),
          codFallbackOrderId:
            flow?.zepto_order_id || terminal.codResult?.orderId || null,
          paymentHandoff: null,
          pravaReportError: terminal.pravaReportError,
          pravaPaymentResult: pravaResultSnapshot(flow, {
            merchantPaymentStatus: "FAILED",
            reportResult: terminal.pravaReportResult,
          }),
        });
      }
      flow = await saveCardAttemptSetupFailure(flow, error.message);
      return sendJson(res, 200, {
        orderId: null,
        paymentStatus: "FAILED",
        cardPaymentReceived: false,
        orderLookupPending: false,
        checkoutFlow: checkoutFlow(flow),
        codFallbackOrderId: null,
        paymentHandoff: null,
        pravaPaymentResult: pravaResultSnapshot(flow, {
          merchantPaymentStatus: "FAILED",
        }),
      });
    }
    const paymentLink = zeptoPaymentLink(confirmed.merchantResult);
    if (!confirmed.orderId || !paymentLink) {
      if (sandboxZeptoAttempt && charge) {
        const failureMessage = !confirmed.orderId
          ? "Sandbox attempt reached Zepto, but Zepto did not confirm an online order ID."
          : "Sandbox attempt reached Zepto, but Zepto did not return its secure payment link.";
        const terminal = await closeSandboxPaymentAttempt(
          req,
          flow,
          failureMessage,
          confirmed.orderId
        );
        flow = terminal.row;
        return sendJson(res, 200, {
          orderId: confirmed.orderId,
          paymentLink,
          paymentStatus: "FAILED",
          sandbox: true,
          sandboxZeptoAttempt: true,
          sandboxTerminal: true,
          cardPaymentReceived: false,
          orderLookupPending: !confirmed.orderId,
          checkoutFlow: checkoutFlow(flow),
          codFallbackOrderId:
            flow?.zepto_order_id || terminal.codResult?.orderId || null,
          paymentHandoff: null,
          pravaReportError: terminal.pravaReportError,
          pravaPaymentResult: pravaResultSnapshot(flow, {
            merchantPaymentStatus: "FAILED",
            reportResult: terminal.pravaReportResult,
          }),
        });
      }
      flow = await saveCardAttemptSetupFailure(
        flow,
        !confirmed.orderId
          ? "Zepto did not confirm an online order ID."
          : "Zepto did not return its secure payment link.",
        confirmed.orderId
      );
      return sendJson(res, 200, {
        orderId: confirmed.orderId,
        paymentLink,
        paymentStatus: "FAILED",
        cardPaymentReceived: false,
        orderLookupPending: !confirmed.orderId,
        checkoutFlow: checkoutFlow(flow),
        codFallbackOrderId: null,
        paymentHandoff: null,
        pravaPaymentResult: pravaResultSnapshot(flow, {
          merchantPaymentStatus: "FAILED",
        }),
      });
    }
    let exactBreakdown;
    try {
      exactBreakdown = await exactZeptoOrderBreakdown(req, confirmed);
    } catch (error) {
      if (sandboxZeptoAttempt && charge) {
        const terminal = await closeSandboxPaymentAttempt(
          req,
          flow,
          `Sandbox attempt reached Zepto, but its final payable amount was unavailable: ${error.message}`,
          confirmed.orderId
        );
        flow = terminal.row;
        return sendJson(res, 200, {
          orderId: confirmed.orderId,
          paymentLink,
          paymentStatus: "FAILED",
          sandbox: true,
          sandboxZeptoAttempt: true,
          sandboxTerminal: true,
          cardPaymentReceived: false,
          checkoutFlow: checkoutFlow(flow),
          codFallbackOrderId:
            flow?.zepto_order_id || terminal.codResult?.orderId || null,
          paymentHandoff: null,
          pravaReportError: terminal.pravaReportError,
          pravaPaymentResult: pravaResultSnapshot(flow, {
            merchantPaymentStatus: "FAILED",
            reportResult: terminal.pravaReportResult,
          }),
        });
      }
      flow = await db.saveCheckoutFlow(
        flowRecord(flow, {
          status: "CARD_PAYMENT_AMOUNT_UNAVAILABLE",
          cardOrderId: confirmed.orderId,
          failureMessage: error.message,
        })
      );
      return sendJson(res, error.status || 409, {
        error: error.message,
        orderId: confirmed.orderId,
        paymentLink,
        checkoutFlow: checkoutFlow(flow),
        pravaPaymentResult: pravaResultSnapshot(flow, {
          merchantPaymentStatus: "AMOUNT_UNAVAILABLE",
        }),
      });
    }
    const exactChargeAmount = positiveBreakdownAmount(exactBreakdown);
    if (!charge) {
      chargeAmount = exactChargeAmount;
      const mandate = await selectPravaMandateForAmount(
        user.userId,
        requestedMandateId,
        chargeAmount
      );
      chargeReference =
        `tokko_${String(flow.id).replace(/-/g, "")}_a` +
        `${Number(flow.card_failure_count || 0) + 1}`;
      try {
        charge = await payments.chargeMandate({
          mandateId: mandate.id,
          amount: chargeAmount,
          reference: chargeReference,
          purchaseContext: zeptoPurchaseContext(flow, chargeAmount),
        });
      } catch (error) {
        flow = await saveCardAttemptSetupFailure(
          flow,
          `Prava did not issue a payment credential: ${error.message}`,
          confirmed.orderId
        );
        return sendJson(res, 200, {
          orderId: confirmed.orderId,
          paymentLink,
          paymentStatus: "FAILED",
          cardPaymentReceived: false,
          checkoutFlow: checkoutFlow(flow),
          codFallbackOrderId: null,
          paymentHandoff: null,
          pravaPaymentResult: pravaResultSnapshot(flow, {
            merchantPaymentStatus: "FAILED",
          }),
        });
      }
    }
    flow = await db.saveCheckoutFlow(
      flowRecord(flow, {
        status: sandboxZeptoAttempt
          ? "SANDBOX_ZEPTO_PAYMENT_PENDING"
          : "CARD_PAYMENT_PENDING",
        cardPaymentReceived: false,
        cardOrderId: confirmed.orderId,
        sandboxPaymentAttempt: sandboxZeptoAttempt,
        allowCodFallback:
          flow.allow_cod_fallback !== false,
        priceBreakdown: exactBreakdown,
        pravaMandateId: charge.mandateId,
        pravaTransactionId: charge.transactionId,
        pravaChargeReference: chargeReference,
        pravaChargeStatus: "CREDENTIAL_ISSUED",
        pravaChargeAmount: chargeAmount,
        pravaChargeReportedAt: null,
        failureMessage:
          sandboxZeptoAttempt
            ? "Prava issued a sandbox credential for a real Zepto hosted-payment attempt."
            : "Prava issued a single-use credential. Complete payment on Zepto, then check status.",
      })
    );
    let initialPaymentStatus = null;
    let paymentStatus = "PENDING";
    initialPaymentStatus = await auth.withPlatformTool(
      req,
      "zepto",
      "check_payment_status",
      { orderId: confirmed.orderId, poll: false }
    ).catch((error) => ({ error: error.message }));
    paymentStatus = zeptoPaymentStatus(initialPaymentStatus);
    let codResult = null;
    let pravaReportError = null;
    let pravaReportResult = null;
    let sandboxTerminal = false;
    if (
      sandboxZeptoAttempt
      && !["SUCCESS", "COMPLETED", "PAID"].includes(paymentStatus)
    ) {
      const observedStatus = paymentStatus;
      const terminal = await closeSandboxPaymentAttempt(
        req,
        flow,
        ["FAILED", "CANCELLED", "CANCELED"].includes(observedStatus)
          ? `Zepto reported the sandbox payment ${observedStatus.toLowerCase()}.`
          : `Tokko closed the sandbox payment attempt as failed after Zepto returned ${observedStatus.toLowerCase()}; no card payment was received.`,
        confirmed.orderId
      );
      flow = terminal.row;
      codResult = terminal.codResult;
      pravaReportError = terminal.pravaReportError;
      pravaReportResult = terminal.pravaReportResult;
      paymentStatus = "FAILED";
      sandboxTerminal = true;
    } else if (["FAILED", "CANCELLED", "CANCELED"].includes(paymentStatus)) {
      const reported = await reportPravaPaymentForFlow(flow, "DECLINED");
      pravaReportResult = reported.report;
      flow = await saveFailedCardAttempt(
        reported.row,
        `Zepto reported card payment ${paymentStatus.toLowerCase()}.`,
        confirmed.orderId
      );
      pravaReportError = reported.error;
      const fallback = await applyCardFailureOutcome(req, flow);
      flow = fallback.row;
      codResult = fallback.codResult;
    } else if (["SUCCESS", "COMPLETED", "PAID"].includes(paymentStatus)) {
      const reported = await reportPravaPaymentForFlow(flow, "APPROVED");
      pravaReportResult = reported.report;
      pravaReportError = reported.error;
      flow = await db.saveCheckoutFlow(
        flowRecord(reported.row, {
          status: "CARD_PAYMENT_RECEIVED",
          cardPaymentReceived: true,
          cardOrderId: confirmed.orderId,
          zeptoOrderId: confirmed.orderId,
          failureMessage: reported.error
            ? `Zepto received payment, but Prava reporting must be retried: ${reported.error}`
            : null,
        })
      );
    }
    const response =
      confirmed.merchantResult &&
      typeof confirmed.merchantResult === "object"
        ? { ...confirmed.merchantResult }
        : { merchantResult: confirmed.merchantResult };
    return sendJson(res, 200, {
      ...response,
      orderId: confirmed.orderId,
      paymentLink,
      recoveredOrder: confirmed.recoveredOrder,
      initialPaymentStatus,
      paymentStatus,
      sandbox: paymentConfiguration.environment !== "production",
      sandboxZeptoAttempt,
      sandboxTerminal,
      cardPaymentReceived:
        flow ? flow.card_payment_received === true : null,
      orderLookupPending: !confirmed.orderId,
      checkoutFlow: checkoutFlow(flow),
      codFallbackOrderId: flow?.zepto_order_id || codResult?.orderId || null,
      paymentHandoff:
        ["FAILED", "CANCELLED", "CANCELED"].includes(paymentStatus)
        || ["SUCCESS", "COMPLETED", "PAID"].includes(paymentStatus)
          ? null
          : pravaPaymentHandoff(flow, charge, {
              sandbox: paymentConfiguration.environment !== "production",
              zeptoAttempt: sandboxZeptoAttempt,
            }),
      pravaReportError,
      pravaPaymentResult: pravaResultSnapshot(flow, {
        merchantPaymentStatus: paymentStatus,
        reportResult: pravaReportResult,
      }),
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message });
  }
});
route("POST", "/api/order/payment-status", async (req, res) => {
  const input = await parseBody(req);
  const { orderId, poll = false } = input;
  if (typeof orderId !== "string" || !orderId.trim()) {
    return sendJson(res, 400, { error: "orderId is required" });
  }
  try {
    const user = await auth.requireUser(req);
    const result = requireSuccessfulZeptoTool(
      await auth.withPlatformTool(
        req,
        "zepto",
        "check_payment_status",
        {
          orderId: orderId.trim(),
          poll: poll === true,
        }
      ),
      "check_payment_status"
    );
    let flow = null;
    let codResult = null;
    let pravaReportError = null;
    let pravaReportResult = null;
    if (input.checkoutId) {
      const id = checkoutId(input.checkoutId);
      flow = await db.getCheckoutFlow(user.userId, id);
      if (!flow) {
        throw Object.assign(new Error("Checkout flow was not found"), {
          status: 404,
        });
      }
      const status = zeptoPaymentStatus(result);
      if (["SUCCESS", "COMPLETED", "PAID"].includes(status)) {
        const reported = await reportPravaPaymentForFlow(flow, "APPROVED");
        pravaReportResult = reported.report;
        flow = reported.row;
        pravaReportError = reported.error;
        flow = await db.saveCheckoutFlow(
          flowRecord(flow, {
            status: "CARD_PAYMENT_RECEIVED",
            cardPaymentReceived: true,
            cardOrderId: orderId.trim(),
            zeptoOrderId: orderId.trim(),
            failureMessage: reported.error
              ? `Zepto received payment, but Prava reporting must be retried: ${reported.error}`
              : null,
          })
        );
      } else if (
        ["FAILED", "CANCELLED", "CANCELED"].includes(status)
      ) {
        const reported = await reportPravaPaymentForFlow(flow, "DECLINED");
        pravaReportResult = reported.report;
        flow = reported.row;
        pravaReportError = reported.error;
        flow = await saveFailedCardAttempt(
          flow,
          `Zepto reported card payment ${status.toLowerCase()}.`,
          orderId.trim()
        );
        if (
          flow.payment_route === "prava_card"
          && flow.allow_cod_fallback !== false
        ) {
          const directCod = await placeCodFallback(req, flow, {
            reason: "The normal Prava card transaction was not received.",
          });
          flow = directCod.saved;
          codResult = directCod.confirmed;
        } else {
          const fallback = await applyCardFailureOutcome(req, flow);
          flow = fallback.row;
          codResult = fallback.codResult;
        }
      } else {
        flow = await db.saveCheckoutFlow(
          flowRecord(flow, {
            status: flow.sandbox_payment_attempt === true
              ? "SANDBOX_ZEPTO_PAYMENT_PENDING"
              : "CARD_PAYMENT_PENDING",
            cardPaymentReceived: false,
            cardOrderId: orderId.trim(),
            failureMessage:
              "Zepto has not reported a successful card payment.",
          })
        );
      }
    }
    const response =
      result && typeof result === "object"
        ? { ...result }
        : { merchantResult: result };
    return sendJson(res, 200, {
      ...response,
      checkoutFlow: checkoutFlow(flow),
      sandboxZeptoAttempt: flow?.sandbox_payment_attempt === true,
      codFallbackOrderId: flow?.zepto_order_id || codResult?.orderId || null,
      paymentHandoff: null,
      pravaReportError,
      pravaPaymentResult: pravaResultSnapshot(flow, {
        merchantPaymentStatus: zeptoPaymentStatus(result),
        reportResult: pravaReportResult,
      }),
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message });
  }
});
route("POST", "/api/order/cod-decision", async (req, res) => {
  try {
    const input = await parseBody(req);
    const user = await auth.requireUser(req);
    const id = checkoutId(input.checkoutId);
    const flow = await db.getCheckoutFlow(user.userId, id);
    if (!flow) {
      throw Object.assign(new Error("Checkout flow was not found"), {
        status: 404,
      });
    }
    if (
      flow.status !== "COD_PERMISSION_REQUIRED"
      || Number(flow.card_failure_count || 0) < 3
    ) {
      throw Object.assign(
        new Error("This checkout is not waiting for a COD decision"),
        { status: 409 }
      );
    }
    if (typeof input.approve !== "boolean") {
      throw Object.assign(new Error("approve must be true or false"), {
        status: 400,
      });
    }
    if (!input.approve) {
      const saved = await db.saveCheckoutFlow(
        flowRecord(flow, {
          status: "COD_FALLBACK_DECLINED",
          fallbackToCod: false,
          failureMessage:
            "Cash on Delivery was declined. No order was created and the cart was kept.",
        })
      );
      return sendJson(res, 200, {
        approved: false,
        orderId: null,
        checkoutFlow: checkoutFlow(saved),
        pravaPaymentResult: pravaResultSnapshot(saved),
      });
    }
    let fallback;
    try {
      fallback = await placeCodFallback(req, flow);
    } catch (error) {
      const failed = await db.saveCheckoutFlow(
        flowRecord(flow, {
          status: "COD_FALLBACK_FAILED",
          cardPaymentReceived: false,
          fallbackToCod: true,
          failureMessage:
            `Cash on Delivery was approved, but Zepto did not place it: ${error.message}`,
        })
      );
      return sendJson(res, 200, {
        approved: true,
        orderId: null,
        checkoutFlow: checkoutFlow(failed),
        pravaPaymentResult: pravaResultSnapshot(failed),
      });
    }
    return sendJson(res, 200, {
      approved: true,
      orderId: fallback.confirmed.orderId,
      recoveredOrder: fallback.confirmed.recoveredOrder,
      checkoutFlow: checkoutFlow(fallback.saved),
      pravaPaymentResult: pravaResultSnapshot(fallback.saved),
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message });
  }
});
route("GET", "/api/checkout/activity", async (req, res) => {
  const user = await auth.requireUser(req);
  const requested = Number.parseInt(getQuery(req).limit, 10) || 10;
  const rows = await db.getRecentCheckoutFlows(user.userId, requested);
  sendJson(res, 200, {
    checkoutFlows: rows.map(checkoutFlow),
  });
});
route("GET", "/api/orders", async (req, res) => {
  try {
    const query = getQuery(req);
    const result = requireSuccessfulZeptoTool(
      await auth.withPlatformTool(
        req,
        "zepto",
        "list_order_history",
        {
          limit: Number.parseInt(query.limit, 10) || 10,
          pageNumber: Number.parseInt(query.pageNumber, 10) || 1,
        }
      ),
      "list_order_history"
    );
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message });
  }
});
route("GET", "/api/orders/:id", async (req, res, params) => {
  try {
    const result = requireSuccessfulZeptoTool(
      await auth.withPlatformTool(
        req,
        "zepto",
        "get_order_detail",
        { orderId: params.id }
      ),
      "get_order_detail"
    );
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message });
  }
});
route("GET", "/api/past-items", (req, res) =>
  toolRoute(req, res, "zepto", "get_past_order_items", {})
);

route("GET", "/api/hermes/memory", async (req, res) => {
  const user = await auth.requireUser(req);
  const memories = await db.getHermesMemories(user.userId);
  sendJson(res, 200, { memories });
});

route("POST", "/api/hermes/transcribe", async (req, res) => {
  await auth.requireUser(req);
  const body = await parseBody(req);
  sendJson(
    res,
    200,
    await hermes.transcribeAudio({
      audioBase64: body.audioBase64,
      mimeType: body.mimeType,
      language: body.language,
    })
  );
});

route("POST", "/api/hermes/checkout/continue", async (req, res) => {
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  const result = await continueHermesPravaCardCheckout(
    req,
    user.userId,
    body.checkoutId
  );
  let message;
  if (result.paymentRoute === "cod") {
    message = result.orderId
      ? "the normal prava card transaction did not complete, so i used the approved cash on delivery fallback. zepto confirmed the order."
      : "the online payment did not complete, and zepto has not confirmed the cash on delivery fallback yet.";
  } else if (result.status === "PAID") {
    message = "prava and zepto both confirmed the card payment. the order is placed.";
  } else if (result.nextAction?.type === "zepto_card_payment") {
    message = "prava approved the normal card transaction and issued a single-use credential. continue with zepto’s secure payment step below.";
  } else {
    message = "prava has not completed the passkey approval yet. finish the secure approval, then continue here.";
  }
  sendJson(res, 200, {
    ...result,
    message,
    pendingAction: null,
    tools: [{
      name: "checkout_current_cart",
      status: "completed",
      result: {
        paymentRoute: result.paymentRoute,
        status: result.status,
        orderId: result.orderId || null,
      },
    }],
  });
});

async function runHermesBackend({
  req,
  userId,
  clerkUserId = null,
  messages,
  language,
  approvalToken = null,
}) {
  if (!hermes.configuration().configured) {
    throw Object.assign(
      new Error("Hermes is not configured. Add GEMINI_API_KEY to the deployment."),
      { status: 503 }
    );
  }
  const explicitMemories = hermes.extractExplicitMemories(messages);
  if (explicitMemories.length) {
    await Promise.all(
      explicitMemories.map((memory) =>
        db.upsertHermesMemory(userId, memory)
      )
    );
  }
  const [state, learnedMemories] = await Promise.all([
    getUserState(userId, clerkUserId),
    db.getHermesMemories(userId),
  ]);
  const tools = [
    HERMES_UCP_SEARCH_TOOL,
    HERMES_UCP_CHECKOUT_TOOL,
    HERMES_MANDATE_TOOL,
  ];
  const selectedDeliveryCountry = String(
    state.deliveryPreference?.countryCode || ""
  ).trim().toUpperCase();
  const selectedDeliveryMarket = ["IN", "US"].includes(
    selectedDeliveryCountry
  )
    ? selectedDeliveryCountry
    : null;
  const result = await hermes.run({
    userId,
    messages,
    tools,
    approvalToken:
      typeof approvalToken === "string" ? approvalToken : null,
    context: {
      accountHolder: state.profile
        ? {
            name: state.profile.primaryParentName || null,
            age: state.profile.primaryParentAge ?? null,
            gender: state.profile.primaryParentGender || null,
          }
        : null,
      dependents: (state.profile?.dependents || []).map((dependent) => ({
        name: dependent.name,
        relationship: dependent.relationshipToUser,
        age: dependent.age ?? null,
        ageBand: dependent.ageBand || null,
        gender: dependent.gender || null,
        country: dependent.country || null,
        cardHolderRelationship:
          dependent.cardHolderRelationship || null,
        mandateRelationship: dependent.mandateRelationship || null,
      })),
      hasSavedCard: state.hasPaymentMethod,
      confirmedDeliveryAddress:
        state.deliveryPreference?.formattedAddress || null,
      selectedDeliveryCountry: selectedDeliveryMarket,
      eligibleMerchants: selectedDeliveryMarket
        ? Object.values(ucp.HERMES_MERCHANTS)
            .filter((merchant) => merchant.market === selectedDeliveryMarket)
            .map((merchant) => ({ slug: merchant.slug, name: merchant.name }))
        : [],
      responseLanguage: hermes.normalizeResponseLanguage(language),
      learnedMemories,
    },
    executeTool: (toolName, args) => {
      if (toolName === HERMES_UCP_SEARCH_TOOL.name) {
        if (!selectedDeliveryMarket) {
          throw Object.assign(
            new Error("Select an India or US delivery address before searching"),
            { status: 409 }
          );
        }
        return executeHermesTool(req, userId, toolName, {
          ...args,
          market: selectedDeliveryMarket,
        });
      }
      return executeHermesTool(req, userId, toolName, args);
    },
  });
  const derivedMemories = hermes.deriveLearnedMemories(
    messages,
    result
  );
  if (derivedMemories.length) {
    await Promise.all(
      derivedMemories.map((memory) =>
        db.upsertHermesMemory(userId, memory)
      )
    );
  }
  const rawSearchResult = [...(result.tools || [])]
    .reverse()
    .find((tool) =>
      tool.name === HERMES_UCP_SEARCH_TOOL.name &&
      tool.status === "completed"
    )?.result;
  const searchResult = Array.isArray(rawSearchResult?.products)
    ? await persistUcpProductChoices(userId, rawSearchResult)
    : rawSearchResult;
  if (Array.isArray(searchResult?.products)) {
    result.productChoices = searchResult.products;
    result.merchantStatuses = searchResult.merchants || [];
    result.productQuery = searchResult.query;
    result.productPagination = searchResult.pagination || null;
    result.message = searchResult.products.length
      ? `i found the ${searchResult.products.length} lowest-priced options across the eligible live merchant ucps. select the one you want.`
      : "i could not find a match across the eligible live merchant ucps. try a broader product name.";
  }
  const checkoutResult = [...(result.tools || [])]
    .reverse()
    .find((tool) =>
      tool.name === HERMES_UCP_CHECKOUT_TOOL.name &&
      tool.status === "completed"
    )?.result;
  const mandateResult = [...(result.tools || [])]
    .reverse()
    .find((tool) =>
      tool.name === HERMES_MANDATE_TOOL.name &&
      tool.status === "completed"
    )?.result;
  if (mandateResult?.stage === "choose_card") {
    result.cardChoices = mandateResult.cardChoices || [];
    result.mandateSetup = mandateResult.mandate;
    result.message = mandateResult.cardChoices?.length > 1
      ? "choose which saved prava card to use for this mandate, or add a new saved card."
      : "add a card securely with prava, then tokko will automatically continue to mandate approval.";
  }
  if (checkoutResult?.merchantHandoffUrl) {
    result.merchantHandoffUrl = checkoutResult.merchantHandoffUrl;
    result.paymentUrl = null;
    result.paymentHandoff = checkoutResult.paymentHandoff || null;
    result.cardChoices = checkoutResult.cardChoices || [];
    result.checkoutSummary = publicUcpCheckoutSummary(checkoutResult);
    result.message = checkoutResult.paymentRoute === "card_selection_required"
      ? `the selected address and phone are prefilled. no active mandate covers ${checkoutResult.currency} ${checkoutResult.totalAmount}. choose which saved prava card you want to use.`
      : checkoutResult.paymentRoute === "mandate"
      ? `i prefilled the selected address and phone, checked ${checkoutResult.mandateCheck?.checkedMandateCount || 0} prava mandates, and selected an active mandate that covers ${checkoutResult.currency} ${checkoutResult.totalAmount}.`
      : checkoutResult.paymentRoute === "prava_card"
        ? "i prefilled the selected address and phone. no eligible mandate covered the total, so trakko selected the approved saved card. the merchant checkout did not advertise a compatible prava payment handler, so it may still ask for payment confirmation."
        : `i prefilled the selected address and phone and checked ${checkoutResult.mandateCheck?.checkedMandateCount || 0} prava mandates, but no eligible mandate or saved card could cover ${checkoutResult.currency} ${checkoutResult.totalAmount}.`;
    result.nextAction = checkoutResult.paymentRoute === "card_selection_required"
      ? null
      : {
          type: "merchant_ucp_checkout",
          url: checkoutResult.merchantHandoffUrl,
          label: `Continue to ${checkoutResult.merchantName} checkout`,
          paymentHandoff: checkoutResult.paymentHandoff || null,
          paymentSelection: checkoutResult.paymentSelection || null,
          checkoutSummary: publicUcpCheckoutSummary(checkoutResult),
        };
  }
  return result;
}

function maskedMerchantPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : "the selected phone";
}

function hermesOtpFromMessages(messages) {
  const latest = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === "user" && message.content);
  const text = String(latest?.content || "").trim();
  if (/^\d{6}$/.test(text)) return text;
  if (text.length <= 80) {
    return text.match(/\b(?:otp|code)\D{0,20}(\d{6})\b/i)?.[1] || null;
  }
  return null;
}

async function maybeVerifyHermesZeptoOtp(userId, messages) {
  const otp = hermesOtpFromMessages(messages);
  if (!otp) return null;
  const platform = await db.getPlatformBySlug("zepto");
  if (!platform) {
    return {
      message: "i could not verify that code because zepto is not configured for this tokko deployment.",
      pendingAction: null,
      tools: [{
        name: "verify_zepto_reconnect",
        status: "failed",
        error: "Zepto platform is not configured",
      }],
      model: hermes.configuration().model,
    };
  }
  const attempt = await db.getLatestMerchantAuthAttempt(
    userId,
    Number(platform.id)
  );
  if (!attempt) {
    return {
      message: "that looks like a zepto otp, but there is no active reconnect request. ask me to reconnect zepto first, then send the new six-digit code.",
      pendingAction: null,
      tools: [{
        name: "verify_zepto_reconnect",
        status: "failed",
        error: "No active Zepto reconnect request",
      }],
      model: hermes.configuration().model,
    };
  }
  try {
    await auth.verifyMerchantAuth(userId, attempt.pending_id, otp);
    return {
      message: "done, zepto is reconnected. i replaced the old merchant session and will reuse this login until it expires or you reconnect again.",
      pendingAction: null,
      tools: [{
        name: "verify_zepto_reconnect",
        status: "completed",
        result: { connected: true, merchant: "zepto" },
      }],
      model: hermes.configuration().model,
    };
  } catch (error) {
    return {
      message: `i could not verify that zepto otp: ${String(error.message || error)}. ask me to reconnect zepto to request a new code.`,
      pendingAction: null,
      tools: [{
        name: "verify_zepto_reconnect",
        status: "failed",
        error: String(error.message || error),
      }],
      model: hermes.configuration().model,
    };
  }
}

async function executeHermesTool(req, userId, toolName, args) {
  if (toolName === HERMES_MANDATE_TOOL.name) {
    return prepareTelegramMandateChoices(userId, args);
  }
  if (toolName === HERMES_UCP_SEARCH_TOOL.name) {
    const searchResult = await ucp.searchAll(args?.query, {
      limit: 3,
      offset: 0,
      market: args?.market,
      merchantResultLimit: 50,
      baseUrl: BASE_URL,
    });
    const products = (searchResult.products || []).slice(0, 3);
    return {
      ...searchResult,
      selectedMerchant: null,
      sort: "lowest_native_price",
      products,
      pagination: {
        ...(searchResult.pagination || {}),
        offset: 0,
        limit: 3,
        returned: products.length,
        nextOffset: products.length,
        hasMore: false,
      },
    };
  }
  if (toolName === HERMES_UCP_CHECKOUT_TOOL.name) {
    return createUcpCheckoutWithPayment(userId, args);
  }
  if (toolName === HERMES_ZEPTO_RECONNECT_TOOL.name) {
    const result = await auth.startMerchantAuth(userId, "zepto", BASE_URL);
    return {
      otpSent: true,
      merchant: result.merchant,
      phoneEnding: maskedMerchantPhone(result.phone),
      expiresInSeconds: result.expiresInSeconds,
    };
  }
  if (toolName === HERMES_CHECKOUT_TOOL.name) {
    return executeHermesCheckoutPolicy(req, userId, args);
  }
  return auth.withPlatformToolForUser(userId, "zepto", toolName, args);
}

function telegramMessageText(body) {
  if (typeof body?.text === "string") return body.text.trim();
  if (typeof body?.message === "string") return body.message.trim();
  if (body?.message && typeof body.message.text === "string") {
    return body.message.text.trim();
  }
  if (body?.edited_message && typeof body.edited_message.text === "string") {
    return body.edited_message.text.trim();
  }
  return "";
}

function publicUcpCart(cart = {}) {
  const items = (Array.isArray(cart.items) ? cart.items : []).map((item) => ({
    id: String(item.id),
    choiceId: String(item.choiceId),
    merchant: item.merchant,
    merchantName: item.merchantName,
    productName: item.productName,
    variantName: item.variantName || null,
    imageUrl: item.imageUrl || null,
    price: item.price,
    currency: item.currency,
    quantity: Number(item.quantity || 1),
  }));
  const groups = [];
  for (const item of items) {
    let group = groups.find((entry) => entry.merchant === item.merchant);
    if (!group) {
      group = {
        merchant: item.merchant,
        merchantName: item.merchantName,
        items: [],
      };
      groups.push(group);
    }
    group.items.push(item);
  }
  return {
    items,
    itemCount: items.reduce((total, item) => total + item.quantity, 0),
    merchantGroups: groups,
    cartMerchant: groups.length === 1 ? groups[0].merchant : null,
    checkoutAvailable: false,
    prescriptionReviewItems: [],
  };
}

async function persistUcpProductChoices(userId, searchResult) {
  const products = Array.isArray(searchResult?.products)
    ? searchResult.products
    : [];
  const choices = products
    .filter((product) => product.selectionToken)
    .map((product) => {
      const id = nodeCrypto.randomUUID();
      const { selectionToken, ...publicProduct } = product;
      return {
        id,
        selectionToken,
        product: {
          ...publicProduct,
          searchQuery: searchResult.query || null,
        },
      };
    });
  await db.saveUcpProductChoices(userId, choices);
  return {
    ...searchResult,
    products: choices.map((choice) => ({
      ...choice.product,
      choiceId: choice.id,
    })),
  };
}

async function addUcpCartChoice(userId, choiceId, quantity, replaceCart = false) {
  const choice = await db.getUcpProductChoice(userId, choiceId);
  if (!choice) {
    throw Object.assign(new Error("That product choice expired. Search again."), {
      status: 404,
    });
  }
  const product = choice.product || {};
  const requestedMerchant = String(product.merchant || "");
  const requestedMerchantName = String(product.merchantName || requestedMerchant);
  const cart = await db.getUcpCart(userId);
  let items = Array.isArray(cart.items) ? [...cart.items] : [];
  const currentMerchant = String(items[0]?.merchant || "");
  if (items.length && currentMerchant && currentMerchant !== requestedMerchant) {
    if (!replaceCart) {
      throw Object.assign(
        new Error("This cart is locked to a different merchant"),
        {
          status: 409,
          code: "merchant_cart_conflict",
          conflict: {
            currentMerchant,
            currentMerchantName: items[0].merchantName || currentMerchant,
            requestedMerchant,
            requestedMerchantName,
          },
        }
      );
    }
    items = [];
  }
  const normalizedQuantity = Math.min(Math.max(Number(quantity) || 1, 1), 20);
  const existing = items.find((item) => item.choiceId === String(choice.id));
  if (existing) {
    existing.quantity = Math.min(Number(existing.quantity || 1) + normalizedQuantity, 20);
  } else {
    items.push({
      id: Math.max(0, ...items.map((item) => Number(item.id) || 0)) + 1,
      choiceId: String(choice.id),
      selectionToken: choice.selection_token,
      merchant: requestedMerchant,
      merchantName: requestedMerchantName,
      productName: product.productName || "Product",
      variantName: product.variantName || product.optionText || null,
      imageUrl: product.imageUrl || null,
      price: product.price,
      currency: product.currency || "INR",
      quantity: normalizedQuantity,
    });
  }
  return db.saveUcpCart(userId, { items });
}

function telegramCardReturnMessage(value) {
  return /^\/start(?:@[A-Za-z0-9_]+)?\s+payments_card_return\s*$/i.test(
    String(value || "").trim()
  );
}

route("POST", "/api/integrations/telegram/hermes", async (req, res) => {
  await requireTelegramIntegration(req);
  const body = await parseBody(req);
  const chatId = telegramChatIdentifier(body);
  const user = await telegramFamilyUser(body, chatId);
  req.tokkoServiceUserId = Number(user.id);
  const text = telegramMessageText(body).slice(0, 6_000);
  if (telegramCardReturnMessage(text)) {
    const result = await resumeTelegramMandateAfterCard(Number(user.id), chatId);
    const card = result.paymentMethod;
    const message =
      `${card.brand || "Card"} ending ${card.last4} was saved. `
      + "Open the Prava approval below to activate the mandate.";
    await db.saveTelegramHermesMessage(chatId, "user", text);
    await db.saveTelegramHermesMessage(chatId, "assistant", message);
    return sendJson(res, 200, {
      ...result,
      message,
      telegram: { chatId, familyLinked: true },
    });
  }
  const suppliedMessages = Array.isArray(body.messages)
    ? body.messages
    : await db.getTelegramHermesMessages(chatId, 23);
  const messages = suppliedMessages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  if (
    text &&
    !(
      messages.at(-1)?.role === "user" &&
      messages.at(-1)?.content === text
    )
  ) {
    messages.push({ role: "user", content: text });
  }
  const approvalToken =
    typeof body.approvalToken === "string" ? body.approvalToken : null;
  if (!messages.length && !approvalToken) {
    throw Object.assign(
      new Error("message, text, messages, or approvalToken is required"),
      { status: 400 }
    );
  }
  const result = await runHermesBackend({
    req,
    userId: Number(user.id),
    clerkUserId: user.clerk_user_id || null,
    messages,
    language: body.language || body.locale || "en-IN",
    approvalToken,
  });
  if (text && !hermesOtpFromMessages([{ role: "user", content: text }])) {
    await db.saveTelegramHermesMessage(chatId, "user", text);
  }
  if (result.message) {
    await db.saveTelegramHermesMessage(
      chatId,
      "assistant",
      result.message
    );
  }
  sendJson(res, 200, {
    ...result,
    telegram: {
      chatId,
      familyLinked: true,
    },
  });
});

route(
  "POST",
  "/api/integrations/telegram/hermes/mandate-options",
  async (req, res) => {
    await requireTelegramIntegration(req);
    const body = await parseBody(req);
    const chatId = telegramChatIdentifier(body);
    const user = await telegramFamilyUser(body, chatId);
    const result = await prepareTelegramMandateChoices(Number(user.id), body);
    sendJson(res, 200, {
      ...result,
      message: result.cardChoices.length > 1
        ? "Choose a saved card or add a new saved card for this mandate."
        : "Add a card securely with Prava to continue mandate setup.",
      telegram: { chatId, familyLinked: true },
    });
  }
);

route(
  "POST",
  "/api/integrations/telegram/hermes/payment-choice",
  async (req, res) => {
    await requireTelegramIntegration(req);
    const body = await parseBody(req);
    const chatId = telegramChatIdentifier(body);
    const user = await telegramFamilyUser(body, chatId);
    const approved = hermes.verifyApproval(
      String(body.token || ""),
      Number(user.id)
    );
    if (
      approved.toolName === "create_mandate_with_saved_card"
      || approved.toolName === "create_mandate_with_new_card"
    ) {
      const result = await startTelegramMandateChoice(
        Number(user.id),
        chatId,
        body
      );
      const message = result.stage === "card_approval"
        ? "Open Prava to add the card securely. When you return here, Tokko will automatically prepare the mandate approval."
        : "Open Prava to approve this mandate with the selected saved card.";
      await db.saveTelegramHermesMessage(chatId, "assistant", message);
      return sendJson(res, 200, {
        ...result,
        message,
        telegram: { chatId, familyLinked: true },
      });
    }
    const result = await selectUcpSavedCard(Number(user.id), body.token);
    await db.saveTelegramHermesMessage(
      chatId,
      "assistant",
      `saved ${result.savedCard.brand} ending ${result.savedCard.last4} selected for ${result.merchantName} checkout`
    );
    sendJson(res, 200, {
      ...result,
      message:
        `${result.savedCard.brand} ending ${result.savedCard.last4} is selected. `
        + "The merchant may still ask you to confirm the card because it does not advertise a Prava payment handler.",
      telegram: { chatId, familyLinked: true },
    });
  }
);

route("POST", "/api/hermes/chat", async (req, res) => {
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  sendJson(res, 200, await runHermesBackend({
    req,
    userId: user.userId,
    clerkUserId: user.clerkUserId,
    messages: body.messages,
    language: body.language,
    approvalToken: body.approvalToken,
  }));
});

async function handler(req, res) {
  try {
    await initializeApplication();
  } catch (error) {
    console.error(`[startup] ${error.message}`);
    return sendJson(res, 500, { error: "Application initialization failed" });
  }
  const pathname = new URL(req.url, "http://localhost").pathname;
  const match = matchRoute(req.method, req.url);
  if (match) {
    try {
      await match.handler(req, res, match.params);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        console.error(`[${req.method} ${pathname}] ${error.message}`);
      } else {
        console.info(`[${req.method} ${pathname}] ${status} ${error.message}`);
      }
      if (!res.headersSent) {
        sendJson(res, status, {
          error: error.status ? error.message : "Internal server error",
        });
      }
    }
    return;
  }
  if (pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "API route not found" });
  }
  return serveStatic(res, pathname);
}

const server = http.createServer(handler);

async function initializeApplication() {
  if (applicationInitialization) return applicationInitialization;
  applicationInitialization = (async () => {
    await db.initialize();
    const allPlatforms = await db.getAllPlatforms();
    await platforms.ensureAllOAuthClients(allPlatforms, BASE_URL);
  })().catch((error) => {
    applicationInitialization = null;
    throw error;
  });
  return applicationInitialization;
}

async function start() {
  await initializeApplication();
  server.listen(PORT, () => console.log(`Tokko running at ${BASE_URL}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Startup failed:", error.message);
    console.error(
      "Set DATABASE_URL (recommended on Vercel) or the PGHOST/PGUSER/PGPASSWORD/PGDATABASE variables."
    );
    process.exitCode = 1;
  });
}

Object.assign(server, {
  CONSENT_POLICY_VERSION,
  HERMES_CHECKOUT_TOOL,
  HERMES_MANDATE_TOOL,
  HERMES_UCP_CHECKOUT_TOOL,
  HERMES_ZEPTO_RECONNECT_TOOL,
  MERCHANT_CONSENT_TEXT,
  canonicalPravaCustomerId,
  careRulesInput,
  createUcpCheckoutQuote,
  createUcpCheckoutWithPayment,
  decisionRequestInput,
  executeHermesTool,
  familyAddressInput,
  familyAddressPayload,
  handler,
  initializeApplication,
  matchRoute,
  parseBody,
  pravaReturnCallback,
  pravaPaymentHandoff,
  prepareTelegramMandateChoices,
  publicUcpCart,
  readRawBody,
  savedAddressInput,
  selectUcpSavedCard,
  startTelegramMandateChoice,
  server,
  start,
  hermesOtpFromMessages,
  mandateListPayload,
  telegramChatIdentifier,
  telegramBotUsername,
  telegramMessageText,
  telegramCardReturnMessage,
  telegramMandateIntent,
  resumeTelegramMandateAfterCard,
  tokkoPaymentRoute,
  usablePravaMandatesForAmount,
  usablePravaMandatesForMerchant,
  withUcpCheckoutCharges,
  zeptoAddressLocationContext,
  zeptoSavedAddressRows,
  zeptoOrderId,
  zeptoOrderRows,
  zeptoPaymentLink,
});

module.exports = server;
