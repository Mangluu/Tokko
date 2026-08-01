export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body:
      options.body && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      data.error || `Request failed (${response.status})`,
      response.status,
      data
    );
  }
  return data;
}

export function phoneParts(e164 = '') {
  const value = String(e164).replace(/\s+/g, '');
  const knownCodes = ['+91', '+1', '+44', '+61', '+65', '+971'];
  const countryCode = knownCodes.find((code) => value.startsWith(code)) || '+91';
  return {
    countryCode,
    localPhone: value.startsWith(countryCode)
      ? value.slice(countryCode.length)
      : value.replace(/^\+/, ''),
  };
}

const NATIONAL_PHONE_LENGTHS = {
  '+1': 10,
  '+44': 10,
  '+61': 9,
  '+65': 8,
  '+91': 10,
  '+971': 9,
};

export function normalizeLocalPhone(countryCode, localPhone) {
  const code = String(countryCode || '').replace(/\D/g, '');
  let digits = String(localPhone || '').replace(/\D/g, '');

  // Accept national numbers with a trunk zero and full international numbers
  // pasted into the local-number field without duplicating the selected code.
  digits = digits.replace(/^00/, '');
  const nationalLength = NATIONAL_PHONE_LENGTHS[countryCode];
  if (
    code
    && nationalLength
    && digits.startsWith(code)
    && digits.length === code.length + nationalLength
  ) {
    digits = digits.slice(code.length);
  }
  return digits.replace(/^0+/, '');
}

export function toE164(countryCode, localPhone) {
  return `${countryCode}${normalizeLocalPhone(countryCode, localPhone)}`;
}

export const DEPENDENT_RELATIONSHIPS = [
  'Child',
  'Son',
  'Daughter',
  'Mother',
  'Father',
  'Spouse',
  'Sibling',
  'Grandparent',
];

const GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary'];

export function setupFromUserState(state, current) {
  const profile = state?.profile;
  const paymentMethods = Array.isArray(state?.paymentMethods)
    ? state.paymentMethods
    : current.cards || [];
  const paymentMethod = paymentMethods.find((item) => item.isDefault)
    || paymentMethods[0];
  const ownerPhone = phoneParts(profile?.primaryParentPhone);
  const members = (profile?.dependents || []).map((dependent) => {
    const savedRelationship = dependent.relationshipToUser || '';
    const isStandardRelationship =
      DEPENDENT_RELATIONSHIPS.includes(savedRelationship);
    const savedGender = dependent.gender || '';
    return {
      id: dependent.id || `${dependent.phone}-${dependent.name}`,
      name: dependent.name,
      age: dependent.age ?? '',
      gender: GENDER_OPTIONS.includes(savedGender)
        ? savedGender
        : savedGender
          ? 'Self-described'
          : '',
      genderDescription: GENDER_OPTIONS.includes(savedGender)
        ? ''
        : savedGender,
      role: isStandardRelationship
        ? savedRelationship
        : 'Other dependent',
      otherRelationship: isStandardRelationship ? '' : savedRelationship,
      phone: dependent.phone,
      ...phoneParts(dependent.phone),
      channel: 'Phone',
      selected: false,
      merchantAuth:
        profile?.merchantAuthSubjectType === 'dependent'
        && profile?.merchantAuthPhone === dependent.phone,
    };
  });
  return {
    ...current,
    account: state?.account || current.account,
    profile: {
      ...current.profile,
      name: profile?.primaryParentName || current.profile.name,
      age: profile?.primaryParentAge ?? current.profile.age ?? '',
      gender: GENDER_OPTIONS.includes(profile?.primaryParentGender)
        ? profile.primaryParentGender
        : profile?.primaryParentGender
          ? 'Self-described'
          : current.profile.gender || '',
      genderDescription:
        profile?.primaryParentGender &&
        !GENDER_OPTIONS.includes(profile.primaryParentGender)
          ? profile.primaryParentGender
          : current.profile.genderDescription || '',
      countryCode: ownerPhone.countryCode,
      localPhone: ownerPhone.localPhone,
      phone: profile?.primaryParentPhone || current.profile.phone,
    },
    members: profile ? members : current.members,
    merchantAuthPhone:
      profile?.merchantAuthSubjectType === 'account_holder'
        ? 'account_holder'
        : profile?.merchantAuthPhone || current.merchantAuthPhone,
    merchantConsent:
      state?.merchantConsent?.consented ?? current.merchantConsent,
    cards: paymentMethods,
    card: paymentMethod
      ? {
          connected: true,
          id: paymentMethod.id,
          last4: paymentMethod.last4,
          brand: paymentMethod.brand || 'Card',
          expMonth: paymentMethod.expMonth,
          expYear: paymentMethod.expYear,
          isDefault: Boolean(paymentMethod.isDefault),
        }
      : current.card,
    zeptoConnected:
      state?.merchantConnected ?? current.zeptoConnected,
    zeptoPhone:
      profile?.merchantAuthPhone || current.zeptoPhone,
    deliveryPreference:
      state?.deliveryPreference ?? current.deliveryPreference ?? null,
  };
}

export function onboardingPayload(setup) {
  const primaryParentLocalPhone = normalizeLocalPhone(
    setup.profile.countryCode,
    setup.profile.localPhone
  );
  const primaryParentPhone = toE164(
    setup.profile.countryCode,
    primaryParentLocalPhone
  );
  const dependents = setup.members.map((member) => {
    const savedPhone = phoneParts(member.phone);
    const countryCode = member.countryCode || savedPhone.countryCode;
    const localPhone = normalizeLocalPhone(
      countryCode,
      member.localPhone ?? savedPhone.localPhone
    );
    return {
      name: member.name.trim(),
      age: member.age === '' || member.age === null || member.age === undefined
        ? null
        : Number(member.age),
      gender: member.gender === 'Self-described'
        ? member.genderDescription?.trim() || null
        : member.gender || null,
      phone: toE164(countryCode, localPhone),
      countryCode,
      localPhone,
      relationshipToUser: member.role,
      ...(member.role === 'Other dependent'
        ? { otherRelationship: member.otherRelationship?.trim() || '' }
        : {}),
    };
  });
  const merchantAuthPhone =
    setup.merchantAuthPhone === 'account_holder'
      ? primaryParentPhone
      : dependents.find((dependent) =>
          dependent.phone === setup.merchantAuthPhone
          || dependent.phone === toE164(
            phoneParts(setup.merchantAuthPhone).countryCode,
            phoneParts(setup.merchantAuthPhone).localPhone
          )
        )?.phone || setup.merchantAuthPhone;
  return {
    primaryParentName: setup.profile.name.trim(),
    primaryParentAge:
      setup.profile.age === '' ||
      setup.profile.age === null ||
      setup.profile.age === undefined
        ? null
        : Number(setup.profile.age),
    primaryParentGender: setup.profile.gender === 'Self-described'
      ? setup.profile.genderDescription?.trim() || null
      : setup.profile.gender || null,
    primaryParentPhone,
    primaryParentCountryCode: setup.profile.countryCode,
    primaryParentLocalPhone,
    dependents,
    merchantAuthPhone,
    merchantAuthSubjectType:
      merchantAuthPhone === primaryParentPhone
        ? 'account_holder'
        : 'dependent',
  };
}

export function resultContent(result) {
  if (result?.structuredContent) return result.structuredContent;
  if (result?.structured_content) return result.structured_content;
  return null;
}

export function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('\n');
}
