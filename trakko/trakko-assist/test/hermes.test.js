const test = require("node:test");
const assert = require("node:assert/strict");
const hermes = require("../lib/hermes.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const tools = [
  {
    name: "get_past_order_items",
    description: "Get previously ordered products",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_saved_address",
    description: "Add a delivery address",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        flatDetails: { type: "string" },
      },
      required: ["name", "flatDetails"],
    },
  },
  {
    name: "list_saved_addresses",
    description: "List saved delivery addresses",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "select_saved_address",
    description: "Select a saved delivery address",
    inputSchema: {
      type: "object",
      properties: { addressId: { type: "string" } },
      required: ["addressId"],
    },
  },
  {
    name: "get_location_serviceability",
    description: "Refresh serviceability for a delivery location",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "select_store",
    description: "Select the active Zepto store",
    inputSchema: {
      type: "object",
      properties: {
        storeId: { type: "string" },
        latitude: { type: "number" },
        longitude: { type: "number" },
      },
      required: ["storeId"],
    },
  },
  {
    name: "update_cart",
    description: "Update a cart item",
    inputSchema: {
      type: "object",
      properties: {
        productVariantId: { type: "string" },
        quantity: { type: "number" },
      },
      required: ["productVariantId", "quantity"],
    },
  },
  {
    name: "search_multiple_products",
    description: "Search for several product queries",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["queries"],
    },
  },
  {
    name: "search_products",
    description: "Search the Zepto catalogue",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

test("Hermes executes read-only Zepto MCP tools and feeds results to Gemini", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let modelCalls = 0;
  const executed = [];
  try {
    const result = await hermes.run({
      userId: 4200,
      messages: [{ role: "user", content: "what milk do we usually buy?" }],
      tools,
      context: { accountHolder: "Test Shopper", zeptoConnected: true },
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return { items: [{ name: "Amul Taaza Milk", count: 3 }] };
      },
      fetchImpl: async (_url, options) => {
        modelCalls += 1;
        assert.equal(options.headers["x-goog-api-key"], "test-gemini-key");
        if (modelCalls === 1) {
          return jsonResponse({
            candidates: [{
              content: {
                role: "model",
                parts: [{
                  functionCall: {
                    name: "get_past_order_items",
                    args: {},
                  },
                }],
              },
            }],
          });
        }
        const payload = JSON.parse(options.body);
        assert.equal(
          payload.contents.at(-1).parts[0].functionResponse.name,
          "get_past_order_items"
        );
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "You usually buy Amul Taaza Milk." }],
            },
          }],
        });
      },
    });
    assert.equal(result.message, "you usually buy amul taaza milk.");
    assert.equal(result.tools[0].name, "get_past_order_items");
    assert.equal(result.tools[0].status, "completed");
    assert.deepEqual(executed, [{ name: "get_past_order_items", args: {} }]);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Hermes signs mutating Zepto actions and executes only after approval", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  const calls = [];
  try {
    const pending = await hermes.run({
      userId: 42,
      messages: [{ role: "user", content: "save home as 12a park street" }],
      tools,
      executeTool: async () => {
        throw new Error("must not execute before approval");
      },
      fetchImpl: async () =>
        jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{
                functionCall: {
                  name: "add_saved_address",
                  args: { name: "home", flatDetails: "12a" },
                },
                thoughtSignature: "gemini-3-thought-signature",
              }],
            },
          }],
        }),
    });
    assert.equal(pending.pendingAction.toolName, "add_saved_address");
    assert.match(pending.message, /good to send\?/);
    const verified = hermes.verifyApproval(pending.pendingAction.token, 42);
    assert.equal(
      verified.actions[0].modelPart.thoughtSignature,
      "gemini-3-thought-signature"
    );

    const approved = await hermes.run({
      userId: 42,
      messages: [{ role: "user", content: "save home as 12a park street" }],
      tools,
      approvalToken: pending.pendingAction.token,
      executeTool: async (name, args) => {
        calls.push({ name, args });
        return { saved: true };
      },
      fetchImpl: async () => {
        throw new Error("approved actions must not spend another model request");
      },
    });
    assert.equal(approved.message, "done, 1 approved zepto action is complete.");
    assert.deepEqual(calls, [{
      name: "add_saved_address",
      args: { name: "home", flatDetails: "12a" },
    }]);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});

