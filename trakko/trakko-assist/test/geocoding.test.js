const test = require("node:test");
const assert = require("node:assert/strict");
const geocoding = require("../lib/geocoding.js");

test("coordinatePair accepts real coordinates and rejects placeholders", () => {
  assert.deepEqual(geocoding.coordinatePair("22.5726", "88.3639"), {
    latitude: 22.5726,
    longitude: 88.3639,
  });
  assert.equal(geocoding.coordinatePair(0, 0), null);
  assert.equal(geocoding.coordinatePair(91, 88), null);
});

test("geocodeArea sends only the area query and caches the result", async () => {
  const previousUrl = process.env.ADDRESS_GEOCODING_URL;
  process.env.ADDRESS_GEOCODING_URL =
    "https://geocoder.example.test/search";
  const writes = [];
  const cache = {
    async getAddressGeocode() {
      return null;
    },
    async saveAddressGeocode(value) {
      writes.push(value);
    },
  };
  let requestedUrl;
  try {
    const result = await geocoding.geocodeArea(
      "Ballygunge, Kolkata, West Bengal",
      {
        cache,
        async fetchImpl(url) {
          requestedUrl = new URL(url);
          return {
            ok: true,
            async json() {
              return [{ lat: "22.5280", lon: "88.3653" }];
            },
          };
        },
      }
    );
    assert.deepEqual(result, {
      latitude: 22.528,
      longitude: 88.3653,
      source: "area_lookup",
    });
    assert.equal(
      requestedUrl.searchParams.get("q"),
      "Ballygunge, Kolkata, West Bengal, India"
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].queryText, "Ballygunge, Kolkata, West Bengal");
  } finally {
    if (previousUrl === undefined) {
      delete process.env.ADDRESS_GEOCODING_URL;
    } else {
      process.env.ADDRESS_GEOCODING_URL = previousUrl;
    }
  }
});
