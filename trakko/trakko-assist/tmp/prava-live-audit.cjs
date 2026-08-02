const fs = require("node:fs");
const { Pool } = require("pg");

function loadEnvironment(filename) {
  const source = fs.readFileSync(filename, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    }
    process.env[match[1]] = value;
  }
}

function apiBaseUrl() {
  const configured = String(process.env.PRAVA_API_BASE_URL || "")
    .trim().replace(/\/+$/, "");
  if (configured) return configured;
  return /_live_/.test(process.env.PRAVA_SECRET_KEY || "")
    ? "https://api.prava.space"
    : "https://sandbox.api.prava.space";
}

function rows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.mandates)) return value.mandates;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.data?.mandates)) return value.data.mandates;
  return [];
}

function suffix(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 5)}…${text.slice(-6)}` : null;
}

async function pravaList(customerId, standingOnly) {
  const url = new URL(`${apiBaseUrl()}/v1/mandates`);
  url.searchParams.set("customer_id", customerId);
  if (standingOnly !== null) {
    url.searchParams.set("standing_only", String(standingOnly));
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.PRAVA_SECRET_KEY}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  const mandates = rows(body);
  return {
    status: response.status,
    responseId: response.headers.get("x-response-id"),
    topLevelKeys: Object.keys(body || {}),
    count: mandates.length,
    records: mandates.slice(0, 10).map((mandate) => ({
      id: suffix(mandate.id || mandate.mandateId || mandate.mandate_id),
      status: mandate.status || null,
      state: mandate.state || null,
      amount:
        mandate.remaining ?? mandate.remainingAmount ?? mandate.remaining_amount
        ?? mandate.approvedAmount ?? mandate.approved_amount ?? mandate.amount ?? null,
      currency: mandate.currency || null,
      customerId: suffix(
        mandate.customerId || mandate.customer_id || mandate.externalUserId
        || mandate.external_user_id
      ),
      keys: Object.keys(mandate || {}),
    })),
    error: body?.error || null,
  };
}

(async () => {
  const envFile = process.argv[2];
  if (envFile) loadEnvironment(envFile);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const result = await pool.query(`
      SELECT DISTINCT source.provider_customer_id, source.user_id, users.email,
             source.source
      FROM (
        SELECT provider_customer_id, user_id, 'current'::text AS source
          FROM payment_customers WHERE provider = 'prava'
        UNION ALL
        SELECT provider_customer_id, user_id, 'callback'::text AS source
          FROM prava_mandate_callbacks
        UNION ALL
        SELECT provider_customer_id, user_id, 'snapshot'::text AS source
          FROM prava_mandate_snapshots
      ) AS source
      LEFT JOIN users ON users.id = source.user_id
      ORDER BY source.user_id, source.source
    `);
    const customerIds = [...new Set(
      result.rows.map((row) => row.provider_customer_id).filter(Boolean)
    )];
    const identities = result.rows.map((row) => ({
      userId: Number(row.user_id),
      emailDomain: String(row.email || "").split("@")[1] || null,
      source: row.source,
      customerId: suffix(row.provider_customer_id),
    }));
    const audits = [];
    for (const customerId of customerIds) {
      audits.push({
        customerId: suffix(customerId),
        standing: await pravaList(customerId, true),
        all: await pravaList(customerId, null),
      });
    }
    console.log(JSON.stringify({
      environment: /_live_/.test(process.env.PRAVA_SECRET_KEY || "")
        ? "production" : "sandbox",
      identities,
      audits,
    }, null, 2));
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
});