test("Hermes approval starts a Zepto reconnect and asks for the OTP", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  const reconnectTool = {
    name: "start_zepto_reconnect",
    description: "Send a Zepto login OTP",
    inputSchema: { type: "object", properties: {} },
  };
  const calls = [];
  try {
    const pending = await hermes.run({
      userId: 84,
      messages: [{ role: "user", content: "reconnect zepto with otp" }],
      tools: [reconnectTool],
      executeTool: async () => {
        throw new Error("must not send an OTP before approval");
      },
      fetchImpl: async () =>
        jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{
                functionCall: {
                  name: "start_zepto_reconnect",
                  args: {},
                },
              }],
            },
          }],
        }),
    });
    assert.equal(pending.pendingAction.toolName, "start_zepto_reconnect");
    assert.match(pending.pendingAction.description, /send a zepto login otp/i);

    const approved = await hermes.run({
      userId: 84,
      messages: [{ role: "user", content: "reconnect zepto with otp" }],
      tools: [reconnectTool],
      approvalToken: pending.pendingAction.token,
      executeTool: async (name, args) => {
        calls.push({ name, args });
        return {
          otpSent: true,
          merchant: "zepto",
          phoneEnding: "••••3210",
          expiresInSeconds: 600,
        };
      },
      fetchImpl: async () => {
        throw new Error("approved reconnect must not spend another model request");
      },
    });
    assert.match(approved.message, /otp.*3210/i);
    assert.match(approved.message, /six-digit code/i);
    assert.deepEqual(calls, [{ name: "start_zepto_reconnect", args: {} }]);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});

test("Hermes replaces a saved-address UUID with the full readable address", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  const addressUuid = "0899ae1f-bfb1-4eb7-bf0f-55c993389c27";
  let modelCalls = 0;
  try {
    const result = await hermes.run({
      userId: 42,
      messages: [{ role: "user", content: "deliver this to home" }],
      tools,
      executeTool: async (name) => {
        assert.equal(name, "list_saved_addresses");
        return {
          addresses: [{
            id: addressUuid,
            label: "home",
            flatDetails: "12a",
            buildingName: "lake view",
            area: "salt lake",
            city: "kolkata",
            pincode: "700091",
          }],
        };
      },
      fetchImpl: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return jsonResponse({
            candidates: [{
              content: {
                role: "model",
                parts: [{
                  functionCall: { name: "list_saved_addresses", args: {} },
                }],
              },
            }],
          });
        }
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [
                { text: `i will use ${addressUuid}.` },
                {
                  functionCall: {
                    name: "select_saved_address",
                    args: { addressId: addressUuid },
                  },
                },
              ],
            },
          }],
        });
      },
    });
    assert.doesNotMatch(result.message, new RegExp(addressUuid));
    assert.match(result.message, /home: 12a, lake view, salt lake, kolkata, 700091/);
    assert.match(
      result.pendingAction.description,
      /home: 12a, lake view, salt lake, kolkata, 700091/
    );
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});

test("Hermes reads Zepto MCP text addresses without exposing their internal IDs", () => {
  const addressBook = new Map();
  const addressUuid = "0899ae1f-bfb1-4eb7-bf0f-55c993389c27";
  hermes.captureAddresses({
    content: [{
      type: "text",
      text: [
        "1. **parents home**: 12a lake view, salt lake, kolkata 700091",
        "---",
        `1. parents home -> Address ID: ${addressUuid}`,
      ].join("\n"),
    }],
  }, addressBook);
  assert.equal(
    addressBook.get(addressUuid),
    "parents home: 12a lake view, salt lake, kolkata 700091"
  );
  assert.equal(
    hermes.replaceAddressIds(`deliver to ${addressUuid}`, addressBook),
    "deliver to parents home: 12a lake view, salt lake, kolkata 700091"
  );
});

test("Hermes resolves a readable address choice to Zepto's saved address ID", () => {
  const addressBook = new Map([
    [
      "0899ae1f-bfb1-4eb7-bf0f-55c993389c27",
      "Kolkata: D-8/16, East Kolkata Township, Kolkata 700107",
    ],
    [
      "4846ce98-13a5-4c9c-8af8-4554369ea483",
      "home: Koramangala, Bengaluru 560095",
    ],
  ]);
  assert.deepEqual(
    hermes.normalizeActionArgs(
      "select_saved_address",
      { addressId: "Kolkata" },
      addressBook
    ),
    { addressId: "0899ae1f-bfb1-4eb7-bf0f-55c993389c27" }
  );
  assert.deepEqual(
    hermes.normalizeActionArgs(
      "select_saved_address",
      { user_address_id: "2" },
      addressBook
    ),
    { addressId: "4846ce98-13a5-4c9c-8af8-4554369ea483" }
  );
});

