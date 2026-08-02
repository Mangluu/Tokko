const fs = require("node:fs");
const { Pool } = require("pg");
const mcp = require("../lib/mcp.js");

function loadEnvironment(filename) {
  const source = fs.readFileSync(filename, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    process.env[match[1]] = value;
  }
}

function safeShape(value, depth = 0) {
  if (depth > 7) return "<depth-limit>";
  if (typeof value === "string") {
    return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => safeShape(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        safeShape(entry, depth + 1),
      ])
    );
  }
  return value;
}

(async () => {
  const envFile = process.argv[2];
  const email = String(
    process.argv[3] || "islamnilufa04@gmail.com"
  ).toLowerCase();
  const schemaOnly = process.argv.includes("--schema-only");
  const allTools = process.argv.includes("--all-tools");
  const addressesOnly = process.argv.includes("--addresses-only");
  const searchFlow = process.argv.includes("--search-flow");
  const singlesFlow = process.argv.includes("--singles");
  const storeRoleIndex = process.argv.indexOf("--store-role");
  const storeRole =
    storeRoleIndex >= 0
      ? String(process.argv[storeRoleIndex + 1] || "primary").toLowerCase()
      : "primary";
  const singleSearchIndex = process.argv.indexOf("--single-search");
  const singleSearchQuery =
    singleSearchIndex >= 0 ? String(process.argv[singleSearchIndex + 1] || "") : "";
  const selectAddressIndex = process.argv.indexOf("--select-address");
  const selectAddressId =
    selectAddressIndex >= 0 ? String(process.argv[selectAddressIndex + 1] || "") : "";
  loadEnvironment(envFile);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const result = await pool.query(
      `SELECT users.id AS user_id, platforms.mcp_url,
              tokens.access_token, tokens.mcp_session_id
       FROM users
       JOIN user_platform_tokens AS tokens ON tokens.user_id = users.id
       JOIN platforms ON platforms.id = tokens.platform_id
       WHERE LOWER(users.email) = $1 AND platforms.slug = 'zepto'
       LIMIT 1`,
      [email]
    );
    if (!result.rows[0]) throw new Error("No connected Zepto account found");
    const row = result.rows[0];
    const listed = await mcp.listTools(
      row.mcp_url,
      row.access_token,
      row.mcp_session_id
    );
    const wanted = new Set([
      "list_saved_addresses",
      "get_location_serviceability",
      "select_store",
      "update_drop_zone",
      "get_past_order_items",
      "search_products",
      "search_multiple_products",
      "view_cart",
      "add_saved_address",
      "select_saved_address",
      "create_order",
      "create_online_payment_order",
      "check_payment_status",
      "list_order_history",
      "get_order_detail",
      "track_order",
      "cancel_order",
    ]);
    const tools = listed.tools
      .filter((tool) => allTools || wanted.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }));
    if (schemaOnly) {
      console.log(JSON.stringify({ tools }, null, 2));
      return;
    }
    const addresses = await mcp.callTool(
      row.mcp_url,
      row.access_token,
      listed.mcpSessionId,
      "list_saved_addresses",
      {}
    );
    if (addressesOnly) {
      console.log(JSON.stringify({
        addresses: safeShape(addresses.data),
      }, null, 2));
      return;
    }
    if (selectAddressId) {
      const selected = await mcp.callTool(
        row.mcp_url,
        row.access_token,
        addresses.mcpSessionId,
        "select_saved_address",
        { addressId: selectAddressId }
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      const latitude = Number(
        selected.data?.coordinates?.latitude ?? selected.data?.address?.latitude
      );
      const longitude = Number(
        selected.data?.coordinates?.longitude ?? selected.data?.address?.longitude
      );
      const serviceability =
        Number.isFinite(latitude) && Number.isFinite(longitude)
          ? await mcp.callTool(
              row.mcp_url,
              row.access_token,
              selected.mcpSessionId,
              "get_location_serviceability",
              { latitude, longitude }
            )
          : null;
      await new Promise((resolve) => setTimeout(resolve, 700));
      const rolePattern = new RegExp(
        `\\b${storeRole}\\s+store\\s+id\\s*:\\s*([a-z0-9-]+)`,
        "i"
      );
      const serviceabilityText = String(serviceability?.data || "");
      const storeId = String(
        serviceabilityText.match(rolePattern)?.[1] || selected.data?.storeId || ""
      ).trim();
      const store = storeId
        ? await mcp.callTool(
            row.mcp_url,
            row.access_token,
            serviceability?.mcpSessionId || selected.mcpSessionId,
            "select_store",
            { storeId, latitude, longitude }
          )
        : null;
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (singleSearchQuery) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const single = await mcp.callTool(
          row.mcp_url,
          row.access_token,
          store?.mcpSessionId || serviceability?.mcpSessionId || selected.mcpSessionId,
          "search_products",
          { query: singleSearchQuery, pageNumber: 0 }
        );
        console.log(JSON.stringify({
          selected: safeShape(selected.data),
          serviceability: safeShape(serviceability?.data),
          store: safeShape(store?.data),
          single: {
            query: single.data?.query || singleSearchQuery,
            totalCount: single.data?.totalCount,
            examples: (single.data?.products || []).slice(0, 10).map((product) =>
              product.name
            ),
            raw: Array.isArray(single.data?.products)
              ? undefined
              : safeShape(single.data),
          },
        }, null, 2));
        return;
      }
      const past = searchFlow
        ? await mcp.callTool(
            row.mcp_url,
            row.access_token,
            store?.mcpSessionId || serviceability?.mcpSessionId || selected.mcpSessionId,
            "get_past_order_items",
            {}
          )
        : null;
      if (searchFlow) await new Promise((resolve) => setTimeout(resolve, 700));
      const pastNames = typeof past?.data === "string"
        ? [...past.data.matchAll(
            /^\s*\d+[.)]\s+(.+?)\s+\(ordered\s+in\s+\d+\s+orders?\)\s*$/gim
          )].map((match) => match[1].trim())
        : [];
      const preferredQuery = (query) =>
        pastNames.find((name) =>
          new RegExp(`\\b${query}\\b`, "i").test(name)
        ) || query;
      const searched = searchFlow
        ? await mcp.callTool(
            row.mcp_url,
            row.access_token,
            past?.mcpSessionId || store?.mcpSessionId || selected.mcpSessionId,
            "search_multiple_products",
            {
              queries: ["milk", "ginger", "garlic"].map(preferredQuery),
              pageNumber: 0,
            }
          )
        : null;
      const singles = [];
      if (searchFlow && singlesFlow) {
        let activeSessionId = searched?.mcpSessionId || past?.mcpSessionId;
        for (const query of ["milk", "ginger", "garlic"]) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          const single = await mcp.callTool(
            row.mcp_url,
            row.access_token,
            activeSessionId,
            "search_products",
            { query, pageNumber: 0 }
          );
          activeSessionId = single.mcpSessionId;
          singles.push({
            query,
            totalCount: single.data?.totalCount,
            examples: (single.data?.products || []).slice(0, 5).map((product) =>
              product.name
            ),
            raw: Array.isArray(single.data?.products)
              ? undefined
              : safeShape(single.data),
          });
        }
      }
      console.log(JSON.stringify({
        selected: safeShape(selected.data),
        serviceability: safeShape(serviceability?.data),
        store: safeShape(store?.data),
        past: searchFlow ? safeShape(past?.data) : undefined,
        search: searched
          ? (searched.data?.sections || []).map((section) => ({
              query: section.query,
              totalCount: section.totalCount,
              examples: (section.products || []).slice(0, 3).map((product) =>
                product.name
              ),
              error: section.error || section.message || null,
            }))
          : undefined,
        singles: searchFlow ? singles : undefined,
      }, null, 2));
      return;
    }
    if (searchFlow) {
      const past = await mcp.callTool(
        row.mcp_url,
        row.access_token,
        addresses.mcpSessionId,
        "get_past_order_items",
        {}
      );
      const multiple = await mcp.callTool(
        row.mcp_url,
        row.access_token,
        past.mcpSessionId,
        "search_multiple_products",
        { queries: ["milk", "ginger", "garlic"], pageNumber: 0 }
      );
      const shaak = await mcp.callTool(
        row.mcp_url,
        row.access_token,
        multiple.mcpSessionId,
        "search_products",
        { query: "leafy greens spinach saag", pageNumber: 0 }
      );
      console.log(JSON.stringify({
        pastOrderItemCount:
          past.data?.items?.length ||
          past.data?.products?.length ||
          past.data?.pastOrderItems?.length ||
          null,
        multiple: (multiple.data?.sections || []).map((section) => ({
          query: section.query,
          totalCount: section.totalCount,
          examples: (section.products || []).slice(0, 3).map((product) =>
            product.name
          ),
          error: section.error || section.message || null,
        })),
        multipleRaw:
          Array.isArray(multiple.data?.sections)
            ? undefined
            : safeShape(multiple.data),
        shaak: {
          query: shaak.data?.query,
          totalCount: shaak.data?.totalCount,
          examples: (shaak.data?.products || []).slice(0, 5).map((product) =>
            product.name
          ),
          raw:
            Array.isArray(shaak.data?.products)
              ? undefined
              : safeShape(shaak.data),
        },
      }, null, 2));
      return;
    }
    if (singleSearchQuery) {
      const past = await mcp.callTool(
        row.mcp_url,
        row.access_token,
        addresses.mcpSessionId,
        "get_past_order_items",
        {}
      );
      const searched = await mcp.callTool(
        row.mcp_url,
        row.access_token,
        past.mcpSessionId,
        "search_products",
        { query: singleSearchQuery, pageNumber: 0 }
      );
      console.log(JSON.stringify({
        query: searched.data?.query || singleSearchQuery,
        totalCount: searched.data?.totalCount,
        examples: (searched.data?.products || []).slice(0, 5).map((product) =>
          product.name
        ),
        raw:
          Array.isArray(searched.data?.products)
            ? undefined
            : safeShape(searched.data),
      }, null, 2));
      return;
    }
    const firstAddressId =
      addresses.data?.addresses?.find((address) => address?.id)?.id;
    const firstAddress = addresses.data?.addresses?.find((address) =>
      Number.isFinite(address?.latitude) && Number.isFinite(address?.longitude)
    );
    const serviceability = firstAddress
      ? await mcp.callTool(
          row.mcp_url,
          row.access_token,
          addresses.mcpSessionId,
          "get_location_serviceability",
          {
            latitude: firstAddress.latitude,
            longitude: firstAddress.longitude,
          }
        )
      : null;
    const cart = await mcp.callTool(
      row.mcp_url,
      row.access_token,
      addresses.mcpSessionId,
      "view_cart",
      {}
    );
    let preview = null;
    if (firstAddressId) {
      await mcp.callTool(
        row.mcp_url,
        row.access_token,
        addresses.mcpSessionId,
        "select_saved_address",
        { addressId: firstAddressId }
      );
      preview = await mcp.callTool(
        row.mcp_url,
        row.access_token,
        addresses.mcpSessionId,
        "create_online_payment_order",
        {
          confirmOrder: false,
          riderTip: 0,
          userAddressId: firstAddressId,
          useZeptoCash: false,
        }
      );
    }
    const history = await mcp.callTool(
      row.mcp_url,
      row.access_token,
      addresses.mcpSessionId,
      "list_order_history",
      { limit: 10, pageNumber: 1 }
    );
    const firstOrderId = history.data?.orders?.find((order) => order?.id)?.id;
    const orderDetail = firstOrderId
      ? await mcp.callTool(
          row.mcp_url,
          row.access_token,
          history.mcpSessionId,
          "get_order_detail",
          { orderId: firstOrderId }
        )
      : null;
    console.log(JSON.stringify({
      userId: Number(row.user_id),
      tools,
      addresses: safeShape(addresses.data),
      serviceability: safeShape(serviceability?.data),
      cart: safeShape(cart.data),
      preview: safeShape(preview?.data),
      history: safeShape(history.data),
      orderDetail: safeShape(orderDetail?.data),
    }, null, 2));
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
