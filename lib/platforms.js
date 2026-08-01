const crypto = require("node:crypto");
const db = require("./db.js");

function base64url(buf) { return buf.toString("base64url"); }

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}

// --- OAuth client registration (per-platform, persisted to PostgreSQL) ---

const oauthClients = new Map(); // slug -> clientId
const oauthRedirectUris = new Map(); // slug -> redirectUri

function preferredRedirectUri(platform, baseUrl) {
  const configured =
    process.env[`${platform.slug.toUpperCase()}_OAUTH_REDIRECT_URI`];
  if (configured) return configured;
  // Zepto currently permits loopback callbacks for dynamically registered
  // clients while rejecting arbitrary hosted domains. This flow exchanges the
  // returned code server-side and never navigates to the callback.
  if (platform.slug === "zepto") {
    return "http://localhost:3456/auth/callback";
  }
  return `${baseUrl}/auth/callback`;
}

async function loadOAuthClient(platform, redirectUri) {
  const configured = process.env[`${platform.slug.toUpperCase()}_OAUTH_CLIENT_ID`];
  if (configured) {
    oauthClients.set(platform.slug, configured);
    oauthRedirectUris.set(platform.slug, redirectUri);
    return configured;
  }
  const saved = await db.getOAuthClient(Number(platform.id), redirectUri);
  if (!saved) return null;
  oauthClients.set(platform.slug, saved.client_id);
  oauthRedirectUris.set(platform.slug, saved.redirect_uri);
  return saved.client_id;
}

async function registerOAuthClient(platform, redirectUri) {
  const existing = await loadOAuthClient(platform, redirectUri);
  if (existing) return existing;

  const res = await fetch(`${platform.auth_server_url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Tokko",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const data = await res.json();
  if (!data.client_id) throw new Error(`OAuth registration failed for ${platform.slug}: ${JSON.stringify(data)}`);

  oauthClients.set(platform.slug, data.client_id);
  oauthRedirectUris.set(platform.slug, redirectUri);
  await db.saveOAuthClient(Number(platform.id), data.client_id, redirectUri);
  console.log(`[platforms] registered OAuth client for ${platform.slug}:`, data.client_id);
  return data.client_id;
}

function getOAuthClientId(slug) {
  return oauthClients.get(slug) || null;
}

function getOAuthRedirectUri(platform, baseUrl) {
  return (
    oauthRedirectUris.get(platform.slug) ||
    preferredRedirectUri(platform, baseUrl)
  );
}

async function ensureAllOAuthClients(platforms, baseUrl) {
  for (const p of platforms) {
    if (!p.enabled) continue;
    try {
      const redirectUri = preferredRedirectUri(p, baseUrl);
      await registerOAuthClient(p, redirectUri);
    } catch (e) {
      console.error(`[platforms] OAuth registration failed for ${p.slug}:`, e.message);
    }
  }
}

// --- Auth adapters (pluggable per auth_flow_type) ---

const pendingAuths = new Map(); // pendingId -> { platform, sessionId, codeVerifier, state, phone }

const authAdapters = {
  // Zepto-style: OAuth2 + phone OTP (auth server has /api/send-otp and /api/login)
  oauth2_otp: {
    async startAuth(platform, phone, clientId, baseUrl) {
      const phoneMatch = String(phone).match(/^\+91(\d{10})$/);
      if (!phoneMatch) {
        throw Object.assign(
          new Error("Zepto authentication requires a +91 Indian mobile number"),
          { status: 400 }
        );
      }
      const countryCode = "+91";
      const mobileNumber = phoneMatch[1];
      const state = base64url(crypto.randomBytes(16));
      const { verifier, challenge } = generatePKCE();
      const redirectUri = getOAuthRedirectUri(platform, baseUrl);

      // GET /authorize to get sessionId
      const authorizeUrl = new URL(`${platform.auth_server_url}/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", platform.oauth_scopes || "");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      if (platform.mcp_url) authorizeUrl.searchParams.set("resource", platform.mcp_url);

      const pageRes = await fetch(authorizeUrl.toString());
      const html = await pageRes.text();
      const match = html.match(/"sessionId"\s*:\s*"([^"]+)"/);
      if (!match) throw new Error(`Could not get auth session from ${platform.slug}`);
      const sessionId = match[1];

      // Send OTP
      const otpRes = await fetch(`${platform.auth_server_url}/api/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileNumber, countryCode }),
      });
      const otpData = await otpRes.json();
      if (otpData.error) throw new Error(`OTP send failed: ${otpData.error}`);

      const pendingId = base64url(crypto.randomBytes(12));
      pendingAuths.set(pendingId, {
        platform, sessionId, codeVerifier: verifier, state, phone,
        mobileNumber, countryCode, clientId, redirectUri,
      });
      setTimeout(() => pendingAuths.delete(pendingId), 600000);

      return { pendingId };
    },

    async verifyAuth(pendingId, otp) {
      const pending = pendingAuths.get(pendingId);
      if (!pending) throw new Error("Session expired. Please start again.");
      pendingAuths.delete(pendingId);

      const {
        platform, phone, mobileNumber, countryCode, sessionId,
        clientId, codeVerifier, state, redirectUri,
      } = pending;

      // Verify OTP
      const loginRes = await fetch(`${platform.auth_server_url}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mobileNumber,
          countryCode,
          otpToken: otp,
          sessionId,
          clientId,
          resource: platform.mcp_url || "",
          state,
        }),
      });
      const loginData = await loginRes.json();
      if (!loginData.redirect) throw new Error(loginData.message || loginData.error || "OTP verification failed");

      // Extract auth code
      const redirectUrl = new URL(loginData.redirect);
      const code = redirectUrl.searchParams.get("code");
      if (!code) throw new Error("No authorization code in response");

      // Exchange code for token
      const tokenRes = await fetch(`${platform.auth_server_url}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          resource: platform.mcp_url || "",
        }),
      });
      const tokenData = await tokenRes.json();
      if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
      if (!tokenData.access_token) throw new Error("No access token received");

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresIn: tokenData.expires_in || null,
        phone,
        platformSlug: platform.slug,
      };
    },

    async refreshToken(platform, refreshTok, clientId) {
      const res = await fetch(`${platform.auth_server_url}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshTok,
          resource: platform.mcp_url || "",
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error_description || data.error);
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshTok,
        expiresIn: data.expires_in || null,
      };
    },
  },
};

function getAdapter(authFlowType) {
  const adapter = authAdapters[authFlowType];
  if (!adapter) throw new Error(`Unknown auth_flow_type: ${authFlowType}`);
  return adapter;
}

module.exports = {
  ensureAllOAuthClients,
  registerOAuthClient,
  getOAuthClientId,
  getOAuthRedirectUri,
  getAdapter,
  pendingAuths,
};
