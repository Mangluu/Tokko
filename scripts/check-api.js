const baseUrl = String(process.env.BASE_URL || process.argv[2] || "")
  .replace(/\/+$/, "");
const apiKey =
  process.env.TOKKO_API_KEY ||
  process.env.PLANTRI_API_KEY ||
  process.env.EXTERNAL_API_KEY ||
  String(process.env.EXTERNAL_API_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);
const serviceToken = process.env.CLERK_M2M_TOKEN;
const onboardingId = process.env.ONBOARDING_ID;

if (!baseUrl) {
  console.error("Set BASE_URL or pass the deployed URL as the first argument.");
  process.exit(1);
}
if (!apiKey && !serviceToken) {
  console.error(
    "Set TOKKO_API_KEY/EXTERNAL_API_KEY or CLERK_M2M_TOKEN for protected checks."
  );
  process.exit(1);
}

const serviceHeaders = serviceToken
  ? { Authorization: `Bearer ${serviceToken}` }
  : { "X-API-Key": apiKey };

async function check(name, pathname, expected, headers = {}) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}${pathname}`, { headers });
  const body = await response.json().catch(() => ({}));
  const elapsed = Date.now() - started;
  if (!response.ok) {
    throw new Error(
      `${name}: HTTP ${response.status} ${JSON.stringify(body)}`
    );
  }
  expected(body);
  console.log(`PASS  ${name.padEnd(24)} ${response.status} ${elapsed}ms`);
  return body;
}

async function main() {
  await check("public health", "/api/health", (body) => {
    if (body.ok !== true) throw new Error("health response did not contain ok=true");
  });
  await check("public config", "/api/config", (body) => {
    if (body.websiteAuthentication !== "email_password") {
      throw new Error("config response shape is invalid");
    }
  });
  const catalog = await check(
    "consolidated API catalog",
    "/api/v1/system/apis",
    (body) => {
      if (!Array.isArray(body.routes) || body.routes.length < 10) {
        throw new Error("API catalog is empty");
      }
    },
    serviceHeaders
  );
  const diagnostics = await check(
    "database diagnostics",
    "/api/v1/system/db",
    (body) => {
      if (
        body.database?.connected !== true ||
        typeof body.database?.tables?.users !== "number" ||
        typeof body.database?.tables?.family_dependents !== "number"
      ) {
        throw new Error("database diagnostics are invalid");
      }
    },
    serviceHeaders
  );
  await check(
    "sanitized database records",
    "/api/v1/system/db/records?limit=5",
    (body) => {
      if (!Array.isArray(body.records) || body.records.length > 5) {
        throw new Error("database records response is invalid");
      }
    },
    serviceHeaders
  );

  if (onboardingId) {
    await check(
      "onboarding record",
      `/api/v1/onboarding/${encodeURIComponent(onboardingId)}`,
      (body) => {
        if (String(body.userId) !== String(onboardingId)) {
          throw new Error("onboarding response has the wrong userId");
        }
      },
      serviceHeaders
    );
  }

  const missingConfig = Object.entries(diagnostics.configuration)
    .filter(([key, value]) => key !== "baseUrl" && value !== true)
    .map(([key]) => key);
  console.log(`\nRoutes discovered: ${catalog.routeCount}`);
  console.log(`Database: ${diagnostics.database.databaseName}`);
  console.log(
    missingConfig.length
      ? `Missing configuration: ${missingConfig.join(", ")}`
      : "Configuration checks: all present"
  );
}

main().catch((error) => {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
});
