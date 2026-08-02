const ENDPOINT = "https://docs.prava.space/mcp";

function parseResponse(text) {
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return events.at(-1) || {};
}

async function call(method, params, id, sessionId) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${method} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return {
    data: parseResponse(body),
    sessionId: response.headers.get("mcp-session-id") || sessionId,
  };
}

(async () => {
  const initialized = await call(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "tokko-prava-debug", version: "1.0.0" },
    },
    1
  );
  await call(
    "notifications/initialized",
    {},
    undefined,
    initialized.sessionId
  );
  const listed = await call("tools/list", {}, 2, initialized.sessionId);
  const requested = process.argv.slice(2).join(" ").trim();
  if (!requested) {
    console.log(JSON.stringify(listed.data.result?.tools || [], null, 2));
    return;
  }
  const filesystemQuery = requested.startsWith("fs:");
  const result = await call(
    "tools/call",
    {
      name: filesystemQuery
        ? "query_docs_filesystem_prava_payments_docs"
        : "search_prava_payments_docs",
      arguments: filesystemQuery
        ? { command: requested.slice(3).trim() }
        : { query: requested },
    },
    3,
    listed.sessionId
  );
  console.log(JSON.stringify(result.data.result || result.data, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
