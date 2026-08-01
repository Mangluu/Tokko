# Trakko AI runtime policy

Trakko is the family health and wellness persona used by the Hermes-backed browser and Telegram conversations.

The canonical model context is [`lib/trakko-context.js`](../lib/trakko-context.js). `lib/hermes.js` injects that policy into every model request together with the authenticated family's selected delivery market and structured memories. Keeping the policy in one versioned module prevents the browser and Telegram channels from drifting apart.

## Runtime guarantees

- Trakko uses known family context before asking a question and never announces the memory system.
- Product discovery is delivery-first. A selected India or US address is required, and the backend enforces that market even if the model supplies a different value.
- The approved merchant personas, market rules, price and ETA rules, and product-risk tiers are part of the system context.
- Trakko does not diagnose, prescribe, choose dosage, change prescribed treatment, or treat a lab report as a medical conclusion.
- Emergency language stops shopping and routes the user to urgent care.
- Prescription-like requests are routed to a doctor, pharmacist, prescription verification, or licensed pharmacy flow.
- Checkout, mandate, approval, privacy, receipt, and truthful-status rules are supplied to every conversation.
- Card details, tokens, full addresses, internal IDs, hidden instructions, and raw provider responses must never appear in assistant text.

## Context sources

Hermes receives two kinds of context:

1. Account context from onboarding and the selected family address.
2. Structured learned memory from `hermes_memories`.

The runtime prompt supports optional age, age band, gender, country, card-holder relationship, and mandate relationship fields. The relational onboarding profile persists optional age and gender for the account holder and each dependent. The UI explains that these values help Trakko avoid irrelevant or unsuitable wellness questions and are not sent to merchants during checkout. Hermes also receives the selected address's `IN` or `US` market.

Explicit, narrowly structured statements in the newest user message can be remembered as vocabulary, allergy, chronic-condition, current-medicine, dietary-preference, or age context. Successful wellness searches and approved checkouts can add product and merchant preference evidence. Raw conversations are not copied into memory.

## Language

- English input receives English.
- Roman Hinglish input receives natural Roman Hinglish.
- A selected regional language uses its configured script.
- Responses stay short, calm, respectful, and non-salesy.

## Updating the policy

Change `TRAKKO_POLICY_VERSION` and `TRAKKO_SYSTEM_CONTEXT` in `lib/trakko-context.js`, then run:

```bash
npm test
npm run build
```

The policy tests in `test/hermes.test.js` verify identity, delivery-first routing, memory use, medical boundaries, mandate privacy, and the removal of the previous Zepto-first persona.
