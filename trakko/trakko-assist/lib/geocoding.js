const crypto = require("node:crypto");
const db = require("./db.js");

const DEFAULT_GEOCODING_URL =
  "https://nominatim.openstreetmap.org/search";
const MINIMUM_PUBLIC_REQUEST_INTERVAL_MS = 1_100;

let lastPublicRequestAt = 0;

function normalizedArea(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function coordinatePair(latitude, longitude) {
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);
  if (
    !Number.isFinite(parsedLatitude) ||
    parsedLatitude < -90 ||
    parsedLatitude > 90 ||
    !Number.isFinite(parsedLongitude) ||
    parsedLongitude < -180 ||
    parsedLongitude > 180 ||
    (parsedLatitude === 0 && parsedLongitude === 0)
  ) {
    return null;
  }
  return {
    latitude: parsedLatitude,
    longitude: parsedLongitude,
  };
}

async function waitForPublicRateLimit(endpoint) {
  if (endpoint.origin !== "https://nominatim.openstreetmap.org") return;
  const delay =
    MINIMUM_PUBLIC_REQUEST_INTERVAL_MS - (Date.now() - lastPublicRequestAt);
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  lastPublicRequestAt = Date.now();
}

async function fetchAreaCoordinates(area, fetchImpl = fetch) {
  const baseUrl =
    process.env.ADDRESS_GEOCODING_URL || DEFAULT_GEOCODING_URL;
  const endpoint = new URL(baseUrl);
  endpoint.searchParams.set("q", `${area}, India`);
  endpoint.searchParams.set("format", "jsonv2");
  endpoint.searchParams.set("limit", "1");
  endpoint.searchParams.set("countrycodes", "in");
  await waitForPublicRateLimit(endpoint);
  const response = await fetchImpl(endpoint, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "en",
      "User-Agent":
        process.env.ADDRESS_GEOCODING_USER_AGENT ||
        `Tokko/1.0 (${process.env.BASE_URL || "https://zepto-shop.vercel.app"})`,
      Referer:
        process.env.BASE_URL || "https://zepto-shop.vercel.app",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw Object.assign(
      new Error("The address locator is temporarily unavailable"),
      { status: 503 }
    );
  }
  const results = await response.json();
  const first = Array.isArray(results) ? results[0] : null;
  return coordinatePair(first?.lat, first?.lon);
}

async function geocodeArea(value, options = {}) {
  const area = normalizedArea(value);
  if (area.length < 4) {
    throw Object.assign(
      new Error(
        "Enter a more complete area, city, and state, or provide optional coordinates"
      ),
      { status: 400 }
    );
  }
  const queryKey = crypto
    .createHash("sha256")
    .update(area.toLowerCase())
    .digest("hex");
  const cache = options.cache || db;
  const cached = await cache.getAddressGeocode(queryKey);
  const cachedCoordinates = cached
    ? coordinatePair(cached.latitude, cached.longitude)
    : null;
  if (cachedCoordinates) {
    return {
      ...cachedCoordinates,
      source: "area_cache",
    };
  }
  const coordinates = await fetchAreaCoordinates(
    area,
    options.fetchImpl || fetch
  );
  if (!coordinates) {
    throw Object.assign(
      new Error(
        "Tokko could not locate this area. Use the optional browser location button or enter coordinates."
      ),
      { status: 422 }
    );
  }
  await cache.saveAddressGeocode({
    queryKey,
    queryText: area,
    ...coordinates,
    provider: "nominatim",
  });
  return {
    ...coordinates,
    source: "area_lookup",
  };
}

module.exports = {
  coordinatePair,
  fetchAreaCoordinates,
  geocodeArea,
  normalizedArea,
};
