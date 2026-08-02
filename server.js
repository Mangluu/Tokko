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
    "Search live health-and-wellness UCP catalogues that advertise delivery to the selected address country. Results include current availability, image, variant, and native-currency price. A selected delivery address is required.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The user's product or wellness need in concise catalogue wording.",
      },
      merchant: {
        type: "string",
        description:
          "For India, one delivery-eligible Indian merchant slug or name chosen from learned family preferences and merchant personas. Omit for other countries, where Trakko searches the global UCP catalogue with an exact shipping-country filter.",
      },
      limit: {
        type: "integer",
        description: "Page size. Trakko returns at most 10 image-backed products per requested item.",
      },
      offset: {
        type: "integer",
        description: "Zero-based result offset. Use 10, 20, and so on when the user asks to show more.",
      },
      market: {
        type: "string",
        pattern: "^[A-Z]{2}$",
        description:
          "ISO 3166-1 alpha-2 delivery country derived from the selected saved address.",
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

const routes = [];
let applicationInitialization = null;

function routeAuth(pattern) {
  if (
    pattern === "/api/health" ||
    pattern === "/api/config" ||
    pattern === "/api/auth/signup" ||
    pattern === "/api/auth/signup/verify" ||
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
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > 4_000_000) {
        tooLarge = true;
        body = "";
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        return;
      }
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
    selected: address.is_selected === true,
    createdAt: address.created_at || null,
    updatedAt: address.updated_at || null,
  };
}

function familyAddressInput(value = {}) {
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
  return {
    label,
    formattedAddress,
    addressLine1: addressLine1 || suppliedFormatted,
    addressLine2,
    city: city || shortAddress,
    state,
    postalCode,
    countryCode,
    contactName: field("contactName", 160),
    contactPhone: value.contactPhone || value.contactNumber
      ? validation.e164(value.contactPhone || value.contactNumber, "contactPhone")
      : null,
  };
}

function familyAddressPayload(rows) {
  const addresses = (Array.isArray(rows) ? rows : []).map(publicFamilyAddress);
  return {
    addresses,
    selectedAddress: addresses.find((address) => address.selected) || null,
  };
}

function ucpCartPayload(items) {
  const safeItems = Array.isArray(items) ? items : [];
  const byMerchant = new Map();
  for (const item of safeItems) {
    const merchant = String(item.merchant || "unknown");
    if (!byMerchant.has(merchant)) {
      byMerchant.set(merchant, {
        merchant,
        merchantName: item.merchantName || merchant,
        items: [],
        subtotals: {},
      });
    }
    const group = byMerchant.get(merchant);
    group.items.push(item);
    const currency = String(item.currency || "INR").toUpperCase();
    group.subtotals[currency] = (group.subtotals[currency] || 0)
      + Number(item.priceMinor || 0) * Number(item.quantity || 1);
  }
  const merchantGroups = [...byMerchant.values()].map((group) => ({
    ...group,
    subtotals: Object.entries(group.subtotals).map(([currency, amountMinor]) => ({
      currency,
      amountMinor,
      amount: (amountMinor / 100).toFixed(2),
    })),
  }));
  return {
    itemCount: safeItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    merchantCount: merchantGroups.length,
    items: safeItems,
    merchantGroups,
    lockedMerchant: merchantGroups[0]?.merchant || null,
    lockedMerchantName: merchantGroups[0]?.merchantName || null,
    checkoutPolicy: "single_merchant_only",
    requiresCartRepair: merchantGroups.length > 1,
  };
}

function ucpCartCountryConflict(items, targetCountry) {
  const safeItems = Array.isArray(items) ? items : [];
  const requestedCountry = String(targetCountry || "").trim().toUpperCase();
  if (!safeItems.length || !/^[A-Z]{2}$/.test(requestedCountry)) return null;

  const markets = [...new Set(safeItems.map((item) => {
    const snapshotMarket = String(item?.market || "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(snapshotMarket)) return snapshotMarket;
    const merchantMarket = String(
      ucp.MERCHANTS[String(item?.merchant || "").trim()]?.market || ""
    ).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(merchantMarket)) return merchantMarket;
    const currency = String(item?.currency || "").trim().toUpperCase();
    if (currency === "INR") return "IN";
    if (currency === "USD") return "US";
    return null;
  }).filter(Boolean))];
  const incompatibleMarkets = markets.filter((market) => market !== requestedCountry);
  if (!incompatibleMarkets.length) return null;

  const cart = ucpCartPayload(safeItems);
  return {
    code: "cart_delivery_country_conflict",
    targetCountry: requestedCountry,
    cartCountry: incompatibleMarkets[0],
    currentMerchant: cart.lockedMerchant,
    currentMerchantName: cart.lockedMerchantName,
    itemCount: cart.itemCount,
    cart,
  };
}

function cartCountryConflictMessage(conflict) {
  const merchant = conflict?.currentMerchantName || "your current merchant";
  return `Your cart from ${merchant} is for ${conflict?.cartCountry || "another country"}, but this delivery address is in ${conflict?.targetCountry || "a different country"}. Clear the current cart before switching countries.`;
}

async function selectFamilyAddressWithCartPolicy(
  userId,
  addressId,
  { replaceCart = false } = {}
) {
  const addresses = await db.getFamilyAddresses(userId);
  const target = addresses.find((address) => String(address.id) === String(addressId));
  if (!target) return null;
  const cart = await db.getUcpCart(userId);
  const conflict = ucpCartCountryConflict(cart, target.country_code);
  if (conflict && !replaceCart) {
    throw Object.assign(new Error(cartCountryConflictMessage(conflict)), {
      status: 409,
      code: conflict.code,
      conflict,
    });
  }
  if (conflict) await db.clearUcpCart(userId);
  const selected = await db.selectFamilyAddress(userId, addressId);
  return {
    selected,
    cartCleared: Boolean(conflict),
    conflict,
  };
}

function latestUserMessageText(messages) {
  const message = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((entry) => entry?.role === "user" && entry?.content);
  return String(message?.content || "").trim();
}

function normalizedCartWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(?:please|the|a|an|my|from|out|of|cart|item|product)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function requestedCartAction(messages, items) {
  const text = latestUserMessageText(messages);
  const compact = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (/^(?:\/cart|show (?:me )?(?:my )?cart|view (?:my )?cart|what(?:'s| is) in (?:my )?cart|my cart)$/i.test(compact)) {
    return { type: "show" };
  }
  if (/^(?:\/emptycart|empty (?:my )?cart|clear (?:my )?cart|remove (?:all|everything)(?: from (?:my )?cart)?|delete (?:all|everything)(?: from (?:my )?cart)?)$/i.test(compact)) {
    return { type: "clear" };
  }
  const removal = compact.match(
    /^(?:remove|delete)\s+(.+?)(?:\s+from\s+(?:my\s+)?cart)?$/i
  ) || compact.match(
    /^take\s+(.+?)\s+out\s+of\s+(?:my\s+)?cart$/i
  );
  if (!removal) return null;
  const requested = normalizedCartWords(removal[1]);
  if (!requested) return { type: "remove", item: null };
  const numbered = requested.match(/^(?:number\s+)?(\d+)$/i);
  if (numbered) {
    return {
      type: "remove",
      item: items[Number(numbered[1]) - 1] || null,
    };
  }
  const requestedWords = new Set(requested.split(" ").filter(Boolean));
  const ranked = (Array.isArray(items) ? items : []).map((item) => {
    const name = normalizedCartWords(
      `${item.productName || ""} ${item.variantName || ""}`
    );
    const nameWords = new Set(name.split(" ").filter(Boolean));
    const overlap = [...requestedWords].filter((word) => nameWords.has(word)).length;
    return {
      item,
      score: name === requested ? 1000 : name.includes(requested) ? 500 : overlap,
    };
  }).sort((left, right) => right.score - left.score);
  if (!ranked[0]?.score || ranked[0].score === ranked[1]?.score) {
    return { type: "remove", item: null };
  }
  return { type: "remove", item: ranked[0].item };
}

async function handleRequestedCartAction(userId, messages, items) {
  const action = requestedCartAction(messages, items);
  if (!action) return null;
  if (action.type === "show") {
    return {
      message: items.length
        ? "here is your current cart. you can remove an item or empty the cart."
        : "your cart is empty.",
      tools: [],
      cartSummary: ucpCartPayload(items),
    };
  }
  if (action.type === "clear") {
    const removedCount = await db.clearUcpCart(userId);
    return {
      message: removedCount
        ? `done, i emptied the cart and removed ${removedCount} item${removedCount === 1 ? "" : "s"}.`
        : "your cart was already empty.",
      tools: [{ name: "empty_wellness_cart", status: "completed" }],
      cartSummary: ucpCartPayload([]),
    };
  }
  if (!action.item) {
    return {
      message: items.length
        ? "i could not tell which cart item you meant. choose remove beside the item below."
        : "your cart is empty.",
      tools: [],
      cartSummary: ucpCartPayload(items),
    };
  }
  const removed = await db.removeUcpCartItem(userId, action.item.id);
  const remaining = await db.getUcpCart(userId);
  return {
    message: removed
      ? `removed ${removed.productName || "that item"} from your cart.`
      : "that cart item was already removed.",
    tools: [{ name: "remove_wellness_cart_item", status: "completed" }],
    cartSummary: ucpCartPayload(remaining),
  };
}

function searchUcpForMarket(body = {}) {
  const market = String(body.market || "").trim().toUpperCase();
  if (market && market !== "IN") {
    return ucp.searchGlobalMarket(body.query, {
      limit: body.limit,
      offset: body.offset,
      market,
      merchant: body.merchant,
      baseUrl: BASE_URL,
    });
  }
  return ucp.searchAll(body.query, {
    limit: body.limit,
    offset: body.offset,
    market,
    merchant: body.merchant,
    baseUrl: BASE_URL,
  });
}

function rankUcpProducts(products, memories = []) {
  const preferenceText = (Array.isArray(memories) ? memories : [])
    .filter((memory) => [
      "checkout_preference", "successful_wellness_search", "product_preferences",
    ].includes(memory.type))
    .map((memory) => `${memory.cue || ""} ${JSON.stringify(memory.value || {})}`)
    .join(" ")
    .toLowerCase();
  const scored = (Array.isArray(products) ? products : []).map((product, index) => {
    const words = [product.merchantName, product.productName, product.variantName]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4);
    const preferenceHits = [...new Set(words)].filter((word) =>
      preferenceText.includes(word)
    ).length;
    const rating = Number(product.rating);
    const hasRating = Number.isFinite(rating) && rating > 0;
    return {
      product: {
        ...product,
        rankingReasons: [
          ...(preferenceHits ? ["matches family order history or preference"] : []),
          ...(hasRating ? [`merchant rating ${rating.toFixed(1)}`] : []),
          "lower live price used as tie-breaker",
        ],
      },
      preferenceHits,
      rating: hasRating ? rating : 0,
      index,
    };
  });
  scored.sort((left, right) => {
    if (left.product.available !== right.product.available) {
      return left.product.available ? -1 : 1;
    }
    if (left.preferenceHits !== right.preferenceHits) {
      return right.preferenceHits - left.preferenceHits;
    }
    if (left.rating !== right.rating) return right.rating - left.rating;
    const priceDifference = Number(left.product.priceMinor) - Number(right.product.priceMinor);
    return priceDifference || left.index - right.index;
  });
  return scored.map((entry) => entry.product);
}

async function selectedDeliveryCountryForUser(userId) {
  const addresses = await db.getFamilyAddresses(userId);
  const selected = addresses.find((address) => address.is_selected) || null;
  if (!selected) {
    throw Object.assign(
      new Error("Select a delivery address before searching or checking out"),
      { status: 409 }
    );
  }
  const countryCode = String(selected.country_code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw Object.assign(
      new Error("The selected address needs a valid two-letter country code"),
      { status: 409 }
    );
  }
  return { countryCode, selectedAddress: selected };
}

async function searchUcpForSelectedAddress(userId, body = {}) {
  const { countryCode } = await selectedDeliveryCountryForUser(userId);
  const [cart, memories] = await Promise.all([
    db.getUcpCart(userId),
    db.getHermesMemories(userId),
  ]);
  const conflict = ucpCartCountryConflict(cart, countryCode);
  if (conflict) {
    throw Object.assign(new Error(cartCountryConflictMessage(conflict)), {
      status: 409,
      code: conflict.code,
      conflict,
    });
  }
  const lockedMerchant = cart[0]?.merchant || null;
  const result = await searchUcpForMarket({
    ...body,
    market: countryCode,
    ...(lockedMerchant ? { merchant: lockedMerchant } : {}),
  });
  result.products = rankUcpProducts(result.products, memories);
  result.ranking = {
    policy: "availability_then_family_preference_then_live_rating_then_lowest_price",
    qualitySignal: result.products.some((product) => Number(product.rating) > 0)
      ? "merchant_rating"
      : "not_returned_by_merchant",
  };
  result.lockedMerchant = lockedMerchant;
  return result;
}

async function rememberUcpCheckout(userId, checkoutResult) {
  const products = (Array.isArray(checkoutResult?.items)
    ? checkoutResult.items.map((item) => item.productName)
    : [checkoutResult?.productName])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const merchant = String(
    checkoutResult?.merchantName || checkoutResult?.merchant || ""
  ).trim();
  if (!merchant && !products.length) return;
  await db.upsertHermesMemory(userId, {
    type: "checkout_preference",
    cue: products.join(", ").toLocaleLowerCase("en-IN").slice(0, 500)
      || `checkout at ${merchant}`,
    value: {
      merchant,
      merchantSlug: checkoutResult?.merchant || null,
      products,
      checkoutStatus: checkoutResult?.status || null,
    },
    confidence: 0.8,
  });
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

function legacyPravaCustomerId(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("A valid family user ID is required"), {
      status: 400,
    });
  }
  return `tokko_user_${id}`;
}

function pravaCustomerIdCandidates(userId, currentCustomerId) {
  return [...new Set([
    String(currentCustomerId || "").trim(),
    canonicalPravaCustomerId(userId),
    legacyPravaCustomerId(userId),
  ].filter(Boolean))];
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
  if (!user) {
    throw Object.assign(
      new Error("Your session is no longer valid. Please sign in again."),
      { status: 401 }
    );
  }
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

function pravaCallbackIdentifier(value) {
  const id = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw Object.assign(new Error("A valid Prava callback ID is required"), {
      status: 400,
    });
  }
  return id.toLowerCase();
}

function pravaReturnCallback(flow, returnContext = {}) {
  const type = flow === "mandate" ? "mandate" : "card";
  const callbackId = returnContext?.callbackId
    ? pravaCallbackIdentifier(returnContext.callbackId)
    : null;
  const callbackBase = BASE_URL.startsWith("https://")
    ? BASE_URL
    : process.env.PRAVA_MERCHANT_URL || "https://zepto-shop.vercel.app";
  if (returnContext?.channel === "telegram") {
    const callbackUrl = new URL("/api/payments/return", callbackBase);
    callbackUrl.searchParams.set("channel", "telegram");
    callbackUrl.searchParams.set(
      "bot",
      telegramBotUsername(returnContext.botUsername)
    );
    callbackUrl.searchParams.set("flow", type);
    if (callbackId) callbackUrl.searchParams.set("callback", callbackId);
    if (/^[0-9a-f-]{36}$/i.test(String(returnContext.orderId || ""))) {
      callbackUrl.searchParams.set("order", String(returnContext.orderId));
    }
    return callbackUrl.toString();
  }

  const callbackUrl = new URL(callbackBase);
  callbackUrl.searchParams.set(
    type === "mandate" ? "pravaMandate" : "pravaCard",
    "return"
  );
  if (callbackId) callbackUrl.searchParams.set("pravaCallback", callbackId);
  if (/^[0-9a-f-]{36}$/i.test(String(returnContext.orderId || ""))) {
    callbackUrl.searchParams.set("ucpOrder", String(returnContext.orderId));
  }
  const returnPage = String(returnContext.page || "").trim().toLowerCase();
  if (["assistant", "card", "mandates"].includes(returnPage)) {
    callbackUrl.searchParams.set("pravaReturnPage", returnPage);
  }
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
      : "https://zepto-shop.vercel.app");
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

async function listPravaMandatesForUser(
  userId,
  customerId,
  { allowCached = false } = {}
) {
  try {
    const settled = await Promise.allSettled(
      pravaCustomerIdCandidates(userId, customerId).map((candidate) =>
        payments.listMandates(candidate)
      )
    );
    const successful = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    if (!successful.length) {
      throw rejected[0]?.reason
        || Object.assign(new Error("Prava mandate list is unavailable"), { status: 502 });
    }
    const mandates = [...new Map(
      successful
        .flatMap((result) => result.value || [])
        .filter((mandate) => mandate?.id)
        .map((mandate) => [String(mandate.id), mandate])
    ).values()];
    if (!mandates.length && rejected.length) throw rejected[0].reason;
    if (mandates.length) {
      if (allowCached) {
        await db.savePravaMandateSnapshot(userId, customerId, mandates);
      }
      return {
        mandates,
        source: "prava",
        stale: false,
        fetchedAt: null,
        warning: rejected.length
          ? "Some historical Prava customer aliases could not be refreshed; active mandates returned by the available aliases are shown."
          : null,
      };
    }
    if (allowCached) {
      const cached = await db.getPravaMandateSnapshot(userId, customerId);
      if (Array.isArray(cached?.mandates) && cached.mandates.length) {
        return {
          mandates: cached.mandates,
          source: "cache",
          stale: true,
          fetchedAt: cached.fetched_at,
          warning:
            "Prava returned an empty list, so Tokko is showing the last successful mandate snapshot.",
        };
      }
    }
    return { mandates, source: "prava", stale: false, fetchedAt: null };
  } catch (error) {
    if (!allowCached) throw error;
    const cached = await db.getPravaMandateSnapshot(userId, customerId);
    if (!Array.isArray(cached?.mandates) || !cached.mandates.length) throw error;
    return {
      mandates: cached.mandates,
      source: "cache",
      stale: true,
      fetchedAt: cached.fetched_at,
      warning: `Prava mandate refresh failed, so Tokko is showing the last successful snapshot: ${error.message}`,
    };
  }
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
  const callbackId = nodeCrypto.randomUUID();
  const returnContext = {
    ...(input.returnContext || {}),
    callbackId,
  };
  const callbackUrl = pravaReturnCallback("mandate", returnContext);
  const existingMandates = await listPravaMandatesForUser(
    userId,
    customerId,
    { allowCached: true }
  ).then((result) => result.mandates).catch(() => []);
  const session = await payments.createMandateSession({
    customerId,
    email,
    cardId: selected.provider_payment_method_id,
    amount: input.amount,
    frequency: input.frequency,
    callbackUrl,
    currency: input.currency,
    purchaseContext: input.purchaseContext,
    externalOrderRef: input.externalOrderRef,
    description: input.description,
  });
  await db.savePravaMandateCallback({
    callbackId,
    userId,
    customerId,
    sessionId: session.sessionId,
    amount: session.amount,
    currency: session.currency,
    frequency: session.frequency,
    preexistingMandateIds: existingMandates.map((mandate) => mandate.id),
    returnChannel:
      String(returnContext.channel || "web").trim().toLowerCase() || "web",
    returnPage: returnContext.page || null,
    telegramBotUsername: returnContext.botUsername || null,
    orderId: returnContext.orderId || null,
  });
  return { ...session, callbackId };
}

