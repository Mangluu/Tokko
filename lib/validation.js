function requiredString(value, field, maxLength = 200) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw Object.assign(new Error(`${field} is too long`), { status: 400 });
  }
  return normalized;
}

function optionalString(value, field, maxLength = 200) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field, maxLength);
}

function e164(value, field) {
  const normalized = requiredString(value, field, 16);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw Object.assign(
      new Error(`${field} must use E.164 format, for example +919876543210`),
      { status: 400 }
    );
  }
  return normalized;
}

function phoneInput(value, countryCode, localNumber, field) {
  if (value !== undefined && value !== null && value !== "") {
    return e164(value, field);
  }
  const code = requiredString(countryCode, `${field}CountryCode`, 5);
  if (!/^\+[1-9]\d{0,3}$/.test(code)) {
    throw Object.assign(new Error(`${field}CountryCode is invalid`), {
      status: 400,
    });
  }
  const local = requiredString(localNumber, `${field}LocalPhone`, 24)
    .replace(/[()\s.-]/g, "")
    .replace(/^0+/, "");
  if (!/^\d+$/.test(local)) {
    throw Object.assign(new Error(`${field}LocalPhone must contain digits`), {
      status: 400,
    });
  }
  return e164(`${code}${local}`, field);
}

function optionalEmail(value, field = "accountEmail") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${field} must be an email address`), {
      status: 400,
    });
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw Object.assign(new Error(`${field} must be an email address`), {
      status: 400,
    });
  }
  return normalized;
}

function optionalAge(value, field = "age") {
  if (value === undefined || value === null || value === "") return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 120) {
    throw Object.assign(
      new Error(`${field} must be a whole number between 0 and 120`),
      { status: 400 }
    );
  }
  return normalized;
}

function optionalGender(value, field = "gender") {
  if (value === undefined || value === null || value === "") return null;
  const normalized = requiredString(value, field, 40);
  if (!/^[\p{L}][\p{L}\p{M} .'-]{0,39}$/u.test(normalized)) {
    throw Object.assign(new Error(`${field} contains unsupported characters`), {
      status: 400,
    });
  }
  if (/^prefer not to say$/i.test(normalized)) return null;
  return normalized;
}

function dependentInput(value, index) {
  const dependent =
    value && typeof value === "object" ? value : {};
  const name = dependent.name ?? dependent.dependentName;
  const phone = phoneInput(
    dependent.phone ?? dependent.dependentPhone,
    dependent.countryCode ?? dependent.phoneCountryCode,
    dependent.localPhone ?? dependent.phoneLocalNumber,
    `dependents[${index}].phone`
  );
  const relationshipValue =
    dependent.relationshipToUser ??
    dependent.relationship ??
    dependent.dependentRelationship;
  const relationship = requiredString(
    relationshipValue,
    `dependents[${index}].relationshipToUser`,
    80
  );
  const isOther = ["other", "other dependent"].includes(
    relationship.toLowerCase()
  );
  const declaredRelationship = isOther
    ? requiredString(
        dependent.otherRelationship,
        `dependents[${index}].otherRelationship`,
        80
      )
    : relationship;
  const age = optionalAge(dependent.age, `dependents[${index}].age`);
  const gender = optionalGender(
    dependent.gender,
    `dependents[${index}].gender`
  );
  return {
    name: requiredString(name, `dependents[${index}].name`),
    phone,
    relationshipToUser: declaredRelationship,
    ...(age !== null ? { age } : {}),
    ...(gender !== null ? { gender } : {}),
  };
}

function onboardingInput(body = {}) {
  const legacyDependent =
    body.dependent && typeof body.dependent === "object" ? body.dependent : {};
  const hasLegacyDependent = [
    legacyDependent.name,
    legacyDependent.phone,
    body.dependentName,
    body.dependentPhone,
    body.offspringName,
    body.offspringPhone,
  ].some((value) => value !== undefined && value !== null && value !== "");
  const suppliedDependents = Array.isArray(body.dependents)
    ? body.dependents
    : hasLegacyDependent
      ? [
        {
          name:
            legacyDependent.name ??
            body.dependentName ??
            body.offspringName,
          phone:
            legacyDependent.phone ??
            body.dependentPhone ??
            body.offspringPhone,
          relationshipToUser:
            legacyDependent.relationshipToUser ??
            legacyDependent.relationship ??
            body.dependentRelationship ??
            body.relationshipToUser,
          otherRelationship:
            legacyDependent.otherRelationship ?? body.otherRelationship,
        },
      ]
      : [];
  if (suppliedDependents.length > 20) {
    throw Object.assign(new Error("A family can contain at most 20 dependents"), {
      status: 400,
    });
  }
  const primaryParentPhone = phoneInput(
    body.primaryParentPhone,
    body.primaryParentCountryCode,
    body.primaryParentLocalPhone,
    "primaryParentPhone"
  );
  const secondaryParentPhone =
    body.secondaryParentPhone || body.secondaryParentLocalPhone
      ? phoneInput(
          body.secondaryParentPhone,
          body.secondaryParentCountryCode,
          body.secondaryParentLocalPhone,
          "secondaryParentPhone"
        )
      : null;
  const dependents = suppliedDependents.map(dependentInput);
  const uniquePhones = new Set(dependents.map((dependent) => dependent.phone));
  if (uniquePhones.size !== dependents.length) {
    throw Object.assign(
      new Error("Each dependent must have a different phone number"),
      { status: 400 }
    );
  }
  const requestedMerchantPhone = e164(
    body.merchantAuthPhone ??
      body.merchantAuthDependentPhone ??
    body.merchantDependentPhone ??
    legacyDependent.phone ??
    body.dependentPhone ??
      body.offspringPhone ??
      dependents[0]?.phone ??
      primaryParentPhone,
    "merchantAuthPhone"
  );
  const declaredSubjectType = body.merchantAuthSubjectType
    ? requiredString(
        body.merchantAuthSubjectType,
        "merchantAuthSubjectType",
        30
      )
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
    : body.merchantAuthDependentPhone || body.merchantDependentPhone
      ? "dependent"
      : null;
  if (
    declaredSubjectType &&
    !["account_holder", "user", "parent", "dependent"].includes(
      declaredSubjectType
    )
  ) {
    throw Object.assign(
      new Error("merchantAuthSubjectType must be account_holder or dependent"),
      { status: 400 }
    );
  }
  const wantsAccountHolder = ["account_holder", "user", "parent"].includes(
    declaredSubjectType
  );
  const merchantDependent =
    !wantsAccountHolder &&
    dependents.find((dependent) => dependent.phone === requestedMerchantPhone);
  const merchantAuthSubjectType = merchantDependent
    ? "dependent"
    : requestedMerchantPhone === primaryParentPhone
      ? "account_holder"
      : null;
  if (!merchantAuthSubjectType) {
    throw Object.assign(
      new Error(
        "merchantAuthPhone must match the account holder or one dependent"
      ),
      { status: 400 }
    );
  }
  if (
    declaredSubjectType === "dependent" &&
    merchantAuthSubjectType !== "dependent"
  ) {
    throw Object.assign(
      new Error("merchantAuthPhone must belong to a dependent"),
      { status: 400 }
    );
  }
  const compatibilityDependent = merchantDependent || dependents[0] || null;
  const primaryParentAge = optionalAge(
    body.primaryParentAge ?? body.age,
    "primaryParentAge"
  );
  const primaryParentGender = optionalGender(
    body.primaryParentGender ?? body.gender,
    "primaryParentGender"
  );

  return {
    primaryParentName: requiredString(body.primaryParentName, "primaryParentName"),
    primaryParentPhone,
    ...(primaryParentAge !== null ? { primaryParentAge } : {}),
    ...(primaryParentGender !== null ? { primaryParentGender } : {}),
    secondaryParentName: optionalString(body.secondaryParentName, "secondaryParentName"),
    secondaryParentPhone,
    dependents,
    merchantAuthPhone: requestedMerchantPhone,
    merchantAuthSubjectType,
    merchantAuthDependentPhone:
      merchantAuthSubjectType === "dependent" ? requestedMerchantPhone : null,
    dependentName: compatibilityDependent?.name || null,
    dependentPhone: compatibilityDependent?.phone || null,
    dependentRelationship: compatibilityDependent?.relationshipToUser || null,
  };
}

module.exports = {
  e164,
  onboardingInput,
  optionalAge,
  optionalEmail,
  optionalGender,
  optionalString,
  phoneInput,
  requiredString,
};
