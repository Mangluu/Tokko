# Tokko auth onboarding

_Tokko auth & onboarding — website sessions (scrypt/plantri_session), Clerk email-OTP + Google, service API keys, LINQ partner onboarding + Standard-Webhooks HMAC, validation, geocoding._

Files: `lib/{auth,website-auth,email-verification,linq,validation,geocoding,trakko-context}.js`.
Route wiring in `server.js`. Auth-tier summary in [tokko-server-routing](tokko-server-routing.md). Part of [tokko-overview](tokko-overview.md).

## Website auth (lib/website-auth.js)
Self-contained email/phone + password, independent of Clerk sessions.
- **Password:** scrypt (`N=16384,r=8,p=1,keylen=64`), 16-byte salt, self-describing string
  `scrypt$N$r$p$salt$hash` (:54) → re-hash-safe; verify is constant-time. Policy 10–128 chars.
- **Session:** token = 32 random bytes b64url; stored **SHA-256-hashed** only (:120). Cookie `plantri_session`
  (:5), `HttpOnly; Path=/; SameSite=Lax; Max-Age=604800; Secure` (Secure iff `x-forwarded-proto`). 7-day TTL.
- **Signup** (server.js:3529): `/api/auth/signup` normalizes email, rejects existing password (409), stores a
  pending challenge (`signup_<b64url>`, 10-min TTL), returns 202 (**no account until verify**). `/api/auth/signup/verify`
  confirms Clerk email verified then creates user + session.
- **Login** (server.js:3588): by email OR family phone. Phone path proceeds only if **exactly one** account
  matches (ambiguous/unknown both fail — anti-enumeration; dummy hash equalizes timing).
- **Clerk→session bridge** `/api/auth/clerk/session`: Google/Clerk users also get a `plantri_session` cookie.

## Clerk (lib/auth.js, lib/email-verification.js)
`@clerk/backend`. Env `CLERK_SECRET_KEY` + `CLERK_PUBLISHABLE_KEY` (both or 503), `CLERK_AUTHORIZED_PARTIES`
(falls back to BASE_URL). Clerk is used ONLY as the **email-verification trust anchor** for signup
(`verifyCompletedSignup`, email-verification.js:31 — signup id `/^sua_.../`, email must match + be verified;
accepts `complete` OR `missing_requirements` when email specifically verified) and for M2M/session-token verify.
Tokko owns the rest of signup.

## Service API auth (`requireService`, auth.js:136)
Clerk `["m2m_token","api_key"]` OR timing-safe `X-API-Key` (SHA-256+timingSafeEqual) vs `EXTERNAL_API_KEYS`
(comma-split). Guards all `/api/v1/*`.

## LINQ (lib/linq.js) — SMS/chat partner
`api.linqapp.com/api/partner/v3`, Bearer `LINQ_API_KEY`.
- **Number assignment** (`assignPhoneNumber`, :50): `LINQ_PHONE_NUMBER` env if set, else list numbers,
  drop CRITICAL-health, then **deterministic** pick `sha256(stableKey) % usable.length` (same family → same number).
- **Onboard** `POST /api/v1/linq/onboard` (server.js:4111, Svc): validate → `upsertLinqUser` → `saveProfile(...,"linq")`
  → assign number → record merchant-auth consent → send welcome chat (idempotency `plantri-onboard-<userId>`). Idempotent by primary phone.
- **Resolve** `GET /api/v1/linq/resolve?from&to` — maps inbound (sender, assigned LINQ number) → Tokko userId (409 ambiguous/404 none).
- **Webhook** `POST /api/webhooks/linq` — **Standard Webhooks** HMAC (`verifyWebhook`, :83): `webhook-{id,timestamp,signature}`,
  **±5-min freshness**, secret stripped of `whsec_` + base64-decoded as HMAC key, `HMAC(id.timestamp.body)`, dedupe via `webhook_events`.
  ⚠ Handler currently only ACKs + dedupes; no event-type dispatch yet.

## Merchant-auth phone decision
`onboardingInput`/`websiteOnboardingInput` (validation.js) resolve **which family phone authenticates with the
merchant** (`merchantAuthPhone` + `merchantAuthSubjectType` ∈ account_holder/dependent). This drives the versioned
`merchant_auth_consents` record (purpose `authenticate_offspring_phone`) that gates Zepto. See [tokko-hermes-agent](tokko-hermes-agent.md).

## Validation (lib/validation.js)
Pure validators, throw `Error` with `.status=400`. E.164 `/^\+[1-9]\d{7,14}$/`; `phoneInput` accepts full E.164
OR countryCode+localPhone (strips trunk-zero). Email, age 0–120, gender. `dependentInput` tolerant of legacy
field aliases; ≤20 dependents, all phones unique. Website flow forces secondaryParent/merchant-auth null.

## Geocoding (lib/geocoding.js)
India-only free-text → coords via **OpenStreetMap Nominatim** (`countrycodes=in`, 8s timeout, ≥1100ms public
rate-limit, custom User-Agent). Cached by `sha256(area)` in `address_geocoding_cache`. Rejects (0,0); no result→422.

## trakko-context.js
Not logic — the **system prompt** `TRAKKO_SYSTEM_CONTEXT` (`TRAKKO_POLICY_VERSION="2026-08-02"`) injected into
the Gemini agent: persona, delivery-first routing, approved-merchant catalogue, medical boundary (no diagnose/prescribe),
never-leak-secrets rules. See [tokko-hermes-agent](tokko-hermes-agent.md).