function activePravaMandate(value) {
  return (
    String(value?.status || "").toLowerCase() === "active"
    || String(value?.state || "").toLowerCase() === "available"
  );
}

function mandateCallbackCandidate(record, mandates) {
  const previous = new Set(
    Array.isArray(record.preexisting_mandate_ids)
      ? record.preexisting_mandate_ids.map(String)
      : []
  );
  const amount = Number(record.amount);
  const createdAfter = new Date(record.created_at).getTime() - 5 * 60 * 1_000;
  const candidates = (Array.isArray(mandates) ? mandates : [])
    .filter(activePravaMandate)
    .filter((mandate) =>
      String(mandate.currency || "").toUpperCase()
        === String(record.currency || "").toUpperCase()
    )
    .filter((mandate) =>
      String(mandate.frequency || "one_time").toLowerCase()
        === String(record.frequency || "one_time").toLowerCase()
    )
    .filter((mandate) => {
      const approved = Number(mandate.approvedAmount);
      return !Number.isFinite(amount) || !Number.isFinite(approved)
        ? true
        : Math.abs(approved - amount) < 0.005;
    })
    .sort((left, right) =>
      new Date(right.createdAt || 0).getTime()
      - new Date(left.createdAt || 0).getTime()
    );
  return (
    candidates.find((mandate) => !previous.has(String(mandate.id)))
    || candidates.find((mandate) =>
      new Date(mandate.createdAt || 0).getTime() >= createdAfter
    )
    || null
  );
}

