const crypto = require("node:crypto");
const net = require("node:net");

const UCP_VERSION = "2026-04-08";
const DEFAULT_AGENT_PROFILE =
  "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json";
const DISCOVERY_TTL_MS = 5 * 60 * 1_000;
const SELECTION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 50;
const MAX_RESULTS_PER_MERCHANT = 100;
const GLOBAL_CATALOG_ENDPOINT = "https://catalog.shopify.com/api/ucp/mcp";
const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "for", "from", "i", "me", "my", "need", "of",
  "please", "show", "the", "to", "want", "with",
]);

const MERCHANTS = Object.freeze({
  kapiva: Object.freeze({
    slug: "kapiva",
    name: "Kapiva",
    market: "IN",
    currency: "INR",
    origin: "https://kapiva.in",
    discoveryUrl: "https://kapiva.in/.well-known/ucp",
  }),
  oziva: Object.freeze({
    slug: "oziva",
    name: "OZiva",
    market: "IN",
    currency: "INR",
    origin: "https://www.oziva.in",
    discoveryUrl: "https://www.oziva.in/.well-known/ucp",
  }),
  himalayawellness: Object.freeze({
    slug: "himalayawellness",
    name: "Himalaya Wellness",
    market: "IN",
    currency: "INR",
    origin: "https://himalayawellness.in",
    discoveryUrl: "https://himalayawellness.in/.well-known/ucp",
  }),
  zanducare: Object.freeze({
    slug: "zanducare", name: "ZanduCare", market: "IN", currency: "INR",
    origin: "https://zanducare.com", discoveryUrl: "https://zanducare.com/.well-known/ucp",
  }),
  organicindia: Object.freeze({
    slug: "organicindia", name: "Organic India", market: "IN", currency: "INR",
    origin: "https://organicindia.com", discoveryUrl: "https://organicindia.com/.well-known/ucp",
  }),
  setunutrition: Object.freeze({
    slug: "setunutrition", name: "Setu Nutrition", market: "IN", currency: "INR",
    origin: "https://setu.in", discoveryUrl: "https://setu.in/.well-known/ucp",
  }),
  wellbeingnutrition: Object.freeze({
    slug: "wellbeingnutrition", name: "Wellbeing Nutrition", market: "IN", currency: "INR",
    origin: "https://wellbeingnutrition.com", discoveryUrl: "https://wellbeingnutrition.com/.well-known/ucp",
  }),
  drortho: Object.freeze({
    slug: "drortho", name: "Dr. Ortho", market: "IN", currency: "INR",
    origin: "https://drorthooil.com", discoveryUrl: "https://drorthooil.com/.well-known/ucp",
  }),
  yogabar: Object.freeze({
    slug: "yogabar", name: "YogaBar", market: "IN", currency: "INR",
    origin: "https://www.yogabars.in", discoveryUrl: "https://www.yogabars.in/.well-known/ucp",
  }),
  mamaearth: Object.freeze({
    slug: "mamaearth", name: "Mamaearth", market: "IN", currency: "INR",
    origin: "https://mamaearth.in", discoveryUrl: "https://mamaearth.in/.well-known/ucp",
  }),
  dotandkey: Object.freeze({
    slug: "dotandkey", name: "Dot & Key", market: "IN", currency: "INR",
    origin: "https://www.dotandkey.com", discoveryUrl: "https://www.dotandkey.com/.well-known/ucp",
  }),
  thedermaco: Object.freeze({
    slug: "thedermaco", name: "The Derma Co", market: "IN", currency: "INR",
    origin: "https://thedermaco.com", discoveryUrl: "https://thedermaco.com/.well-known/ucp",
  }),
  carbamideforte: Object.freeze({
    slug: "carbamideforte", name: "Carbamide Forte", market: "IN", currency: "INR",
    origin: "https://mycf.in", discoveryUrl: "https://mycf.in/.well-known/ucp",
  }),
  ritual: Object.freeze({
    slug: "ritual", name: "Ritual", market: "US", currency: "USD",
    origin: "https://ritual.com", discoveryUrl: "https://ritual.com/.well-known/ucp",
  }),
  momentous: Object.freeze({
    slug: "momentous", name: "Momentous", market: "US", currency: "USD",
    origin: "https://www.livemomentous.com", discoveryUrl: "https://www.livemomentous.com/.well-known/ucp",
  }),
  teamiblends: Object.freeze({
    slug: "teamiblends", name: "Teami Blends", market: "US", currency: "USD",
    origin: "https://www.teamiblends.com", discoveryUrl: "https://www.teamiblends.com/.well-known/ucp",
  }),
  perelel: Object.freeze({
    slug: "perelel", name: "Perelel", market: "US", currency: "USD",
    origin: "https://perelelhealth.com", discoveryUrl: "https://perelelhealth.com/.well-known/ucp",
  }),
  needed: Object.freeze({
    slug: "needed", name: "Needed", market: "US", currency: "USD",
    origin: "https://thisisneeded.com", discoveryUrl: "https://thisisneeded.com/.well-known/ucp",
  }),
});

