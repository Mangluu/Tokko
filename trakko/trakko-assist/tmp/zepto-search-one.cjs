const fs = require("node:fs");
const { Pool } = require("pg");
const mcp = require("../lib/mcp.js");

function loadEnvironment(filename) {
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
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

(async () => {
  const envFile = process.argv[2];
  const email = String(process.argv[3] || "").trim().toLowerCase();
  const query = String(process.argv[4] || "milk").trim();
  const metadataOnly = process.argv.includes("--metadata-only");
  const multiple = process.argv.includes("--multiple");
  if (!envFile || !email || !query) {
    throw new Error("Usage: node tmp/zepto-search-one.cjs ENV_FILE EMAIL QUERY");
  }
  loadEnvironment(envFile);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const result = await pool.query(
      `SELECT platforms.mcp_url, tokens.access_token, tokens.mcp_session_id,
              tokens.token_expires_at
       FROM users
       JOIN user_platform_tokens AS tokens ON tokens.user_id = users.id
       JOIN platforms ON platforms.id = tokens.platform_id
       WHERE LOWER(users.email) = $1 AND platforms.slug = 'zepto'
       LIMIT 1`,
      [email]
    );
    if (!result.rows[0]) throw new Error("No connected Zepto account found");
    const row = result.rows[0];
    if (metadataOnly) {
      console.log(JSON.stringify({
        tokenExpiresAt: row.token_expires_at || null,
        hasPersistedMcpSession: Boolean(row.mcp_session_id),
      }, null, 2));
      return;
    }
    const searched = await mcp.callTool(
      row.mcp_url,
      row.access_token,
      row.mcp_session_id,
      multiple ? "search_multiple_products" : "search_products",
      multiple
        ? { queries: [query], pageNumber: 0 }
        : { query, pageNumber: 0 }
    );
    const data = searched.data;
    const section = multiple && Array.isArray(data?.sections)
      ? data.sections[0]
      : data;
    const products = Array.isArray(section?.products) ? section.products : [];
    console.log(JSON.stringify({
      query,
      tokenExpiresAt: row.token_expires_at || null,
      tool: multiple ? "search_multiple_products" : "search_products",
      totalCount: Number(section?.totalCount || products.length || 0),
      products: products.slice(0, 10).map((product) => ({
        name: product.name || product.productName || product.title || null,
        price: product.sellingPrice || product.price || product.mrp || null,
      })),
      rawWhenEmpty: products.length === 0
        ? JSON.stringify(data).slice(0, 1_000)
        : undefined,
      providerError:
        typeof data === "string" && /error|failed|too many requests/i.test(data)
          ? data
          : typeof section?.error === "string"
            ? section.error
          : null,
    }, null, 2));
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
