const suppliedArgs = process.argv.slice(2);
const profileArgument = suppliedArgs.find((value) => value.startsWith('--profile='));
const endpoints = suppliedArgs.filter((value) => !value.startsWith('--profile='));
const agentProfile = profileArgument?.slice('--profile='.length) || process.env.UCP_AGENT_PROFILE
  || 'https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json';

function headers(sessionId) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'UCP-Agent': `profile="${agentProfile}"`,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

async function parse(response) {
  const text = await response.text();
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    return text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
      })
      .filter(Boolean)
      .pop() || {};
  }
  try { return JSON.parse(text); } catch { return { text }; }
}

async function rpc(endpoint, method, params, sessionId) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id') || sessionId,
    data: await parse(response),
  };
}

(async () => {
  for (const endpoint of endpoints) {
    const searched = await rpc(endpoint, 'tools/call', {
      name: 'search_catalog',
      arguments: {
        meta: { 'ucp-agent': { profile: agentProfile } },
        catalog: {
          query: process.env.UCP_QUERY || 'protein',
          context: { address_country: 'IN', currency: 'INR' },
          pagination: { limit: 5 },
        },
      },
    });
    process.stdout.write(`${JSON.stringify({ endpoint, searched }, null, 2)}\n`);
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