const discoveryCache = new Map();

function httpError(status, message, details = null) {
  return Object.assign(new Error(message), { status, details });
}

function agentProfileUrl(baseUrl) {
  return String(
    process.env.UCP_AGENT_PROFILE_URL ||
      (baseUrl ? `${String(baseUrl).replace(/\/$/, "")}/.well-known/ucp` : "") ||
      DEFAULT_AGENT_PROFILE
  ).trim();
}

function agentProfile(baseUrl) {
  const profileUrl = agentProfileUrl(baseUrl);
  return {
    uri: profileUrl,
    document: {
      ucp: {
        version: UCP_VERSION,
        capabilities: {
          "dev.ucp.shopping.catalog.search": [{ version: UCP_VERSION }],
          "dev.ucp.shopping.catalog.lookup": [{ version: UCP_VERSION }],
          "dev.ucp.shopping.cart": [{ version: UCP_VERSION }],
          "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
          "dev.ucp.shopping.fulfillment": [{
            version: UCP_VERSION,
            extends: ["dev.ucp.shopping.checkout"],
            config: { supports_multi_group: false },
          }],
        },
      },
    },
  };
}

function merchant(slug) {
  const value = MERCHANTS[String(slug || "").toLowerCase()];
  if (!value) throw httpError(400, "Unsupported UCP merchant");
  return value;
}

function safeHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw httpError(400, "Invalid UCP merchant origin");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "443")
    || !host.includes(".")
    || host === "localhost"
    || net.isIP(host)
  ) {
    throw httpError(400, "Invalid UCP merchant origin");
  }
  return parsed.origin;
}

function capability(profile, name) {
  return Array.isArray(profile?.ucp?.capabilities?.[name]);
}

function serviceEndpoint(profile) {
  const services = profile?.ucp?.services;
  const shopping = Array.isArray(services?.["dev.ucp.shopping"])
    ? services["dev.ucp.shopping"]
    : [];
  const mcp = shopping.find((service) => service?.transport === "mcp");
  const rest = shopping.find((service) => service?.transport === "rest");
  const selected = mcp || rest;
  if (!selected?.endpoint) {
    throw httpError(502, "Merchant UCP profile did not provide a shopping endpoint");
  }
  return {
    endpoint: String(selected.endpoint),
    transport: String(selected.transport || ""),
  };
}

async function discover(slug, fetchImpl = fetch) {
  const selected = merchant(slug);
  const cached = discoveryCache.get(selected.slug);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetchImpl(selected.discoveryUrl, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw httpError(
      502,
      `${selected.name} UCP discovery failed with HTTP ${response.status}`
    );
  }
  const profile = await response.json();
  const service = serviceEndpoint(profile);
  const value = {
    ...selected,
    profile,
    ...service,
    catalogSearch: capability(profile, "dev.ucp.shopping.catalog.search"),
    checkout: capability(profile, "dev.ucp.shopping.checkout"),
  };
  discoveryCache.set(selected.slug, {
    expiresAt: Date.now() + DISCOVERY_TTL_MS,
    value,
  });
  return value;
}

