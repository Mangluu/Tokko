const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "plantri_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const EMAIL_OTP_TTL_SECONDS = 10 * 60;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeEmail(value) {
  if (typeof value !== "string") throw httpError(400, "Email is required");
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw httpError(400, "Enter a valid email address");
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== "string") throw httpError(400, "Password is required");
  if (value.length < 10) {
    throw httpError(400, "Password must be at least 10 characters");
  }
  if (value.length > 128) {
    throw httpError(400, "Password must be 128 characters or fewer");
  }
  return value;
}

async function derivePassword(password, salt, options = {}) {
  return scrypt(password, salt, KEY_LENGTH, {
    N: options.N || SCRYPT_N,
    r: options.r || SCRYPT_R,
    p: options.p || SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

async function hashPassword(value) {
  const password = validatePassword(value);
  const salt = crypto.randomBytes(16);
  const derived = await derivePassword(password, salt);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

async function verifyPassword(value, encoded) {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    typeof encoded !== "string"
  ) {
    return false;
  }
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !saltValue ||
    !hashValue ||
    !Number.isSafeInteger(Number(n)) ||
    !Number.isSafeInteger(Number(r)) ||
    !Number.isSafeInteger(Number(p))
  ) {
    return false;
  }
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = Buffer.from(
      await derivePassword(value, Buffer.from(saltValue, "base64url"), {
        N: Number(n),
        r: Number(r),
        p: Number(p),
      })
    );
    return (
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function createEmailSignupChallengeId() {
  return `signup_${crypto.randomBytes(24).toString("base64url")}`;
}

function emailOtpExpiresAt() {
  return new Date(Date.now() + EMAIL_OTP_TTL_SECONDS * 1000).toISOString();
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  const [local, domain] = email.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function parseCookies(header = "") {
  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return cookies;
      const name = part.slice(0, separator);
      const value = part.slice(separator + 1);
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function getSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

function sessionCookie(token, secure = true) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function expiredSessionCookie(secure = true) {
  return [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function sessionExpiresAt() {
  return new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  EMAIL_OTP_TTL_SECONDS,
  createEmailSignupChallengeId,
  createSessionToken,
  emailOtpExpiresAt,
  expiredSessionCookie,
  getSessionToken,
  hashPassword,
  hashSessionToken,
  maskEmail,
  normalizeEmail,
  sessionCookie,
  sessionExpiresAt,
  validatePassword,
  verifyPassword,
};
