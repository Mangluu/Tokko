// --- State ---
let phone = null;
let appConfig = null;
let onboardingState = null;
let signedInAccount = null;
let authMode = "login";
let pravaSession = null;
let merchantPendingId = null;
let selectedAddressId = null;
let selectedCoordinates = null;
let cartItems = [];
let searchResultItems = [];
let checkoutSavedCard = null;
let searchRequestVersion = 0;
let checkoutPaymentState = {
  failures: 0,
  orderId: null,
  paymentLink: null,
  countedFailedOrders: new Set(),
};
let authActionVersion = 0;
let activePlatformSlug = null;
let onboardingReturnContext = null;

// --- API ---
async function api(method, path, body) {
  const opts = {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// --- Status bar ---
let statusTimer;
function showStatus(msg, type = "") {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.className = "status-bar visible " + type;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (bar.className = "status-bar"), 3000);
}

function setLoginError(message) {
  document.getElementById("login-error").textContent = message;
}

function setLoginStatus(message) {
  document.getElementById("login-status").textContent = message;
}

function setFormStatus(id, message, isError = false) {
  const element = document.getElementById(id);
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  document.getElementById("auth-title").textContent = signup
    ? "Create your account"
    : "Sign in";
  document.getElementById("auth-submit").textContent = signup
    ? "Create account"
    : "Sign in";
  document.getElementById("auth-switch-copy").textContent = signup
    ? "Already have an account?"
    : "New to Tokko?";
  document.getElementById("auth-switch-button").textContent = signup
    ? "Sign in"
    : "Create an account";
  const password = document.querySelector('#email-auth-form [name="password"]');
  password.autocomplete = signup ? "new-password" : "current-password";
  setLoginError("");
  setLoginStatus("");
}

document
  .getElementById("auth-switch-button")
  .addEventListener("click", () =>
    setAuthMode(authMode === "login" ? "signup" : "login")
  );

document
  .getElementById("email-auth-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    authActionVersion += 1;
    const form = event.currentTarget;
    const button = document.getElementById("auth-submit");
    button.disabled = true;
    setLoginError("");
    setLoginStatus(authMode === "signup" ? "Creating account..." : "Signing in...");
    try {
      const credentials = Object.fromEntries(new FormData(form).entries());
      const result = await api(
        "POST",
        authMode === "signup" ? "/api/auth/signup" : "/api/auth/login",
        credentials
      );
      signedInAccount = result.account;
      form.reset();
      await onSignedIn();
    } catch (error) {
      setLoginStatus("");
      setLoginError(error.message);
    } finally {
      button.disabled = false;
    }
  });

async function onSignedIn() {
  setLoginStatus("Loading your account...");
  const state = await api("GET", "/api/me");
  onboardingState = state;
  signedInAccount = state.account;
  setLoginStatus("");
  if (state.onboardingComplete) {
    enterApp(state);
  } else {
    await showOnboarding(state);
  }
}

function familyMemberCard(role, name, details) {
  const card = document.createElement("article");
  card.className = "family-member";

  const roleElement = document.createElement("div");
  roleElement.className = "family-member-role";
  roleElement.textContent = role;
  card.appendChild(roleElement);

  const nameElement = document.createElement("div");
  nameElement.className = "family-member-name";
  nameElement.textContent = name;
  card.appendChild(nameElement);

  details.filter(Boolean).forEach((detail) => {
    const detailElement = document.createElement("div");
    detailElement.className = "family-member-detail";
    detailElement.textContent = detail;
    card.appendChild(detailElement);
  });
  return card;
}

const PHONE_COUNTRIES = [
  ["India", "+91"],
  ["United States / Canada", "+1"],
  ["United Kingdom", "+44"],
  ["United Arab Emirates", "+971"],
  ["Singapore", "+65"],
  ["Australia", "+61"],
  ["New Zealand", "+64"],
  ["Bangladesh", "+880"],
  ["Pakistan", "+92"],
  ["Sri Lanka", "+94"],
  ["Nepal", "+977"],
  ["Saudi Arabia", "+966"],
  ["Qatar", "+974"],
  ["Malaysia", "+60"],
  ["Indonesia", "+62"],
  ["Japan", "+81"],
  ["South Korea", "+82"],
  ["South Africa", "+27"],
  ["Germany", "+49"],
  ["France", "+33"],
  ["Netherlands", "+31"],
  ["Spain", "+34"],
  ["Italy", "+39"],
];

function populateCountryCodes() {
  const selects = [
    ...document.querySelectorAll("select[data-phone-country]"),
    ...document
      .getElementById("dependent-template")
      .content.querySelectorAll("select[data-phone-country]"),
  ];
  selects.forEach((select) => {
    select.replaceChildren(
      ...PHONE_COUNTRIES.map(([country, code]) => {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = `${country} (${code})`;
        return option;
      })
    );
    select.value = "+91";
  });
}

function combinedPhone(countryCode, localNumber) {
  const entered = String(localNumber || "").trim();
  if (!entered) return "";
  if (entered.startsWith("+")) {
    return `+${entered.slice(1).replace(/\D/g, "")}`;
  }
  const localDigits = entered.replace(/\D/g, "").replace(/^0+/, "");
  return `${countryCode}${localDigits}`;
}

function splitPhone(phone) {
  const normalized = String(phone || "").trim();
  const match = [...PHONE_COUNTRIES]
    .sort((left, right) => right[1].length - left[1].length)
    .find(([, code]) => normalized.startsWith(code));
  if (!match) {
    return {
      countryCode: "+91",
      localNumber: normalized.replace(/\D/g, ""),
    };
  }
  return {
    countryCode: match[1],
    localNumber: normalized.slice(match[1].length),
  };
}

function setPhoneValue(countrySelect, localInput, phone) {
  const parsed = splitPhone(phone);
  countrySelect.value = parsed.countryCode;
  localInput.value = parsed.localNumber;
}

function dependentRows() {
  return Array.from(
    document.querySelectorAll("#dependents-list .dependent-editor")
  );
}

function updateDependentEditors() {
  const rows = dependentRows();
  rows.forEach((row, index) => {
    row.querySelector("[data-dependent-title]").textContent =
      `Dependent ${index + 1}`;
    row.querySelector("[data-remove-dependent]").hidden = rows.length === 1;
  });
  const accountHolder = document.querySelector("[data-account-holder-merchant]");
  if (
    rows.length > 0 &&
    !accountHolder.checked &&
    !rows.some((row) => row.querySelector("[data-dependent-merchant]").checked)
  ) {
    rows[0].querySelector("[data-dependent-merchant]").checked = true;
  }
  const selected = rows.find((row) =>
    row.querySelector("[data-dependent-merchant]").checked
  );
  const selectedPhone = accountHolder.checked
    ? combinedPhone(
        document.querySelector('[name="primaryParentCountryCode"]').value,
        document.querySelector('[name="primaryParentLocalPhone"]').value
      )
    : selected
      ? combinedPhone(
          selected.querySelector('[data-dependent-field="countryCode"]').value,
          selected.querySelector('[data-dependent-field="phone"]').value
        )
      : "";
  document.getElementById("merchant-dependent-phone").textContent =
    selectedPhone ? `(${selectedPhone})` : "";
}

function setOtherRelationshipVisibility(row) {
  const relationship = row.querySelector(
    '[data-dependent-field="relationshipToUser"]'
  );
  const otherLabel = row.querySelector("[data-other-relationship]");
  const otherInput = row.querySelector(
    '[data-dependent-field="otherRelationship"]'
  );
  const isOther = relationship.value === "Other dependent";
  otherLabel.hidden = !isOther;
  otherInput.required = isOther;
  if (!isOther) otherInput.value = "";
}