async function discoverSelectionMerchant(selection, fetchImpl = fetch) {
  if (MERCHANTS[selection.merchant]) {
    return discover(selection.merchant, fetchImpl);
  }
  const origin = safeHttpsOrigin(selection.merchantOrigin);
  const cacheKey = `global:${origin}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const discoveryUrl = `${origin}/.well-known/ucp`;
  const response = await fetchImpl(discoveryUrl, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw httpError(
      502,
      `${selection.merchantName} UCP discovery failed with HTTP ${response.status}`
    );
  }
  const profile = await response.json();
  const service = serviceEndpoint(profile);
  safeHttpsOrigin(service.endpoint);
  const value = {
    slug: selection.merchant,
    name: String(selection.merchantName).slice(0, 160),
    market: String(selection.market || "").toUpperCase() || null,
    currency: String(selection.currency || "").toUpperCase() || null,
    origin,
    discoveryUrl,
    profile,
    ...service,
    catalogSearch: capability(profile, "dev.ucp.shopping.catalog.search"),
    checkout: capability(profile, "dev.ucp.shopping.checkout"),
    fulfillment: capability(profile, "dev.ucp.shopping.fulfillment"),
    dynamic: true,
  };
  if (!value.checkout || !value.fulfillment) {
    throw httpError(
      422,
      `${value.name} does not advertise UCP checkout with fulfillment`
    );
  }
  discoveryCache.set(cacheKey, {
    expiresAt: Date.now() + DISCOVERY_TTL_MS,
    value,
  });
  return value;
}

function parseEventStream(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .pop();
}

async function parseRpcResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  let payload;
  try {
    payload = contentType.includes("text/event-stream")
      ? parseEventStream(text)
      : JSON.parse(text);
  } catch {
    throw httpError(502, "Merchant UCP returned an unreadable response");
  }
  if (!response.ok || payload?.error) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `Merchant UCP request failed with HTTP ${response.status}`;
    throw httpError(response.status >= 400 ? response.status : 502, message, payload);
  }
  return payload?.result || payload;
}

function structuredContent(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Ignore non-JSON diagnostic text and keep looking.
    }
  }
  return {};
}

async function callMcp({ endpoint, toolName, arguments: toolArgs, baseUrl, fetchImpl = fetch }) {
  const profile = agentProfileUrl(baseUrl);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "UCP-Agent": `profile="${profile}"`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: {
          ...(toolArgs || {}),
          meta: { "ucp-agent": { profile } },
        },
      },
    }),
  });
  return structuredContent(await parseRpcResponse(response));
}

function signingSecret() {
  const value =
    process.env.UCP_SELECTION_SECRET ||
    process.env.HERMES_ACTION_SECRET ||
    process.env.CLERK_SECRET_KEY ||
    process.env.GEMINI_API_KEY;
  if (!value) throw httpError(503, "UCP product selection signing is not configured");
  return crypto.createHash("sha256").update(`tokko-ucp:${value}`).digest();
}

function signSelection(data) {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, ...data, expiresAt: Date.now() + SELECTION_TTL_MS }),
    "utf8"
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", signingSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifySelection(token) {
  const [payload, signature, ...extra] = String(token || "").split(".");
  if (!payload || !signature || extra.length) throw httpError(400, "Invalid product selection");
  const expected = crypto
    .createHmac("sha256", signingSecret())
    .update(payload)
    .digest("base64url");
  const suppliedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw httpError(400, "Invalid product selection");
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw httpError(400, "Invalid product selection");
  }
  if (Number(value.expiresAt || 0) < Date.now()) {
    throw httpError(409, "This product selection expired. Search again for current pricing.");
  }
  if (MERCHANTS[value.merchant]) {
    merchant(value.merchant);
  } else {
    if (value.globalCatalog !== true) {
      throw httpError(400, "Invalid UCP merchant selection");
    }
    value.merchantOrigin = safeHttpsOrigin(value.merchantOrigin);
    if (!String(value.merchantName || "").trim()) {
      throw httpError(400, "Invalid UCP merchant selection");
    }
  }
  if (!String(value.variantId || "").startsWith("gid://shopify/ProductVariant/")) {
    throw httpError(400, "Invalid product variant");
  }
  return value;
}

function firstImage(variant, product) {
  const candidates = [
    ...(variant?.media || []),
    ...(product?.media || []),
    ...(variant?.images || []),
    ...(product?.images || []),
    variant?.image,
    product?.image,
  ].filter(Boolean);
  for (const media of candidates) {
    const type = String(media?.type || media?.media_type || "image").toLowerCase();
    const url = String(
      typeof media === "string"
        ? media
        : media?.url || media?.src || media?.imageUrl || media?.image_url || ""
    );
    if ((!type || type.includes("image")) && /^https:\/\//.test(url)) return url;
  }
  return null;
}

function comparableMerchantName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hostname(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function globalResultMerchant(product, variant, market) {
  const seller = variant?.seller || product?.seller || {};
  const sellerHost = hostname(seller.url || `https://${seller.domain || ""}`);
  const productHost = hostname(variant?.url || product?.url);
  const sellerName = comparableMerchantName(seller.name);
  const registered = Object.values(MERCHANTS).find((entry) => {
    const registeredHost = hostname(entry.origin);
    const registeredName = comparableMerchantName(entry.name);
    return (
      (sellerHost && sellerHost === registeredHost)
      || (productHost && productHost === registeredHost)
      || (sellerName && registeredName
        && (sellerName === registeredName
          || sellerName.includes(registeredName)
          || registeredName.includes(sellerName)))
    );
  }) || null;
  if (registered) return registered;
  const productUrl = variant?.url || product?.url;
  let origin;
  try {
    origin = safeHttpsOrigin(productUrl);
  } catch {
    return null;
  }
  const name = String(seller.name || new URL(origin).hostname.replace(/^www\./, ""))
    .trim()
    .slice(0, 160);
  return {
    slug: `global_${crypto.createHash("sha256").update(origin).digest("hex").slice(0, 20)}`,
    name,
    market,
    origin,
    discoveryUrl: `${origin}/.well-known/ucp`,
    dynamic: true,
  };
}

