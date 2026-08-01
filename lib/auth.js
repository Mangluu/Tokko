const crypto = require("node:crypto");
const { createClerkClient } = require("@clerk/backend");
const db = require("./db.js");
const platforms = require("./platforms.js");
const mcp = require("./mcp.js");
const websiteAuth = require("./website-auth.js");

const MERCHANT_AUTH_PURPOSE = "authenticate_offspring_phone";

function merchantAuthPhone(profile) {
  return profile?.merchant_auth_phone || profile?.offspring_phone || null;
}
let clerkClient = null;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function getClerkClient() {
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    throw httpError(503, "Clerk authentication is not configured");
  }
  if (!clerkClient) {
    clerkClient = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
      publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    });
  }
  return clerkClient;
}

function toWebRequest(req) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const url = new URL(req.url || "/", `${protocol}://${host}`);
  return new Request(url, {
    method: req.method || "GET",
    headers: new Headers(req.headers),
  });
}

function authorizedParties() {
  const configured =
    process.env.CLERK_AUTHORIZED_PARTIES || process.env.BASE_URL || "";
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function authenticateClerk(req, acceptsToken = "session_token") {
  const options = { acceptsToken };
  const tokenTypes = Array.isArray(acceptsToken) ? acceptsToken : [acceptsToken];
  if (tokenTypes.includes("session_token")) {
    const parties = authorizedParties();
    if (parties.length) options.authorizedParties = parties;
  }
  const state = await getClerkClient().authenticateRequest(toWebRequest(req), options);
  if (!state.isAuthenticated) return null;
  return state.toAuth();
}

function verifiedClerkEmail(user) {
  if (!user) throw httpError(401, "Clerk user was not found");
  const primary = user.emailAddresses?.find(
    (entry) => entry.id === user.primaryEmailAddressId
  ) || user.emailAddresses?.[0];
  const email = String(primary?.emailAddress || "").trim().toLowerCase();
  if (!email || primary?.verification?.status !== "verified") {
    throw httpError(403, "A verified email address is required");
  }
  return email;
}

async function authenticateClerkUser(req) {
  const identity = await authenticateClerk(req, "session_token");
  if (!identity?.userId) throw httpError(401, "Google sign-in could not be verified");
  const user = await getClerkClient().users.getUser(identity.userId);
  return {
    identity,
    email: verifiedClerkEmail(user),
  };
}

async function requireUser(req) {
  const serviceUserId = Number(req?.tokkoServiceUserId);
  if (Number.isInteger(serviceUserId) && serviceUserId > 0) {
    const user = await db.getUserById(serviceUserId);
    if (!user) throw httpError(404, "Tokko family account was not found");
    return {
      ...user,
      userId: Number(user.id),
      clerkUserId: user.clerk_user_id || null,
      sessionId: `service:${user.id}`,
      authType: "trusted_service",
    };
  }
  const websiteToken = websiteAuth.getSessionToken(req);
  if (websiteToken) {
    const user = await db.getWebsiteSession(
      websiteAuth.hashSessionToken(websiteToken)
    );
    if (user) {
      return {
        ...user,
        userId: Number(user.id),
        clerkUserId: user.clerk_user_id || null,
        sessionId: `website:${user.token_hash.slice(0, 12)}`,
        authType: "website_session",
      };
    }
  }

  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) {
    throw httpError(401, "Sign in with email to continue");
  }
  const identity = await authenticateClerk(req, "session_token");
  if (!identity?.userId) throw httpError(401, "Unauthorized");
  const user = await db.getOrCreateWebsiteUser(identity.userId);
  return {
    ...user,
    userId: Number(user.id),
    clerkUserId: identity.userId,
    sessionId: identity.sessionId,
    authType: "clerk_session",
  };
}