function addDependent(dependent = {}) {
  const template = document.getElementById("dependent-template");
  const row = template.content.firstElementChild.cloneNode(true);
  const name = row.querySelector('[data-dependent-field="name"]');
  const dependentPhone = row.querySelector('[data-dependent-field="phone"]');
  const dependentCountryCode = row.querySelector(
    '[data-dependent-field="countryCode"]'
  );
  const relationship = row.querySelector(
    '[data-dependent-field="relationshipToUser"]'
  );
  const otherRelationship = row.querySelector(
    '[data-dependent-field="otherRelationship"]'
  );
  const knownRelationships = Array.from(relationship.options).map(
    (option) => option.value
  );

  name.value = dependent.name || "";
  setPhoneValue(dependentCountryCode, dependentPhone, dependent.phone);
  if (
    dependent.relationshipToUser &&
    knownRelationships.includes(dependent.relationshipToUser)
  ) {
    relationship.value = dependent.relationshipToUser;
  } else if (dependent.relationshipToUser) {
    relationship.value = "Other dependent";
    otherRelationship.value = dependent.relationshipToUser;
  }
  row.querySelector("[data-dependent-merchant]").checked =
    dependent.isMerchantAuthSubject === true;

  relationship.addEventListener("change", () => {
    setOtherRelationshipVisibility(row);
    updateDependentEditors();
  });
  dependentPhone.addEventListener("input", updateDependentEditors);
  dependentCountryCode.addEventListener("change", updateDependentEditors);
  row
    .querySelector("[data-dependent-merchant]")
    .addEventListener("change", updateDependentEditors);
  row.querySelector("[data-remove-dependent]").addEventListener("click", () => {
    row.remove();
    updateDependentEditors();
  });

  document.getElementById("dependents-list").appendChild(row);
  setOtherRelationshipVisibility(row);
  updateDependentEditors();
}

function setDependentEditors(profile) {
  document.getElementById("dependents-list").replaceChildren();
  const dependents =
    profile?.dependents?.length > 0
      ? profile.dependents
      : profile?.dependentPhone
        ? [
            {
              name: profile.dependentName,
              phone: profile.dependentPhone,
              relationshipToUser: profile.dependentRelationship,
              isMerchantAuthSubject: true,
            },
          ]
        : [{}];
  dependents.forEach(addDependent);
  if (profile?.merchantAuthSubjectType === "account_holder") {
    document.querySelector("[data-account-holder-merchant]").checked = true;
  } else if (profile?.merchantAuthPhone) {
    const matchingRow = dependentRows().find(
      (row) =>
        combinedPhone(
          row.querySelector('[data-dependent-field="countryCode"]').value,
          row.querySelector('[data-dependent-field="phone"]').value
        ) === profile.merchantAuthPhone
    );
    if (matchingRow) {
      matchingRow.querySelector("[data-dependent-merchant]").checked = true;
    }
  }
  updateDependentEditors();
}

function collectFamilyPhoneInput(form) {
  const rows = dependentRows();
  const selected = rows.find((row) =>
    row.querySelector("[data-dependent-merchant]").checked
  );
  const dependents = rows.map((row) => {
    const relationship = row.querySelector(
      '[data-dependent-field="relationshipToUser"]'
    ).value;
    return {
      name: row.querySelector('[data-dependent-field="name"]').value,
      phone: combinedPhone(
        row.querySelector('[data-dependent-field="countryCode"]').value,
        row.querySelector('[data-dependent-field="phone"]').value
      ),
      relationshipToUser: relationship,
      ...(relationship === "Other dependent"
        ? {
            otherRelationship: row.querySelector(
              '[data-dependent-field="otherRelationship"]'
            ).value,
          }
        : {}),
    };
  });
  const primaryParentPhone = combinedPhone(
    form.elements.primaryParentCountryCode.value,
    form.elements.primaryParentLocalPhone.value
  );
  const accountHolderSelected = form.querySelector(
    "[data-account-holder-merchant]"
  ).checked;
  if (!accountHolderSelected && !selected) {
    throw new Error("Select a phone number for Zepto authentication.");
  }
  return {
    primaryParentPhone,
    secondaryParentPhone: form.elements.secondaryParentLocalPhone.value
      ? combinedPhone(
          form.elements.secondaryParentCountryCode.value,
          form.elements.secondaryParentLocalPhone.value
        )
      : null,
    dependents,
    merchantAuthPhone: accountHolderSelected
      ? primaryParentPhone
      : combinedPhone(
          selected.querySelector('[data-dependent-field="countryCode"]').value,
          selected.querySelector('[data-dependent-field="phone"]').value
        ),
    merchantAuthSubjectType: accountHolderSelected
      ? "account_holder"
      : "dependent",
  };
}

document
  .getElementById("add-dependent-btn")
  .addEventListener("click", () => addDependent());

function renderFamilyGroup(state) {
  const profile = state?.profile;
  const onboardingSummary = document.getElementById(
    "onboarding-family-summary"
  );
  onboardingSummary.hidden = !profile;

  document.querySelectorAll("[data-family-source]").forEach((element) => {
    element.textContent = profile
      ? `${profile.onboardingSource || "website"} onboarding`
      : "No profile";
  });

  document.querySelectorAll("[data-family-summary]").forEach((container) => {
    container.replaceChildren();
    if (!profile) {
      container.appendChild(
        familyMemberCard("Family group", "No family details yet", [
          "Complete onboarding in the browser or through LINQ.",
        ])
      );
      return;
    }

    container.appendChild(
      familyMemberCard("Account holder", profile.primaryParentName, [
        profile.primaryParentPhone,
        state.account?.email || null,
        profile.merchantAuthSubjectType === "account_holder"
          ? "Selected for Zepto authentication"
          : null,
      ])
    );
    if (profile.secondaryParentName || profile.secondaryParentPhone) {
      container.appendChild(
        familyMemberCard(
          "Second guardian",
          profile.secondaryParentName || "Guardian",
          [profile.secondaryParentPhone]
        )
      );
    }
    const dependents =
      profile.dependents?.length > 0
        ? profile.dependents
        : [
            {
              name: profile.dependentName,
              phone: profile.dependentPhone,
              relationshipToUser: profile.dependentRelationship,
              isMerchantAuthSubject:
                profile.merchantAuthSubjectType !== "account_holder",
            },
          ];
    dependents.forEach((dependent, index) => {
      container.appendChild(
        familyMemberCard(`Dependent ${index + 1}`, dependent.name, [
          dependent.phone,
          dependent.relationshipToUser,
          dependent.isMerchantAuthSubject
            ? "Selected for Zepto authentication"
            : null,
        ])
      );
    });
  });
}

function renderPaymentSummary(state) {
  const container = document.getElementById("family-payment-summary");
  const addButton = document.getElementById("add-tokenized-card-btn");
  addButton.disabled = !state?.paymentConfigured;
  addButton.title = state?.paymentConfigured
    ? "Open Prava card tokenization"
    : "Configure Prava keys in Vercel to enable card tokenization";
  container.replaceChildren();

  if (state?.paymentMethods?.length > 0) {
    state.paymentMethods.forEach((method) => {
      const line = document.createElement("div");
      line.className = "saved-card-line";
      line.textContent = `${String(method.brand || "Card").toUpperCase()} •••• ${
        method.last4
      } · expires ${method.expMonth}/${method.expYear}`;
      container.appendChild(line);
    });
    return;
  }

  container.textContent = state?.paymentConfigured
    ? "No card saved. You can add one securely through Prava."
    : "Card saving is unavailable until Prava is configured in Vercel.";
}

