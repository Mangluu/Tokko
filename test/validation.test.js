const test = require("node:test");
const assert = require("node:assert/strict");
const {
  onboardingInput,
  optionalAge,
  optionalEmail,
  optionalGender,
  phoneInput,
  websiteOnboardingInput,
} = require("../lib/validation.js");

test("website onboarding needs an account phone but not family contacts", () => {
  const profile = websiteOnboardingInput({
    primaryParentName: "Shivang",
    primaryParentCountryCode: "+91",
    primaryParentLocalPhone: "98111 22333",
    dependents: [{
      id: 12,
      name: "Asha",
      countryCode: "+91",
      localPhone: "98765 43210",
      relationshipToUser: "Mother",
    }],
  });
  assert.equal(profile.primaryParentPhone, "+919811122333");
  assert.equal(profile.dependents[0].id, 12);
  assert.equal(profile.dependents[0].phone, "+919876543210");
  assert.equal(profile.merchantAuthPhone, null);

  const withoutFamily = websiteOnboardingInput({
    primaryParentName: "Shivang",
    primaryParentPhone: "+919811122333",
    dependents: [],
  });
  assert.equal(withoutFamily.dependents.length, 0);

  assert.throws(
    () => websiteOnboardingInput({ primaryParentName: "Shivang", dependents: [] }),
    /primaryParentPhone/
  );
});

test("website onboarding rejects duplicate family contacts and account reuse", () => {
  const member = {
    name: "Asha",
    phone: "+919876543210",
    relationshipToUser: "Mother",
  };
  assert.throws(
    () => websiteOnboardingInput({
      primaryParentName: "Shivang",
      dependents: [member, { ...member, name: "Kabir" }],
    }),
    /different phone number/
  );
  assert.throws(
    () => websiteOnboardingInput({
      primaryParentName: "Shivang",
      primaryParentPhone: member.phone,
      dependents: [member],
    }),
    /must be different/
  );
});

test("phoneInput supports complete E.164 and country-code phone login values", () => {
  assert.equal(
    phoneInput("+919876543210", undefined, undefined, "phone"),
    "+919876543210"
  );
  assert.equal(
    phoneInput(undefined, "+91", "09876 543210", "phone"),
    "+919876543210"
  );
});

test("optional family age and gender are validated without becoming required", () => {
  assert.equal(optionalAge("63", "age"), 63);
  assert.equal(optionalAge("", "age"), null);
  assert.throws(() => optionalAge(121, "age"), /between 0 and 120/);
  assert.equal(optionalGender("Non-binary", "gender"), "Non-binary");
  assert.equal(optionalGender("Prefer not to say", "gender"), null);

  const profile = onboardingInput({
    primaryParentName: "Asha",
    primaryParentPhone: "+919876543210",
    primaryParentAge: 42,
    primaryParentGender: "Woman",
    dependents: [{
      name: "Papa",
      phone: "+919900112233",
      relationshipToUser: "Father",
      age: 68,
      gender: "Man",
    }],
  });
  assert.equal(profile.primaryParentAge, 42);
  assert.equal(profile.primaryParentGender, "Woman");
  assert.equal(profile.dependents[0].age, 68);
  assert.equal(profile.dependents[0].gender, "Man");
});

test("onboardingInput normalizes a valid family profile", () => {
  assert.deepEqual(
    onboardingInput({
      primaryParentName: "  Asha Khan ",
      primaryParentPhone: "+919876543210",
      dependentName: " Mira Khan ",
      dependentPhone: "+919900112233",
      dependentRelationship: " Daughter ",
    }),
    {
      primaryParentName: "Asha Khan",
      primaryParentPhone: "+919876543210",
      secondaryParentName: null,
      secondaryParentPhone: null,
      dependents: [
        {
          name: "Mira Khan",
          phone: "+919900112233",
          relationshipToUser: "Daughter",
        },
      ],
      merchantAuthPhone: "+919900112233",
      merchantAuthSubjectType: "dependent",
      merchantAuthDependentPhone: "+919900112233",
      dependentName: "Mira Khan",
      dependentPhone: "+919900112233",
      dependentRelationship: "Daughter",
    }
  );
});

test("onboardingInput accepts the nested dependent contract used by integrations", () => {
  assert.deepEqual(
    onboardingInput({
      primaryParentName: "Asha Khan",
      primaryParentPhone: "+919876543210",
      dependent: {
        name: "Mira Khan",
        phone: "+919900112233",
        relationshipToUser: "Daughter",
      },
    }),
    {
      primaryParentName: "Asha Khan",
      primaryParentPhone: "+919876543210",
      secondaryParentName: null,
      secondaryParentPhone: null,
      dependents: [
        {
          name: "Mira Khan",
          phone: "+919900112233",
          relationshipToUser: "Daughter",
        },
      ],
      merchantAuthPhone: "+919900112233",
      merchantAuthSubjectType: "dependent",
      merchantAuthDependentPhone: "+919900112233",
      dependentName: "Mira Khan",
      dependentPhone: "+919900112233",
      dependentRelationship: "Daughter",
    }
  );
});