async function completePravaMandateCallback(userId, callbackId) {
  const id = pravaCallbackIdentifier(callbackId);
  let record = await db.getPravaMandateCallback(userId, id);
  if (!record) {
    throw Object.assign(new Error("This Prava mandate callback is invalid or expired"), {
      status: 404,
    });
  }
  if (payments.configuration().environment !== "sandbox") {
    throw Object.assign(
      new Error("Automatic callback token display is enabled only for Prava sandbox"),
      { status: 409 }
    );
  }

  let mandate = null;
  if (record.mandate_id) {
    mandate = await payments.getMandate(record.mandate_id);
  } else {
    const result = await listPravaMandatesForUser(
      userId,
      record.provider_customer_id,
      { allowCached: false }
    );
    mandate = mandateCallbackCandidate(record, result.mandates);
    if (!mandate) {
      throw Object.assign(
        new Error(
          "Prava has not returned the newly approved active mandate yet. Retry in a moment."
        ),
        { status: 409 }
      );
    }
    record = await db.updatePravaMandateCallback(userId, id, {
      status: "MANDATE_CONFIRMED",
      mandateId: mandate.id,
    });
  }

  if (!activePravaMandate(mandate)) {
    throw Object.assign(
      new Error("Prava has not marked this mandate active yet. Retry in a moment."),
      { status: 409 }
    );
  }
  const configuredChargeAmount = payments.decimalAmount(
    process.env.PRAVA_MANDATE_CALLBACK_CHARGE_AMOUNT || "1.00",
    "Prava callback charge amount"
  );
  const remaining = Number(mandate.remaining ?? mandate.approvedAmount);
  if (Number.isFinite(remaining) && remaining < Number(configuredChargeAmount)) {
    throw Object.assign(
      new Error("The approved mandate cannot cover the sandbox callback charge"),
      { status: 409 }
    );
  }
  const reference = `tokko_callback_${id.replaceAll("-", "")}`;
  try {
    const charge = await payments.chargeMandate({
      mandateId: mandate.id,
      amount: configuredChargeAmount,
      reference,
    });
    await db.updatePravaMandateCallback(userId, id, {
      status: "CREDENTIAL_ISSUED",
      mandateId: charge.mandateId,
      transactionId: charge.transactionId,
      credentialFingerprint: paymentCredentialFingerprint(charge.credentials),
      chargeError: null,
    });
    return {
      callbackId: id,
      status: "credential_issued",
      chargeAmount: configuredChargeAmount,
      currency: String(mandate.currency || record.currency || "INR").toUpperCase(),
      mandate,
      tokenIssued: true,
      sandboxPaymentCredential: {
        mandateId: charge.mandateId,
        transactionId: charge.transactionId,
        token: charge.credentials.token,
        ephemeral: true,
      },
      note:
        "Prava issued this single-use sandbox virtual PAN. Tokko stored only its SHA-256 fingerprint.",
    };
  } catch (error) {
    await db.updatePravaMandateCallback(userId, id, {
      status: "CHARGE_FAILED",
      mandateId: mandate.id,
      chargeError: error.message,
    });
    throw error;
  }
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

function usablePravaMandatesForMerchant(
  mandates,
  amount,
  merchantName,
  merchantUrl,
  currency = "INR"
) {
  const amountValue = Number(amount);
  return (Array.isArray(mandates) ? mandates : [])
    .filter((mandate) => {
      const remaining = Number(mandate.remaining ?? mandate.approvedAmount);
      const active =
        String(mandate.status || "").toLowerCase() === "active"
        || String(mandate.state || "").toLowerCase() === "available";
      return (
        active
        && String(mandate.currency || "").toUpperCase()
          === String(currency || "INR").toUpperCase()
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
  const totalAmount = Number(checkoutResult.totalAmount || 0).toFixed(2);
  const items = Array.isArray(checkoutResult.items)
    ? checkoutResult.items
    : [];
  const itemNames = items
    .map((item) => String(item?.productName || item?.variantName || "").trim())
    .filter(Boolean);
  const itemCount = items.reduce(
    (sum, item) => sum + Math.max(1, Math.round(Number(item?.quantity || 1))),
    0
  );
  const merchantName = String(
    checkoutResult.merchantName || "UCP merchant"
  ).trim().slice(0, 200);
  const listedItems = itemNames.slice(0, 3).join(", ");
  const extraItems = itemNames.length > 3
    ? ` and ${itemNames.length - 3} more`
    : "";
  const description = (
    listedItems
      ? `${listedItems}${extraItems}; merchant quote total including charges`
      : `${merchantName} order${itemCount ? ` (${itemCount} item${itemCount === 1 ? "" : "s"})` : ""}; merchant quote total including charges`
  ).slice(0, 200);
  const productId = nodeCrypto
    .createHash("sha256")
    .update(String(checkoutResult.variantId || checkoutResult.checkoutId || "ucp-product"))
    .digest("hex")
    .slice(0, 40);
  return [{
    merchant_details: {
      name: merchantName,
      url: checkoutResult.merchantUrl,
      country_code_iso2: String(checkoutResult.market || "IN").toUpperCase(),
    },
    product_details: [{
      description,
      // Prava requires total_amount to exactly equal unit_price x quantity.
      // The merchant quote can include shipping, tax, discounts, and fees, so
      // represent the binding checkout total as one order-level line.
      unit_price: totalAmount,
      product_id: `ucp_${productId}`,
      quantity: 1,
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
    totals: Array.isArray(checkout.totals) ? checkout.totals : [],
    shippingOptions: Array.isArray(checkout.shippingOptions)
      ? checkout.shippingOptions
      : [],
    shippingQuoted: checkout.shippingQuoted === true,
    destinationSelected: checkout.destinationSelected === true,
    phoneAccepted: checkout.phoneAccepted === true,
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

async function createUcpCheckoutWithPayment(userId, input = {}) {
  const [user, profile, addresses] = await Promise.all([
    db.getUserById(userId),
    db.getProfile(userId),
    db.getFamilyAddresses(userId),
  ]);
  const selectedAddress = addresses.find((address) => address.is_selected) || null;
  const selectedCountry = String(
    selectedAddress?.country_code || ""
  ).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(selectedCountry)) {
    throw Object.assign(
      new Error("Select a delivery address with a valid two-letter country code"),
      { status: 409 }
    );
  }
  const checkoutIdentity = ucpCheckoutIdentity(user, profile, selectedAddress);
  const checkoutOptions = {
    baseUrl: BASE_URL,
    buyer: checkoutIdentity.buyer,
    destination: checkoutIdentity.destination,
    deliveryCountry: selectedCountry,
  };
  const checkoutResult = Array.isArray(input.cartItems)
    ? await ucp.createCheckoutFromSelections(input.cartItems, checkoutOptions)
    : await ucp.createCheckout(input.selectionToken, {
        ...checkoutOptions,
        quantity: input.quantity,
      });
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
    mandates = (await listPravaMandatesForUser(
      userId,
      identity.customerId
    )).mandates;
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

function ucpQuoteDeliveryWindow(checkoutResult) {
  const selected = (checkoutResult.shippingOptions || []).find((option) => option.selected)
    || checkoutResult.shippingOptions?.[0]
    || null;
  if (!selected) return null;
  return {
    title: selected.title || "Delivery",
    description: selected.description || null,
    earliest: selected.earliestFulfillmentTime || null,
    latest: selected.latestFulfillmentTime || null,
  };
}

function ucpForexLines(checkoutResult) {
  return (checkoutResult.totals || []).filter((line) =>
    /(?:forex|foreign exchange|currency conversion|exchange fee|fx fee)/i.test(
      `${line.type || ""} ${line.label || ""}`
    )
  );
}

const UCP_FOREX_RATE_PERCENT = 3;

function ucpQuoteWithForexCharge(checkoutResult) {
  const merchantTotalMinor = Math.round(Number(checkoutResult?.totalMinor));
  if (!Number.isFinite(merchantTotalMinor) || merchantTotalMinor <= 0) {
    throw Object.assign(new Error("Merchant checkout total is invalid"), {
      status: 502,
    });
  }
  const forexChargeMinor = Math.round(
    merchantTotalMinor * UCP_FOREX_RATE_PERCENT / 100
  );
  const totalMinor = merchantTotalMinor + forexChargeMinor;
  const originalTotals = Array.isArray(checkoutResult.totals)
    ? checkoutResult.totals
    : [];
  const componentTotals = originalTotals.filter(
    (line) => String(line?.type || "").toLowerCase() !== "total"
  );
  const totals = componentTotals.length
    ? componentTotals
    : [{
        type: "subtotal",
        label: "Merchant cart total",
        amountMinor: merchantTotalMinor,
        lines: [],
      }];
  totals.push({
    type: "forex",
    label: `Foreign exchange charge (${UCP_FOREX_RATE_PERCENT}%)`,
    amountMinor: forexChargeMinor,
    lines: [],
  });
  totals.push({
    type: "total",
    label: "Total payable",
    amountMinor: totalMinor,
    lines: [],
  });
  return {
    ...checkoutResult,
    merchantTotalMinor,
    forexChargeMinor,
    forexRatePercent: UCP_FOREX_RATE_PERCENT,
    totals,
    totalMinor,
    totalAmount: (totalMinor / 100).toFixed(2),
  };
}

function publicUcpOrderIntent(row) {
  if (!row) return null;
  const quote = row.quote_snapshot || {};
  return {
    orderId: String(row.id),
    merchant: row.merchant_slug,
    merchantName: row.merchant_name,
    currency: row.currency,
    totalAmount: (Number(row.total_minor) / 100).toFixed(2),
    totalMinor: Number(row.total_minor),
    status: row.status,
    priceConfirmed: Boolean(row.price_confirmed_at),
    paymentRoute: row.payment_route || null,
    paymentReference: row.credential_fingerprint
      ? {
          fingerprint: row.credential_fingerprint,
          issuedAt: row.credential_issued_at,
          storage: "fingerprint_only",
        }
      : null,
    prava: {
      mandateId: row.prava_mandate_id || null,
      sessionId: row.prava_session_id || null,
      transactionId: row.prava_transaction_id || null,
      orderId: row.prava_order_id || null,
    },
    merchantOrder: row.merchant_order_id
      ? { id: row.merchant_order_id, url: row.merchant_order_url || null }
      : null,
    failureMessage: row.failure_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    quote,
  };
}

function ucpOrderIntentInput(row, updates = {}) {
  return {
    id: row.id,
    merchantSlug: row.merchant_slug,
    merchantName: row.merchant_name,
    merchantUrl: row.merchant_url,
    merchantCheckoutId: row.merchant_checkout_id,
    selectionToken: row.selection_token,
    quoteSnapshot: row.quote_snapshot || {},
    currency: row.currency,
    totalMinor: Number(row.total_minor),
    status: updates.status || row.status,
    priceConfirmedAt: updates.priceConfirmedAt || row.price_confirmed_at,
    paymentRoute: updates.paymentRoute || row.payment_route,
    pravaMandateId: updates.pravaMandateId || row.prava_mandate_id,
    pravaSessionId: updates.pravaSessionId || row.prava_session_id,
    pravaTransactionId: updates.pravaTransactionId || row.prava_transaction_id,
    pravaOrderId: updates.pravaOrderId || row.prava_order_id,
    credentialFingerprint:
      updates.credentialFingerprint || row.credential_fingerprint,
    credentialIssuedAt: updates.credentialIssuedAt || row.credential_issued_at,
    merchantOrderId: updates.merchantOrderId || row.merchant_order_id,
    merchantOrderUrl: updates.merchantOrderUrl || row.merchant_order_url,
    failureMessage: Object.hasOwn(updates, "failureMessage")
      ? updates.failureMessage
      : row.failure_message,
  };
}

async function createUcpCheckoutQuote(userId, input = {}) {
  const [user, profile, addresses] = await Promise.all([
    db.getUserById(userId),
    db.getProfile(userId),
    db.getFamilyAddresses(userId),
  ]);
  const selectedAddress = addresses.find((address) => address.is_selected) || null;
  const selectedCountry = String(selectedAddress?.country_code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(selectedCountry)) {
    throw Object.assign(new Error("Select a delivery address before requesting a quote"), {
      status: 409,
    });
  }
  const checkoutIdentity = ucpCheckoutIdentity(user, profile, selectedAddress);
  const checkoutOptions = {
    baseUrl: BASE_URL,
    buyer: checkoutIdentity.buyer,
    destination: checkoutIdentity.destination,
    deliveryCountry: selectedCountry,
  };
  const cartItems = Array.isArray(input.cartItems) ? input.cartItems : null;
  const checkoutResult = cartItems
    ? await ucp.createCheckoutFromSelections(cartItems, checkoutOptions)
    : await ucp.createCheckout(input.selectionToken, {
        ...checkoutOptions,
        quantity: input.quantity,
      });
  if (checkoutResult.reconciles === false) {
    throw Object.assign(
      new Error("Merchant checkout components do not reconcile with its final total"),
      { status: 409 }
    );
  }
  const payableCheckout = ucpQuoteWithForexCharge(checkoutResult);
  const selectionToken = String(
    cartItems?.[0]?.selectionToken || input.selectionToken || ""
  );
  const forexLines = ucpForexLines(payableCheckout);
  const quoteSnapshot = {
    items: payableCheckout.items || [],
    market: payableCheckout.market || selectedCountry,
    totals: payableCheckout.totals || [],
    shippingOptions: payableCheckout.shippingOptions || [],
    shippingQuoted: payableCheckout.shippingQuoted === true,
    deliveryWindow: ucpQuoteDeliveryWindow(payableCheckout),
    merchantTotalMinor: payableCheckout.merchantTotalMinor,
    forex: {
      returnedByMerchant: false,
      appliedByTokko: true,
      ratePercent: payableCheckout.forexRatePercent,
      baseAmountMinor: payableCheckout.merchantTotalMinor,
      amountMinor: payableCheckout.forexChargeMinor,
      lines: forexLines,
    },
    destinationSelected: checkoutResult.destinationSelected === true,
    phoneAccepted: checkoutResult.phoneAccepted === true,
    reconciles: checkoutResult.reconciles,
    expiresAt: checkoutResult.expiresAt || null,
  };
  const row = await db.saveUcpOrderIntent(userId, {
    merchantSlug: checkoutResult.merchant,
    merchantName: checkoutResult.merchantName,
    merchantUrl: checkoutResult.merchantUrl,
    merchantCheckoutId: checkoutResult.checkoutId,
    selectionToken,
    quoteSnapshot,
    currency: payableCheckout.currency,
    totalMinor: payableCheckout.totalMinor,
    status: "AWAITING_PRICE_CONFIRMATION",
  });
  await rememberUcpCheckout(userId, checkoutResult);
  return {
    ...publicUcpOrderIntent(row),
    confirmationRequired: true,
    actions: [
      { id: "proceed", label: "Proceed With Order" },
      { id: "cancel", label: "Do Not Place Order" },
    ],
    merchantCheckoutUrl: null,
    pravaCheckoutUrl: null,
  };
}

async function ucpPaymentOptions(userId, row) {
  const [cards, identity] = await Promise.all([
    syncPravaPaymentMethodsForUser(userId),
    pravaMandateIdentity(userId).catch(() => null),
  ]);
  let mandates = [];
  let mandateError = null;
  if (identity) {
    try {
      mandates = (await listPravaMandatesForUser(
        userId,
        identity.customerId
      )).mandates;
    } catch (error) {
      mandateError = error.message;
    }
  }
  const allEligibleMandates = usablePravaMandatesForMerchant(
    mandates,
    Number(row.total_minor) / 100,
    row.merchant_name,
    row.merchant_url,
    row.currency
  );
  const eligibleMandates = allEligibleMandates.slice(0, 5);
  const publicCards = cards.map(publicUcpCard);
  return {
    eligibleMandates,
    eligibleMandateCount: allEligibleMandates.length,
    recommendedMandate: eligibleMandates[0] || null,
    savedCards: publicCards,
    mandateError,
    categories: {
      mandates: {
        id: "mandates",
        label: "Mandates",
        coverageAvailable: eligibleMandates.length > 0,
        eligibleCount: allEligibleMandates.length,
        recommendedMandate: eligibleMandates[0] || null,
        canCreate: publicCards.length > 0,
      },
      savedCards: {
        id: "saved_cards",
        label: "Saved Cards",
        count: publicCards.length,
        cards: publicCards,
        canCreate: true,
      },
    },
    methods: [
      ...(eligibleMandates.length ? [{ id: "mandate", label: "Use Active Mandate" }] : []),
      { id: "create_mandate", label: "Create A Mandate" },
      ...(cards.length ? [{ id: "card", label: "Use Saved Card" }] : []),
      { id: "add_card", label: "Add A Card" },
    ],
  };
}

async function decideUcpOrder(userId, orderId, proceed) {
  const row = await db.getUcpOrderIntent(userId, orderId);
  if (!row) throw Object.assign(new Error("Order quote was not found"), { status: 404 });
  if (typeof proceed !== "boolean") {
    throw Object.assign(new Error("proceed must be true or false"), { status: 400 });
  }
  if (!proceed) {
    const canceled = await db.saveUcpOrderIntent(
      userId,
      ucpOrderIntentInput(row, { status: "CANCELED", failureMessage: null })
    );
    return { ...publicUcpOrderIntent(canceled), paymentDecisionRequired: false };
  }
  if (row.status === "CANCELED") {
    throw Object.assign(
      new Error("This quote was canceled after the cart changed. Review a fresh checkout total."),
      { status: 409 }
    );
  }
  const confirmed = await db.saveUcpOrderIntent(
    userId,
    ucpOrderIntentInput(row, {
      status: "AWAITING_PAYMENT_METHOD",
      priceConfirmedAt: new Date().toISOString(),
      failureMessage: null,
    })
  );
  return {
    ...publicUcpOrderIntent(confirmed),
    paymentDecisionRequired: true,
    paymentOptions: await ucpPaymentOptions(userId, confirmed),
  };
}

function paymentCredentialFingerprint(credentials) {
  return nodeCrypto
    .createHash("sha256")
    .update(String(credentials?.token || ""))
    .digest("hex");
}

async function chooseUcpOrderPayment(userId, orderId, input = {}) {
  let row = await db.getUcpOrderIntent(userId, orderId);
  if (!row) throw Object.assign(new Error("Order quote was not found"), { status: 404 });
  if (!row.price_confirmed_at || row.status === "CANCELED") {
    throw Object.assign(new Error("Confirm the final merchant price first"), { status: 409 });
  }
  const method = String(input.method || "").trim().toLowerCase();
  const amount = (Number(row.total_minor) / 100).toFixed(2);
  const purchaseContext = ucpPurchaseContext({
    ...(row.quote_snapshot || {}),
    merchantName: row.merchant_name,
    merchantUrl: row.merchant_url,
    market: row.quote_snapshot?.market,
    checkoutId: row.merchant_checkout_id,
    totalAmount: amount,
    quantity: (row.quote_snapshot?.items || []).reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    ) || 1,
  });
  if (method === "mandate") {
    const { customerId } = await pravaMandateIdentity(userId);
    const mandates = (await listPravaMandatesForUser(
      userId,
      customerId
    )).mandates;
    const eligible = usablePravaMandatesForMerchant(
      mandates,
      amount,
      row.merchant_name,
      row.merchant_url,
      row.currency
    );
    const requestedMandateId = String(input.mandateId || "").trim();
    const selected = requestedMandateId
      ? eligible.find((mandate) => String(mandate.id) === requestedMandateId)
      : eligible[0];
    if (!selected) {
      throw Object.assign(new Error("Select an active mandate that covers the total"), {
        status: 409,
      });
    }
    const reference = `trakko_ucp_${row.id.replaceAll("-", "")}`;
    const charge = await payments.chargeMandate({
      mandateId: selected.id,
      amount,
      reference,
    });
    row = await db.saveUcpOrderIntent(userId, ucpOrderIntentInput(row, {
      status: "PAYMENT_CREDENTIAL_ISSUED",
      paymentRoute: "mandate",
      pravaMandateId: charge.mandateId,
      pravaTransactionId: charge.transactionId,
      pravaOrderId: charge.orderId,
      credentialFingerprint: paymentCredentialFingerprint(charge.credentials),
      credentialIssuedAt: new Date().toISOString(),
      failureMessage: null,
    }));
    return {
      ...publicUcpOrderIntent(row),
      tokenIssued: true,
      sandboxPaymentCredential:
        payments.configuration().environment === "sandbox"
          ? {
              mandateId: charge.mandateId,
              transactionId: charge.transactionId,
              token: charge.credentials.token,
              ephemeral: true,
            }
          : null,
      pravaCheckoutUrl: null,
      redirectRequired: false,
      nextAction: {
        type: "browser_harness_required",
        label: "Payment credential issued; merchant order not placed yet",
      },
      selectedMandate: {
        id: selected.id,
        currency: selected.currency,
        remaining: selected.remaining ?? selected.approvedAmount,
        selectionRule: "smallest_active_mandate_covering_full_cart",
      },
    };
  }
  if (method === "create_mandate") {
    const availableCards = await syncPravaPaymentMethodsForUser(userId);
    const selectedCard = availableCards.find((card) =>
      String(card.id) === String(input.paymentMethodId || "")
    ) || availableCards.find((card) => card.is_default === true || card.isDefault === true)
      || availableCards[0];
    if (!selectedCard) {
      throw Object.assign(new Error("Add a saved Prava card before creating a mandate"), {
        status: 409,
      });
    }
    const session = await createPravaMandateForUser(userId, {
      paymentMethodId: selectedCard.id,
      amount,
      frequency: input.frequency || "monthly",
      returnContext: { ...(input.returnContext || {}), orderId: row.id },
      currency: row.currency,
      purchaseContext,
      externalOrderRef: `trakko_ucp_mandate_${row.id.replaceAll("-", "")}`,
      description: `Authorize ${row.merchant_name} purchases up to ${row.currency} ${amount}.`,
    });
    row = await db.saveUcpOrderIntent(userId, ucpOrderIntentInput(row, {
      status: "PRAVA_MANDATE_APPROVAL_REQUIRED",
      paymentRoute: "create_mandate",
    }));
    return {
      ...publicUcpOrderIntent(row),
      tokenIssued: false,
      pravaCheckoutUrl: session.approvalUrl,
      redirectRequired: true,
      nextAction: { type: "prava_mandate_approval", label: "Approve Mandate With Prava", url: session.approvalUrl },
    };
  }
  if (method === "add_card") {
    const session = await createTokenizationSessionForUser(userId, {
      returnContext: { ...(input.returnContext || {}), orderId: row.id },
    });
    row = await db.saveUcpOrderIntent(userId, ucpOrderIntentInput(row, {
      status: "PRAVA_CARD_SETUP_REQUIRED",
      paymentRoute: "add_card",
    }));
    return {
      ...publicUcpOrderIntent(row),
      tokenIssued: false,
      pravaCheckoutUrl: session.approvalUrl,
      redirectRequired: true,
      nextAction: { type: "prava_card_setup", label: "Add Card With Prava", url: session.approvalUrl },
    };
  }
  if (method === "card") {
    const [{ email, customerId }, methods] = await Promise.all([
      pravaMandateIdentity(userId),
      syncPravaPaymentMethodsForUser(userId),
    ]);
    const selected = methods.find((card) =>
      String(card.id) === String(input.paymentMethodId || "")
    ) || methods.find((card) => card.is_default === true || card.isDefault === true)
      || methods[0];
    if (!selected?.provider_payment_method_id) {
      throw Object.assign(new Error("Select a saved Prava card"), { status: 404 });
    }
    const callbackUrl = pravaReturnCallback("card", {
      ...(input.returnContext || {}),
      orderId: row.id,
    });
    const session = await payments.createPaymentSession({
      customerId,
      email,
      cardId: selected.provider_payment_method_id,
      amount,
      callbackUrl,
      purchaseContext,
      externalOrderRef: `trakko_ucp_${row.id.replaceAll("-", "")}`,
      currency: row.currency,
    });
    row = await db.saveUcpOrderIntent(userId, ucpOrderIntentInput(row, {
      status: "PRAVA_CARD_APPROVAL_REQUIRED",
      paymentRoute: "card",
      pravaSessionId: session.sessionId,
      pravaOrderId: session.orderId,
      failureMessage: null,
    }));
    return {
      ...publicUcpOrderIntent(row),
      tokenIssued: false,
      pravaCheckoutUrl: session.approvalUrl,
      redirectRequired: true,
      nextAction: { type: "prava_card_approval", label: "Approve Card With Prava", url: session.approvalUrl },
    };
  }
  throw Object.assign(new Error("Choose mandate, create_mandate, card, or add_card"), {
    status: 400,
  });
}

async function continueUcpOrderPayment(userId, orderId) {
  let row = await db.getUcpOrderIntent(userId, orderId);
  if (!row) throw Object.assign(new Error("Order quote was not found"), { status: 404 });
  if (row.payment_route === "create_mandate") {
    const { customerId } = await pravaMandateIdentity(userId);
    const mandates = usablePravaMandatesForMerchant(
      (await listPravaMandatesForUser(userId, customerId)).mandates,
      Number(row.total_minor) / 100,
      row.merchant_name,
      row.merchant_url,
      row.currency
    );
    if (!mandates.length) {
      return {
        ...publicUcpOrderIntent(row),
        tokenIssued: false,
        pravaStatus: "mandate_approval_pending",
      };
    }
    return chooseUcpOrderPayment(userId, orderId, {
      method: "mandate",
      mandateId: mandates[0].id,
    });
  }
  if (row.payment_route !== "card" || !row.prava_session_id) {
    throw Object.assign(new Error("No Prava card payment is waiting for this order"), {
      status: 409,
    });
  }
  const result = await payments.getPaymentResult(row.prava_session_id);
  const payment = payments.paymentSessionCredentials(result);
  if (!payment) {
    return {
      ...publicUcpOrderIntent(row),
      tokenIssued: false,
      pravaStatus: String(result?.status || "pending").toLowerCase(),
      pravaCheckoutUrl: row.quote_snapshot?.pravaCheckoutUrl || null,
    };
  }
  row = await db.saveUcpOrderIntent(userId, ucpOrderIntentInput(row, {
    status: "PAYMENT_CREDENTIAL_ISSUED",
    pravaTransactionId: payment.transactionId,
    credentialFingerprint: paymentCredentialFingerprint(payment.credentials),
    credentialIssuedAt: new Date().toISOString(),
    failureMessage: null,
  }));
  return {
    ...publicUcpOrderIntent(row),
    tokenIssued: true,
    pravaStatus: payment.status,
    sandboxPaymentCredential:
      payments.configuration().environment === "sandbox"
        ? {
            sessionId: row.prava_session_id,
            transactionId: payment.transactionId,
            token: payment.credentials.token,
            ephemeral: true,
          }
        : null,
    note:
      payments.configuration().environment === "sandbox"
        ? "Prava payment-result returned this single-use sandbox virtual PAN. Tokko stored only its SHA-256 fingerprint."
        : "Prava payment-result issued a one-time credential. Tokko stored only its SHA-256 fingerprint.",
    nextAction: {
      type: "browser_harness_required",
      label: "Payment credential issued; merchant order not placed yet",
    },
  };
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
  const mandates = (await listPravaMandatesForUser(
    userId,
    customerId
  )).mandates;
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
      mandates = (await listPravaMandatesForUser(
        userId,
        identity.customerId
      )).mandates;
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
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  const result = await searchUcpForSelectedAddress(user.userId, {
    ...body,
    limit: Math.min(Math.max(Number(body.limit) || 10, 1), 10),
  });
  result.products = await db.saveUcpProductChoices(
    user.userId,
    result.products.slice(0, 10),
    result.query
  );
  sendJson(res, 200, result);
});

route("GET", "/api/merchants/ucp/cart", async (req, res) => {
  const user = await auth.requireUser(req);
  sendJson(res, 200, ucpCartPayload(await db.getUcpCart(user.userId)));
});

route("DELETE", "/api/merchants/ucp/cart/items/:itemId", async (req, res, params) => {
  const user = await auth.requireUser(req);
  const removedItem = await db.removeUcpCartItem(user.userId, params.itemId);
  if (!removedItem) return sendJson(res, 404, { error: "Cart item was not found" });
  sendJson(res, 200, {
    removedItem,
    cart: ucpCartPayload(await db.getUcpCart(user.userId)),
  });
});

route("DELETE", "/api/merchants/ucp/cart", async (req, res) => {
  const user = await auth.requireUser(req);
  const removedCount = await db.clearUcpCart(user.userId);
  sendJson(res, 200, { removedCount, cart: ucpCartPayload([]) });
});

route("POST", "/api/merchants/ucp/cart/items", async (req, res) => {
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  const choiceId = String(body.choiceId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(choiceId)) {
    throw Object.assign(new Error("choiceId is required"), { status: 400 });
  }
  const addition = await db.addSingleMerchantUcpCartItem(
    user.userId,
    choiceId,
    body.quantity,
    body.replaceCart === true
  );
  if (addition.expired) {
    return sendJson(res, 409, {
      error: "This product choice expired. Search again for current availability and price.",
    });
  }
  if (addition.conflict) {
    return sendJson(res, 409, {
      error:
        `Your cart is locked to ${addition.currentMerchantName}. `
        + `Replace it before adding a product from ${addition.requestedMerchantName}.`,
      code: "merchant_cart_conflict",
      conflict: addition,
    });
  }
  sendJson(res, 201, {
    added: true,
    addedItem: addition.addedItem,
    replacedCart: addition.replacedCart,
    cart: ucpCartPayload(await db.getUcpCart(user.userId)),
  });
});

route("POST", "/api/merchants/ucp/cart/checkout", async (req, res) => {
  const user = await auth.requireUser(req);
  const cart = await db.getUcpCart(user.userId);
  const merchant = cart[0]?.merchant;
  if (!merchant) return sendJson(res, 404, { error: "Your cart is empty" });
  if (new Set(cart.map((item) => item.merchant)).size > 1) {
    return sendJson(res, 409, {
      error: "This legacy cart contains multiple merchants. Keep one merchant before checkout.",
    });
  }
  const cartItems = await db.getUcpCartCheckoutItems(user.userId, merchant);
  if (cartItems.some((item) => item.expired)) {
    return sendJson(res, 409, { error: "One or more product prices expired. Search again." });
  }
  sendJson(res, 201, await createUcpCheckoutQuote(user.userId, { cartItems }));
});

route("POST", "/api/merchants/ucp/checkout", async (req, res) => {
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  const result = await createUcpCheckoutQuote(user.userId, body);
  sendJson(res, 201, result);
});

route("GET", "/api/merchants/ucp/orders", async (req, res) => {
  const user = await auth.requireUser(req);
  const limit = Number.parseInt(getQuery(req).limit, 10) || 50;
  const rows = await db.getUcpOrderIntents(user.userId, limit);
  sendJson(res, 200, { orders: rows.map(publicUcpOrderIntent) });
});
route("GET", "/api/merchants/ucp/orders/:id", async (req, res, params) => {
  const user = await auth.requireUser(req);
  const row = await db.getUcpOrderIntent(user.userId, params.id);
  if (!row) return sendJson(res, 404, { error: "Order quote was not found" });
  sendJson(res, 200, publicUcpOrderIntent(row));
});

route("GET", "/api/merchants/ucp/orders/:id/payment-options", async (req, res, params) => {
  const user = await auth.requireUser(req);
  const row = await db.getUcpOrderIntent(user.userId, params.id);
  if (!row) return sendJson(res, 404, { error: "Order quote was not found" });
  if (!row.price_confirmed_at || row.status === "CANCELED") {
    return sendJson(res, 409, { error: "Confirm the final merchant price first" });
  }
  sendJson(res, 200, await ucpPaymentOptions(user.userId, row));
});

route("POST", "/api/merchants/ucp/orders/:id/decision", async (req, res, params) => {
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  sendJson(res, 200, await decideUcpOrder(user.userId, params.id, body.proceed));
});

route("POST", "/api/merchants/ucp/orders/:id/payment", async (req, res, params) => {
  const user = await auth.requireUser(req);
  sendJson(
    res,
    200,
    await chooseUcpOrderPayment(user.userId, params.id, await parseBody(req))
  );
});

route("POST", "/api/merchants/ucp/orders/:id/payment/continue", async (req, res, params) => {
  const user = await auth.requireUser(req);
  sendJson(res, 200, await continueUcpOrderPayment(user.userId, params.id));
});

route("POST", "/api/merchants/ucp/payment-choice", async (req, res) => {
  await auth.requireUser(req);
  throw Object.assign(
    new Error("Use the confirmed order payment endpoint; merchant checkout redirects are disabled"),
    { status: 410 }
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
    websiteAuthentication: "email_or_phone_password",
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
    telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || null,
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
      responseLanguage: binding.response_language || "en-IN",
    });
  }
);

route(
  "POST",
  "/api/v1/integrations/telegram/bindings/:chatId/language",
  async (req, res, params) => {
    await auth.requireService(req);
    const chatId = telegramChatIdentifier({ chatId: params.chatId });
    const binding = await db.getTelegramHermesBinding(chatId);
    if (!binding) return sendJson(res, 404, { error: "Telegram chat is not linked" });
    const body = await parseBody(req);
    const requested = String(body.language || "").trim();
    const language = hermes.normalizeResponseLanguage(requested);
    if (language !== requested) {
      throw Object.assign(new Error("Unsupported response language"), { status: 400 });
    }
    await db.setTelegramResponseLanguage(chatId, language);
    sendJson(res, 200, { language });
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
      awaitingAddress: session.awaiting_address === true,
      pendingCountryCode: /^[A-Z]{2}$/.test(String(session.pending_address_country || ""))
        ? session.pending_address_country
        : null,
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
      return sendJson(res, 200, {
        confirmed: false,
        awaitingAddress: false,
        selectedAddress: null,
      });
    }
    if (typeof body.awaitingAddress === "boolean") {
      const pendingCountryCode = String(body.countryCode || "").trim().toUpperCase();
      if (pendingCountryCode && !/^[A-Z]{2}$/.test(pendingCountryCode)) {
        throw Object.assign(
          new Error("countryCode must use a two-letter ISO code"),
          { status: 400 }
        );
      }
      const session = await db.setTelegramAwaitingAddress(
        chatId,
        body.awaitingAddress,
        pendingCountryCode || null
      );
      return sendJson(res, 200, {
        confirmed: Boolean(session?.selected_address_id),
        awaitingAddress: session?.awaiting_address === true,
        pendingCountryCode: session?.pending_address_country || null,
      });
    }
    const addressId = String(body.addressId || "").trim();
    if (!/^[1-9]\d*$/.test(addressId)) {
      throw Object.assign(new Error("addressId is required"), { status: 400 });
    }
    let selection;
    try {
      selection = await selectFamilyAddressWithCartPolicy(
        Number(binding.user_id),
        addressId,
        { replaceCart: body.replaceCart === true }
      );
    } catch (error) {
      if (error.code === "cart_delivery_country_conflict") {
        return sendJson(res, 409, {
          error: error.message,
          code: error.code,
          conflict: error.conflict,
        });
      }
      throw error;
    }
    const selected = selection?.selected;
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
      cartCleared: selection.cartCleared,
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
  const input = validation.onboardingInput(await parseBody(req));
  const linkedUser = await db.linkWebsiteUserPhone(
    user.userId,
    {
      clerkUserId: user.clerkUserId,
      email: user.email,
    },
    input.primaryParentPhone
  );
  const userId = Number(linkedUser.id);
  await db.saveProfile(userId, input, "website");
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
    const orderId = /^[0-9a-f-]{36}$/i.test(String(query.order || ""))
      ? String(query.order).toLowerCase()
      : null;
    const payload =
      query.flow === "mandate"
        ? query.callback
          ? `pmr_${pravaCallbackIdentifier(query.callback).replaceAll("-", "")}`
          : "payments_mandate_return"
        : orderId
          ? `pcr_${orderId.replaceAll("-", "")}`
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
    const result = await listPravaMandatesForUser(
      user.userId,
      customerId,
      { allowCached: true }
    );
    sendJson(res, 200, {
      ...mandateListPayload(result.mandates, getQuery(req)),
      source: result.source,
      stale: result.stale,
      fetchedAt: result.fetchedAt,
      warning: result.warning || null,
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
});

route("POST", "/api/payments/mandates/callback/complete", async (req, res) => {
  try {
    const user = await auth.requireUser(req);
    const { callbackId } = await parseBody(req);
    sendJson(
      res,
      200,
      await completePravaMandateCallback(user.userId, callbackId)
    );
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
    const result = await listPravaMandatesForUser(
      userId,
      customerId,
      { allowCached: true }
    );
    sendJson(res, 200, {
      userId,
      customerId,
      ...mandateListPayload(result.mandates, getQuery(req)),
      source: result.source,
      stale: result.stale,
      fetchedAt: result.fetchedAt,
      warning: result.warning || null,
    });
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/payment/mandates/callback/complete",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const { callbackId } = await parseBody(req);
    sendJson(
      res,
      200,
      await completePravaMandateCallback(userId, callbackId)
    );
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
    sendJson(res, 200, await searchUcpForSelectedAddress(userId, body));
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/hermes/transcribe",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    if (!(await db.getUserById(userId))) {
      return sendJson(res, 404, { error: "Onboarding not found" });
    }
    const body = await parseBody(req);
    sendJson(res, 200, await hermes.transcribeAudio({
      audioBase64: body.audioBase64,
      mimeType: body.mimeType,
      language: body.language,
    }));
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/hermes/media",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    if (!(await db.getUserById(userId))) {
      return sendJson(res, 404, { error: "Onboarding not found" });
    }
    const body = await parseBody(req);
    sendJson(res, 200, await runHermesMediaBackend({
      req,
      userId,
      messages: body.messages,
      language: body.language,
      dataBase64: body.dataBase64,
      mimeType: body.mimeType,
      declaredType: body.declaredType,
    }));
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/merchants/ucp/cart",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    if (!(await db.getUserById(userId))) {
      return sendJson(res, 404, { error: "Onboarding not found" });
    }
    const [items, prescriptionReviewItems] = await Promise.all([
      db.getUcpCart(userId),
      db.getPrescriptionReviewItems(userId),
    ]);
    sendJson(res, 200, {
      ...ucpCartPayload(items),
      prescriptionReviewItems,
    });
  }
);

route(
  "DELETE",
  "/api/v1/onboarding/:id/merchants/ucp/cart/items/:itemId",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const removedItem = await db.removeUcpCartItem(userId, params.itemId);
    if (!removedItem) return sendJson(res, 404, { error: "Cart item was not found" });
    sendJson(res, 200, {
      removedItem,
      cart: ucpCartPayload(await db.getUcpCart(userId)),
    });
  }
);

route(
  "DELETE",
  "/api/v1/onboarding/:id/merchants/ucp/cart",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const removedCount = await db.clearUcpCart(userId);
    sendJson(res, 200, { removedCount, cart: ucpCartPayload([]) });
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/cart/items",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    if (!(await db.getUserById(userId))) {
      return sendJson(res, 404, { error: "Onboarding not found" });
    }
    const body = await parseBody(req);
    const choiceId = String(body.choiceId || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(choiceId)) {
      throw Object.assign(new Error("choiceId is required"), { status: 400 });
    }
    const addition = await db.addSingleMerchantUcpCartItem(
      userId,
      choiceId,
      body.quantity,
      body.replaceCart === true
    );
    if (addition.expired) {
      return sendJson(res, 409, {
        error: "This product choice expired. Search again for current availability and price.",
      });
    }
    if (addition.conflict) {
      return sendJson(res, 409, {
        error:
          `Your cart is locked to ${addition.currentMerchantName}. `
          + `Replace it before adding a product from ${addition.requestedMerchantName}.`,
        code: "merchant_cart_conflict",
        conflict: addition,
      });
    }
    sendJson(res, 201, {
      added: true,
      addedItem: addition.addedItem,
      replacedCart: addition.replacedCart,
      cart: ucpCartPayload(await db.getUcpCart(userId)),
    });
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/cart/checkout",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    if (!(await db.getUserById(userId))) {
      return sendJson(res, 404, { error: "Onboarding not found" });
    }
    const body = await parseBody(req);
    const merchant = String(body.merchant || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(merchant)) {
      throw Object.assign(new Error("merchant is required"), { status: 400 });
    }
    const cartItems = await db.getUcpCartCheckoutItems(userId, merchant);
    if (!cartItems.length) {
      return sendJson(res, 404, { error: "This merchant cart is empty" });
    }
    if (cartItems.some((item) => item.expired)) {
      return sendJson(res, 409, {
        error: "One or more product prices expired. Search again before checkout.",
      });
    }
    const result = await createUcpCheckoutQuote(userId, { cartItems });
    sendJson(res, 201, result);
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/merchants/ucp/orders/:orderId",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const row = await db.getUcpOrderIntent(userId, params.orderId);
    if (!row) return sendJson(res, 404, { error: "Order quote was not found" });
    sendJson(res, 200, publicUcpOrderIntent(row));
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/merchants/ucp/orders/:orderId/payment-options",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const row = await db.getUcpOrderIntent(userId, params.orderId);
    if (!row) return sendJson(res, 404, { error: "Order quote was not found" });
    if (!row.price_confirmed_at || row.status === "CANCELED") {
      return sendJson(res, 409, { error: "Confirm the final merchant price first" });
    }
    sendJson(res, 200, await ucpPaymentOptions(userId, row));
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/orders/:orderId/decision",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    const body = await parseBody(req);
    sendJson(res, 200, await decideUcpOrder(userId, params.orderId, body.proceed));
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/orders/:orderId/payment",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    sendJson(
      res,
      200,
      await chooseUcpOrderPayment(userId, params.orderId, await parseBody(req))
    );
  }
);

