const test = require("node:test");
const assert = require("node:assert/strict");
const { callTool } = require("../lib/mcp.js");

test(
  "callTool preserves MCP structured content including product images",
  { concurrency: false },
  async () => {
    const originalFetch = global.fetch;
    try {
      global.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        assert.equal(request.params.name, "search_products");
        assert.deepEqual(request.params.arguments, {
          query: "milk",
          pageNumber: 1,
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: "Found 1 product" }],
              structuredContent: {
                products: [
                  {
                    productVariantId: "product-1",
                    storeProductId: "store-product-1",
                    name: "Example Milk",
                    imageUrl: "https://cdn.example.test/milk.jpg",
                    price: 3000,
                  },
                ],
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      };

      const result = await callTool(
        "https://mcp.example.test/mcp",
        "access-token",
        "session-id",
        "search_products",
        { query: "milk", pageNumber: 1 }
      );

      assert.equal(result.mcpSessionId, "session-id");
      assert.deepEqual(result.data, {
        products: [
          {
            productVariantId: "product-1",
            storeProductId: "store-product-1",
            name: "Example Milk",
            imageUrl: "https://cdn.example.test/milk.jpg",
            price: 3000,
          },
        ],
      });
    } finally {
      global.fetch = originalFetch;
    }
  }
);

test(
  "callTool transparently replaces an expired MCP session",
  { concurrency: false },
  async () => {
    const originalFetch = global.fetch;
    const requests = [];
    try {
      global.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        requests.push({
          method: request.method,
          sessionId: options.headers["mcp-session-id"] || null,
        });
        if (
          request.method === "tools/call"
          && options.headers["mcp-session-id"] === "expired-session"
        ) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32001, message: "Session not found" },
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (request.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: {},
              },
            }),
            {
              headers: {
                "content-type": "application/json",
                "mcp-session-id": "fresh-session",
              },
            }
          );
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        assert.equal(request.method, "tools/call");
        assert.equal(options.headers["mcp-session-id"], "fresh-session");
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              structuredContent: { ok: true },
            },
          }),
          { headers: { "content-type": "application/json" } }
        );
      };

      const result = await callTool(
        "https://mcp.example.test/mcp",
        "access-token",
        "expired-session",
        "view_cart",
        {}
      );

      assert.deepEqual(result, {
        data: { ok: true },
        mcpSessionId: "fresh-session",
      });
      assert.deepEqual(requests, [
        { method: "tools/call", sessionId: "expired-session" },
        { method: "initialize", sessionId: null },
        { method: "notifications/initialized", sessionId: "fresh-session" },
        { method: "tools/call", sessionId: "fresh-session" },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  }
);
