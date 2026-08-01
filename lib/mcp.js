// Per-user, per-platform MCP client — no globals

function mcpHeaders(accessToken, mcpSessionId) {
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  if (mcpSessionId) h["mcp-session-id"] = mcpSessionId;
  return h;
}

async function parseMcpResponse(res) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();

  if (ct.includes("text/event-stream")) {
    const messages = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try { messages.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
    return messages.filter((m) => m.id !== undefined).pop() || messages.pop() || {};
  }

  try { return JSON.parse(text); }
  catch { throw new Error(`Unexpected MCP response: ${text.slice(0, 200)}`); }
}

function isExpiredSessionError(error) {
  return /\b(?:session not found|invalid session|session expired)\b/i.test(
    String(error?.message || error || "")
  );
}

async function mcpInitialize(mcpUrl, accessToken, existingSessionId) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: mcpHeaders(accessToken, existingSessionId),
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tokko", version: "1.0.0" } },
    }),
  });

  const sid = res.headers.get("mcp-session-id") || existingSessionId;
  const data = await parseMcpResponse(res);
  if (data.error) throw new Error(data.error.error_description || data.error.message || JSON.stringify(data.error));

  // Send initialized notification
  await fetch(mcpUrl, {
    method: "POST",
    headers: mcpHeaders(accessToken, sid),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  return { mcpSessionId: sid };
}

async function callTool(mcpUrl, accessToken, mcpSessionId, toolName, args = {}) {
  if (!accessToken) throw new Error("Not authenticated with this platform");

  let sessionId = mcpSessionId;
  if (!sessionId) {
    const init = await mcpInitialize(mcpUrl, accessToken, null);
    sessionId = init.mcpSessionId;
  }

  const execute = async (activeSessionId) => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: mcpHeaders(accessToken, activeSessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: args } }),
    });

    const data = await parseMcpResponse(res);
    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    const result = data.result;
    if (
      result?.structuredContent &&
      typeof result.structuredContent === "object"
    ) {
      return {
        data: result.structuredContent,
        mcpSessionId: activeSessionId,
      };
    }
    if (result?.content && Array.isArray(result.content)) {
      const joined = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      try { return { data: JSON.parse(joined), mcpSessionId: activeSessionId }; }
      catch { return { data: joined, mcpSessionId: activeSessionId }; }
    }
    return {
      data: result || data,
      mcpSessionId: activeSessionId,
    };
  };

  try {
    return await execute(sessionId);
  } catch (error) {
    if (!mcpSessionId || !isExpiredSessionError(error)) throw error;
    const initialized = await mcpInitialize(mcpUrl, accessToken, null);
    return execute(initialized.mcpSessionId);
  }
}

async function listTools(mcpUrl, accessToken, mcpSessionId) {
  if (!accessToken) throw new Error("Not authenticated with this platform");
  let sessionId = mcpSessionId;
  if (!sessionId) {
    const init = await mcpInitialize(mcpUrl, accessToken, null);
    sessionId = init.mcpSessionId;
  }
  const execute = async (activeSessionId) => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: mcpHeaders(accessToken, activeSessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/list",
        params: {},
      }),
    });
    const data = await parseMcpResponse(res);
    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    return {
      tools: data.result?.tools || [],
      mcpSessionId: activeSessionId,
    };
  };

  try {
    return await execute(sessionId);
  } catch (error) {
    if (!mcpSessionId || !isExpiredSessionError(error)) throw error;
    const initialized = await mcpInitialize(mcpUrl, accessToken, null);
    return execute(initialized.mcpSessionId);
  }
}

module.exports = { mcpInitialize, callTool, listTools };
