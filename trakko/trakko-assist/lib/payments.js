const SANDBOX_API_BASE = "https://sandbox.api.prava.space";
const PRODUCTION_API_BASE = "https://api.prava.space";

function httpError(status, message, details) {
  return Object.assign(new Error(message), { status, details });
}

function environmentFromKey(value) {
  const key = String(value || "");
  if (/_test_/.test(key)) return "sandbox";
  if (/_live_/.test(key)) return "production";
  return null;
}

function configuration() {
  const publishableKey = String(process.env.PRAVA_PUBLISHABLE_KEY || "").trim();
  const secretKey = String(process.env.PRAVA_SECRET_KEY || "").trim();
  const publishableEnvironment = environmentFromKey(publishableKey);
  const secretEnvironment = environmentFromKey(secretKey);
  const environment =
    publishableEnvironment &&
    publishableEnvironment === secretEnvironment
      ? publishableEnvironment
      : null;
  return {
    publishableKey,
    secretKey,
    environment,
    configured: Boolean(publishableKey && secretKey && environment),
  };
}

function requireConfiguration() {
  const value = configuration();
  if (!value.publishableKey || !value.secretKey) {
    throw httpError(
      503,
      "Prava card tokenization is disabled for this deployment"
    );
  }
  if (!value.environment) {
    throw httpError(
      503,
      "Prava publishable and secret keys must belong to the same environment"
    );
  }
  return value;
}