function renderZeptoAccount(state) {
  const connected = state?.merchantConnected === true;
  document.getElementById("zepto-connection-badge").textContent = connected
    ? "Connected"
    : "Not connected";
  document.getElementById("select-zepto-btn").textContent = connected
    ? "Open Zepto"
    : "Select Zepto";
  document.getElementById("reconnect-zepto-btn").hidden = !connected;
  document.getElementById("zepto-otp-row").hidden = connected;
  const authPhone =
    state?.profile?.merchantAuthPhone ||
    state?.profile?.dependentPhone ||
    state?.profile?.primaryParentPhone ||
    "";
  const phoneEnding = authPhone.replace(/\D/g, "").slice(-4);
  document.getElementById("zepto-auth-phone").textContent = phoneEnding
    ? connected
      ? `Saved authorization for the selected phone ending in ${phoneEnding}. No OTP is needed.`
      : `Zepto will authenticate the selected phone ending in ${phoneEnding}.`
    : "";
}

async function showOnboarding(state, options = {}) {
  onboardingState = state;
  const editingFamily = options.editingFamily === true;
  const paymentOnly = options.paymentOnly === true;
  const onboardingScreen = document.getElementById("onboarding-screen");
  onboardingScreen.classList.toggle("payment-focus", paymentOnly);
  onboardingScreen.classList.toggle("family-edit-focus", editingFamily);
  document.getElementById("onboarding-title").textContent = paymentOnly
    ? "Your secure shopper wallet"
    : editingFamily
      ? "Manage your family account"
      : "Set up your family account";
  document.getElementById("onboarding-copy").textContent = paymentOnly
    ? "Add a payment method in one focused, secure step."
    : editingFamily
      ? "Add dependents or update which family phone Zepto should authenticate."
      : "Tell your personal shopper who you’re shopping for.";
  document.getElementById("onboarding-back-btn").hidden =
    !editingFamily && !paymentOnly;
  document.getElementById("continue-family-btn").hidden =
    editingFamily || paymentOnly;
  document.getElementById("login-screen").classList.remove("active");
  document.getElementById("app-screen").classList.remove("active");
  onboardingScreen.classList.add("active");
  document.getElementById("payment-onboarding").hidden = true;
  renderFamilyGroup(state);

  if (paymentOnly) {
    setFormStatus("payment-status", "");
    await initializePaymentStep();
    return;
  }

  const profile = state.profile;
  const form = document.getElementById("family-profile-form");
  form.reset();
  if (profile) {
    ["primaryParentName", "secondaryParentName"].forEach((key) => {
      const value = profile[key];
      if (form.elements[key] && value !== null) form.elements[key].value = value;
    });
    setPhoneValue(
      form.elements.primaryParentCountryCode,
      form.elements.primaryParentLocalPhone,
      profile.primaryParentPhone
    );
    setPhoneValue(
      form.elements.secondaryParentCountryCode,
      form.elements.secondaryParentLocalPhone,
      profile.secondaryParentPhone
    );
    form.elements.merchantConsent.checked = state.merchantConsent.consented;
  }
  setDependentEditors(profile);

  if (
    !editingFamily &&
    state.profileComplete &&
    state.merchantConsent.consented
  ) {
    await initializePaymentStep();
  }
}

