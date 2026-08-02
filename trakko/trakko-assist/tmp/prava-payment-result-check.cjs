const fs = require("node:fs");
const { Pool } = require("pg");

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

function apiBaseUrl() {
  const override = String(process.env.PRAVA_API_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (override) return override;
  return /_live_/.test(process.env.PRAVA_SECRET_KEY || "")
    ? "https://api.prava.space"
    : "https://sandbox.api.prava.space";
}

(async () => {
  const environmentFile = process.argv[2];
  if (environmentFile && environmentFile !== "-") {
    loadEnvironment(environmentFile);
  }
  const email = String(
    process.argv[3] || "islamnilufa04@gmail.com"
  ).trim().toLowerCase();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    if (email === "--list") {
      const recent = await pool.query(
        `SELECT users.email, sessions.session_id, sessions.completed_at,
                sessions.expires_at, sessions.created_at
         FROM payment_tokenization_sessions AS sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.provider = 'prava'
         ORDER BY sessions.created_at DESC
         LIMIT 10`
      );
      console.log(JSON.stringify(recent.rows.map((row) => ({
        email: row.email || null,
        sessionId: row.session_id,
        completed: Boolean(row.completed_at),
        expired:
          Boolean(row.expires_at)
          && new Date(row.expires_at).getTime() <= Date.now(),
        createdAt: row.created_at,
      })), null, 2));
      return;
    }
    const result = await pool.query(
      `SELECT sessions.session_id, sessions.completed_at, sessions.expires_at
       FROM users
       JOIN payment_tokenization_sessions AS sessions
         ON sessions.user_id = users.id
       WHERE LOWER(users.email) = $1
         AND sessions.provider = 'prava'
       ORDER BY sessions.created_at DESC
       LIMIT 1`,
      [email]
    );
    const session = result.rows[0];
    if (!session) throw new Error("No Prava session exists for this account");
    const response = await fetch(
      `${apiBaseUrl()}/v1/sessions/${encodeURIComponent(session.session_id)}/payment-result`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PRAVA_SECRET_KEY}`,
          Accept: "application/json",
        },
      }
    );
    const data = await response.json().catch(() => ({}));
    const lineItems = (data.transactions || []).flatMap(
      (transaction) => transaction.line_items || []
    );
    console.log(JSON.stringify({
      httpStatus: response.status,
      sessionId: session.session_id,
      sessionCompletedInTokko: Boolean(session.completed_at),
      sessionExpiredInTokko:
        Boolean(session.expires_at)
        && new Date(session.expires_at).getTime() <= Date.now(),
      paymentResultStatus: data.status || null,
      lineItems: lineItems.map((line) => ({
        status: line.status || null,
        tokenPresent: Boolean(line.token),
        dynamicCvvPresent: Boolean(line.dynamic_cvv),
        expiryPresent: Boolean(line.expiry_month && line.expiry_year),
        merchantName: line.merchant_name || null,
        totalAmount: line.total_amount || null,
      })),
      error: data.error?.code || data.error?.message || null,
      note:
        "Credentials are returned to this API caller when present; the response contains no Zepto URL insertion or handoff field.",
    }, null, 2));
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
