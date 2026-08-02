const PRICE_FIELDS = [
  {
    key: "itemTotal",
    label: "Item total",
    aliases: [
      "itemTotal",
      "itemsTotal",
      "itemSubtotal",
      "subtotal",
      "subTotal",
      "cartTotal",
    ],
  },
  {
    key: "discount",
    label: "Discount",
    aliases: [
      "discount",
      "discountAmount",
      "itemDiscount",
      "couponDiscount",
      "promoDiscount",
      "totalDiscount",
    ],
    subtract: true,
  },
  {
    key: "deliveryCharge",
    label: "Delivery charge",
    aliases: ["deliveryCharge", "deliveryFee", "deliveryCharges", "deliveryFees"],
  },
  {
    key: "handlingCharge",
    label: "Handling charge",
    aliases: ["handlingCharge", "handlingFee", "handlingCharges", "handlingFees"],
  },
  {
    key: "packagingCharge",
    label: "Packaging charge",
    aliases: ["packagingCharge", "packagingFee", "packagingCharges", "packagingFees"],
  },
  {
    key: "platformFee",
    label: "Platform fee",
    aliases: ["platformFee", "platformCharge"],
  },
  {
    key: "smallCartFee",
    label: "Small-cart fee",
    aliases: ["smallCartFee", "smallCartCharge"],
  },
  {
    key: "surgeFee",
    label: "Surge fee",
    aliases: ["surgeFee", "surgeCharge", "highDemandFee"],
  },
  {
    key: "rainFee",
    label: "Rain fee",
    aliases: ["rainFee", "rainCharge"],
  },
  {
    key: "convenienceFee",
    label: "Convenience fee",
    aliases: ["convenienceFee", "convenienceCharge"],
  },
  {
    key: "gst",
    label: "GST / taxes",
    aliases: [
      "gst",
      "gstAmount",
      "tax",
      "taxes",
      "taxAmount",
      "taxesAndCharges",
      "taxAndCharges",
      "totalTax",
    ],
  },
  {
    key: "riderTip",
    label: "Rider tip",
    aliases: ["riderTip", "tip", "tipAmount"],
  },
  {
    key: "zeptoCash",
    label: "Zepto Cash",
    aliases: ["zeptoCash", "walletBalanceUsed", "cashbackUsed"],
    subtract: true,
  },
  {
    key: "totalSaved",
    label: "Total saved",
    aliases: ["totalSaved", "savings", "savedAmount"],
    subtract: true,
    informational: true,
  },
];

const TOTAL_ALIASES = [
  "toPayAmount",
  "totalPayable",
  "amountToPay",
  "payableAmount",
  "finalPayableAmount",
  "grandTotalAmount",
  "grandTotal",
  "totalBill",
  "orderTotal",
  "toPay",
];

const LABELED_TOTAL_ALIASES = [
  ...TOTAL_ALIASES,
  "total",
  "amount",
];

function normalizeKey(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function numericAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const isRupeeDisplay = /₹|\bINR\b/i.test(value);
  const normalized = value.replace(/INR|[₹,\s]/gi, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return isRupeeDisplay ? Math.round(amount * 100) : amount;
}

function collectNumericFields(value, result = new Map(), depth = 0) {
  if (depth > 7 || value === null || value === undefined) return result;
  if (Array.isArray(value)) {
    for (const entry of value) collectNumericFields(entry, result, depth + 1);
    return result;
  }
  if (typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value)) {
    const amount = numericAmount(entry);
    const normalized = normalizeKey(key);
    if (amount !== null && normalized && !result.has(normalized)) {
      result.set(normalized, amount);
    }
    if (entry && typeof entry === "object") {
      collectNumericFields(entry, result, depth + 1);
    }
  }
  return result;
}

function canonicalLabeledField(label) {
  const normalized = normalizeKey(label);
  for (const field of PRICE_FIELDS) {
    if (field.aliases.some((alias) => normalizeKey(alias) === normalized)) {
      return field.key;
    }
  }
  if (
    LABELED_TOTAL_ALIASES.some(
      (alias) => normalizeKey(alias) === normalized
    )
  ) {
    return "reportedTotal";
  }
  return null;
}

function collectLabeledFields(value, result = new Map(), depth = 0) {
  if (depth > 7 || value === null || value === undefined) return result;
  if (Array.isArray(value)) {
    for (const entry of value) collectLabeledFields(entry, result, depth + 1);
    return result;
  }
  if (typeof value !== "object") return result;
  const label =
    value.label
    ?? value.title
    ?? value.displayName
    ?? value.display_name;
  const key = canonicalLabeledField(label);
  if (key && !result.has(normalizeKey(key))) {
    const amount = numericAmount(
      value.amountPaise
      ?? value.amount_paise
      ?? value.amount
      ?? value.value
      ?? value.price
      ?? value.displayValue
      ?? value.display_value
    );
    if (amount !== null) result.set(normalizeKey(key), amount);
  }
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === "object") {
      collectLabeledFields(entry, result, depth + 1);
    }
  }
  return result;
}

function firstField(fields, aliases) {
  for (const alias of aliases) {
    const value = fields.get(normalizeKey(alias));
    if (value !== undefined) return value;
  }
  return null;
}

