const test = require("node:test");
const assert = require("node:assert/strict");
const { verifiedClerkEmail } = require("../lib/auth.js");

test("Google OAuth accepts only Clerk's verified primary email", () => {
  assert.equal(
    verifiedClerkEmail({
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [
        {
          id: "idn_secondary",
          emailAddress: "other@example.com",
          verification: { status: "verified" },
        },
        {
          id: "idn_primary",
          emailAddress: " Parent@Example.com ",
          verification: { status: "verified" },
        },
      ],
    }),
    "parent@example.com"
  );
});

test("Google OAuth rejects an unverified Clerk email", () => {
  assert.throws(
    () => verifiedClerkEmail({
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [{
        id: "idn_primary",
        emailAddress: "parent@example.com",
        verification: { status: "unverified" },
      }],
    }),
    /verified email address/
  );
});