document.getElementById("family-profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.elements.merchantConsent.checked) {
    setFormStatus("profile-status", "Consent is required before Zepto authentication.", true);
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setFormStatus("profile-status", "Saving...");
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    delete data.merchantConsent;
    delete data.merchantAuthSubject;
    delete data.primaryParentCountryCode;
    delete data.primaryParentLocalPhone;
    delete data.secondaryParentCountryCode;
    delete data.secondaryParentLocalPhone;
    Object.assign(data, collectFamilyPhoneInput(form));
    onboardingState = await api("PUT", "/api/onboarding/profile", data);
    renderFamilyGroup(onboardingState);
    onboardingState = await api("PUT", "/api/onboarding/merchant-consent", {
      consented: true,
    });
    renderFamilyGroup(onboardingState);
    setFormStatus("profile-status", "Details and consent saved.");
    if (
      !document
        .getElementById("onboarding-screen")
        .classList.contains("family-edit-focus")
    ) {
      await initializePaymentStep();
    }
  } catch (error) {
    setFormStatus("profile-status", error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function initializePaymentStep() {
  const section = document.getElementById("payment-onboarding");
  section.hidden = false;
  const configured = Boolean(appConfig.pravaConfigured);
  document.getElementById("payment-unavailable-note").hidden = configured;
  document.getElementById("payment-controls").hidden = !configured;
}

function pravaCardError(error) {
  return error?.message || "Prava could not create a hosted card session";
}

async function saveCard() {
  if (!appConfig?.pravaConfigured) return;
  const button = document.getElementById("save-card-btn");
  button.disabled = true;
  button.textContent = "Creating Prava session";
  setFormStatus("payment-status", "Creating Prava’s hosted card setup...");
  try {
    pravaSession = await api(
      "POST",
      "/api/payments/tokenization-session"
    );
    if (!pravaSession.approvalUrl) {
      throw new Error("Prava did not return its hosted card setup URL");
    }
    window.open(pravaSession.approvalUrl, "_blank", "noopener,noreferrer");
    setFormStatus(
      "payment-status",
      "Complete card setup in the Prava tab, then return to Tokko."
    );
  } catch (error) {
    setFormStatus("payment-status", pravaCardError(error), true);
  } finally {
    button.disabled = false;
    button.textContent = "Open Prava hosted card setup";
  }
}

function continueWithoutCard() {
  finishOnboardingFlow();
}

async function openCardSetup() {
  if (!onboardingState?.paymentConfigured) return;
  onboardingReturnContext = {
    view:
      document.querySelector(".view.active")?.id.replace(/^view-/, "") ||
      "family",
    platformSlug: activePlatformSlug,
  };
  await showOnboarding(onboardingState, { paymentOnly: true });
}

async function editFamilyDetails() {
  onboardingReturnContext = {
    view: "family",
    platformSlug: activePlatformSlug,
  };
  await showOnboarding(onboardingState, { editingFamily: true });
}

function finishOnboardingFlow() {
  pravaSession = null;

  const returnContext = onboardingReturnContext;
  onboardingReturnContext = null;
  enterApp(onboardingState);

  if (returnContext?.platformSlug === "zepto") {
    activePlatformSlug = "zepto";
    setShoppingNavigation(true);
  }
  if (
    returnContext?.view &&
    (!["search", "cart", "orders"].includes(returnContext.view) ||
      activePlatformSlug === "zepto")
  ) {
    showView(returnContext.view);
  }
}

async function startZeptoConnection(isReconnect = false) {
  const button = document.getElementById(
    isReconnect ? "reconnect-zepto-btn" : "select-zepto-btn"
  );
  button.disabled = true;
  setFormStatus(
    "zepto-account-status",
    isReconnect ? "Requesting a new OTP from Zepto..." : "Requesting OTP from Zepto..."
  );
  try {
    const result = await api("POST", "/api/merchant/zepto/connect/start");
    merchantPendingId = result.pendingId;
    document.getElementById("zepto-otp-row").hidden = false;
    document.getElementById("zepto-otp-input").focus();
    setFormStatus(
      "zepto-account-status",
      `${isReconnect ? "New OTP" : "OTP"} sent to ${result.phone}. Enter it below.`
    );
  } catch (error) {
    setFormStatus("zepto-account-status", error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function verifyZeptoConnection() {
  const otpInput = document.getElementById("zepto-otp-input");
  const otp = otpInput.value.trim();
  if (!/^\d{6}$/.test(otp)) {
    setFormStatus("zepto-account-status", "Enter the complete 6-digit OTP.", true);
    return;
  }
  setFormStatus("zepto-account-status", "Connecting Zepto...");
  try {
    await api("POST", "/api/merchant/zepto/connect/verify", {
      pendingId: merchantPendingId,
      otp,
    });
    merchantPendingId = null;
    otpInput.value = "";
    document.getElementById("zepto-otp-row").hidden = true;
    onboardingState = await api("GET", "/api/me");
    renderZeptoAccount(onboardingState);
    setFormStatus("zepto-account-status", "Zepto account connected.");
    await openZeptoWorkspace();
  } catch (error) {
    setFormStatus("zepto-account-status", error.message, true);
  }
}

function setShoppingNavigation(enabled) {
  document.querySelectorAll(".platform-shopping-control").forEach((element) => {
    element.hidden = !enabled;
  });
}

async function selectPlatform(slug) {
  if (slug !== "zepto") {
    showStatus("This platform is not available yet", "error");
    return;
  }
  activePlatformSlug = slug;
  if (onboardingState?.merchantConnected) {
    await openZeptoWorkspace();
    return;
  }
  await startZeptoConnection();
}

async function reconnectZepto() {
  activePlatformSlug = "zepto";
  await startZeptoConnection(true);
}

async function openZeptoWorkspace() {
  activePlatformSlug = "zepto";
  setShoppingNavigation(true);
  showView("search");
  await loadAddresses();
  await refreshCartState();
}

// --- Enter App ---
function enterApp(state) {
  onboardingState = state;
  signedInAccount = state.account;
  phone =
    state.profile?.merchantAuthPhone ||
    state.profile?.dependentPhone ||
    state.profile?.primaryParentPhone ||
    "";
  document.getElementById("header-user").textContent =
    state.profile?.primaryParentName || state.account?.email || "";
  document.getElementById("header-email").textContent =
    state.account?.email || "";
  renderFamilyGroup(state);
  renderPaymentSummary(state);
  renderZeptoAccount(state);
  document.getElementById("login-screen").classList.remove("active");
  document.getElementById("onboarding-screen").classList.remove("active");
  document.getElementById("app-screen").classList.add("active");
  activePlatformSlug = null;
  onboardingReturnContext = null;
  setShoppingNavigation(false);
  showView("platforms");
}

async function logout() {
  phone = null;
  merchantPendingId = null;
  selectedAddressId = null;
  selectedCoordinates = null;
  cartItems = [];
  searchResultItems = [];
  checkoutSavedCard = null;
  checkoutPaymentState = {
    failures: 0,
    orderId: null,
    paymentLink: null,
    countedFailedOrders: new Set(),
  };
  activePlatformSlug = null;
  onboardingState = null;
  signedInAccount = null;
  try {
    await api("POST", "/api/auth/logout");
  } catch {
    // The local UI should still reset when a session has already expired.
  }
  document.getElementById("app-screen").classList.remove("active");
  document.getElementById("onboarding-screen").classList.remove("active");
  document.getElementById("login-screen").classList.add("active");
  document.getElementById("email-auth-form").reset();
  setAuthMode("login");
}

// --- Navigation ---
function showView(name) {
  if (name === "platforms") {
    activePlatformSlug = null;
    setShoppingNavigation(false);
    renderZeptoAccount(onboardingState);
  }
  if (
    ["search", "cart", "orders"].includes(name) &&
    activePlatformSlug !== "zepto"
  ) {
    showStatus("Select Zepto from Platforms first", "error");
    name = "platforms";
    setShoppingNavigation(false);
  }
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "cart") loadCart();
  if (name === "orders") loadOrders();
  if (name === "family") {
    renderFamilyGroup(onboardingState);
    renderPaymentSummary(onboardingState);
  }
}

// --- Addresses ---
function parseMcpAddressText(value) {
  const text = String(value || "");
  const [visibleText, internalText = ""] = text.split(/\n---\n/);
  const idsByNumber = new Map(
    Array.from(
      internalText.matchAll(
        /^(\d+)\.\s+"[^"]+"\s+(?:→|->)\s+ID:\s+"?([^"\s]+)"?/gm
      ),
      (match) => [match[1], match[2]]
    )
  );
  const addresses = Array.from(
    visibleText.matchAll(/^(\d+)\.\s+([^:\n]+):\s*(.+)$/gm),
    (match) => ({
      id: idsByNumber.get(match[1]) || null,
      label: match[2].trim(),
      formattedAddress: match[3].trim(),
    })
  );
  return {
    addresses,
    message: addresses.length > 0 ? null : visibleText.trim(),
  };
}

async function loadAddresses() {
  const select = document.getElementById("address-select");
  const addressList = document.getElementById("search-address-list");
  addressList.textContent = "Loading saved addresses from Zepto...";
  try {
    let data = await api("GET", "/api/addresses");
    if (typeof data === "string") {
      const parsed = parseMcpAddressText(data);
      if (parsed.addresses.length === 0) {
        select.innerHTML = '<option value="">No saved Zepto addresses</option>';
        addressList.textContent =
          parsed.message || "No saved addresses were returned by Zepto.";
        return;
      }
      data = parsed.addresses;
    }
    const addresses =
      data.addresses ||
      data.savedAddresses ||
      data.data?.addresses ||
      data.data ||
      data ||
      [];
    select.innerHTML = '<option value="">Select address...</option>';
    addressList.replaceChildren();
    if (!Array.isArray(addresses) || addresses.length === 0) {
      addressList.textContent = "No saved addresses were returned by Zepto.";
      return;
    }
    addresses.forEach((a) => {
      const addressId = a.id || a.addressId || a.userAddressId;
      const label = a.type || a.name || a.label || "Saved address";
      const formatted =
        a.shortAddress ||
        a.formattedAddress ||
        a.address ||
        a.displayAddress ||
        "";
      if (addressId) {
        const opt = document.createElement("option");
        opt.value = addressId;
        opt.textContent = `${label} - ${formatted}`.trim();
        select.appendChild(opt);
      }

      const item = document.createElement("div");
      item.className = "saved-address-item";
      const title = document.createElement("strong");
      title.textContent = label;
      const detail = document.createElement("span");
      detail.textContent = formatted;
      item.append(title, detail);
      if (addressId) {
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.addEventListener("click", async () => {
          await onAddressChange(addressId);
          select.value = addressId;
          addressList
            .querySelectorAll(".saved-address-item")
            .forEach((candidate) => candidate.classList.remove("selected"));
          item.classList.add("selected");
        });
        item.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") item.click();
        });
      }
      addressList.appendChild(item);
    });
    if (!selectedAddressId && addresses.length > 0) {
      const firstId =
        addresses[0].id ||
        addresses[0].addressId ||
        addresses[0].userAddressId;
      if (firstId) {
        await onAddressChange(firstId);
        select.value = firstId;
      }
    } else if (selectedAddressId) {
      select.value = selectedAddressId;
    }
  } catch (error) {
    console.error("Addresses:", error);
    select.innerHTML = '<option value="">Could not load Zepto addresses</option>';
    addressList.textContent = `Could not load addresses: ${error.message}`;
    setFormStatus("zepto-account-status", error.message, true);
  }
}

async function useCurrentLocation() {
  if (!onboardingState?.merchantConnected) {
    showStatus("Select and connect Zepto from Platforms first", "error");
    showView("platforms");
    return;
  }
  if (!navigator.geolocation) {
    showStatus("Location access is not supported by this browser", "error");
    return;
  }
  showStatus("Checking Zepto serviceability...");
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        selectedCoordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        const result = await api("POST", "/api/location/serviceability", {
          latitude: selectedCoordinates.latitude,
          longitude: selectedCoordinates.longitude,
        });
        selectedAddressId = "current-location";
        const select = document.getElementById("address-select");
        select.replaceChildren();
        const option = document.createElement("option");
        option.value = selectedAddressId;
        option.textContent = "Current location";
        select.appendChild(option);
        const message =
          result.message ||
          result.status ||
          (result.serviceable === false
            ? "This location is not serviceable"
            : "Current location selected");
        showStatus(String(message), result.serviceable === false ? "error" : "success");
      } catch (error) {
        showStatus(`Location check failed: ${error.message}`, "error");
      }
    },
    (error) => showStatus(`Location access failed: ${error.message}`, "error"),
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 300_000 }
  );
}