test("Hermes keeps every grocery item when removing a destination", () => {
  assert.deepEqual(
    hermes.shoppingQueriesFromMessage(
      "1 milk, ginger and lehsun to Kolkata"
    ),
    ["milk", "ginger", "lehsun"]
  );
  assert.deepEqual(
    hermes.shoppingQueriesFromMessage("select the Kolkata address"),
    []
  );
});

test("Hermes learns vocabulary corrections without a hardcoded grocery map", () => {
  assert.deepEqual(
    hermes.extractExplicitMemories([
      { role: "user", content: "when i say shaak, i mean leafy greens" },
    ]),
    [{
      type: "vocabulary",
      cue: "shaak",
      value: { meaning: "leafy greens" },
      confidence: 0.95,
    }]
  );
  const prompt = hermes.systemPrompt({ responseLanguage: "en-IN" });
  assert.doesNotMatch(prompt, /\blehsun\b|\bshaak\b|\bgarlic\b/i);
});

test("Hermes loads the Trakko health policy and delivery-first rules", () => {
  const prompt = hermes.systemPrompt({
    responseLanguage: "en-IN",
    accountHolder: "Asha",
    dependents: [{
      name: "Papa",
      relationship: "father",
      age: 63,
      gender: "male",
      country: "IN",
    }],
    confirmedDeliveryAddress: "Kolkata 700107",
    selectedDeliveryCountry: "IN",
    eligibleMerchants: [{ slug: "oziva", name: "OZiva" }],
  });

  assert.match(prompt, /you are trakko, a calm family health and wellness assistant/i);
  assert.match(prompt, /an active delivery address is required before showing catalogue products/i);
  assert.match(prompt, /must not diagnose, prescribe/i);
  assert.match(prompt, /possible emergency signals include chest pain/i);
  assert.match(prompt, /setu is the india skin, hair, gut/i);
  assert.match(prompt, /"age":63/);
  assert.match(prompt, /"gender":"male"/);
  assert.match(prompt, /"selectedDeliveryCountry":"IN"/);
  assert.match(prompt, /"eligibleMerchants":\[\{"slug":"oziva","name":"OZiva"\}\]/);
  assert.match(prompt, /for an IN address, choose exactly one merchant/i);
  assert.match(prompt, /for every non-IN address, use the global UCP catalogue/i);
  assert.match(prompt, /ships_to\.country set to selectedDeliveryCountry/i);
  assert.match(prompt, /health report recommendation policy/i);
  assert.match(prompt, /mark method-sensitive values without a range as needs_reference_range/i);
  assert.match(prompt, /search the exact brand plus exact product first/i);
  assert.match(prompt, /a photo match or positive availability statement needs a live recheck under 5 minutes/i);
  assert.match(prompt, /nuskhe are low-risk comfort and self-care suggestions/i);
  assert.match(prompt, /never give honey to a child under 12 months/i);
  assert.match(prompt, /adds a 3 percent foreign-exchange charge on that entire merchant total/i);
  assert.match(prompt, /mandate charge must use the final payable amount after the 3 percent forex charge/i);
  assert.doesNotMatch(prompt, /do not ask for a delivery address before searching/i);
  assert.doesNotMatch(prompt, /you are tokko/i);
});

test("Hermes learns explicit family health facts without storing raw chat", () => {
  assert.deepEqual(
    hermes.extractExplicitMemories([
      { role: "user", content: "mummy ko penicillin allergy hai" },
    ]),
    [{
      type: "health_context",
      cue: "mummy allergy",
      value: {
        subject: "mummy",
        kind: "allergy",
        detail: "penicillin",
      },
      confidence: 0.96,
    }]
  );

  assert.deepEqual(
    hermes.extractExplicitMemories([
      { role: "user", content: "papa is 63 years old" },
    ]),
    [{
      type: "family_context",
      cue: "papa age",
      value: {
        subject: "papa",
        kind: "age",
        detail: "63",
      },
      confidence: 0.97,
    }]
  );
});

