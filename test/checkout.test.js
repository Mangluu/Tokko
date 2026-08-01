const test = require("node:test");
const assert = require("node:assert/strict");
const {
  zeptoCartSnapshot,
  zeptoOnlinePaymentAvailability,
  zeptoPriceBreakdown,
} = require("../lib/checkout.js");

test("Zepto price breakdown preserves MCP charges in paise", () => {
  assert.deepEqual(
    zeptoPriceBreakdown({
      data: {
        billSummary: {
          itemTotal: 15_800,
          deliveryCharge: 2_500,
          handlingFee: 800,
          gstAmount: 300,
          totalSaved: 4_000,
          totalBill: 19_400,
        },
      },
    }),
    {
      currency: "INR",
      source: "zepto_mcp",
      lines: [
        {
          key: "itemTotal",
          label: "Item total",
          amountPaise: 15_800,
          subtract: false,
          informational: false,
        },
        {
          key: "deliveryCharge",
          label: "Delivery charge",
          amountPaise: 2_500,
          subtract: false,
          informational: false,
        },
        {
          key: "handlingCharge",
          label: "Handling charge",
          amountPaise: 800,
          subtract: false,
          informational: false,
        },
        {
          key: "gst",
          label: "GST / taxes",
          amountPaise: 300,
          subtract: false,
          informational: false,
        },
        {
          key: "totalSaved",
          label: "Total saved",
          amountPaise: 4_000,
          subtract: true,
          informational: true,
        },
      ],
      totalPaise: 19_400,
    }
  );
});

test("Zepto online preview uses toPayAmount and derives a missing item subtotal", () => {
  assert.deepEqual(
    zeptoPriceBreakdown({
      isPreview: true,
      items: [{
        name: "Amul Taaza Milk",
        price: 1_700,
        quantity: 1,
      }],
      paymentMethod: "PAYMENT_LINK",
      toPay: "₹47",
      toPayAmount: 4_700,
      subTotal: null,
      deliveryFee: 3_000,
      packagingFee: null,
      taxes: null,
      discount: null,
    }),
    {
      currency: "INR",
      source: "zepto_mcp",
      lines: [
        {
          key: "itemTotal",
          label: "Item total",
          amountPaise: 1_700,
          subtract: false,
          informational: false,
        },
        {
          key: "deliveryCharge",
          label: "Delivery charge",
          amountPaise: 3_000,
          subtract: false,
          informational: false,
        },
      ],
      totalPaise: 4_700,
    }
  );
});

test("Zepto preview derives payable total when no total field is returned", () => {
  assert.equal(
    zeptoPriceBreakdown({
      items: [{ price: 3_200, quantity: 1 }],
      deliveryFee: 300,
      taxes: 150,
    }).totalPaise,
    3_650
  );
});

test("Zepto bill rows reconcile every component to the reported payable total", () => {
  assert.deepEqual(
    zeptoPriceBreakdown({
      data: {
        billDetails: [
          { label: "Item total", value: "₹100" },
          { label: "Discount", value: "₹20" },
          { label: "Delivery fee", value: "₹10" },
          { label: "Taxes and charges", value: "₹5" },
          { label: "Total payable", value: "₹96" },
        ],
      },
    }),
    {
      currency: "INR",
      source: "zepto_mcp",
      lines: [
        {
          key: "itemTotal",
          label: "Item total",
          amountPaise: 10_000,
          subtract: false,
          informational: false,
        },
        {
          key: "discount",
          label: "Discount",
          amountPaise: 2_000,
          subtract: true,
          informational: false,
        },
        {
          key: "deliveryCharge",
          label: "Delivery charge",
          amountPaise: 1_000,
          subtract: false,
          informational: false,
        },
        {
          key: "gst",
          label: "GST / taxes",
          amountPaise: 500,
          subtract: false,
          informational: false,
        },
        {
          key: "zeptoAdjustment",
          label: "Other Zepto adjustment",
          amountPaise: 100,
          subtract: false,
          informational: false,
        },
      ],
      totalPaise: 9_600,
    }
  );
});

test("nested component amount is not mistaken for the Zepto order total", () => {
  const breakdown = zeptoPriceBreakdown({
    data: {
      billDetails: [
        { label: "Item total", amount: 10_000 },
        { label: "Delivery fee", amount: 1_000 },
        { label: "GST", amount: 500 },
      ],
    },
  });
  assert.equal(breakdown.totalPaise, 11_500);
});

test("display-formatted Zepto rupees are normalized to paise", () => {
  assert.equal(
    zeptoPriceBreakdown({ toPay: "₹47" }).totalPaise,
    4_700
  );
});

test("Zepto cart snapshot keeps only orderable cart identifiers", () => {
  assert.deepEqual(
    zeptoCartSnapshot({
      items: [
        {
          productVariantId: "variant-1",
          storeProductId: "store-1",
          quantity: 2,
          name: "Milk",
          price: 3_200,
        },
        { name: "Unreadable item", quantity: 1 },
      ],
    }),
    [{
      productVariantId: "variant-1",
      storeProductId: "store-1",
      quantity: 2,
      name: "Milk",
      label: "Milk",
      price: 3_200,
      mrp: undefined,
      imageUrl: undefined,
      packSize: undefined,
    }]
  );
});

test("Zepto online payment availability understands structured MCP responses", () => {
  assert.equal(
    zeptoOnlinePaymentAvailability({
      paymentMethods: [
        { type: "COD", enabled: true },
        { type: "PREPAID", enabled: true },
      ],
    }),
    true
  );
  assert.equal(
    zeptoOnlinePaymentAvailability({
      data: { onlinePaymentAvailable: true },
    }),
    true
  );
  assert.equal(
    zeptoOnlinePaymentAvailability({ methods: "Cash on Delivery" }),
    false
  );
  assert.equal(zeptoOnlinePaymentAvailability({ methods: [] }), null);
});