function markdownAmounts(value) {
  if (typeof value !== "string") return new Map();
  const fields = new Map();
  const pattern = /([A-Za-z][A-Za-z /&-]{2,40})\s*:\s*₹?\s*([\d,.]+)/g;
  for (const match of value.matchAll(pattern)) {
    const amount = Number(match[2].replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;
    fields.set(normalizeKey(match[1]), Math.round(amount * 100));
  }
  return fields;
}

function previewItemTotal(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [
    value.items,
    value.cartItems,
    value.cart?.items,
    value.data?.items,
    value.data?.cartItems,
    value.data?.cart?.items,
  ];
  const items = candidates.find(Array.isArray);
  if (!items?.length) return null;
  let found = false;
  const total = items.reduce((sum, item) => {
    const unitPrice = numericAmount(
      item?.price
      ?? item?.sellingPrice
      ?? item?.unitSellingPrice
      ?? item?.finalPrice
    );
    const quantity = Number(item?.quantity ?? item?.count ?? 1);
    if (
      unitPrice === null
      || !Number.isFinite(quantity)
      || quantity <= 0
    ) {
      return sum;
    }
    found = true;
    return sum + unitPrice * quantity;
  }, 0);
  return found ? Math.round(total) : null;
}

function payableFromLines(lines) {
  const usable = lines.filter((line) => !line.informational);
  if (!usable.length) return null;
  return Math.max(
    0,
    Math.round(
      usable.reduce(
        (total, line) =>
          total + (line.subtract ? -line.amountPaise : line.amountPaise),
        0
      )
    )
  );
}

function zeptoPriceBreakdown(value) {
  const fields =
    typeof value === "string"
      ? markdownAmounts(value)
      : collectNumericFields(value);
  if (value && typeof value === "object") {
    for (const [key, amount] of collectLabeledFields(value)) {
      if (!fields.has(key)) fields.set(key, amount);
    }
  }
  const lines = [];
  for (const field of PRICE_FIELDS) {
    let amount = firstField(fields, field.aliases);
    if (field.key === "itemTotal" && amount === null) {
      amount = previewItemTotal(value);
    }
    if (amount === null) continue;
    lines.push({
      key: field.key,
      label: field.label,
      amountPaise: Math.round(Math.abs(amount)),
      subtract: Boolean(field.subtract),
      informational: Boolean(field.informational),
    });
  }
  const genericTopLevelTotal =
    value && typeof value === "object"
      ? numericAmount(
          value.total
          ?? value.amount
          ?? value.data?.total
          ?? value.data?.amount
        )
      : null;
  const reportedTotal =
    firstField(fields, TOTAL_ALIASES)
    ?? fields.get(normalizeKey("reportedTotal"))
    ?? genericTopLevelTotal;
  const calculatedTotal = payableFromLines(lines);
  if (
    reportedTotal !== null
    && reportedTotal > 0
    && calculatedTotal !== null
    && Math.round(reportedTotal) !== Math.round(calculatedTotal)
  ) {
    const difference = Math.round(reportedTotal - calculatedTotal);
    lines.push({
      key: "zeptoAdjustment",
      label: "Other Zepto adjustment",
      amountPaise: Math.abs(difference),
      subtract: difference < 0,
      informational: false,
    });
  }
  const total =
    reportedTotal === null
    || (reportedTotal <= 0 && Number(calculatedTotal) > 0)
      ? calculatedTotal
      : reportedTotal;
  return {
    currency: "INR",
    source: "zepto_mcp",
    lines,
    totalPaise: total === null ? null : Math.round(total),
  };
}

function zeptoCartSnapshot(value) {
  const candidates = [
    value?.items,
    value?.cartItems,
    value?.cart?.items,
    value?.data?.items,
    value?.data?.cart?.items,
  ];
  const items = candidates.find(Array.isArray) || [];
  return items
    .map((item) => ({
      productVariantId:
        item?.productVariantId || item?.variantId || item?.id || null,
      storeProductId: item?.storeProductId || item?.store_product_id || null,
      quantity: Math.max(0, Number(item?.quantity || item?.count || 0)),
      name: item?.name || item?.label || "Item",
      label: item?.label || item?.name || "Item",
      price: item?.price,
      mrp: item?.mrp,
      imageUrl: item?.imageUrl || item?.image,
      packSize: item?.packSize || item?.quantityLabel,
    }))
    .filter(
      (item) =>
        item.productVariantId
        && item.storeProductId
        && Number.isFinite(item.quantity)
        && item.quantity > 0
    );
}

function zeptoOnlinePaymentAvailability(value) {
  const explicitKeys =
    /^(?:is)?(?:online|prepaid|digital|card|upi|wallet)(?:payment)?(?:available|enabled|supported)$/i;
  let explicit = null;
  const visit = (entry, depth = 0) => {
    if (depth > 8 || entry === null || entry === undefined) return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (typeof entry !== "object") return;
    for (const [key, item] of Object.entries(entry)) {
      const normalizedKey = String(key).replace(/[^a-z0-9]/gi, "");
      if (explicitKeys.test(normalizedKey) && typeof item === "boolean") {
        if (item) explicit = true;
        else if (explicit === null) explicit = false;
      }
      visit(item, depth + 1);
    }
  };
  visit(value);
  if (explicit === true) return true;

  const text = (typeof value === "string"
    ? value
    : JSON.stringify(value || {}))
    .replace(/[_-]+/g, " ");
  const positive =
    /\b(?:pay(?:ment)?\s*online|online\s*pay(?:ment)?|prepaid|payment\s*link|card(?:s|\s*payment)?|upi|wallets?|net\s*banking|digital\s*payment)\b/i;
  if (positive.test(text)) return true;
  if (
    explicit === false
    || /\b(?:online|prepaid|card|upi|wallet|digital)\s+(?:payment\s+)?(?:unavailable|disabled|unsupported|not\s+available)\b/i.test(text)
    || /\b(?:cash\s+on\s+delivery|cod)\s+only\b/i.test(text)
    || (
      /\b(?:cash\s+on\s+delivery|cod)\b/i.test(text)
      && !positive.test(text)
    )
  ) {
    return false;
  }
  return null;
}

module.exports = {
  zeptoCartSnapshot,
  zeptoOnlinePaymentAvailability,
  zeptoPriceBreakdown,
};