test("Hermes derives reusable family memory from successful tool results", () => {
  const memories = hermes.deriveLearnedMemories(
    [{ role: "user", content: "find our usual breakfast milk" }],
    {
      tools: [{
        name: "search_products",
        status: "completed",
        result: {
          query: "Amul Gold Milk 500ml",
          products: [{ name: "Amul Gold Full Cream Milk 500 ml" }],
        },
      }],
    }
  );
  assert.deepEqual(memories, [{
    type: "successful_search",
    cue: "find our usual breakfast milk",
    value: {
      queries: ["Amul Gold Milk 500ml"],
      products: ["Amul Gold Full Cream Milk 500 ml"],
    },
    confidence: 0.7,
  }]);
});

test("Hermes continues the original product search after address approval", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  const addressUuid = "0899ae1f-bfb1-4eb7-bf0f-55c993389c27";
  const executed = [];
  try {
    const pending = await hermes.run({
      userId: 4201,
      messages: [{
        role: "user",
        content: "1 milk, ginger and lehsun to kolkata",
      }],
      tools,
      executeTool: async () => {
        throw new Error("must wait for approval");
      },
      fetchImpl: async () => jsonResponse({
        candidates: [{
          content: {
            role: "model",
            parts: [{
              functionCall: {
                name: "select_saved_address",
                args: { addressId: addressUuid },
              },
            }, {
              functionCall: {
                name: "search_multiple_products",
                args: { queries: ["milk", "ginger", "garlic"] },
              },
            }],
          },
        }],
      }),
    });
    assert.equal(pending.pendingAction.toolName, "select_saved_address");

    let modelCalls = 0;
    const result = await hermes.run({
      userId: 4201,
      messages: [{
        role: "user",
        content: "1 milk, ginger and lehsun to kolkata",
      }],
      tools,
      approvalToken: pending.pendingAction.token,
      context: {
        learnedMemories: [{
          type: "vocabulary",
          cue: "lehsun",
          value: { meaning: "garlic" },
          confidence: 0.95,
        }],
      },
      executeTool: async (name, args) => {
        executed.push({ name, args });
        if (name === "select_saved_address") {
          return {
            success: true,
            summary: "Address selected successfully.",
            address: {
              id: addressUuid,
              label: "Kolkata",
              addressLine: "East Kolkata Township, Kolkata 700107",
              latitude: 22.510117368562877,
              longitude: 88.40566797181964,
            },
            storeId: "9cc80a80-f39d-4da4-9ce6-14fad42e470e",
          };
        }
        if (name === "get_location_serviceability") {
          return "Primary store ID: 9cc80a80-f39d-4da4-9ce6-14fad42e470e";
        }
        if (name === "select_store") {
          return { success: true };
        }
        const productByQuery = {
          milk: "Amul Taaza Milk",
          ginger: "Fresh Ginger",
          garlic: "Fresh Garlic",
        };
        return {
          query: args.query,
          products: [{ name: productByQuery[args.query] }],
          totalCount: 1,
        };
      },
      fetchImpl: async (_url, options) => {
        modelCalls += 1;
        const payload = JSON.parse(options.body);
        assert.match(
          payload.contents.at(-1).parts[0].text,
          /remaining requested products are: milk, ginger, garlic/
        );
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{
                text: "I found milk, ginger, and garlic for the Kolkata address.",
              }],
            },
          }],
        });
      },
    });
    assert.equal(
      result.message,
      "i found milk, ginger, and garlic for the kolkata address."
    );
    assert.deepEqual(
      executed.map((entry) => entry.name),
      [
        "select_saved_address",
        "get_location_serviceability",
        "select_store",
        "search_products",
        "search_products",
        "search_products",
      ]
    );
    assert.deepEqual(executed[1].args, {
      latitude: 22.510117368562877,
      longitude: 88.40566797181964,
    });
    assert.deepEqual(executed[2].args, {
      storeId: "9cc80a80-f39d-4da4-9ce6-14fad42e470e",
      latitude: 22.510117368562877,
      longitude: 88.40566797181964,
    });
    assert.deepEqual(
      executed.slice(3).map((entry) => entry.args.query),
      ["milk", "ginger", "garlic"]
    );
    assert.equal(modelCalls, 1);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});