function apiBaseUrl() {
  const configured = String(process.env.PRAVA_API_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;
  return requireConfiguration().environment === "production"
    ? PRODUCTION_API_BASE
    : SANDBOX_API_BASE;
}

async function pravaRequest(
  pathname,
  { method = "GET", body, query } = {}
) {
  const { secretKey } = requireConfiguration();
  const url = new URL(`${apiBaseUrl()}${pathname}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data =
    response.status === 204
      ? {}
      : await response.json().catch(() => ({}));
  if (!response.ok) {
    const responseId = response.headers.get("x-response-id");
    const message =
      data?.error?.message ||
      data?.message ||
      `Prava request failed (${response.status})`;
    throw httpError(
      response.status >= 400 && response.status < 500
        ? response.status
        : 502,
      responseId ? `${message} (Prava response ${responseId})` : message,
      data
    );
  }
  return data;
}

function enrollmentAmount() {
  const value = String(process.env.PRAVA_CARD_ENROLLMENT_AMOUNT || "1.00");
  if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0) {
    throw httpError(
      503,
      "PRAVA_CARD_ENROLLMENT_AMOUNT must be a positive decimal amount"
    );
  }
  return Number(value).toFixed(2);
}

function enrollmentCurrency() {
  const value = String(
    process.env.PRAVA_CARD_ENROLLMENT_CURRENCY || "INR"
  )
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    throw httpError(
      503,
      "PRAVA_CARD_ENROLLMENT_CURRENCY must be an ISO 4217 currency code"
    );
  }
  return value;
}

function decimalAmount(value, label = "amount") {
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw httpError(400, `${label} must be a positive decimal amount`);
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    throw httpError(
      400,
      `${label} must be greater than zero and no more than 1000000`
    );
  }
  return amount.toFixed(2);
}

function providerIdentifier(value, label) {
  const identifier = String(value || "").trim();
  if (
    !identifier
    || identifier.length > 255
    || !/^[A-Za-z0-9_-]+$/.test(identifier)
  ) {
    throw httpError(400, `${label} is invalid`);
  }
  return identifier;
}

function sessionPurchaseContext(value, totalAmount, options = {}) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw httpError(
      400,
      "Prava purchase context must contain exactly one merchant"
    );
  }
  const source = value[0] || {};
  const merchant = source.merchant_details || {};
  const merchantName = String(merchant.name || "").trim();
  const merchantUrl = String(merchant.url || "").trim();
  const countryCode = String(merchant.country_code_iso2 || "")
    .trim()
    .toUpperCase();
  if (!merchantName) {
    throw httpError(400, "Prava merchant name is required");
  }
  if (!/^https:\/\//i.test(merchantUrl)) {
    throw httpError(400, "Prava merchant URL must use HTTPS");
  }
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw httpError(400, "Prava merchant country must be an ISO country code");
  }
  const products = Array.isArray(source.product_details)
    ? source.product_details
    : [];
  if (!products.length) {
    throw httpError(400, "Prava purchase context needs at least one product");
  }
  const normalizedProducts = products.map((product, index) => {
    const quantity = Number(product?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw httpError(
        400,
        `Prava product ${index + 1} quantity must be a positive integer`
      );
    }
    return {
      ...product,
      description:
        String(product?.description || "").trim()
        || `${merchantName} order item ${index + 1}`,
      unit_price: decimalAmount(
        product?.unit_price,
        `Prava product ${index + 1} unit price`
      ),
      quantity,
    };
  });
  const totalMinor = Math.round(Number(totalAmount) * 100);
  const productMinor = normalizedProducts.reduce(
    (sum, product) =>
      sum + Math.round(Number(product.unit_price) * 100) * product.quantity,
    0
  );
  const productDetails = productMinor === totalMinor
    ? normalizedProducts
    : [{
        description: `${merchantName} merchant quote total including charges`,
        unit_price: totalAmount,
        quantity: 1,
      }];
  return [{
    merchant_details: {
      ...merchant,
      name: merchantName,
      url: merchantUrl,
      country_code_iso2: countryCode,
    },
    product_details: productDetails,
    ...(Number.isInteger(options.effectiveUntilMinutes)
      && options.effectiveUntilMinutes > 0
      ? { effective_until_minutes: options.effectiveUntilMinutes }
      : {}),
  }];
}

async function createTokenizationSession({
  customerId,
  email,
  merchantUrl,
  callbackUrl,
}) {
  const amount = enrollmentAmount();
  const countryCode = String(
    process.env.PRAVA_MERCHANT_COUNTRY_CODE || "IN"
  )
    .trim()
    .toUpperCase();
  const data = await pravaRequest("/v1/sessions", {
    method: "POST",
    body: {
      user_id: customerId,
      user_email: email,
      total_amount: amount,
      currency: enrollmentCurrency(),
      integration_type: "full_checkout",
      callback_url: callbackUrl,
      effective_until_minutes: 15,
      external_order_ref: `tokko_card_enrollment_${Date.now()}`,
      description:
        "Authorize and save a card for Tokko. No purchase is made.",
      mandate_setup: {
        intent: "mandate_setup",
        recurring_frequency: "one_time",
        merchant_scope: "listed",
        max_charges: 1,
      },
      purchase_context: [
        {
          merchant_details: {
            name: process.env.PRAVA_MERCHANT_NAME || "Tokko",
            url: merchantUrl,
            country_code_iso2: countryCode,
          },
          product_details: [
            {
              description: "Tokko secure card enrollment",
              unit_price: amount,
              quantity: 1,
            },
          ],
        },
      ],
    },
  });
  if (
    typeof data.session_id !== "string" ||
    typeof data.iframe_url !== "string"
  ) {
    throw httpError(502, "Prava returned an incomplete tokenization session");
  }
  return {
    provider: "prava",
    sessionId: data.session_id,
    approvalUrl: data.iframe_url,
    expiresAt: data.expires_at || null,
  };
}

function mandateCurrency() {
  const value = String(
    process.env.PRAVA_MANDATE_CURRENCY || "INR"
  ).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    throw httpError(
      503,
      "PRAVA_MANDATE_CURRENCY must be an ISO 4217 currency code"
    );
  }
  return value;
}

function mandateFrequency(value) {
  const frequency = String(value || "monthly").trim().toLowerCase();
  if (!["weekly", "monthly", "yearly"].includes(frequency)) {
    throw httpError(
      400,
      "frequency must be weekly, monthly, or yearly"
    );
  }
  return frequency;
}

function mandateMaxCharges(frequency) {
  if (frequency === "weekly") return 52;
  if (frequency === "yearly") return 5;
  return 24;
}

function mandateDurationMinutes(frequency) {
  if (frequency === "weekly") return 365 * 24 * 60;
  if (frequency === "yearly") return 5 * 365 * 24 * 60;
  return 2 * 365 * 24 * 60;
}

async function createMandateSession({
  customerId,
  email,
  cardId,
  amount,
  frequency = "monthly",
  callbackUrl,
  currency = mandateCurrency(),
  purchaseContext = null,
  externalOrderRef = null,
  description = null,
}) {
  const approvedAmount = decimalAmount(amount, "Mandate amount");
  const recurringFrequency = mandateFrequency(frequency);
  const durationMinutes = mandateDurationMinutes(recurringFrequency);
  const validUntil = new Date(
    Date.now() + durationMinutes * 60 * 1000
  ).toISOString();
  const merchantName =
    process.env.PRAVA_ZEPTO_MERCHANT_NAME || "Zepto";
  const merchantUrl =
    process.env.PRAVA_ZEPTO_MERCHANT_URL || "https://www.zeptonow.com";
  const countryCode = String(
    process.env.PRAVA_ZEPTO_MERCHANT_COUNTRY_CODE || "IN"
  ).trim().toUpperCase();
  if (!/^https:\/\//i.test(merchantUrl)) {
    throw httpError(
      503,
      "PRAVA_ZEPTO_MERCHANT_URL must be an HTTPS URL"
    );
  }
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw httpError(
      503,
      "PRAVA_ZEPTO_MERCHANT_COUNTRY_CODE must be an ISO country code"
    );
  }
  const requestedPurchaseContext = Array.isArray(purchaseContext)
    && purchaseContext.length
    ? purchaseContext
    : [
        {
          merchant_details: {
            name: merchantName,
            url: merchantUrl,
            country_code_iso2: countryCode,
          },
          product_details: [
            {
              description: "Zepto shopping mandate",
              unit_price: approvedAmount,
              quantity: 1,
            },
          ],
        },
      ];
  const data = await pravaRequest("/v1/sessions", {
    method: "POST",
    body: {
      user_id: customerId,
      user_email: email,
      total_amount: approvedAmount,
      currency: String(currency || mandateCurrency()).trim().toUpperCase(),
      integration_type: "full_checkout",
      callback_url: callbackUrl,
      card: {
        card_id: cardId,
      },
      external_order_ref:
        externalOrderRef || `tokko_zepto_mandate_${Date.now()}`,
      description:
        description || "Authorize card payments for future shopping within this cap.",
      mandate_setup: {
        intent: "mandate_setup",
        recurring_frequency: recurringFrequency,
        merchant_scope: "listed",
        max_charges: mandateMaxCharges(recurringFrequency),
        valid_until: validUntil,
      },
      purchase_context: sessionPurchaseContext(
        requestedPurchaseContext,
        approvedAmount,
        { effectiveUntilMinutes: durationMinutes }
      ),
    },
  });
  if (
    typeof data.session_id !== "string"
    || typeof data.iframe_url !== "string"
  ) {
    throw httpError(502, "Prava returned an incomplete mandate session");
  }
  return {
    provider: "prava",
    sessionId: data.session_id,
    approvalUrl: data.iframe_url,
    expiresAt: data.expires_at || null,
    authorizeOnly: data.authorizeOnly === true,
    amount: approvedAmount,
    currency: String(currency || mandateCurrency()).trim().toUpperCase(),
    frequency: recurringFrequency,
  };
}

async function createPaymentSession({
  customerId,
  email,
  cardId,
  amount,
  callbackUrl,
  purchaseContext,
  externalOrderRef,
  currency = mandateCurrency(),
}) {
  const totalAmount = decimalAmount(amount, "Payment amount");
  const normalizedPurchaseContext = sessionPurchaseContext(
    purchaseContext,
    totalAmount
  );
  const data = await pravaRequest("/v1/sessions", {
    method: "POST",
    body: {
      user_id: providerIdentifier(customerId, "Prava customer ID"),
      user_email: String(email || "").trim(),
      total_amount: totalAmount,
      currency: String(currency || mandateCurrency()).trim().toUpperCase(),
      integration_type: "full_checkout",
      callback_url: String(callbackUrl || "").trim(),
      card: {
        card_id: providerIdentifier(cardId, "Prava card ID"),
      },
      external_order_ref: providerIdentifier(
        externalOrderRef,
        "External order reference"
      ),
      description: "Authorize this merchant card payment with Prava.",
      purchase_context: normalizedPurchaseContext,
    },
  });
  if (
    typeof data.session_id !== "string"
    || typeof data.iframe_url !== "string"
  ) {
    throw httpError(502, "Prava returned an incomplete payment session");
  }
  return {
    provider: "prava",
    sessionId: data.session_id,
    approvalUrl: data.iframe_url,
    orderId: data.order_id || null,
    expiresAt: data.expires_at || null,
    amount: totalAmount,
    currency: String(currency || mandateCurrency()).trim().toUpperCase(),
  };
}

function safeMandate(value) {
  const id = String(
    value?.id || value?.mandateId || value?.mandate_id || ""
  ).trim();
  if (!id) return null;
  const lastCharge = value.lastCharge || value.last_charge;
  const charges = Array.isArray(value.charges) ? value.charges : [];
  return {
    id,
    status: String(value.status || "pending").toLowerCase(),
    state: String(value.state || "").toLowerCase() || null,
    frequency:
      String(
        value.recurringFrequency
        || value.recurring_frequency
        || value.frequency
        || "one_time"
      ).toLowerCase(),
    merchantScope: value.merchantScope || value.merchant_scope || null,
    merchantName: value.merchantName || value.merchant_name || null,
    approvedAmount: String(
      value.approvedAmount ?? value.approved_amount ?? value.amount ?? "0"
    ),
    remaining: String(
      value.remaining
      ?? value.remainingAmount
      ?? value.remaining_amount
      ?? value.approvedAmount
      ?? value.approved_amount
      ?? value.amount
      ?? "0"
    ),
    currency: String(value.currency || mandateCurrency()).toUpperCase(),
    validUntil: value.validUntil || value.valid_until || null,
    renewsAt: value.renewsAt || value.renews_at || null,
    ...((value.createdAt || value.created_at)
      ? { createdAt: value.createdAt || value.created_at }
      : {}),
    ...((value.updatedAt || value.updated_at)
      ? { updatedAt: value.updatedAt || value.updated_at }
      : {}),
    lastCharge: lastCharge
      ? {
          status: lastCharge.status || null,
          at: lastCharge.at || lastCharge.createdAt || lastCharge.created_at || null,
        }
      : null,
    ...(value.spent !== undefined && value.spent !== null
      ? { spent: String(value.spent) }
      : {}),
    ...((value.chargeCount ?? value.charge_count) !== undefined
      && (value.chargeCount ?? value.charge_count) !== null
      ? { chargeCount: Number(value.chargeCount ?? value.charge_count) }
      : {}),
    ...(charges.length
      ? {
          charges: charges.map((charge) => ({
            transactionId:
              charge.transactionId || charge.transaction_id || null,
            amount: charge.amount ? String(charge.amount) : null,
            currency: charge.currency || null,
            status: charge.status || null,
            reference: charge.reference || null,
            createdAt: charge.createdAt || charge.created_at || null,
          })),
        }
      : {}),
  };
}

function mandateRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.mandates)) return data.mandates;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.mandates)) return data.data.mandates;
  return [];
}

async function listMandates(customerId) {
  let data;
  let lastError;
  let unfiltered = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      data = await pravaRequest("/v1/mandates", {
        query: {
          customer_id: customerId,
          standing_only: "true",
        },
      });
      break;
    } catch (error) {
      lastError = error;
      const transient = error?.status === 429 || Number(error?.status) >= 500;
      if (!transient || attempt === 2) break;
      await new Promise((resolve) =>
        setTimeout(resolve, attempt === 0 ? 150 : 500)
      );
    }
  }
  if (!data && lastError) {
    try {
      data = await pravaRequest("/v1/mandates", {
        query: { customer_id: customerId },
      });
      unfiltered = true;
      lastError = null;
    } catch (fallbackError) {
      console.error("[payments] Prava mandate list remained unavailable after retries:", {
        status: fallbackError.status || lastError.status || null,
        code:
          fallbackError.details?.error?.code
          || fallbackError.details?.errorCode
          || lastError.details?.error?.code
          || lastError.details?.errorCode
          || null,
        message: fallbackError.message || lastError.message,
      });
      throw fallbackError;
    }
  }
  let rows = mandateRows(data);
  // A few Prava sandbox accounts have returned an empty standing-only list
  // even while their newly-approved mandate is still transitioning. A single
  // unfiltered read prevents Tokko from hiding that active mandate.
  if (!rows.length && !unfiltered) {
    try {
      rows = mandateRows(
        await pravaRequest("/v1/mandates", {
          query: { customer_id: customerId },
        })
      );
    } catch {
      // Preserve the successful standing-only response when the fallback fails.
    }
  }
  return rows
    .map(safeMandate)
    .filter(Boolean);
}

async function getMandate(mandateId) {
  const id = providerIdentifier(mandateId, "Mandate ID");
  const mandate = safeMandate(
    await pravaRequest(`/v1/mandates/${encodeURIComponent(id)}`)
  );
  if (!mandate) {
    throw httpError(502, "Prava returned an incomplete mandate");
  }
  return mandate;
}

async function getPaymentResult(sessionId) {
  const id = providerIdentifier(sessionId, "Prava session ID");
  return pravaRequest(
    `/v1/sessions/${encodeURIComponent(id)}/payment-result`
  );
}

function paymentSessionCredentials(value) {
  const transactions = Array.isArray(value?.transactions)
    ? value.transactions
    : [];
  const lineItems = transactions.flatMap((transaction) =>
    Array.isArray(transaction?.line_items)
      ? transaction.line_items.map((lineItem) => ({ transaction, lineItem }))
      : []
  );
  const selected = lineItems.find(({ lineItem }) =>
    lineItem?.token &&
    (lineItem?.dynamic_cvv || lineItem?.dynamicCvv) &&
    (lineItem?.txn_ref_id || lineItem?.txnRefId)
  );
  if (!selected) return null;
  const { transaction, lineItem } = selected;
  const credentials = mandateChargeCredentials({
    credentials: {
      token: lineItem.token,
      dynamicCvv: lineItem.dynamic_cvv || lineItem.dynamicCvv,
      expiryMonth: lineItem.expiry_month || lineItem.expiryMonth,
      expiryYear: lineItem.expiry_year || lineItem.expiryYear,
    },
  });
  return {
    transactionId: providerIdentifier(
      lineItem.txn_ref_id || lineItem.txnRefId,
      "Prava transaction reference"
    ),
    status: String(
      lineItem.status || transaction?.status || value?.status || "awaiting_result"
    ).toLowerCase(),
    credentials,
  };
}

async function reportPaymentSession({
  sessionId,
  transactionId,
  status,
  amountPaid,
}) {
  const id = providerIdentifier(sessionId, "Prava session ID");
  const transaction = providerIdentifier(
    transactionId,
    "Prava transaction reference"
  );
  const transactionStatus = String(status || "").trim().toUpperCase();
  if (!["APPROVED", "DECLINED"].includes(transactionStatus)) {
    throw httpError(400, "Payment status must be APPROVED or DECLINED");
  }
  return pravaRequest(
    `/v1/sessions/${encodeURIComponent(id)}/report-status`,
    {
      method: "POST",
      body: {
        txn_ref_id: transaction,
        txn_status: transactionStatus,
        ...(amountPaid !== undefined && amountPaid !== null
          ? { amount_paid: decimalAmount(amountPaid, "Amount paid") }
          : {}),
      },
    }
  );
}

function mandateChargeCredentials(data) {
  const source = data?.credentials;
  const token = String(source?.token || "").replace(/\s+/g, "");
  const dynamicCvv = String(source?.dynamicCvv || "").trim();
  const expiryMonth = String(source?.expiryMonth || "").padStart(2, "0");
  const expiryYear = String(source?.expiryYear || "").trim();
  if (
    !/^\d{12,19}$/.test(token)
    || !/^\d{3,4}$/.test(dynamicCvv)
    || !/^(?:0[1-9]|1[0-2])$/.test(expiryMonth)
    || !/^\d{4}$/.test(expiryYear)
  ) {
    throw httpError(
      502,
      "Prava did not return complete single-use card credentials"
    );
  }
  return { token, dynamicCvv, expiryMonth, expiryYear };
}

async function chargeMandate({
  mandateId,
  amount,
  reference,
  purchaseContext,
}) {
  const id = providerIdentifier(mandateId, "Mandate ID");
  const idempotencyReference = providerIdentifier(
    reference,
    "Charge reference"
  );
  const pathname = `/v1/mandates/${encodeURIComponent(id)}/charge`;
  const baseBody = {
    amount: decimalAmount(amount, "Charge amount"),
    reference: idempotencyReference,
  };
  const body = {
    ...baseBody,
    ...(Array.isArray(purchaseContext) && purchaseContext.length
      ? { purchase_context: purchaseContext }
      : {}),
  };
  let data;
  try {
    data = await pravaRequest(pathname, { method: "POST", body });
  } catch (error) {
    const cryptogramFailure = /(?:visa\s*400|cryptogram)/i.test(
      `${error.message || ""} ${JSON.stringify(error.details || {})}`
    );
    if (!cryptogramFailure) throw error;
    // The reference is idempotent. Retry once using Prava's documented
    // minimal charge body so a transient Visa cryptogram fetch or a
    // per-charge purchase-context mismatch cannot create a duplicate charge.
    await new Promise((resolve) => setTimeout(resolve, 250));
    data = await pravaRequest(pathname, {
      method: "POST",
      body: baseBody,
    });
  }
  if (
    String(data?.status || "").toLowerCase() === "failed"
    || String(data?.fetchStatus || "").toUpperCase() === "FAILURE"
  ) {
    throw httpError(
      409,
      data?.errorMessage || data?.errorCode || "Prava could not mint a payment credential",
      data
    );
  }
  const transactionId = providerIdentifier(
    data?.transactionId,
    "Prava transaction ID"
  );
  return {
    mandateId: providerIdentifier(
      data?.mandateId || id,
      "Mandate ID"
    ),
    transactionId,
    orderId: data?.orderId ? String(data.orderId) : null,
    status: String(data?.status || "awaiting_result").toLowerCase(),
    deduplicated: data?.deduplicated === true,
    credentials: mandateChargeCredentials(data),
  };
}

async function reportMandateCharge({
  mandateId,
  transactionId,
  status,
  amountPaid,
  authorizationCode,
  responseCode,
}) {
  const id = providerIdentifier(mandateId, "Mandate ID");
  const transaction = providerIdentifier(
    transactionId,
    "Prava transaction ID"
  );
  const transactionStatus = String(status || "").trim().toUpperCase();
  if (!["APPROVED", "DECLINED"].includes(transactionStatus)) {
    throw httpError(400, "Charge status must be APPROVED or DECLINED");
  }
  const data = await pravaRequest(
    `/v1/mandates/${encodeURIComponent(id)}/charges/${encodeURIComponent(transaction)}/report`,
    {
      method: "POST",
      body: {
        txn_status: transactionStatus,
        txn_type: "PURCHASE",
        ...(amountPaid !== undefined && amountPaid !== null
          ? { amount_paid: decimalAmount(amountPaid, "Amount paid") }
          : {}),
        ...(authorizationCode
          ? { authorization_code: String(authorizationCode).slice(0, 128) }
          : {}),
        ...(responseCode
          ? { response_code: String(responseCode).slice(0, 2) }
          : {}),
      },
    }
  );
  return {
    mandateId: String(data?.mandateId || id),
    transactionId: String(data?.transactionId || transaction),
    status: String(data?.status || "").toLowerCase() || null,
    mandateStatus:
      String(data?.mandateStatus || "").toLowerCase() || null,
    visaConfirmation: data?.visaConfirmation || null,
  };
}

async function listCards(customerId) {
  const data = await pravaRequest("/v1/listCards", {
    query: {
      customer_id: customerId,
      status: "active",
      include_card_art: "false",
    },
  });
  return Array.isArray(data.cards) ? data.cards : [];
}

function safePaymentMethod(card) {
  const providerPaymentMethodId = String(card?.card_id || "").trim();
  const last4 = String(card?.card_last4 || "").trim();
  const expMonth = Number(card?.card_exp_month);
  const expYear = Number(card?.card_exp_year);
  if (
    !providerPaymentMethodId ||
    !/^\d{4}$/.test(last4) ||
    !Number.isInteger(expMonth) ||
    expMonth < 1 ||
    expMonth > 12 ||
    !Number.isInteger(expYear) ||
    expYear < new Date().getUTCFullYear()
  ) {
    throw httpError(409, "Prava did not return complete tokenized card metadata");
  }
  return {
    providerPaymentMethodId,
    type: "card",
    brand: card.card_brand || "card",
    last4,
    expMonth,
    expYear,
    isDefault: card.is_default === true,
  };
}

async function retrieveEnrolledCard(
  customerId,
  enrollmentId,
  { attempts = 1, delayMs = 0 } = {}
) {
  const maximumAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const cards = await listCards(customerId);
    const card = cards.find(
      (candidate) => String(candidate.card_id) === String(enrollmentId)
    );
    if (card) return safePaymentMethod(card);
    if (attempt < maximumAttempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw httpError(
    404,
    "The tokenized card was not found in this Prava customer account"
  );
}

async function revokeSession(sessionId) {
  return pravaRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: "POST",
  });
}

module.exports = {
  apiBaseUrl,
  chargeMandate,
  configuration,
  createMandateSession,
  createPaymentSession,
  createTokenizationSession,
  decimalAmount,
  enrollmentAmount,
  enrollmentCurrency,
  getMandate,
  getPaymentResult,
  listCards,
  listMandates,
  mandateCurrency,
  mandateDurationMinutes,
  paymentSessionCredentials,
  reportMandateCharge,
  reportPaymentSession,
  retrieveEnrolledCard,
  revokeSession,
  safeMandate,
  safePaymentMethod,
};