function normalizeGlobalProducts(payload, market, query) {
  const normalized = [];
  for (const product of Array.isArray(payload?.products) ? payload.products : []) {
    for (const variant of Array.isArray(product?.variants) ? product.variants : []) {
      const selected = globalResultMerchant(product, variant, market);
      const amount = Number(variant?.price?.amount);
      if (
        !selected
        || !Number.isFinite(amount)
        || amount < 0
        || !variant?.id
        || variant?.availability?.available === false
      ) continue;
      const optionText = (variant.options || [])
        .map((option) => option?.label)
        .filter(Boolean)
        .join(" · ");
      if (!relevantProduct(query, product, variant, optionText, "all")) continue;
      const item = {
        merchant: selected.slug,
        merchantName: selected.name,
        market,
        productName: String(product?.title || "Product"),
        variantName: String(variant?.title || optionText || "Default"),
        optionText: optionText || null,
        price: amount / 100,
        priceMinor: amount,
        currency: String(variant?.price?.currency || selected.currency).toUpperCase(),
        available: variant?.availability?.available !== false,
        imageUrl: firstImage(variant, product),
        productUrl: /^https:\/\//.test(String(variant?.url || product?.url || ""))
          ? String(variant?.url || product.url)
          : null,
        discoverySource: "shopify_global_catalog",
      };
      item.selectionToken = signSelection({
        merchant: item.merchant,
        deliveryMarket: market,
        ...(selected.dynamic
          ? {
              globalCatalog: true,
              merchantOrigin: selected.origin,
              merchantName: selected.name,
              market,
            }
          : {}),
        variantId: String(variant.id),
        productName: item.productName,
        variantName: item.variantName,
        priceMinor: item.priceMinor,
        currency: item.currency,
      });
      if (item.imageUrl) normalized.push(item);
    }
  }
  return normalized;
}

async function searchGlobalCatalog(
  query,
  { markets = ["IN", "US"], limit = 50, baseUrl, fetchImpl = fetch } = {}
) {
  const results = await Promise.allSettled(markets.map(async (market) => {
    const payload = await callMcp({
      endpoint: GLOBAL_CATALOG_ENDPOINT,
      toolName: "search_catalog",
      arguments: {
        catalog: {
          query,
          view: "offer",
          context: {
            address_country: market,
            currency: market === "US" ? "USD" : "INR",
          },
          filters: {
            available: true,
            ships_to: { country: market },
          },
          pagination: { limit: Math.min(Math.max(Number(limit) || 50, 1), 50) },
        },
      },
      baseUrl,
      fetchImpl,
    });
    return {
      market,
      products: normalizeGlobalProducts(payload, market, query),
      pagination: payload?.pagination || null,
    };
  }));
  return {
    products: mergeProducts(results.flatMap((entry) =>
      entry.status === "fulfilled" ? entry.value.products : []
    )),
    markets: results.map((entry, index) => ({
      market: markets[index],
      status: entry.status === "fulfilled" ? "ok" : "unavailable",
      resultCount: entry.status === "fulfilled" ? entry.value.products.length : 0,
      pagination: entry.status === "fulfilled" ? entry.value.pagination : null,
      ...(entry.status === "rejected"
        ? { error: String(entry.reason?.message || entry.reason) }
        : {}),
    })),
  };
}

function searchWords(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !SEARCH_STOP_WORDS.has(word));
}

function relevantProduct(query, product, variant, optionText, matchMode = "all") {
  const wanted = [...new Set(searchWords(query))];
  if (!wanted.length) return true;
  const available = new Set(searchWords([
    product?.title,
    product?.description,
    product?.product_type,
    product?.vendor,
    variant?.title,
    optionText,
  ].filter(Boolean).join(" ")));
  return matchMode === "any"
    ? wanted.some((word) => available.has(word))
    : wanted.every((word) => available.has(word));
}