async function onAddressChange(forceId) {
  const id = forceId || document.getElementById("address-select").value;
  if (!id) return;
  try {
    await api("POST", "/api/addresses/select", { addressId: id });
    selectedAddressId = id;
    showStatus("Delivery address set", "success");
  } catch (e) { showStatus("Failed: " + e.message, "error"); }
}

function toggleAddressForm() {
  const m = document.getElementById("address-modal");
  const opening = m.style.display === "none";
  m.style.display = opening ? "flex" : "none";
  if (opening) {
    const form = document.getElementById("add-address-form");
    if (!form.elements.contactName.value) {
      form.elements.contactName.value =
        onboardingState?.profile?.primaryParentName || "";
    }
    if (!form.elements.contactNumber.value) {
      form.elements.contactNumber.value =
        onboardingState?.profile?.primaryParentPhone || phone || "";
    }
    setFormStatus("address-form-status", "");
  }
}

function browserCoordinates() {
  if (selectedCoordinates) return Promise.resolve(selectedCoordinates);
  if (!navigator.geolocation) {
    return Promise.reject(
      new Error("Location access is required to save a Zepto address")
    );
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        selectedCoordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        resolve(selectedCoordinates);
      },
      (error) =>
        reject(new Error(`Location access failed: ${error.message}`)),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 300_000 }
    );
  });
}

document.getElementById("add-address-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;
  setFormStatus("address-form-status", "Getting location and saving in Zepto...");
  const fd = new FormData(e.target);
  const body = {};
  for (const [k, v] of fd.entries()) if (v) body[k] = v;
  try {
    Object.assign(body, await browserCoordinates());
    await api("POST", "/api/addresses", body);
    showStatus("Address saved in Zepto", "success");
    e.target.reset();
    toggleAddressForm();
    await loadAddresses();
  } catch (err) {
    setFormStatus("address-form-status", err.message, true);
    showStatus("Address not saved: " + err.message, "error");
  } finally {
    button.disabled = false;
  }
});

// --- Search ---
function parseMcpProductText(value) {
  const text = String(value || "");
  const [visibleText, internalText = ""] = text.split(/\n---\n/);
  const idsByNumber = new Map(
    Array.from(
      internalText.matchAll(
        /^\[(\d+)\]\s+pvid:\s*([^,\s]+),\s*spid:\s*([^\s]+)/gm
      ),
      (match) => [
        match[1],
        {
          productVariantId: match[2],
          storeProductId: match[3],
        },
      ]
    )
  );
  const products = Array.from(
    visibleText.matchAll(
      /^(\d+)\.\s+(.+?)\s+-\s+₹([\d,.]+)\s+\((.+)\)$/gm
    ),
    (match) => ({
      name: match[2].trim(),
      priceRupees: Number(match[3].replace(/,/g, "")),
      packSize: match[4].trim(),
      ...(idsByNumber.get(match[1]) || {}),
    })
  );
  return {
    products,
    message: products.length > 0 ? null : visibleText.trim(),
  };
}

function productVariantId(product) {
  return product?.productVariantId || product?.pvid || product?.id || "";
}

function storeProductId(product) {
  return product?.storeProductId || product?.spid || "";
}

function cartQuantityFor(product) {
  const variantId = productVariantId(product);
  const match = cartItems.find(
    (item) => productVariantId(item) === variantId
  );
  return Number(match?.quantity || 0);
}

function productQuantityControl(product, quantity) {
  const controls = document.createElement("div");
  controls.className = "product-qty";

  const decrease = document.createElement("button");
  decrease.type = "button";
  decrease.textContent = "−";
  decrease.setAttribute(
    "aria-label",
    `Decrease ${product.name || product.label || "product"} quantity`
  );
  decrease.addEventListener("click", () =>
    setProductQuantity(product, Math.max(0, quantity - 1))
  );

  const count = document.createElement("span");
  count.textContent = String(quantity);
  count.setAttribute("aria-label", `Quantity ${quantity}`);

  const increase = document.createElement("button");
  increase.type = "button";
  increase.textContent = "+";
  increase.setAttribute(
    "aria-label",
    `Increase ${product.name || product.label || "product"} quantity`
  );
  increase.addEventListener("click", () =>
    setProductQuantity(product, quantity + 1)
  );

  controls.append(decrease, count, increase);
  return controls;
}

function renderProductResults() {
  const container = document.getElementById("search-results");
  container.replaceChildren();
  searchResultItems.forEach((product, index) => {
    const card = document.createElement("article");
    card.className = "product-card";
    card.style.setProperty("--product-index", String(index % 12));

    const media = document.createElement("div");
    media.className = "product-media";
    const suppliedImage = product.imageUrl || product.image;
    let usableImage = null;
    if (suppliedImage) {
      try {
        const parsedImage = new URL(suppliedImage, window.location.href);
        if (parsedImage.protocol === "https:") usableImage = parsedImage.href;
      } catch {
        // The visual fallback below is used for malformed product image URLs.
      }
    }
    const fallback = document.createElement("span");
    fallback.className = "product-image-fallback";
    fallback.textContent = (product.name || product.label || "P")
      .trim()
      .charAt(0)
      .toUpperCase();
    media.appendChild(fallback);
    if (usableImage) {
      const image = document.createElement("img");
      image.src = usableImage;
      image.alt = product.name || product.label || "Product";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("load", () => media.classList.add("image-ready"));
      image.addEventListener("error", () => image.remove());
      media.appendChild(image);
    }
    if (product.isAd) {
      const sponsored = document.createElement("span");
      sponsored.className = "product-sponsored";
      sponsored.textContent = "Sponsored";
      media.appendChild(sponsored);
    }
    card.appendChild(media);

    const name = document.createElement("div");
    name.className = "p-name";
    name.textContent = product.name || product.label || "Product";
    const size = document.createElement("div");
    size.className = "p-size";
    size.textContent = product.packSize || product.quantityLabel || "";
    const price = document.createElement("div");
    price.className = "p-price";
    price.textContent = formatProductPrice(product);
    const priceRow = document.createElement("div");
    priceRow.className = "product-price-row";
    priceRow.appendChild(price);

    if (product.mrp && product.mrp !== product.price) {
      const mrp = document.createElement("div");
      mrp.className = "p-mrp";
      mrp.textContent = formatPrice(product.mrp);
      priceRow.appendChild(mrp);
      const discount = Math.round(
        ((Number(product.mrp) - Number(product.price)) /
          Number(product.mrp)) *
          100
      );
      if (discount > 0) {
        const saving = document.createElement("span");
        saving.className = "product-saving";
        saving.textContent = `${discount}% off`;
        priceRow.appendChild(saving);
      }
    }

    card.append(name, size, priceRow);
    if (Number.isFinite(Number(product.availableQuantity))) {
      const availability = document.createElement("div");
      availability.className =
        Number(product.availableQuantity) > 0
          ? "product-availability"
          : "product-availability unavailable";
      availability.textContent =
        Number(product.availableQuantity) > 0
          ? `${Number(product.availableQuantity)} available`
          : "Currently unavailable";
      card.appendChild(availability);
    }

    const quantity = cartQuantityFor(product);
    if (quantity > 0) {
      card.appendChild(productQuantityControl(product, quantity));
    } else {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add-btn";
      add.textContent = "Add to Cart";
      add.addEventListener("click", () => setProductQuantity(product, 1));
      card.appendChild(add);
    }
    container.appendChild(card);
  });
}