route(
  "POST",
  "/api/v1/onboarding/:id/merchants/ucp/orders/:orderId/payment/continue",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
    sendJson(res, 200, await continueUcpOrderPayment(userId, params.orderId));
  }
);

route(
  "GET",
  "/api/v1/onboarding/:id/addresses",
  async (req, res, params) => {
    await auth.requireService(req);
    const userId = await resolveOnboardingUserId(params.id);
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
    const body = await parseBody(req);
    let selection;
    try {
      selection = await selectFamilyAddressWithCartPolicy(userId, body.addressId, {
        replaceCart: body.replaceCart === true,
      });
    } catch (error) {
      if (error.code === "cart_delivery_country_conflict") {
        return sendJson(res, 409, {
          error: error.message,
          code: error.code,
          conflict: error.conflict,
        });
      }
      throw error;
    }
    const selected = selection?.selected;
    if (!selected) return sendJson(res, 404, { error: "Tokko address not found" });
    sendJson(res, 200, {
      selected: true,
      selectedAddress: publicFamilyAddress(selected),
      cartCleared: selection.cartCleared,
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
    await db.clearDeliveryPreference(user.userId, "zepto");
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
    try {
      await db.assignFamilyAddress(user.userId, address.id, body.memberIds);
    } catch (assignError) {
      // Member assignment validates the ids and can reject (404) after the
      // address row already committed. Remove the orphan so a corrected retry
      // does not pile up dangling addresses, then surface the original error.
      await db.deleteFamilyAddress(user.userId, address.id).catch(() => {});
      throw assignError;
    }
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
route("POST", "/api/addresses/select", async (req, res) => {
  const body = await parseBody(req);
  try {
    const user = await auth.requireUser(req);
    const selection = await selectFamilyAddressWithCartPolicy(
      user.userId,
      body.addressId,
      { replaceCart: body.replaceCart === true }
    );
    const selected = selection?.selected;
    if (!selected) return sendJson(res, 404, { error: "Tokko address not found" });
    return sendJson(res, 200, {
      selected: true,
      selectedAddress: publicFamilyAddress(selected),
      cartCleared: selection.cartCleared,
      ...familyAddressPayload(await db.getFamilyAddresses(user.userId)),
    });
  } catch (error) {
    return sendJson(res, error.status || 400, {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.conflict ? { conflict: error.conflict } : {}),
    });
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

route("POST", "/api/hermes/media", async (req, res) => {
  const user = await auth.requireUser(req);
  const body = await parseBody(req);
  sendJson(res, 200, await runHermesMediaBackend({
    req,
    userId: user.userId,
    messages: body.messages,
    language: body.language,
    dataBase64: body.dataBase64,
    mimeType: body.mimeType,
    declaredType: body.declaredType,
  }));
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
  const activeCart = await db.getUcpCart(userId);
  const cartActionResult = await handleRequestedCartAction(
    userId,
    messages,
    activeCart
  );
  if (cartActionResult) return cartActionResult;
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
  const lockedMerchant = activeCart[0]?.merchant || null;
  const lockedMerchantName = activeCart[0]?.merchantName || null;
  const tools = [
    HERMES_UCP_SEARCH_TOOL,
    HERMES_UCP_CHECKOUT_TOOL,
  ];
  const selectedDeliveryCountry = String(
    state.deliveryPreference?.countryCode || ""
  ).trim().toUpperCase();
  const selectedDeliveryMarket = /^[A-Z]{2}$/.test(selectedDeliveryCountry)
    ? selectedDeliveryCountry
    : null;
  const countryConflict = ucpCartCountryConflict(
    activeCart,
    selectedDeliveryMarket
  );
  if (countryConflict) {
    return {
      message: `${cartCountryConflictMessage(countryConflict)} Clear it and I’ll retry your search using merchants that deliver to ${countryConflict.targetCountry}.`,
      tools: [],
      cartSummary: ucpCartPayload(activeCart),
      cartCountryConflict: {
        ...countryConflict,
        retryQuery: latestUserMessageText(messages).slice(0, 300),
      },
    };
  }
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
      lockedMerchant,
      lockedMerchantName,
      eligibleMerchants: selectedDeliveryMarket === "IN"
        ? Object.values(ucp.MERCHANTS)
            .filter((merchant) => merchant.market === "IN")
            .map((merchant) => ({ slug: merchant.slug, name: merchant.name }))
        : selectedDeliveryMarket
          ? [{
              slug: "global_ucp",
              name: `Global UCP catalogue shipping to ${selectedDeliveryMarket}`,
            }]
          : [],
      responseLanguage: hermes.normalizeResponseLanguage(language),
      learnedMemories,
    },
    executeTool: (toolName, args) => {
      if (toolName === HERMES_UCP_SEARCH_TOOL.name) {
        if (!selectedDeliveryMarket) {
          throw Object.assign(
            new Error(
              "Select a delivery address with a valid two-letter country code before searching"
            ),
            { status: 409 }
          );
        }
        return executeHermesTool(req, userId, toolName, {
          ...args,
          market: selectedDeliveryMarket,
          ...(lockedMerchant ? { merchant: lockedMerchant } : {}),
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
  const searchResults = (result.tools || [])
    .filter((tool) =>
      tool.name === HERMES_UCP_SEARCH_TOOL.name
      && tool.status === "completed"
      && Array.isArray(tool.result?.products)
    )
    .map((tool) => tool.result);
  if (searchResults.length) {
    for (const searchResult of searchResults) {
      searchResult.products = rankUcpProducts(searchResult.products, learnedMemories);
    }
    result.productGroups = await Promise.all(searchResults.map(async (searchResult) => ({
      query: searchResult.query,
      merchant: searchResult.merchants?.[0]?.merchant || null,
      merchantName: searchResult.merchants?.[0]?.merchantName || null,
      products: await db.saveUcpProductChoices(
        userId,
        searchResult.products.slice(0, 10),
        searchResult.query
      ),
      pagination: searchResult.pagination || null,
    })));
    result.productChoices = result.productGroups.flatMap((group) =>
      group.products.map((product) => ({ ...product, searchQuery: group.query }))
    );
    result.merchantStatuses = searchResults.flatMap((entry) => entry.merchants || []);
    result.productQuery = searchResults.length === 1 ? searchResults[0].query : null;
    result.productPagination = searchResults.length === 1
      ? searchResults[0].pagination || null
      : null;
    const foundGroups = result.productGroups.filter((group) => group.products.length);
    result.message = foundGroups.length
      ? `i found ${foundGroups.map((group) => `${group.products.length} preferred options for ${group.query}`).join(", ")}. tap a product to add it to your cart.`
      : "i could not find an image-backed match for that search. try a broader product name.";
  }
  const checkoutResult = [...(result.tools || [])]
    .reverse()
    .find((tool) =>
      tool.name === HERMES_UCP_CHECKOUT_TOOL.name &&
      tool.status === "completed"
    )?.result;
  if (checkoutResult?.orderId) {
    result.merchantHandoffUrl = null;
    result.paymentUrl = null;
    result.paymentHandoff = null;
    result.cardChoices = [];
    result.checkoutSummary = {
      orderId: checkoutResult.orderId,
      currency: checkoutResult.currency,
      totalAmount: checkoutResult.totalAmount,
      ...(checkoutResult.quote || {}),
      confirmationRequired: true,
    };
    result.message =
      `the merchant returned a final ${checkoutResult.currency} ${checkoutResult.totalAmount} quote. `
      + "review the full breakdown and choose proceed with order or do not place order.";
    result.nextAction = {
      type: "ucp_quote_confirmation",
      orderId: checkoutResult.orderId,
      actions: checkoutResult.actions,
    };
  }
  return result;
}

async function runHermesMediaBackend({
  req,
  userId,
  messages,
  language,
  dataBase64,
  mimeType,
  declaredType,
}) {
  const inspection = await hermes.inspectShoppingMedia({
    dataBase64,
    mimeType,
    language,
    declaredType,
  });
  const isPrescription =
    String(declaredType || "").toLowerCase() === "prescription"
    || inspection.documentType === "prescription";
  if (isPrescription) {
    const names = inspection.items.map((item) => item.name).filter(Boolean);
    if (!names.length) {
      return {
        message: "i could not read a clear medicine name from that prescription. upload a sharper image or type the names.",
        mediaInspection: { documentType: "prescription", items: [] },
        prescriptionReviewItems: [],
      };
    }
    const sourceHash = nodeCrypto
      .createHash("sha256")
      .update(Buffer.from(String(dataBase64 || ""), "base64"))
      .digest("hex");
    const prescriptionReviewItems = await db.savePrescriptionReviewItems(
      userId,
      names,
      sourceHash
    );
    await db.upsertHermesMemory(userId, {
      type: "health_context",
      cue: "medicines extracted from current prescription",
      value: { medicines: names, verificationRequired: true },
      confidence: 0.85,
    });
    return {
      message:
        `i extracted ${names.join(", ")} and added ${names.length === 1 ? "it" : "them"} to prescription review. `
        + "checkout is blocked until a licensed pharmacy verifies the prescription; i will not infer dosage or substitute medicines.",
      mediaInspection: {
        documentType: "prescription",
        items: inspection.items,
      },
      prescriptionReviewItems,
      productChoices: [],
    };
  }
  const queries = inspection.items.map((item) => item.name).filter(Boolean).slice(0, 5);
  const productQuery = inspection.query || queries.join(", ");
  if (!productQuery) {
    return {
      message: "i could not identify a product from that image. upload a clearer front-label photo or type the product name.",
      mediaInspection: inspection,
      productChoices: [],
    };
  }
  const priorMessages = Array.isArray(messages) ? messages : [];
  const request = queries.length > 1
    ? `find 3 preferred options for each of these products from the upload: ${queries.join(", ")}`
    : `find 3 preferred options matching this uploaded product: ${productQuery}`;
  const result = await runHermesBackend({
    req,
    userId,
    messages: [...priorMessages, { role: "user", content: request }],
    language,
  });
  result.mediaInspection = inspection;
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
  if (toolName === HERMES_UCP_SEARCH_TOOL.name) {
    const market = String(args?.market || "").trim().toUpperCase();
    if (market && market !== "IN") {
      return ucp.searchGlobalMarket(args?.query, {
        limit: 10,
        offset: args?.offset,
        market,
        merchant: args?.merchant,
        baseUrl: BASE_URL,
      });
    }
    return ucp.searchAll(args?.query, {
      limit: 10,
      offset: args?.offset,
      market: args?.market,
      merchant: args?.merchant,
      baseUrl: BASE_URL,
    });
  }
  if (toolName === HERMES_UCP_CHECKOUT_TOOL.name) {
    return createUcpCheckoutQuote(userId, args);
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

route("POST", "/api/integrations/telegram/hermes", async (req, res) => {
  await requireTelegramIntegration(req);
  const body = await parseBody(req);
  const chatId = telegramChatIdentifier(body);
  const user = await telegramFamilyUser(body, chatId);
  req.tokkoServiceUserId = Number(user.id);
  const text = telegramMessageText(body).slice(0, 6_000);
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

route("POST", "/api/integrations/telegram/hermes/cart-country-retry", async (req, res) => {
  await requireTelegramIntegration(req);
  const body = await parseBody(req);
  const chatId = telegramChatIdentifier(body);
  const user = await telegramFamilyUser(body, chatId);
  req.tokkoServiceUserId = Number(user.id);
  const history = await db.getTelegramHermesMessages(chatId, 23);
  const lastUserIndex = history.map((message) => message.role).lastIndexOf("user");
  const retryMessages = lastUserIndex >= 0
    ? history.slice(0, lastUserIndex + 1)
    : [];
  const retryQuery = latestUserMessageText(retryMessages);
  if (!retryQuery) {
    throw Object.assign(new Error("No previous product search is available to retry"), {
      status: 409,
    });
  }
  await db.clearUcpCart(Number(user.id));
  const result = await runHermesBackend({
    req,
    userId: Number(user.id),
    clerkUserId: user.clerk_user_id || null,
    messages: retryMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    language: body.language || body.locale || "en-IN",
  });
  if (result.message) {
    await db.saveTelegramHermesMessage(chatId, "assistant", result.message);
  }
  sendJson(res, 200, {
    ...result,
    cartCountryConflict: null,
    cartCleared: true,
    retriedQuery: retryQuery,
    telegram: { chatId, familyLinked: true },
  });
});

route(
  "POST",
  "/api/integrations/telegram/hermes/payment-choice",
  async (req, res) => {
    await requireTelegramIntegration(req);
    throw Object.assign(
      new Error("Use the confirmed order payment endpoint; merchant redirects are disabled"),
      { status: 410 }
    );
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
          ...(error.code ? { code: error.code } : {}),
          ...(error.conflict ? { conflict: error.conflict } : {}),
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


// ==== Family-care verticals grafted from main ====
// ===== HELPERS =====

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

// ===== ROUTES =====

route("POST", "/api/auth/clerk/session", async (req, res) => {
  const { identity, email } = await auth.authenticateClerkUser(req);
  const user = await db.getOrCreateWebsiteUser(identity.userId, email);
  await createBrowserSession(req, res, user);
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
  HERMES_UCP_CHECKOUT_TOOL,
  HERMES_ZEPTO_RECONNECT_TOOL,
  MERCHANT_CONSENT_TEXT,
  canonicalPravaCustomerId,
  continueUcpOrderPayment,
  createUcpCheckoutWithPayment,
  familyAddressInput,
  familyAddressPayload,
  handler,
  initializeApplication,
  matchRoute,
  parseBody,
  pravaReturnCallback,
  pravaPaymentHandoff,
  readRawBody,
  requestedCartAction,
  ucpCartCountryConflict,
  savedAddressInput,
  selectUcpSavedCard,
  server,
  start,
  hermesOtpFromMessages,
  mandateListPayload,
  listPravaMandatesForUser,
  pravaCustomerIdCandidates,
  telegramChatIdentifier,
  telegramBotUsername,
  telegramMessageText,
  tokkoPaymentRoute,
  usablePravaMandatesForAmount,
  usablePravaMandatesForMerchant,
  ucpPurchaseContext,
  ucpQuoteWithForexCharge,
  ucpCartPayload,
  zeptoAddressLocationContext,
  zeptoSavedAddressRows,
  zeptoOrderId,
  zeptoOrderRows,
  zeptoPaymentLink,
});

module.exports = server;