function normalizeProducts(selected, payload, query, matchMode = "all") {
  const products = Array.isArray(payload?.products) ? payload.products : [];
  const normalized = [];
  for (const product of products) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    for (const variant of variants) {
      const minorAmount = Number(variant?.price?.amount);
      if (!Number.isFinite(minorAmount) || minorAmount < 0 || !variant?.id) continue;
      const available = variant?.availability?.available !== false;
      const optionText = (variant.options || [])
        .map((option) => option?.label)
        .filter(Boolean)
        .join(" · ");
      if (!relevantProduct(query, product, variant, optionText, matchMode)) continue;
      const item = {
        merchant: selected.slug,
        merchantName: selected.name,
        market: selected.market,
        productName: String(product?.title || "Product"),
        variantName: String(variant?.title || optionText || "Default"),
        optionText: optionText || null,
        price: minorAmount / 100,
        priceMinor: minorAmount,
        currency: String(variant?.price?.currency || "INR"),
        available,
        imageUrl: firstImage(variant, product),
        productUrl: /^https:\/\//.test(String(product?.url || ""))
          ? String(product.url)
          : null,
      };
      item.selectionToken = signSelection({
        merchant: item.merchant,
        variantId: String(variant.id),
        productName: item.productName,
        variantName: item.variantName,
        priceMinor: item.priceMinor,
        currency: item.currency,
      });
      normalized.push(item);
    }
  }
  return normalized.filter((product) => Boolean(product.imageUrl));
}

async function searchMerchant(
  slug,
  query,
  {
    limit,
    baseUrl,
    relevanceQuery = query,
    matchMode = "all",
    fetchImpl = fetch,
  } = {}
) {
  const selected = await discover(slug, fetchImpl);
  if (!selected.catalogSearch) {
    throw httpError(
      422,
      `${selected.name} does not advertise UCP catalog search in its current profile`
    );
  }
  if (selected.transport !== "mcp") {
    throw httpError(
      422,
      `${selected.name} advertises checkout but no MCP catalog-search transport`
    );
  }
  const requestedLimit = Math.min(
    Math.max(Number(limit) || DEFAULT_PAGE_SIZE, 1),
    MAX_RESULTS_PER_MERCHANT
  );
  const payload = await callMcp({
    endpoint: selected.endpoint,
    toolName: "search_catalog",
    arguments: {
      catalog: {
        query,
        context: {
          address_country: selected.market,
          currency: selected.currency,
        },
        pagination: { limit: requestedLimit },
      },
    },
    baseUrl,
    fetchImpl,
  });
  return normalizeProducts(selected, payload, relevanceQuery, matchMode);
}