test("Hermes searches the broad category before applying past-order preferences", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  const addressUuid = "0899ae1f-bfb1-4eb7-bf0f-55c993389c27";
  const executed = [];
  try {
    const pending = await hermes.run({
      userId: 14203,
      messages: [{ role: "user", content: "find milk to kolkata" }],
      tools,
      executeTool: async () => {
        throw new Error("must wait for approval");
      },
      fetchImpl: async () => jsonResponse({
        candidates: [{
          content: {
            role: "model",
            parts: [{
              functionCall: {
                name: "select_saved_address",
                args: { addressId: addressUuid },
              },
            }],
          },
        }],
      }),
    });

    const result = await hermes.run({
      userId: 14203,
      messages: [{ role: "user", content: "find milk to kolkata" }],
      tools,
      approvalToken: pending.pendingAction.token,
      executeTool: async (name, args) => {
        executed.push({ name, args });
        if (name === "select_saved_address") {
          return {
            success: true,
            address: {
              id: addressUuid,
              label: "Kolkata",
              addressLine: "East Kolkata Township, Kolkata 700107",
              latitude: 22.510117368562877,
              longitude: 88.40566797181964,
            },
            storeId: "kolkata-primary-store",
          };
        }
        if (name === "get_location_serviceability") {
          return "Primary store ID: kolkata-primary-store";
        }
        if (name === "select_store") return { success: true };
        assert.equal(args.query, "milk");
        return {
          query: "milk",
          products: [
            { name: "Mother Dairy Toned Milk 500 ml", available: true },
            { name: "Amul Gold Full Cream Milk 500 ml", available: true },
          ],
          totalCount: 2,
        };
      },
      fetchImpl: async (_url, options) => {
        const prompt = JSON.parse(options.body).contents.at(-1).parts[0].text;
        assert.match(prompt, /Mother Dairy Toned Milk 500 ml/);
        assert.match(prompt, /broad_category_first/);
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{
                text:
                  "I found Mother Dairy Toned Milk and Amul Gold. Cheapest or healthiest?",
              }],
            },
          }],
        });
      },
    });

    assert.equal(
      result.message,
      "i found mother dairy toned milk and amul gold. cheapest or healthiest?"
    );
    assert.deepEqual(
      executed
        .filter((entry) => entry.name === "search_products")
        .map((entry) => entry.args.query),
      ["milk"]
    );
    const searchTrace = result.tools.find(
      (entry) => entry.name === "search_products"
    );
    assert.equal(searchTrace.result.searchStrategy, "broad_category_first");
    assert.equal(searchTrace.result.products.length, 2);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});

test("Hermes invalidates cached catalogue results after an address change", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  const userId = 4299;
  const addressUuid = "0899ae1f-bfb1-4eb7-bf0f-55c993389c27";
  let searchCalls = 0;
  try {
    let primeModelCalls = 0;
    await hermes.run({
      userId,
      messages: [{ role: "user", content: "find milk" }],
      tools,
      executeTool: async (name) => {
        assert.equal(name, "search_products");
        searchCalls += 1;
        return {
          query: "milk",
          totalCount: 1,
          products: [{ name: "Old-store Milk" }],
        };
      },
      fetchImpl: async () => {
        primeModelCalls += 1;
        return primeModelCalls === 1
          ? jsonResponse({
              candidates: [{
                content: {
                  role: "model",
                  parts: [{
                    functionCall: {
                      name: "search_products",
                      args: { query: "milk", pageNumber: 0 },
                    },
                  }],
                },
              }],
            })
          : jsonResponse({
              candidates: [{
                content: {
                  role: "model",
                  parts: [{ text: "I found the old-store milk." }],
                },
              }],
            });
      },
    });
    assert.equal(searchCalls, 1);

    const pending = await hermes.run({
      userId,
      messages: [{ role: "user", content: "find milk to kolkata" }],
      tools,
      executeTool: async () => {
        throw new Error("must wait for address approval");
      },
      fetchImpl: async () => jsonResponse({
        candidates: [{
          content: {
            role: "model",
            parts: [{
              functionCall: {
                name: "select_saved_address",
                args: { addressId: addressUuid },
              },
            }],
          },
        }],
      }),
    });

    const result = await hermes.run({
      userId,
      messages: [{ role: "user", content: "find milk to kolkata" }],
      tools,
      approvalToken: pending.pendingAction.token,
      executeTool: async (name) => {
        if (name === "select_saved_address") {
          return {
            success: true,
            address: {
              id: addressUuid,
              latitude: 22.510117368562877,
              longitude: 88.40566797181964,
            },
            storeId: "9cc80a80-f39d-4da4-9ce6-14fad42e470e",
          };
        }
        if (name === "get_location_serviceability") {
          return "Primary store ID: 9cc80a80-f39d-4da4-9ce6-14fad42e470e";
        }
        if (name === "select_store") return { success: true };
        if (name === "get_past_order_items") return { items: [] };
        assert.equal(name, "search_products");
        searchCalls += 1;
        return {
          query: "milk",
          totalCount: 1,
          products: [{ name: "Kolkata-store Milk" }],
        };
      },
      fetchImpl: async (_url, options) => {
        const prompt = JSON.parse(options.body).contents.at(-1).parts[0].text;
        assert.match(prompt, /Kolkata-store Milk/);
        assert.doesNotMatch(prompt, /Old-store Milk/);
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "I found milk at the refreshed Kolkata store." }],
            },
          }],
        });
      },
    });
    assert.equal(searchCalls, 2);
    assert.equal(
      result.message,
      "i found milk at the refreshed kolkata store."
    );
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});

