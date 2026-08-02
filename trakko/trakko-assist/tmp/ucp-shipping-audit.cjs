const crypto = require('node:crypto');

const PROFILE = 'https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json';
const MERCHANTS = [
  ['IN', 'Kapiva', 'https://kapiva.in', 'ashwagandha'],
  ['IN', 'Himalaya Wellness India', 'https://himalayawellness.in', 'ashwagandha'],
  ['IN', 'ZanduCare', 'https://zanducare.com', 'honey'],
  ['IN', 'Organic India', 'https://organicindia.com', 'tea'],
  ['IN', 'OZiva', 'https://www.oziva.in', 'protein'],
  ['IN', 'Setu Nutrition', 'https://setu.in', 'vitamin'],
  ['IN', 'Wellbeing Nutrition', 'https://wellbeingnutrition.com', 'vitamin'],
  ['IN', 'Dr. Ortho', 'https://drorthooil.com', 'oil'],
  ['IN', 'YogaBar', 'https://www.yogabars.in', 'protein'],
  ['IN', 'Mamaearth', 'https://mamaearth.in', 'face wash'],
  ['IN', 'Dot & Key', 'https://www.dotandkey.com', 'sunscreen'],
  ['IN', 'The Derma Co', 'https://thedermaco.com', 'sunscreen'],
  ['IN', 'Carbamide Forte', 'https://mycf.in', 'vitamin'],
  ['US', 'Ritual', 'https://ritual.com', 'vitamin'],
  ['US', 'Momentous', 'https://www.livemomentous.com', 'protein'],
  ['US', 'Teami Blends', 'https://www.teamiblends.com', 'tea'],
  ['US', 'Perelel', 'https://perelelhealth.com', 'vitamin'],
  ['US', 'Needed', 'https://thisisneeded.com', 'prenatal'],
].map(([market, name, origin, query]) => ({ market, name, origin, query }));

function address(market) {
  if (market === 'US') {
    return {
      id: 'tokko_audit_us',
      first_name: 'Test',
      last_name: 'Buyer',
      street_address: '123 Main Street',
      extended_address: 'Apartment 4B',
      address_locality: 'New York',
      address_region: 'NY',
      postal_code: '10001',
      address_country: 'US',
      phone_number: '+12125550123',
    };
  }
  return {
    id: 'tokko_audit_in',
    first_name: 'Test',
    last_name: 'Buyer',
    street_address: '12 Park Street',
    extended_address: 'Apartment 3A',
    address_locality: 'Kolkata',
    address_region: 'West Bengal',
    postal_code: '700016',
    address_country: 'IN',
    phone_number: '+919876543210',
  };
}

function parseEventStream(text) {
  return String(text).split('\n').filter((line) => line.startsWith('data:')).map((line) => {
    try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
  }).filter(Boolean).pop();
}

function structured(result) {
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content || []) {
    if (item?.type !== 'text') continue;
    try { return JSON.parse(item.text); } catch { /* keep looking */ }
  }
  return result || {};
}

async function call(endpoint, name, args) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'UCP-Agent': `profile="${PROFILE}"`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
      params: { name, arguments: { ...args, meta: { 'ucp-agent': { profile: PROFILE } } } },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = (response.headers.get('content-type') || '').includes('text/event-stream')
      ? parseEventStream(text)
      : JSON.parse(text);
  } catch {
    throw new Error(`unreadable HTTP ${response.status}`);
  }
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
  }
  return structured(payload?.result || payload);
}

function totals(payload) {
  return (payload?.totals || []).map((line) => ({
    type: line.type,
    displayText: line.display_text || line.type,
    amountMinor: Number(line.amount),
  }));
}

function fulfillmentOptions(payload) {
  return (payload?.fulfillment?.methods || []).flatMap((method) =>
    (method.groups || []).flatMap((group) => (group.options || []).map((option) => ({
      method: method.type,
      groupId: group.id,
      selected: group.selected_option_id === option.id,
      id: option.id,
      title: option.title,
      totals: totals(option),
    })))
  );
}

function chosenVariant(payload) {
  for (const product of payload?.products || []) {
    for (const variant of product?.variants || []) {
      if (variant?.availability?.available !== false && variant?.id) {
        return { product: product.title, id: variant.id };
      }
    }
  }
  return null;
}