async function searchProducts() {
  const q = document.getElementById("search-input").value.trim();
  if (!q) return;
  if (!onboardingState?.merchantConnected) {
    showStatus("Select and connect Zepto from Platforms first", "error");
    showView("platforms");
    return;
  }
  if (!selectedAddressId) { showStatus("Select a delivery address first", "error"); return; }
  const requestVersion = ++searchRequestVersion;
  const c = document.getElementById("search-results");
  const progress = document.getElementById("search-progress");
  const progressCopy = document.getElementById("search-progress-copy");
  const meta = document.getElementById("search-results-meta");
  searchResultItems = [];
  c.replaceChildren();
  meta.hidden = true;
  progress.hidden = false;
  progressCopy.textContent = `Searching Zepto for “${q}”...`;
  try {
    const seenProducts = new Set();
    let pageNumber = 0;
    let lastMessage = "";

    while (requestVersion === searchRequestVersion) {
      let data;
      try {
        data = await api(
          "GET",
          `/api/search?q=${encodeURIComponent(q)}&pageNumber=${pageNumber}`
        );
      } catch (error) {
        if (searchResultItems.length === 0) throw error;
        showStatus(
          `${searchResultItems.length} products loaded; Zepto could not return the next page`,
          "error"
        );
        break;
      }
      let products;
      if (typeof data === "string") {
        const parsed = parseMcpProductText(data);
        products = parsed.products;
        lastMessage = parsed.message || lastMessage;
      } else {
        products = data.products || data.items || data || [];
      }

      if (!Array.isArray(products) || products.length === 0) break;

      let newProducts = 0;
      for (const product of products) {
        const identity =
          productVariantId(product) ||
          `${product.name || product.label}:${product.packSize || ""}:${
            product.price ?? product.priceRupees ?? ""
          }`;
        if (seenProducts.has(identity)) continue;
        seenProducts.add(identity);
        searchResultItems.push(product);
        newProducts += 1;
      }

      if (newProducts === 0) break;
      renderProductResults();
      progressCopy.textContent =
        `${searchResultItems.length} matches found—checking Zepto for more...`;

      if (products.length < 10) break;
      pageNumber += 1;
    }

    if (requestVersion !== searchRequestVersion) return;
    if (searchResultItems.length === 0) {
      const message = document.createElement("div");
      message.className = "cart-empty";
      message.textContent = lastMessage || "No products found.";
      c.appendChild(message);
      return;
    }

    try {
      await refreshCartState();
    } catch {
      // Product results are still useful if the cart cannot be refreshed.
    }
    renderProductResults();
    meta.textContent =
      `${searchResultItems.length} Zepto ${
        searchResultItems.length === 1 ? "match" : "matches"
      } for “${q}”`;
    meta.hidden = false;
  } catch (e) {
    if (requestVersion !== searchRequestVersion) return;
    c.replaceChildren();
    const message = document.createElement("div");
    message.className = "cart-empty";
    message.textContent = `Search failed: ${e.message}`;
    c.appendChild(message);
  } finally {
    if (requestVersion === searchRequestVersion) progress.hidden = true;
  }
}

document.getElementById("search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchProducts(); });

function formatPrice(paisa) {
  if (!paisa && paisa !== 0) return "";
  const val = typeof paisa === "number" && paisa > 100 ? paisa / 100 : paisa;
  return "\u20B9" + Number(val).toFixed(2);
}

function formatProductPrice(product) {
  if (product?.priceRupees !== undefined) {
    return `₹${Number(product.priceRupees).toFixed(2)}`;
  }
  return formatPrice(product?.price || product?.sellingPrice);
}

// --- Cart ---
function parseMcpCartText(value) {
  const text = String(value || "");
  const items = Array.from(
    text.matchAll(
      /^[ \t]*(\d+)\.\s+(.+?)\s+-\s+₹([\d,.]+)\s+\(Qty:\s*([\d.]+)\)[ \t]*\r?\n[ \t]*pvid:\s*([^,\s]+),\s*spid:\s*([^\s]+)/gm
    ),
    (match) => ({
      name: match[2].trim(),
      label: match[2].trim(),
      priceRupees: Number(match[3].replace(/,/g, "")),
      quantity: Number(match[4]),
      productVariantId: match[5],
      storeProductId: match[6],
    })
  );
  return {
    items,
    message: items.length > 0 ? null : text.trim(),
  };
}

function normalizeCartItems(data) {
  if (typeof data === "string") return parseMcpCartText(data);
  const items = data?.items || data?.cartItems || data?.data?.items || data || [];
  return {
    items: Array.isArray(items) ? items : [],
    message: Array.isArray(items) ? null : "Zepto returned an unreadable cart.",
  };
}

function cartTotals() {
  return {
    products: cartItems.length,
    units: cartItems.reduce(
      (total, item) => total + Number(item.quantity || 0),
      0
    ),
  };
}

function updateCartIndicators() {
  const totals = cartTotals();
  document.getElementById("cart-count").textContent = String(totals.units);
  document.getElementById("cart-summary").textContent =
    `${totals.products} ${totals.products === 1 ? "product" : "products"} · ` +
    `${totals.units} ${totals.units === 1 ? "unit" : "units"}`;
}

function renderCartItems(message = null) {
  const container = document.getElementById("cart-items");
  container.replaceChildren();
  document.getElementById("checkout-section").style.display = "none";
  document.getElementById("cart-actions").style.display =
    cartItems.length > 0 ? "block" : "none";

  if (cartItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cart-empty";
    empty.textContent = message || "Your cart is empty.";
    container.appendChild(empty);
    return;
  }

  cartItems.forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "cart-item";
    if (item.imageUrl || item.image) {
      const image = document.createElement("img");
      image.src = item.imageUrl || item.image;
      image.alt = item.name || item.label || "Cart item";
      row.appendChild(image);
    }
    const info = document.createElement("div");
    info.className = "ci-info";
    const name = document.createElement("div");
    name.className = "ci-name";
    name.textContent = item.name || item.label || "Item";
    const price = document.createElement("div");
    price.className = "ci-price";
    price.textContent = formatProductPrice(item);
    info.append(name, price);

    const controls = document.createElement("div");
    controls.className = "ci-qty";
    const decrease = document.createElement("button");
    decrease.type = "button";
    decrease.textContent = "−";
    decrease.setAttribute("aria-label", `Decrease ${name.textContent} quantity`);
    decrease.addEventListener("click", () => changeQty(index, -1));
    const count = document.createElement("span");
    count.textContent = String(Number(item.quantity || 0));
    count.setAttribute(
      "aria-label",
      `Quantity ${Number(item.quantity || 0)}`
    );
    const increase = document.createElement("button");
    increase.type = "button";
    increase.textContent = "+";
    increase.setAttribute("aria-label", `Increase ${name.textContent} quantity`);
    increase.addEventListener("click", () => changeQty(index, 1));
    controls.append(decrease, count, increase);
    row.append(info, controls);
    container.appendChild(row);
  });
}

async function refreshCartState({ renderCart = false } = {}) {
  const data = await api("GET", "/api/cart");
  const normalized = normalizeCartItems(data);
  cartItems = normalized.items;
  updateCartIndicators();
  if (renderCart) renderCartItems(normalized.message);
  if (searchResultItems.length > 0) renderProductResults();
  return cartItems;
}