test("Hermes searches every item without asking for an unspecified address", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  const executed = [];
  let modelCalls = 0;
  try {
    const result = await hermes.run({
      userId: 4203,
      messages: [{
        role: "user",
        content: "1 milk, ginger and lehsun",
      }],
      tools,
      executeTool: async (name, args) => {
        executed.push({ name, args });
        const productByQuery = {
          milk: "Amul Milk",
          ginger: "Fresh Ginger",
          lehsun: "Fresh Garlic",
        };
        return {
          query: args.query,
          products: [{ name: productByQuery[args.query] }],
          totalCount: 1,
        };
      },
      fetchImpl: async (_url, options) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return jsonResponse({
            candidates: [{
              content: {
                role: "model",
                parts: [{
                  functionCall: {
                    name: "select_saved_address",
                    args: { addressId: "made-up-address" },
                  },
                }],
              },
            }],
          });
        }
        if (modelCalls === 2) {
          const payload = JSON.parse(options.body);
          assert.match(
            payload.contents.at(-1).parts[0].functionResponse.response.error,
            /address selection is not required/
          );
          return jsonResponse({
            candidates: [{
              content: {
                role: "model",
                parts: [{
                  functionCall: {
                    name: "search_products",
                    args: { query: "milk" },
                  },
                }],
              },
            }],
          });
        }
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "I found options for all three groceries." }],
            },
          }],
        });
      },
    });
    assert.equal(result.pendingAction, null);
    assert.deepEqual(
      executed.map((entry) => entry.name),
      ["search_products", "search_products", "search_products"]
    );
    assert.deepEqual(
      executed.map((entry) => entry.args.query),
      ["milk", "ginger", "lehsun"]
    );
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Hermes retries transient high-traffic Zepto searches", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let toolAttempts = 0;
  let modelCalls = 0;
  try {
    const result = await hermes.run({
      userId: 4202,
      messages: [{ role: "user", content: "find shaak" }],
      tools,
      context: {
        learnedMemories: [{
          type: "vocabulary",
          cue: "shaak",
          value: { meaning: "spinach" },
          confidence: 0.95,
        }],
      },
      executeTool: async (name, args) => {
        assert.equal(name, "search_products");
        assert.equal(args.query, "spinach");
        toolAttempts += 1;
        if (toolAttempts < 3) {
          throw new Error("Zepto is unavailable because of high traffic");
        }
        return { products: [{ name: "Fresh Palak Spinach" }] };
      },
      fetchImpl: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return jsonResponse({
            candidates: [{
              content: {
                role: "model",
                parts: [{
                  functionCall: {
                    name: "search_products",
                    args: { query: "shaak" },
                  },
                }],
              },
            }],
          });
        }
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "I found fresh palak spinach." }],
            },
          }],
        });
      },
    });
    assert.equal(toolAttempts, 3);
    assert.equal(result.message, "i found fresh palak spinach.");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Hermes stops after one explicit Zepto 429 and never reports empty stock", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let toolAttempts = 0;
  let modelCalls = 0;
  try {
    const result = await hermes.run({
      userId: 9429,
      messages: [{ role: "user", content: "find milk" }],
      tools,
      executeTool: async (name, args) => {
        assert.equal(name, "search_products");
        assert.equal(args.query, "milk");
        toolAttempts += 1;
        return "Error: Failed to search products: API request failed: Too Many Requests";
      },
      fetchImpl: async () => {
        modelCalls += 1;
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{
                functionCall: {
                  name: "search_products",
                  args: { query: "milk", pageNumber: 0 },
                },
              }],
            },
          }],
        });
      },
    });

    assert.equal(toolAttempts, 1);
    assert.equal(modelCalls, 1);
    assert.match(result.message, /catalogue search is rate-limited/);
    assert.match(result.message, /have not marked the requested items unavailable/);
    assert.doesNotMatch(result.message, /no products found|out of stock/);
    assert.equal(result.tools[0].status, "failed");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Hermes switches Zepto search tools after persistent traffic errors", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  const attempts = [];
  let modelCalls = 0;
  try {
    const result = await hermes.run({
      userId: 9205,
      messages: [{ role: "user", content: "find leafy greens" }],
      tools,
      executeTool: async (name, args) => {
        attempts.push({ name, args });
        if (name === "search_products") {
          throw new Error("Zepto is experiencing high traffic");
        }
        assert.equal(name, "search_multiple_products");
        assert.deepEqual(args.queries, ["leafy greens"]);
        return {
          sections: [{
            query: "leafy greens",
            products: [{ name: "Fresh Spinach" }],
          }],
        };
      },
      fetchImpl: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return jsonResponse({
            candidates: [{
              content: {
                role: "model",
                parts: [{
                  functionCall: {
                    name: "search_products",
                    args: { query: "leafy greens" },
                  },
                }],
              },
            }],
          });
        }
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "I found fresh spinach." }],
            },
          }],
        });
      },
    });
    assert.equal(
      attempts.filter((attempt) => attempt.name === "search_products").length,
      4
    );
    assert.equal(attempts.at(-1).name, "search_multiple_products");
    assert.equal(result.message, "i found fresh spinach.");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Hermes bundles recommended cart items behind one approval", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  const executed = [];
  try {
    const pending = await hermes.run({
      userId: 42,
      messages: [{ role: "user", content: "yes, add onions and masala" }],
      tools,
      executeTool: async () => {
        throw new Error("must wait for approval");
      },
      fetchImpl: async () => jsonResponse({
        candidates: [{
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "update_cart",
                  args: { productVariantId: "onion", quantity: 1 },
                },
              },
              {
                functionCall: {
                  name: "update_cart",
                  args: { productVariantId: "masala", quantity: 1 },
                },
              },
            ],
          },
        }],
      }),
    });
    assert.equal(pending.pendingAction.actionCount, 2);
    assert.equal(
      pending.pendingAction.description,
      "add or update 2 selected items in the linked zepto cart"
    );
    const approved = await hermes.run({
      userId: 42,
      messages: [],
      tools,
      approvalToken: pending.pendingAction.token,
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return { success: true };
      },
      fetchImpl: async () => {
        throw new Error("approval should not call the model");
      },
    });
    assert.equal(
      approved.message,
      "done, i updated the zepto cart with 2 approved items."
    );
    assert.equal(executed.length, 2);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});