function mergeProducts(values) {
  const seen = new Set();
  return values.filter((product) => {
    const key = [
      product.merchant,
      product.productName,
      product.variantName,
      product.priceMinor,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchAll(
  query,
  { limit, offset, market, baseUrl, fetchImpl = fetch } = {}
) {
  const normalizedQuery = String(query || "").trim().slice(0, 300);
  if (!normalizedQuery) throw httpError(400, "query is required");
  const normalizedMarket = String(market || "").trim().toUpperCase();
  if (normalizedMarket && !["IN", "US"].includes(normalizedMarket)) {
    throw httpError(400, "market must be IN or US");
  }
  const merchantEntries = Object.values(MERCHANTS).filter(
    (entry) => !normalizedMarket || entry.market === normalizedMarket
  );
  const pageSize = Math.min(
    Math.max(Math.floor(Number(limit) || DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE
  );
  const pageOffset = Math.min(
    Math.max(Math.floor(Number(offset) || 0), 0),
    MAX_RESULTS_PER_MERCHANT
  );
  const merchantLimit = Math.min(
    Math.max(pageOffset + pageSize, pageSize),
    MAX_RESULTS_PER_MERCHANT
  );
  const requestedMarkets = normalizedMarket
    ? [normalizedMarket]
    : ["IN", "US"];
  const [globalSearch, settled] = await Promise.all([
    searchGlobalCatalog(normalizedQuery, {
      markets: requestedMarkets,
      limit: pageSize,
      baseUrl,
      fetchImpl,
    }),
    Promise.allSettled(
      merchantEntries.map((entry) =>
        searchMerchant(entry.slug, normalizedQuery, {
          limit: merchantLimit,
          baseUrl,
          fetchImpl,
        })
          .then((products) => ({ slug: entry.slug, products }))
      )
    ),
  ]);
  let products = [...globalSearch.products];
  const merchants = globalSearch.markets.map((entry) => ({
    merchant: `shopify_global_catalog_${entry.market.toLowerCase()}`,
    merchantName: `Shopify Global Catalog (${entry.market})`,
    currency: entry.market === "US" ? "USD" : "INR",
    ...entry,
  }));
  settled.forEach((entry, index) => {
    const selected = merchantEntries[index];
    if (entry.status === "fulfilled") {
      products.push(...entry.value.products);
      merchants.push({
        merchant: selected.slug,
        merchantName: selected.name,
        market: selected.market,
        currency: selected.currency,
        status: "ok",
        resultCount: entry.value.products.length,
      });
    } else {
      merchants.push({
        merchant: selected.slug,
        merchantName: selected.name,
        market: selected.market,
        currency: selected.currency,
        status: "unavailable",
        resultCount: 0,
        error: String(entry.reason?.message || entry.reason),
      });
    }
  });
  products = mergeProducts(products);
  let searchStrategy = "exact";
  let queriesTried = [normalizedQuery];
  const fallbackQueries = [...new Set(searchWords(normalizedQuery))];
  if (!products.length && fallbackQueries.length > 1) {
    searchStrategy = "broadened_terms";
    queriesTried = [normalizedQuery, ...fallbackQueries];
    const broadened = await Promise.allSettled(
      merchantEntries.map(async ({ slug }) => {
        const resultSets = await Promise.all(
          fallbackQueries.map((fallbackQuery) =>
            searchMerchant(slug, fallbackQuery, {
              limit: merchantLimit,
              baseUrl,
              relevanceQuery: normalizedQuery,
              matchMode: "any",
              fetchImpl,
            })
          )
        );
        return mergeProducts(resultSets.flat());
      })
    );
    products = mergeProducts(
      broadened.flatMap((entry) =>
        entry.status === "fulfilled" ? entry.value : []
      )
    );
    broadened.forEach((entry, index) => {
      if (entry.status !== "fulfilled") return;
      const merchantIndex = globalSearch.markets.length + index;
      merchants[merchantIndex] = {
        ...merchants[merchantIndex],
        status: "ok",
        resultCount: entry.value.length,
        broadened: true,
      };
    });
  }
  products.sort((left, right) => {
    const marketOrder = String(left.market).localeCompare(String(right.market));
    if (marketOrder) return marketOrder;
    const currencyOrder = String(left.currency).localeCompare(String(right.currency));
    if (currencyOrder) return currencyOrder;
    if (left.price !== right.price) return left.price - right.price;
    if (left.available !== right.available) return left.available ? -1 : 1;
    return left.merchantName.localeCompare(right.merchantName);
  });
  const pageProducts = products.slice(pageOffset, pageOffset + pageSize);
  const mayHaveMoreAtMerchant = merchants.some(
    (entry) => entry.status === "ok" && entry.resultCount >= merchantLimit
  );
  return {
    query: normalizedQuery,
    searchStrategy,
    queriesTried,
    source: "shopify_global_catalog_and_live_merchant_ucp",
    market: normalizedMarket || null,
    markets: [...new Set(merchantEntries.map((entry) => entry.market))],
    sort: "market_then_lowest_native_price",
    products: pageProducts,
    merchants,
    pagination: {
      offset: pageOffset,
      limit: pageSize,
      returned: pageProducts.length,
      nextOffset: pageOffset + pageProducts.length,
      hasMore:
        products.length > pageOffset + pageProducts.length
        || (pageProducts.length === pageSize && mayHaveMoreAtMerchant),
    },
  };
}

function checkoutLink(payload) {
  const candidate =
    payload?.continue_url ||
    payload?.checkout?.continue_url ||
    payload?.checkout?.url ||
    payload?.url;
  if (!/^https:\/\//.test(String(candidate || ""))) {
    throw httpError(502, "Merchant UCP created a checkout without a continue URL");
  }
  return String(candidate);
}

function checkoutTotals(payload) {
  const source = Array.isArray(payload?.totals)
    ? payload.totals
    : Array.isArray(payload?.checkout?.totals)
      ? payload.checkout.totals
      : [];
  return source
    .map((entry) => ({
      type: String(entry?.type || "").trim().toLowerCase(),
      label: String(entry?.display_text || entry?.label || entry?.type || "Amount").trim(),
      amountMinor: Math.round(Number(entry?.amount)),
      lines: (Array.isArray(entry?.lines) ? entry.lines : [])
        .map((line) => ({
          label: String(line?.display_text || line?.label || "Detail").trim(),
          amountMinor: Math.round(Number(line?.amount)),
        }))
        .filter((line) => Number.isFinite(line.amountMinor)),
    }))
    .filter((entry) => entry.type && Number.isFinite(entry.amountMinor));
}

function totalAmount(totals, type) {
  return totals
    .filter((entry) => entry.type === type)
    .reduce((sum, entry) => sum + entry.amountMinor, 0);
}

function checkoutPricing(payload, fallback) {
  const totals = checkoutTotals(payload);
  const total = [...totals].reverse().find((entry) => entry.type === "total");
  const fallbackMinor = Math.round(Number(fallback));
  const totalMinor = total && total.amountMinor > 0
    ? total.amountMinor
    : Number.isFinite(fallbackMinor) && fallbackMinor > 0
      ? fallbackMinor
      : null;
  if (!totalMinor) {
    throw httpError(502, "Merchant UCP did not return a positive checkout total");
  }
  const calculatedMinor = totals
    .filter((entry) => entry.type !== "total")
    .reduce((sum, entry) => sum + entry.amountMinor, 0);
  return {
    totals,
    subtotalMinor: totalAmount(totals, "subtotal"),
    shippingMinor: totalAmount(totals, "fulfillment"),
    taxMinor: totalAmount(totals, "tax"),
    feeMinor: totalAmount(totals, "fee"),
    discountMinor:
      totalAmount(totals, "discount") + totalAmount(totals, "items_discount"),
    totalMinor,
    calculatedMinor,
    reconciles: totals.some((entry) => entry.type === "total")
      ? calculatedMinor === totalMinor
      : null,
  };
}

function checkoutTotalMinor(payload, fallback) {
  return checkoutPricing(payload, fallback).totalMinor;
}

function checkoutInput({ selection, count, buyer, destination }) {
  const checkout = {
    currency: selection.currency || "INR",
    line_items: [{ item: { id: selection.variantId }, quantity: count }],
  };
  if (buyer && Object.keys(buyer).length) checkout.buyer = buyer;
  if (destination && Object.keys(destination).length) {
    checkout.context = {
      ...(destination.address_country
        ? { address_country: destination.address_country }
        : {}),
      ...(destination.address_region
        ? { address_region: destination.address_region }
        : {}),
      ...(destination.postal_code
        ? { postal_code: destination.postal_code }
        : {}),
      language: "en-IN",
      currency: selection.currency || "INR",
      intent: "Ship the selected item to the buyer's confirmed Tokko address",
    };
    checkout.fulfillment = {
      methods: [{
        type: "shipping",
        selected_destination_id: destination.id,
        destinations: [destination],
      }],
    };
  }
  return checkout;
}

function checkoutResource(payload) {
  return payload?.checkout && typeof payload.checkout === "object"
    ? payload.checkout
    : payload;
}

function fulfillmentOptions(payload) {
  const checkout = checkoutResource(payload);
  return (checkout?.fulfillment?.methods || []).flatMap((method) =>
    (method?.groups || []).flatMap((group) =>
      (group?.options || []).map((option) => {
        const totals = checkoutTotals({ totals: option?.totals || [] });
        return {
          methodId: method.id || null,
          methodType: method.type || null,
          groupId: group.id || null,
          id: option.id || null,
          title: String(option.title || "Shipping"),
          description: option.description ? String(option.description) : null,
          selected: group.selected_option_id === option.id,
          amountMinor:
            [...totals].reverse().find((entry) => entry.type === "total")?.amountMinor
            ?? totals.reduce((sum, entry) => sum + entry.amountMinor, 0),
          totals,
        };
      })
    )
  );
}

function cheapestOption(group) {
  return [...(group?.options || [])].sort((left, right) => {
    const price = (option) => {
      const totals = checkoutTotals({ totals: option?.totals || [] });
      return [...totals].reverse().find((entry) => entry.type === "total")?.amountMinor
        ?? totals.reduce((sum, entry) => sum + entry.amountMinor, 0);
    };
    return price(left) - price(right);
  })[0] || null;
}

function shippingSelectionUpdate(payload, destination) {
  const checkout = checkoutResource(payload);
  const methods = Array.isArray(checkout?.fulfillment?.methods)
    ? checkout.fulfillment.methods
    : [];
  let needsUpdate = false;
  const replacementMethods = methods.map((method) => {
    const selectedDestinationId = method.selected_destination_id
      || (method.type === "shipping" ? destination?.id : null);
    if (!method.selected_destination_id && selectedDestinationId) needsUpdate = true;
    const groups = (method.groups || []).map((group) => {
      let selectedOptionId = group.selected_option_id;
      if (!selectedOptionId) {
        selectedOptionId = cheapestOption(group)?.id || null;
        if (selectedOptionId) needsUpdate = true;
      }
      return {
        id: group.id,
        ...(selectedOptionId ? { selected_option_id: selectedOptionId } : {}),
      };
    });
    return {
      id: method.id,
      ...(method.type ? { type: method.type } : {}),
      ...(Array.isArray(method.line_item_ids)
        ? { line_item_ids: method.line_item_ids }
        : {}),
      ...(selectedDestinationId
        ? { selected_destination_id: selectedDestinationId }
        : {}),
      ...(Array.isArray(method.destinations) && method.destinations.length
        ? { destinations: method.destinations }
        : destination
          ? { destinations: [destination] }
          : {}),
      ...(groups.length ? { groups } : {}),
    };
  });
  if (!needsUpdate || !checkout?.id || !methods.length) return null;
  return {
    id: checkout.id,
    checkout: {
      ...(checkout.buyer ? { buyer: checkout.buyer } : {}),
      ...(checkout.context ? { context: checkout.context } : {}),
      ...(checkout.signals ? { signals: checkout.signals } : {}),
      ...(checkout.attribution ? { attribution: checkout.attribution } : {}),
      ...(checkout.payment ? { payment: checkout.payment } : {}),
      currency: checkout.currency,
      line_items: (checkout.line_items || []).map((lineItem) => ({
        ...(lineItem.id ? { id: lineItem.id } : {}),
        item: { id: lineItem?.item?.id },
        quantity: lineItem.quantity,
      })),
      fulfillment: { methods: replacementMethods },
    },
  };
}

async function createCheckout(
  selectionToken,
  {
    quantity = 1,
    baseUrl,
    buyer = null,
    destination = null,
    fetchImpl = fetch,
  } = {}
) {
  const selection = verifySelection(selectionToken);
  const selected = await discoverSelectionMerchant(selection, fetchImpl);
  if (!selected.checkout) {
    throw httpError(422, `${selected.name} does not advertise UCP checkout`);
  }
  if (selected.transport !== "mcp") {
    throw httpError(
      422,
      `${selected.name} does not expose MCP checkout creation to Tokko`
    );
  }
  const count = Math.min(Math.max(Math.floor(Number(quantity) || 1), 1), 20);
  let payload = await callMcp({
    endpoint: selected.endpoint,
    toolName: "create_checkout",
    arguments: {
      checkout: checkoutInput({ selection, count, buyer, destination }),
    },
    baseUrl,
    fetchImpl,
  });
  const selectionUpdate = shippingSelectionUpdate(payload, destination);
  if (selectionUpdate) {
    payload = await callMcp({
      endpoint: selected.endpoint,
      toolName: "update_checkout",
      arguments: selectionUpdate,
      baseUrl,
      fetchImpl,
    });
  }
  const continueUrl = checkoutLink(payload);
  const pricing = checkoutPricing(
    payload,
    Number(selection.priceMinor || 0) * count
  );
  const checkout = checkoutResource(payload);
  const selectedDestinationId = checkout?.fulfillment?.methods
    ?.find((method) => method?.type === "shipping")?.selected_destination_id || null;
  const shippingOptions = fulfillmentOptions(payload);
  return {
    merchant: selected.slug,
    merchantName: selected.name,
    merchantUrl: selected.origin,
    productName: selection.productName,
    variantName: selection.variantName,
    variantId: selection.variantId,
    quantity: count,
    market: selection.deliveryMarket || selected.market,
    currency: String(checkout?.currency || selection.currency || "INR").toUpperCase(),
    quotedUnitPrice: Number(selection.priceMinor || 0) / 100,
    ...pricing,
    totalAmount: (pricing.totalMinor / 100).toFixed(2),
    shippingOptions,
    shippingQuoted: pricing.totals.some((entry) => entry.type === "fulfillment"),
    destinationSelected: Boolean(
      destination?.id && selectedDestinationId === destination.id
    ),
    phoneAccepted: Boolean(
      destination?.phone_number && (checkout?.fulfillment?.methods || [])
        .flatMap((method) => method?.destinations || [])
        .some((entry) => entry?.phone_number === destination.phone_number)
    ),
    checkoutId: checkout?.id || null,
    status: checkout?.status || "incomplete",
    checkoutUrl: continueUrl,
    continueUrl,
    paymentHandlers: Object.keys(
      payload?.ucp?.payment_handlers || payload?.checkout?.ucp?.payment_handlers || {}
    ),
  };
}

async function status(fetchImpl = fetch) {
  return Promise.all(
    Object.keys(MERCHANTS).map(async (slug) => {
      try {
        const selected = await discover(slug, fetchImpl);
        return {
          merchant: slug,
          merchantName: selected.name,
          market: selected.market,
          catalogSearch: selected.catalogSearch,
          checkout: selected.checkout,
          fulfillment: capability(
            selected.profile,
            "dev.ucp.shopping.fulfillment"
          ),
          transport: selected.transport,
          endpoint: selected.endpoint,
        };
      } catch (error) {
        return {
          merchant: slug,
          merchantName: MERCHANTS[slug].name,
          market: MERCHANTS[slug].market,
          currency: MERCHANTS[slug].currency,
          catalogSearch: false,
          checkout: false,
          fulfillment: false,
          error: String(error.message || error),
        };
      }
    })
  );
}

module.exports = {
  MERCHANTS,
  UCP_VERSION,
  agentProfile,
  callMcp,
  checkoutTotalMinor,
  checkoutTotals,
  createCheckout,
  discover,
  searchAll,
  searchGlobalCatalog,
  searchMerchant,
  status,
  relevantProduct,
  verifySelection,
};
