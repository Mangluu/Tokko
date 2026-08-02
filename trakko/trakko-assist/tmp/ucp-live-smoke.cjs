process.env.UCP_SELECTION_SECRET ||= 'local-live-smoke-only';
process.env.UCP_AGENT_PROFILE_URL = process.argv[3]
  || process.env.UCP_AGENT_PROFILE_URL
  || 'https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json';

const ucp = require('../lib/ucp.js');

(async () => {
  const found = await ucp.searchAll(process.argv[2] || 'ashwagandha', {
    limit: 3,
  });
  const selected = found.products.find((product) => product.available);
  const checkout = selected
    ? await ucp.createCheckout(selected.selectionToken)
    : null;
  process.stdout.write(`${JSON.stringify({
    merchants: found.merchants,
    firstFive: found.products.slice(0, 5).map(({ selectionToken, ...product }) => product),
    checkout,
  }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