function safeKeyEquals(actual, expected) {
  const actualHash = crypto.createHash("sha256").update(actual).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

async function requireService(req) {
  try {
    const identity = await authenticateClerk(req, ["m2m_token", "api_key"]);
    if (identity) return { type: "clerk", identity };
  } catch (error) {
    if (error.status === 503) {
      // A deployment may intentionally use EXTERNAL_API_KEYS without Clerk M2M.
    } else {
      console.warn("[auth] Clerk service-token validation failed:", error.message);
    }
  }

  const supplied = String(req.headers["x-api-key"] || "");
  const configured = String(process.env.EXTERNAL_API_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (supplied && configured.some((key) => safeKeyEquals(supplied, key))) {
    return { type: "api_key" };
  }
  throw httpError(401, "A Clerk machine token or valid X-API-Key is required");
}

async function startMerchantAuth(userId, platformSlug, baseUrl) {
  const profile = await db.getProfile(userId);
  if (!profile) throw httpError(409, "Complete the family profile first");
  const platform = await db.getPlatformBySlug(platformSlug);
  if (!platform) throw httpError(404, "Merchant platform not found");

  const consent = await db.getMerchantAuthConsent(
    userId,
    Number(platform.id),
    MERCHANT_AUTH_PURPOSE
  );
  if (
    !consent ||
    consent.consented !== true ||
    consent.subject_phone !== merchantAuthPhone(profile)
  ) {
    throw httpError(
      403,
      `Consent is required to use ${merchantAuthPhone(profile)} to authenticate with ${platform.name}`
    );
  }

  const clientId = platforms.getOAuthClientId(platform.slug);
  if (!clientId) throw httpError(503, `OAuth client not registered for ${platform.slug}`);
  const adapter = platforms.getAdapter(platform.auth_flow_type);
  const { pendingId } = await adapter.startAuth(
    platform,
    merchantAuthPhone(profile),
    clientId,
    baseUrl
  );
  const pending = platforms.pendingAuths.get(pendingId);
  if (!pending) throw httpError(500, "Merchant authentication state was not created");

  await db.saveMerchantAuthAttempt(
    pendingId,
    userId,
    Number(platform.id),
    pending,
    new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );
  platforms.pendingAuths.delete(pendingId);
  return {
    pendingId,
    merchant: platform.slug,
    phone: merchantAuthPhone(profile),
    expiresInSeconds: 600,
  };
}

async function verifyMerchantAuth(userId, pendingId, otp) {
  const attempt = await db.consumeMerchantAuthAttempt(pendingId, userId);
  if (!attempt) throw httpError(401, "Merchant authentication session expired");
  const pending = attempt.payload;
  platforms.pendingAuths.set(pendingId, pending);

  const adapter = platforms.getAdapter(pending.platform.auth_flow_type);
  const result = await adapter.verifyAuth(pendingId, otp);
  const platform = await db.getPlatformBySlug(result.platformSlug);
  if (!platform || Number(platform.id) !== Number(attempt.platform_id)) {
    throw httpError(409, "Merchant authentication state does not match");
  }
  const profile = await db.getProfile(userId);
  if (result.phone !== merchantAuthPhone(profile)) {
    throw httpError(
      409,
      "The selected Zepto authentication phone changed. Start reconnection again."
    );
  }

  await db.saveToken(userId, Number(platform.id), {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    mcpSessionId: null,
    authenticatedPhone: result.phone,
    expiresAt: result.expiresIn
      ? new Date(Date.now() + result.expiresIn * 1000).toISOString()
      : null,
  });
  await db.setConsent(userId, Number(platform.id), true);

  if (platform.mcp_url) {
    try {
      const { mcpSessionId } = await mcp.mcpInitialize(
        platform.mcp_url,
        result.accessToken,
        null
      );
      await db.saveToken(userId, Number(platform.id), {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        mcpSessionId,
        authenticatedPhone: result.phone,
        expiresAt: result.expiresIn
          ? new Date(Date.now() + result.expiresIn * 1000).toISOString()
          : null,
      });
    } catch (error) {
      console.error("[auth] MCP init deferred:", error.message);
    }
  }

  return {
    connected: true,
    merchant: platform.slug,
    phone: result.phone,
  };
}

async function withPlatformTool(req, platformSlug, toolName, args) {
  const user = await requireUser(req);
  return withPlatformToolForUser(user.userId, platformSlug, toolName, args);
}

async function platformConnectionForUser(userId, platformSlug) {
  const [platform, profile] = await Promise.all([
    db.getPlatformBySlug(platformSlug),
    db.getProfile(userId),
  ]);
  if (!platform) throw httpError(404, "Platform not found");

  const consent = await db.getMerchantAuthConsent(
    userId,
    Number(platform.id),
    MERCHANT_AUTH_PURPOSE
  );
  if (
    !consent ||
    consent.consented !== true ||
    consent.subject_phone !== merchantAuthPhone(profile)
  ) {
    throw httpError(
      403,
      "Selected phone authentication consent is missing or revoked"
    );
  }

  const tokenRow = await db.getToken(userId, Number(platform.id));
  if (!tokenRow?.access_token) {
    throw httpError(403, "Platform not connected. Complete merchant authentication first.");
  }
  if (tokenRow.authenticated_phone !== merchantAuthPhone(profile)) {
    throw httpError(
      403,
      "Zepto authorization belongs to a different phone. Reconnect using the selected phone."
    );
  }

  let accessToken = tokenRow.access_token;
  let mcpSessionId = tokenRow.mcp_session_id;
  let refreshToken = tokenRow.refresh_token;
  let tokenExpiresAt = tokenRow.token_expires_at;
  if (
    tokenRow.token_expires_at &&
    new Date(tokenRow.token_expires_at) < new Date(Date.now() + 60_000)
  ) {
    const clientId = platforms.getOAuthClientId(platform.slug);
    const adapter = platforms.getAdapter(platform.auth_flow_type);
    const refreshed = await adapter.refreshToken(
      platform,
      tokenRow.refresh_token,
      clientId
    );
    accessToken = refreshed.accessToken;
    mcpSessionId = null;
    refreshToken = refreshed.refreshToken;
    tokenExpiresAt = refreshed.expiresIn
      ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
      : null;
    await db.saveToken(userId, Number(platform.id), {
      accessToken,
      refreshToken,
      mcpSessionId,
      authenticatedPhone: tokenRow.authenticated_phone,
      expiresAt: tokenExpiresAt,
    });
  }

  return {
    platform,
    tokenRow,
    accessToken,
    mcpSessionId,
    refreshToken,
    tokenExpiresAt,
  };
}

async function persistMcpSession(userId, platform, connection, nextSessionId) {
  if (!nextSessionId || nextSessionId === connection.mcpSessionId) return;
  await db.saveToken(userId, Number(platform.id), {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    mcpSessionId: nextSessionId,
    authenticatedPhone: connection.tokenRow.authenticated_phone,
    expiresAt: connection.tokenExpiresAt,
  });
}

async function withPlatformToolForUser(userId, platformSlug, toolName, args) {
  const connection = await platformConnectionForUser(userId, platformSlug);
  const result = await mcp.callTool(
    connection.platform.mcp_url,
    connection.accessToken,
    connection.mcpSessionId,
    toolName,
    args
  );
  await persistMcpSession(
    userId,
    connection.platform,
    connection,
    result.mcpSessionId
  );
  return result.data;
}

async function listPlatformTools(req, platformSlug) {
  const user = await requireUser(req);
  return listPlatformToolsForUser(user.userId, platformSlug);
}

async function listPlatformToolsForUser(userId, platformSlug) {
  const connection = await platformConnectionForUser(userId, platformSlug);
  const result = await mcp.listTools(
    connection.platform.mcp_url,
    connection.accessToken,
    connection.mcpSessionId
  );
  await persistMcpSession(
    userId,
    connection.platform,
    connection,
    result.mcpSessionId
  );
  return result.tools;
}

module.exports = {
  MERCHANT_AUTH_PURPOSE,
  authenticateClerk,
  authenticateClerkUser,
  listPlatformTools,
  listPlatformToolsForUser,
  requireService,
  requireUser,
  startMerchantAuth,
  verifyMerchantAuth,
  verifiedClerkEmail,
  withPlatformTool,
  withPlatformToolForUser,
};