test("onboardingInput rejects non-E.164 phone numbers", () => {
  assert.throws(
    () =>
      onboardingInput({
        primaryParentName: "Asha",
        primaryParentPhone: "9876543210",
        dependentName: "Mira",
        dependentPhone: "+919900112233",
        dependentRelationship: "Daughter",
      }),
    /E\.164/
  );
});

test("onboardingInput requires dependent name, phone, and relationship", () => {
  assert.throws(
    () =>
      onboardingInput({
        primaryParentName: "Asha",
        primaryParentPhone: "+919876543210",
        dependentName: "Mira",
        dependentPhone: "+919900112233",
      }),
    /relationshipToUser is required/
  );
});

test("onboardingInput accepts multiple dependents and selects the merchant number", () => {
  const result = onboardingInput({
    primaryParentName: "Asha",
    primaryParentPhone: "+919876543210",
    merchantAuthDependentPhone: "+919911223344",
    dependents: [
      {
        name: "Rekha",
        phone: "+919900112233",
        relationshipToUser: "Mother",
      },
      {
        name: "Dev",
        phone: "+919911223344",
        relationshipToUser: "Father",
      },
    ],
  });

  assert.deepEqual(result.dependents, [
    {
      name: "Rekha",
      phone: "+919900112233",
      relationshipToUser: "Mother",
    },
    {
      name: "Dev",
      phone: "+919911223344",
      relationshipToUser: "Father",
    },
  ]);
  assert.equal(result.merchantAuthDependentPhone, "+919911223344");
  assert.equal(result.merchantAuthPhone, "+919911223344");
  assert.equal(result.merchantAuthSubjectType, "dependent");
  assert.equal(result.dependentName, "Dev");
  assert.equal(result.dependentRelationship, "Father");
});

test("onboardingInput accepts an account holder without dependents", () => {
  const result = onboardingInput({
    primaryParentName: "Asha",
    primaryParentPhone: "+919876543210",
    dependents: [],
  });
  assert.deepEqual(result.dependents, []);
  assert.equal(result.merchantAuthPhone, "+919876543210");
  assert.equal(result.merchantAuthSubjectType, "account_holder");
  assert.equal(result.merchantAuthDependentPhone, null);
  assert.equal(result.dependentName, null);
  assert.equal(result.dependentPhone, null);
  assert.equal(result.dependentRelationship, null);
});

test("onboardingInput requires a declared relationship for Other dependent", () => {
  const base = {
    primaryParentName: "Asha",
    primaryParentPhone: "+919876543210",
    dependents: [
      {
        name: "Ravi",
        phone: "+919900112233",
        relationshipToUser: "Other dependent",
      },
    ],
  };
  assert.throws(() => onboardingInput(base), /otherRelationship is required/);
  assert.equal(
    onboardingInput({
      ...base,
      dependents: [
        {
          ...base.dependents[0],
          otherRelationship: "Cousin",
        },
      ],
    }).dependents[0].relationshipToUser,
    "Cousin"
  );
});

test("onboardingInput rejects duplicate or unlisted merchant phones", () => {
  const base = {
    primaryParentName: "Asha",
    primaryParentPhone: "+919876543210",
    dependents: [
      {
        name: "One",
        phone: "+919900112233",
        relationshipToUser: "Sibling",
      },
    ],
  };
  assert.throws(
    () =>
      onboardingInput({
        ...base,
        dependents: [...base.dependents, { ...base.dependents[0], name: "Two" }],
      }),
    /different phone number/
  );
  assert.throws(
    () =>
      onboardingInput({
        ...base,
        merchantAuthDependentPhone: "+919922334455",
      }),
    /must match the account holder or one dependent/
  );
});

test("onboardingInput accepts local numbers and account-holder merchant auth", () => {
  const result = onboardingInput({
    primaryParentName: "Asha",
    primaryParentCountryCode: "+91",
    primaryParentLocalPhone: "09876 543 210",
    merchantAuthPhone: "+919876543210",
    merchantAuthSubjectType: "account_holder",
    dependents: [
      {
        name: "Mira",
        countryCode: "+44",
        localPhone: "07700 900123",
        relationshipToUser: "Daughter",
      },
    ],
  });

  assert.equal(result.primaryParentPhone, "+919876543210");
  assert.equal(result.dependents[0].phone, "+447700900123");
  assert.equal(result.merchantAuthPhone, "+919876543210");
  assert.equal(result.merchantAuthSubjectType, "account_holder");
  assert.equal(result.merchantAuthDependentPhone, null);
  assert.equal(result.dependentName, "Mira");
});

test("optionalEmail normalizes the LINQ account email", () => {
  assert.equal(optionalEmail(" Family@Example.COM "), "family@example.com");
  assert.equal(optionalEmail(undefined), null);
  assert.throws(() => optionalEmail("invalid"), /email address/);
});
