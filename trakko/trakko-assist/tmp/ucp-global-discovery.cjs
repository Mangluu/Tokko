const CANDIDATES = [
  { market: 'IN', name: 'Himalaya Wellness India', origin: 'https://himalayawellness.in' },
  { market: 'IN', name: 'ZanduCare', origin: 'https://zanducare.com' },
  { market: 'IN', name: 'Organic India', origin: 'https://organicindia.com' },
  { market: 'IN', name: 'Kapiva', origin: 'https://kapiva.in' },
  { market: 'IN', name: 'OZiva', origin: 'https://www.oziva.in' },
  { market: 'IN', name: 'Setu Nutrition', origin: 'https://setu.in' },
  { market: 'IN', name: 'Wellbeing Nutrition', origin: 'https://wellbeingnutrition.com' },
  { market: 'IN', name: 'Dr. Ortho', origin: 'https://drorthooil.com' },
  { market: 'IN', name: 'YogaBar', origin: 'https://www.yogabars.in' },
  { market: 'IN', name: 'Mamaearth', origin: 'https://mamaearth.in' },
  { market: 'IN', name: 'Dot & Key', origin: 'https://www.dotandkey.com' },
  { market: 'IN', name: 'The Derma Co', origin: 'https://thedermaco.com' },
  { market: 'IN', name: 'HealthKart', origin: 'https://www.healthkart.com' },
  { market: 'IN', name: 'Nutrabay', origin: 'https://nutrabay.com' },
  { market: 'IN', name: 'Carbamide Forte', origin: 'https://mycf.in' },
  { market: 'US', name: 'Ritual', origin: 'https://ritual.com' },
  { market: 'US', name: 'Momentous', origin: 'https://www.livemomentous.com' },
  { market: 'US', name: 'Teami Blends', origin: 'https://www.teamiblends.com' },
  { market: 'US', name: 'Thorne', origin: 'https://www.thorne.com' },
  { market: 'US', name: 'Seed', origin: 'https://seed.com' },
  { market: 'US', name: 'HUM Nutrition', origin: 'https://www.humnutrition.com' },
  { market: 'US', name: 'Perelel', origin: 'https://perelelhealth.com' },
  { market: 'US', name: 'Needed', origin: 'https://thisisneeded.com' },
  { market: 'US', name: 'AG1', origin: 'https://drinkag1.com' },
  { market: 'US', name: 'The Vitamin Shoppe', origin: 'https://www.vitaminshoppe.com' },
  { market: 'US', name: 'GNC', origin: 'https://www.gnc.com' },
  { market: 'US', name: 'iHerb', origin: 'https://www.iherb.com' },
];

function capability(profile, name) {
  return Array.isArray(profile?.ucp?.capabilities?.[name]);
}

async function probe(candidate) {
  const url = `${candidate.origin}/.well-known/ucp`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Tokko-UCP-Audit/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('json')) {
      return { ...candidate, url, http: response.status, ucp: false };
    }
    const profile = await response.json();
    const services = Array.isArray(profile?.ucp?.services?.['dev.ucp.shopping'])
      ? profile.ucp.services['dev.ucp.shopping']
      : [];
    return {
      ...candidate,
      url,
      http: response.status,
      ucp: Boolean(profile?.ucp?.version),
      version: profile?.ucp?.version || null,
      transports: services.map((service) => ({
        transport: service.transport,
        endpoint: service.endpoint,
      })),
      catalogSearch: capability(profile, 'dev.ucp.shopping.catalog.search'),
      checkout: capability(profile, 'dev.ucp.shopping.checkout'),
      fulfillment: capability(profile, 'dev.ucp.shopping.fulfillment'),
      paymentHandlers: Object.keys(profile?.ucp?.payment_handlers || {}),
    };
  } catch (error) {
    return { ...candidate, url, ucp: false, error: error.message };
  }
}

(async () => {
  const results = [];
  for (let index = 0; index < CANDIDATES.length; index += 5) {
    results.push(...await Promise.all(CANDIDATES.slice(index, index + 5).map(probe)));
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
