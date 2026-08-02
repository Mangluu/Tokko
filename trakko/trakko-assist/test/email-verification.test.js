const test = require("node:test");
const assert = require("node:assert/strict");
const emailVerification = require("../lib/email-verification.js");

function withClerkEnvironment(run) {
  const previousPublishable = process.env.CLERK_PUBLISHABLE_KEY;
  const previousSecret = process.env.CLERK_SECRET_KEY;
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_example";
  process.env.CLERK_SECRET_KEY = "sk_test_example";
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previousPublishable === undefined) {
        delete process.env.CLERK_PUBLISHABLE_KEY;
      } else {
        process.env.CLERK_PUBLISHABLE_KEY = previousPublishable;
      }
      if (previousSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = previousSecret;
      }
    });
}

test("verifyCompletedSignup accepts a completed matching Clerk signup", () =>
  withClerkEnvironment(async () => {
    const verified = await emailVerification.verifyCompletedSignup(
      "sua_example123",
      "shopper@example.com",
      {
        signUps: {
          async get(signUpId) {
            return {
              id: signUpId,
              status: "complete",
              emailAddress: "Shopper@Example.com",
              createdUserId: "user_example123",
            };
          },
        },
      }
    );
    assert.deepEqual(verified, {
      signUpId: "sua_example123",
      clerkUserId: "user_example123",
    });
  }));

test("verifyCompletedSignup accepts a verified email with remaining Clerk requirements", () =>
  withClerkEnvironment(async () => {
    const verified = await emailVerification.verifyCompletedSignup(
      "sua_example123",
      "shopper@example.com",
      {
        signUps: {
          async get(signUpId) {
            return {
              id: signUpId,
              status: "missing_requirements",
              emailAddress: "Shopper@Example.com",
              createdUserId: null,
              missingFields: ["phone_number"],
              unverifiedFields: [],
              verifications: {
                emailAddress: { nextAction: "" },
              },
            };
          },
        },
      }
    );
    assert.deepEqual(verified, {
      signUpId: "sua_example123",
      clerkUserId: null,
    });
  }));

test("verifyCompletedSignup rejects unverified or mismatched signups", () =>
  withClerkEnvironment(async () => {
    await assert.rejects(
      emailVerification.verifyCompletedSignup(
        "sua_example123",
        "shopper@example.com",
        {
          signUps: {
            async get() {
              return {
                id: "sua_example123",
                status: "missing_requirements",
                emailAddress: "somebody@example.com",
                createdUserId: null,
                unverifiedFields: ["email_address"],
                verifications: {
                  emailAddress: { nextAction: "needs_attempt" },
                },
              };
            },
          },
        }
      ),
      /Complete the Clerk email verification/
    );
  }));
