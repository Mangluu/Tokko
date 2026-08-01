const { createClerkClient } = require("@clerk/backend");

let cachedClient = null;
let cachedSecretKey = null;

function httpError(status, message) {
  return Object.assign(new Error(message), {
    status,
    isApplicationError: true,
  });
}

function configuration() {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY || "";
  const secretKey = process.env.CLERK_SECRET_KEY || "";
  return {
    configured: Boolean(publishableKey && secretKey),
    publishableKey,
    secretKey,
  };
}

function clerkClient(secretKey) {
  if (!cachedClient || cachedSecretKey !== secretKey) {
    cachedClient = createClerkClient({ secretKey });
    cachedSecretKey = secretKey;
  }
  return cachedClient;
}

async function verifyCompletedSignup(signUpId, email, clientOverride = null) {
  const config = configuration();
  if (!config.configured) {
    throw httpError(503, "Email verification is not configured");
  }
  if (
    typeof signUpId !== "string" ||
    !/^sua_[A-Za-z0-9]+$/.test(signUpId)
  ) {
    throw httpError(400, "A valid Clerk signup verification is required");
  }
  try {
    const client = clientOverride || clerkClient(config.secretKey);
    const signUp = await client.signUps.get(signUpId);
    const emailMatches =
      signUp.emailAddress?.trim().toLowerCase() ===
      String(email || "").trim().toLowerCase();
    const emailStillUnverified = (signUp.unverifiedFields || []).some(
      (field) => field === "email_address" || field === "emailAddress"
    );
    const emailVerificationComplete =
      signUp.status === "complete" ||
      (
        signUp.status === "missing_requirements" &&
        !emailStillUnverified &&
        signUp.verifications?.emailAddress?.nextAction === ""
      );
    if (
      !emailMatches ||
      !emailVerificationComplete ||
      signUp.status === "abandoned"
    ) {
      throw httpError(
        400,
        "Complete the Clerk email verification before creating the account"
      );
    }
    if (signUp.status !== "complete") {
      console.info(
        `[email] Accepting verified email from Clerk signup ${signUp.id}; ` +
        `remaining Clerk fields: ${(signUp.missingFields || []).join(",") || "none"}`
      );
    }
    return {
      clerkUserId: signUp.createdUserId || null,
      signUpId: signUp.id,
    };
  } catch (error) {
    if (error.isApplicationError) throw error;
    console.error(
      `[email] Clerk could not confirm signup verification: ${error.message}`
    );
    if (error.status === 404 || error.status === 422) {
      throw httpError(
        400,
        "This Clerk signup verification is invalid or has expired"
      );
    }
    throw httpError(
      error.status === 401 || error.status === 403 ? 503 : 502,
      error.status === 401 || error.status === 403
        ? "Clerk email verification is misconfigured"
        : "The email verification could not be confirmed. Please try again."
    );
  }
}

module.exports = {
  configuration,
  verifyCompletedSignup,
};