async function setProductQuantity(product, quantity) {
  const variantId = productVariantId(product);
  const storeId = storeProductId(product);
  if (!variantId || !storeId) {
    showStatus("Zepto did not return the product identifiers", "error");
    return;
  }
  const safeQuantity = Math.max(0, Number(quantity) || 0);
  const price =
    product.price ??
    product.sellingPrice ??
    (Number.isFinite(product.priceRupees)
      ? Math.round(product.priceRupees * 100)
      : undefined);
  try {
    await api("POST", "/api/cart", {
      deviceId: phone || "default",
      cartItems: [
        {
          productVariantId: variantId,
          storeProductId: storeId,
          quantity: safeQuantity,
          name: product.name || product.label || "Item",
          label: product.label || product.name || "Item",
          price,
          mrp: product.mrp,
          imageUrl: product.imageUrl || product.image,
          packSize: product.packSize || product.quantityLabel,
        },
      ],
    });
    await refreshCartState({
      renderCart: document.getElementById("view-cart").classList.contains("active"),
    });
    showStatus(
      safeQuantity === 0
        ? `${product.name || product.label || "Item"} removed from cart`
        : `Quantity updated to ${safeQuantity}`,
      "success"
    );
  } catch (error) {
    showStatus(`Cart update failed: ${error.message}`, "error");
  }
}

async function addToCart(product) {
  await setProductQuantity(product, cartQuantityFor(product) + 1);
}

async function loadCart() {
  const container = document.getElementById("cart-items");
  container.innerHTML = '<div class="loading"></div>';
  try {
    await refreshCartState({ renderCart: true });
  } catch (error) {
    cartItems = [];
    updateCartIndicators();
    renderCartItems(`Could not load cart: ${error.message}`);
  }
}

async function changeQty(index, delta) {
  const item = cartItems[index];
  if (!item) return;
  await setProductQuantity(
    item,
    Math.max(0, Number(item.quantity || 0) + delta)
  );
}

// --- Checkout ---
const MAX_ONLINE_PAYMENT_FAILURES = 3;

function responseText(data) {
  return typeof data === "string" ? data : JSON.stringify(data || {});
}

function previewAmount(data) {
  const match = responseText(data).match(/Amount To Pay:\s*₹\s*([\d,.]+)/i);
  return match ? `₹${match[1]}` : "the displayed total";
}

function onlineOrderDetails(data) {
  const text = responseText(data);
  const orderId =
    data?.orderId ||
    data?.order_id ||
    data?.data?.orderId ||
    text.match(/Order\s*ID:\s*\**\s*([A-Za-z0-9_-]+)/i)?.[1] ||
    null;
  const suppliedLink =
    data?.paymentLink ||
    data?.paymentUrl ||
    data?.payment_url ||
    data?.url ||
    data?.data?.paymentLink ||
    null;
  const matchedLink = text.match(/https?:\/\/[^\s<>"']+/i)?.[0] || null;
  const paymentLink = String(suppliedLink || matchedLink || "")
    .replace(/[)\].,]+$/, "");
  return {
    orderId,
    paymentLink: /^https:\/\//i.test(paymentLink) ? paymentLink : null,
  };
}

function paymentStatusFrom(data) {
  const direct =
    data?.paymentStatus ||
    data?.status ||
    data?.data?.paymentStatus ||
    data?.data?.status;
  if (direct) return String(direct).toUpperCase();
  const text = responseText(data).toUpperCase();
  return (
    ["CANCELLED", "CANCELED", "FAILED", "SUCCESS", "COMPLETED", "PAID", "PENDING", "PROCESSING"]
      .find((status) => text.includes(status)) || "UNKNOWN"
  );
}

function resetCheckoutPaymentState() {
  checkoutPaymentState = {
    failures: 0,
    orderId: null,
    paymentLink: null,
    countedFailedOrders: new Set(),
  };
  document.getElementById("online-payment-actions").hidden = true;
  document.getElementById("online-payment-link").href = "#";
  document.getElementById("online-payment-btn").textContent =
    "Pay Online (UPI / Cards / Wallets)";
}

async function checkout() {
  if (!selectedAddressId) { showStatus("Select a delivery address first", "error"); return; }
  document.getElementById("checkout-section").style.display = "block";
  const methodsContainer = document.getElementById("payment-methods");
  const note = document.getElementById("checkout-payment-note");
  const addCardButton = document.getElementById("add-checkout-card-btn");
  const onlineButton = document.getElementById("online-payment-btn");
  methodsContainer.innerHTML = '<div class="loading"></div>';
  setFormStatus("checkout-status", "");
  resetCheckoutPaymentState();
  try {
    const [saved, zeptoMethods] = await Promise.all([
      api("GET", "/api/payments/payment-methods"),
      api("GET", "/api/payment-methods"),
    ]);
    const savedMethods = saved.paymentMethods || [];
    checkoutSavedCard =
      savedMethods.find((method) => method.isDefault) || savedMethods[0] || null;
    methodsContainer.replaceChildren();
    if (checkoutSavedCard) {
      const card = document.createElement("div");
      card.className = "saved-card-line checkout-saved-card";
      card.textContent =
        `${String(checkoutSavedCard.brand || "Card").toUpperCase()} •••• ` +
        `${checkoutSavedCard.last4} · expires ${checkoutSavedCard.expMonth}/` +
        `${checkoutSavedCard.expYear}`;
      methodsContainer.appendChild(card);
    } else {
      methodsContainer.textContent = "No saved card.";
    }

    const onlineAvailable = responseText(zeptoMethods).includes(
      "Pay Online (UPI / Cards / Wallets)"
    );
    addCardButton.hidden = Boolean(checkoutSavedCard);
    addCardButton.disabled = !onboardingState?.paymentConfigured;
    onlineButton.disabled = !checkoutSavedCard || !onlineAvailable;
    note.textContent = checkoutSavedCard
      ? "Preferred saved card selected. Zepto does not accept external Prava enrollments, " +
        "so its secure payment page will ask you to enter the card again. After three " +
        "confirmed failed or cancelled attempts, checkout falls back to Cash on Delivery."
      : onboardingState?.paymentConfigured
        ? "Add and tokenize a card with Prava before choosing online payment."
        : "Card saving is unavailable until Prava keys are configured in Vercel. " +
          "Cash on Delivery remains available.";
  } catch (error) {
    methodsContainer.textContent = `Could not load payment methods: ${error.message}`;
    note.textContent = "";
    onlineButton.disabled = true;
  }
}

async function startOnlineCheckout() {
  if (!checkoutSavedCard) {
    setFormStatus("checkout-status", "Add a saved card first.", true);
    return;
  }
  const onlineButton = document.getElementById("online-payment-btn");
  onlineButton.disabled = true;
  setFormStatus("checkout-status", "Preparing online-payment preview...");
  try {
    await api("GET", "/api/payment-methods");
    const preview = await api("POST", "/api/order/online", {
      userAddressId: selectedAddressId,
      confirmOrder: false,
      useZeptoCash: false,
      riderTip: 0,
    });
    const confirmed = confirm(
      `Pay ${previewAmount(preview)} using Pay Online (UPI / Cards / Wallets)?\n\n` +
      `Preferred card: ${String(checkoutSavedCard.brand || "Card").toUpperCase()} ` +
      `ending ${checkoutSavedCard.last4}.\n\n` +
      "Zepto will ask you to enter the card on its secure page. If three distinct " +
      "payment attempts reach FAILED or CANCELLED, this order will fall back to " +
      "Cash on Delivery."
    );
    if (!confirmed) {
      onlineButton.disabled = false;
      setFormStatus("checkout-status", "Online checkout cancelled.");
      return;
    }
    await createOnlinePaymentAttempt();
  } catch (error) {
    onlineButton.disabled = false;
    setFormStatus("checkout-status", `Could not start checkout: ${error.message}`, true);
  }
}

