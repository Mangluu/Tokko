const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SESSION_COOKIE,
  createEmailSignupChallengeId,
  createSessionToken,
  getSessionToken,
  hashPassword,
  hashSessionToken,
  maskEmail,
  normalizeEmail,
  sessionCookie,
  verifyPassword,
} = require("../lib/website-auth.js");

test("email authentication normalizes email and hashes passwords", async () => {
  assert.equal(normalizeEmail("  Parent@Example.COM "), "parent@example.com");
  const encoded = await hashPassword("a-secure-test-password");
  assert.equal(encoded.startsWith("scrypt$"), true);
  assert.equal(await verifyPassword("a-secure-test-password", encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
  assert.equal(encoded.includes("a-secure-test-password"), false);
});

test("website sessions use opaque tokens and HttpOnly cookies", () => {
  const token = createSessionToken();
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(hashSessionToken(token), /^[a-f0-9]{64}$/);
  const cookie = sessionCookie(token, true);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.equal(
    getSessionToken({ headers: { cookie } }),
    token
  );
});

test("signup email challenges are opaque and emails are masked", () => {
  const challengeId = createEmailSignupChallengeId();
  assert.match(challengeId, /^signup_[A-Za-z0-9_-]{20,}$/);
  assert.equal(maskEmail("parent@example.com"), "pa****@example.com");
});

test("email authentication rejects malformed input", async () => {
  assert.throws(() => normalizeEmail("not-an-email"), /valid email/);
  await assert.rejects(() => hashPassword("short"), /at least 10/);
});