test("Hermes presents the mandate-first checkout policy as one approved action", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  const checkoutTools = [...tools, {
    name: "checkout_current_cart",
    description:
      "Check all active mandates, then normal Prava card, then COD.",
    inputSchema: {
      type: "object",
      properties: {
        userAddressId: { type: "string" },
        allowCodFallback: { type: "boolean" },
      },
      required: ["userAddressId"],
    },
  }];
  try {
    const pending = await hermes.run({
      userId: 7721,
      messages: [{ role: "user", content: "place this cart at home" }],
      tools: checkoutTools,
      executeTool: async () => {
        throw new Error("must wait for approval");
      },
      fetchImpl: async () => jsonResponse({
        candidates: [{
          content: {
            role: "model",
            parts: [{
              functionCall: {
                name: "checkout_current_cart",
                args: {
                  userAddressId: "home-address-id",
                  allowCodFallback: true,
                },
              },
            }],
          },
        }],
      }),
    });
    assert.equal(pending.pendingAction.toolName, "checkout_current_cart");
    assert.match(pending.pendingAction.description, /mandate first/i);

    const approved = await hermes.run({
      userId: 7721,
      messages: [{ role: "user", content: "place this cart at home" }],
      tools: checkoutTools,
      approvalToken: pending.pendingAction.token,
      executeTool: async (name, args) => {
        assert.equal(name, "checkout_current_cart");
        assert.equal(args.userAddressId, "home-address-id");
        return {
          paymentRoute: "prava_card",
          status: "PASSKEY_REQUIRED",
          checkedMandateCount: 3,
          nextAction: {
            type: "prava_card_approval",
            label: "Approve Card With Prava",
            url: "https://checkout.prava.space/s/ses_checkout_1",
            checkoutId: "11111111-1111-4111-8111-111111111111",
          },
        };
      },
      fetchImpl: async () => {
        throw new Error("approval should not call the model again");
      },
    });
    assert.match(approved.message, /checked 3 prava mandates/);
    assert.match(approved.message, /normal transaction/);
    assert.equal(approved.nextAction.type, "prava_card_approval");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});