async function createOnlinePaymentAttempt() {
  const attemptNumber = checkoutPaymentState.failures + 1;
  const onlineButton = document.getElementById("online-payment-btn");
  onlineButton.disabled = true;
  setFormStatus(
    "checkout-status",
    `Creating online payment attempt ${attemptNumber} of ${MAX_ONLINE_PAYMENT_FAILURES}...`
  );
  try {
    const result = await api("POST", "/api/order/online", {
      userAddressId: selectedAddressId,
      confirmOrder: true,
      useZeptoCash: false,
      riderTip: 0,
    });
    const details = onlineOrderDetails(result);
    if (!details.orderId) {
      const error = new Error(
        "Zepto created an online-payment response without an order ID. " +
        "Check Orders before retrying."
      );
      error.unsafeToRetry = true;
      throw error;
    }
    checkoutPaymentState.orderId = details.orderId;
    checkoutPaymentState.paymentLink = details.paymentLink;
    const actions = document.getElementById("online-payment-actions");
    const link = document.getElementById("online-payment-link");
    actions.hidden = false;
    link.hidden = !details.paymentLink;
    if (details.paymentLink) link.href = details.paymentLink;
    setFormStatus(
      "checkout-status",
      details.paymentLink
        ? "Open Zepto secure payment, complete the card payment, then check its status."
        : "Online order created. Check payment status before taking any other action."
    );
    await checkOnlinePaymentStatus({ initialCheck: true });
  } catch (error) {
    onlineButton.disabled = error.unsafeToRetry === true;
    setFormStatus(
      "checkout-status",
      `Online-payment attempt was not confirmed: ${error.message}`,
      true
    );
  }
}

async function checkOnlinePaymentStatus({ initialCheck = false } = {}) {
  const orderId = checkoutPaymentState.orderId;
  if (!orderId) {
    setFormStatus("checkout-status", "No online order is awaiting payment.", true);
    return;
  }
  if (!initialCheck) {
    setFormStatus("checkout-status", "Checking Zepto payment status...");
  }
  try {
    const result = await api("POST", "/api/order/payment-status", {
      orderId,
      poll: false,
    });
    const status = paymentStatusFrom(result);
    if (["SUCCESS", "COMPLETED", "PAID"].includes(status)) {
      document.getElementById("online-payment-actions").hidden = true;
      setFormStatus("checkout-status", "Online payment succeeded. Order placed.");
      showStatus("Online payment succeeded", "success");
      await refreshCartState({ renderCart: true });
      return;
    }

    if (["FAILED", "CANCELLED", "CANCELED"].includes(status)) {
      if (!checkoutPaymentState.countedFailedOrders.has(orderId)) {
        checkoutPaymentState.countedFailedOrders.add(orderId);
        checkoutPaymentState.failures += 1;
      }
      document.getElementById("online-payment-actions").hidden = true;
      checkoutPaymentState.orderId = null;
      checkoutPaymentState.paymentLink = null;
      if (checkoutPaymentState.failures >= MAX_ONLINE_PAYMENT_FAILURES) {
        setFormStatus(
          "checkout-status",
          "Three online-payment attempts failed. Falling back to Cash on Delivery..."
        );
        await placeCodOrder({ fallback: true });
        return;
      }
      const remaining =
        MAX_ONLINE_PAYMENT_FAILURES - checkoutPaymentState.failures;
      const onlineButton = document.getElementById("online-payment-btn");
      onlineButton.disabled = false;
      onlineButton.textContent =
        `Retry Pay Online (UPI / Cards / Wallets) · ${remaining} left`;
      setFormStatus(
        "checkout-status",
        `Payment ${status.toLowerCase()}. ${remaining} online attempt` +
          `${remaining === 1 ? "" : "s"} remain.`,
        true
      );
      return;
    }

    setFormStatus(
      "checkout-status",
      status === "UNKNOWN"
        ? "Zepto did not return a definitive payment status. Check again; COD fallback is disabled until failure is confirmed."
        : `Payment is ${status.toLowerCase()}. Complete payment and check again.`
    );
  } catch (error) {
    setFormStatus(
      "checkout-status",
      `Payment status could not be verified: ${error.message}. No COD order was created.`,
      true
    );
  }
}

async function placeCodOrder({ fallback = false } = {}) {
  if (!selectedAddressId) {
    setFormStatus("checkout-status", "Select an address first.", true);
    return;
  }
  const codButton = document.getElementById("cod-payment-btn");
  codButton.disabled = true;
  try {
    await api("GET", "/api/payment-methods");
    const preview = await api("POST", "/api/order", {
      userAddressId: selectedAddressId,
      confirmOrder: false,
      useZeptoCash: false,
      riderTip: 0,
    });
    if (
      !fallback &&
      !confirm(
        `Place a ${previewAmount(preview)} order using Cash on Delivery?`
      )
    ) {
      setFormStatus("checkout-status", "Cash on Delivery cancelled.");
      return;
    }
    await api("POST", "/api/order", {
      userAddressId: selectedAddressId,
      confirmOrder: true,
      useZeptoCash: false,
      riderTip: 0,
    });
    document.getElementById("online-payment-actions").hidden = true;
    setFormStatus(
      "checkout-status",
      fallback
        ? "Online payment failed three times. Cash on Delivery order placed."
        : "Cash on Delivery order placed."
    );
    showStatus("Order placed with Cash on Delivery", "success");
    await refreshCartState({ renderCart: true });
  } catch (error) {
    setFormStatus(
      "checkout-status",
      `${fallback ? "COD fallback" : "Cash on Delivery"} failed: ${error.message}`,
      true
    );
  } finally {
    codButton.disabled = false;
  }
}

// --- Orders ---
async function loadOrders() {
  const c = document.getElementById("order-list");
  c.innerHTML = '<div class="loading"></div>';
  try {
    const data = await api("GET", "/api/orders");
    const orders = data.orders || data || [];
    if (!Array.isArray(orders) || orders.length === 0) { c.innerHTML = '<div class="cart-empty">No orders yet.</div>'; return; }
    c.innerHTML = orders.map((o) => `
      <div class="order-card">
        <div><span class="o-id">Order #${o.id || o.orderId || "?"}</span>
        <span class="o-status ${(o.status || "").toLowerCase()}">${o.status || "Unknown"}</span></div>
        <div class="o-items">${Array.isArray(o.items) ? o.items.map((i) => i.name || i.label).join(", ") : o.itemCount ? o.itemCount + " items" : ""}</div>
        <div class="o-total">${formatPrice(o.total || o.orderTotal)}</div>
      </div>`).join("");
  } catch (e) { c.innerHTML = `<div class="cart-empty">Error: ${e.message}</div>`; }
}

// --- Init ---
populateCountryCodes();
document
  .querySelector("[data-account-holder-merchant]")
  .addEventListener("change", updateDependentEditors);
document
  .querySelector('[name="primaryParentCountryCode"]')
  .addEventListener("change", updateDependentEditors);
document
  .querySelector('[name="primaryParentLocalPhone"]')
  .addEventListener("input", updateDependentEditors);
setDependentEditors(null);

(async function init() {
  const authVersionAtStart = authActionVersion;
  setLoginStatus("Checking your session...");
  try {
    const response = await fetch("/api/config");
    appConfig = await response.json();
    if (!response.ok) throw new Error(appConfig.error || "Could not load configuration");
    if (authActionVersion !== authVersionAtStart) return;
    const session = await fetch("/api/auth/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (authActionVersion !== authVersionAtStart) return;
    if (session.ok) {
      const result = await session.json();
      signedInAccount = result.account;
      await onSignedIn();
    } else {
      setLoginStatus("");
      setAuthMode("login");
    }
  } catch (error) {
    if (authActionVersion !== authVersionAtStart) return;
    setLoginStatus("");
    setLoginError(error.message);
  }
})();