async function audit(merchant) {
  const discovery = await fetch(`${merchant.origin}/.well-known/ucp`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
  }).then((response) => response.json());
  const capabilities = discovery?.ucp?.capabilities || {};
  const discountCapability = capabilities['dev.ucp.shopping.discount'] || [];
  const checkoutCapability = capabilities['dev.ucp.shopping.checkout'] || [];
  const fulfillmentCapability = capabilities['dev.ucp.shopping.fulfillment'] || [];
  const catalogCapability = capabilities['dev.ucp.shopping.catalog.search'] || [];
  const services = discovery?.ucp?.services?.['dev.ucp.shopping'] || [];
  const service = services.find((candidate) => candidate.transport === 'mcp');
  const capabilitySummary = {
    checkoutAdvertised: checkoutCapability.length > 0,
    fulfillmentAdvertised: fulfillmentCapability.length > 0,
    discountAdvertised: discountCapability.length > 0,
    catalogSearchAdvertised: catalogCapability.length > 0,
    transports: services.map((candidate) => candidate.transport),
  };
  if (!service?.endpoint) {
    return {
      ...merchant,
      ...capabilitySummary,
      quoteAvailable: false,
      error: catalogCapability.length
        ? 'merchant did not advertise MCP transport'
        : 'merchant did not advertise catalog search; no current variant was available for a safe quote',
    };
  }
  const catalog = await call(service.endpoint, 'search_catalog', {
    catalog: {
      query: merchant.query,
      context: { address_country: merchant.market, currency: merchant.market === 'US' ? 'USD' : 'INR' },
      pagination: { limit: 20 },
    },
  });
  const variant = chosenVariant(catalog);
  if (!variant) throw new Error(`no available result for ${merchant.query}`);
  const destination = address(merchant.market);
  const checkout = await call(service.endpoint, 'create_checkout', {
    checkout: {
      currency: merchant.market === 'US' ? 'USD' : 'INR',
      buyer: {
        first_name: 'Test', last_name: 'Buyer',
        email: `checkout-audit-${merchant.market.toLowerCase()}@example.com`,
        phone_number: destination.phone_number,
      },
      context: {
        address_country: destination.address_country,
        address_region: destination.address_region,
        postal_code: destination.postal_code,
        language: merchant.market === 'US' ? 'en-US' : 'en-IN',
        currency: merchant.market === 'US' ? 'USD' : 'INR',
      },
      line_items: [{ item: { id: variant.id }, quantity: 1 }],
      fulfillment: {
        methods: [{
          type: 'shipping',
          selected_destination_id: destination.id,
          destinations: [destination],
        }],
      },
    },
  });
  const responseDestination = (checkout?.fulfillment?.methods || [])
    .flatMap((method) => method.destinations || [])[0] || {};
  const checkoutTotals = totals(checkout);
  const checkoutDiscounts = checkout?.discounts || null;
  const discountTotals = checkoutTotals.filter((line) =>
    line.type === 'discount' || line.type === 'items_discount'
  );
  return {
    ...merchant,
    ...capabilitySummary,
    quoteAvailable: true,
    product: variant.product,
    checkoutId: checkout.id,
    status: checkout.status,
    currency: checkout.currency,
    totals: checkoutTotals,
    taxReturned: checkoutTotals.some((line) => line.type === 'tax'),
    shippingReturned: checkoutTotals.some((line) => line.type === 'fulfillment'),
    discountTotalReturned: discountTotals.length > 0,
    discountMinor: discountTotals.reduce((sum, line) => sum + line.amountMinor, 0),
    discountsObjectReturned: Boolean(checkoutDiscounts),
    couponCodesReturned: Array.isArray(checkoutDiscounts?.codes)
      ? checkoutDiscounts.codes.filter(Boolean)
      : [],
    appliedOffers: Array.isArray(checkoutDiscounts?.applied)
      ? checkoutDiscounts.applied.map((discount) => ({
          title: discount.title || null,
          code: discount.code || null,
          automatic: discount.automatic === true,
          amountMinor: Number(discount.amount),
        }))
      : [],
    subtotalMinor: checkoutTotals.find((line) => line.type === 'subtotal')?.amountMinor ?? null,
    shippingMinor: checkoutTotals.filter((line) => line.type === 'fulfillment')
      .reduce((sum, line) => sum + line.amountMinor, 0),
    totalMinor: checkoutTotals.find((line) => line.type === 'total')?.amountMinor ?? null,
    fulfillmentOptions: fulfillmentOptions(checkout),
    destinationAccepted: {
      selected: (checkout?.fulfillment?.methods || [])[0]?.selected_destination_id || null,
      street: responseDestination.street_address || null,
      extended: responseDestination.extended_address || null,
      locality: responseDestination.address_locality || null,
      region: responseDestination.address_region || null,
      postalCode: responseDestination.postal_code || null,
      country: responseDestination.address_country || null,
      phone: responseDestination.phone_number || null,
    },
    messages: (checkout.messages || []).map((message) => ({
      code: message.code, severity: message.severity, content: message.content,
    })),
  };
}

(async () => {
  const filter = String(process.argv[2] || '').toLowerCase();
  const selected = MERCHANTS.filter((merchant) =>
    !filter || `${merchant.market} ${merchant.name} ${merchant.origin}`.toLowerCase().includes(filter)
  );
  const results = [];
  for (const merchant of selected) {
    try {
      results.push(await audit(merchant));
    } catch (error) {
      results.push({ ...merchant, error: error.message });
    }
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