test("Hermes retries a short Gemini quota response", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let calls = 0;
  try {
    const result = await hermes.run({
      userId: 42,
      messages: [{ role: "user", content: "hello" }],
      tools,
      executeTool: async () => ({}),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({
            error: {
              message: "quota exceeded. please retry in 0s.",
              details: [{ retryDelay: "0s" }],
            },
          }, 429);
        }
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "namaste, what should we shop for?" }],
            },
          }],
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.message, "namaste, what should we shop for?");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Hermes transcribes a browser voice recording with the selected locale", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  try {
    const result = await hermes.transcribeAudio({
      audioBase64: Buffer.from("sample browser audio").toString("base64"),
      mimeType: "audio/webm;codecs=opus",
      language: "bn-IN",
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.equal(
          payload.contents[0].parts[1].inlineData.mimeType,
          "audio/webm"
        );
        assert.equal(
          payload.contents[0].parts[1].inlineData.data,
          Buffer.from("sample browser audio").toString("base64")
        );
        assert.match(payload.contents[0].parts[0].text, /bn-IN/);
        return jsonResponse({
          candidates: [{
            content: {
              role: "model",
              parts: [{ text: "\"এক লিটার দুধ আর আদা\"" }],
            },
          }],
        });
      },
    });
    assert.equal(result.transcript, "এক লিটার দুধ আর আদা");
    assert.equal(result.language, "bn-IN");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Hermes extracts exact prescription names without dosage or diagnosis", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  try {
    const encoded = Buffer.from("sample prescription image").toString("base64");
    const result = await hermes.inspectShoppingMedia({
      dataBase64: encoded,
      mimeType: "image/jpeg",
      language: "hi-IN",
      declaredType: "prescription",
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.equal(payload.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
        assert.equal(payload.contents[0].parts[1].inlineData.data, encoded);
        assert.match(payload.contents[0].parts[0].text, /do not infer dosage/i);
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            documentType: "prescription",
            items: [{
              name: "Medicine Brand 10",
              brand: "Medicine Brand",
              kind: "prescription_medicine",
              confidence: 0.96,
            }],
            query: "",
          }) }] } }],
        });
      },
    });
    assert.equal(result.documentType, "prescription");
    assert.equal(result.items[0].name, "Medicine Brand 10");
    assert.equal(result.language, "hi-IN");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Hermes approval tokens are scoped to one family", () => {
  const previousSecret = process.env.HERMES_ACTION_SECRET;
  process.env.HERMES_ACTION_SECRET = "test-action-secret";
  try {
    const token = hermes.signApproval({
      userId: 10,
      toolName: "update_cart",
      args: { quantity: 2 },
      now: 1_000,
    });
    assert.equal(
      hermes.verifyApproval(token, 10, 2_000).toolName,
      "update_cart"
    );
    assert.throws(
      () => hermes.verifyApproval(token, 11, 2_000),
      /does not belong/
    );
  } finally {
    if (previousSecret === undefined) delete process.env.HERMES_ACTION_SECRET;
    else process.env.HERMES_ACTION_SECRET = previousSecret;
  }
});
