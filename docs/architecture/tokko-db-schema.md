# Tokko db schema

_Tokko PostgreSQL schema — 27 tables, the pg.Pool in lib/db.js, inline idempotent migrations, and key data-access functions by domain._

DB layer is `lib/db.js` (~2869 lines). Part of [tokko-overview](tokko-overview.md).

## Connection
- Real client = **`pg` npm `Pool`**, one lazy module singleton `getPool()` (db.js:8), reused warm across
  serverless invocations. `DATABASE_URL` OR discrete `PG*` (defaults host=localhost, user+db=**`plantri`**).
  `max=PGPOOL_MAX||5`, idle 30s, connect 10s. **⚠ No SSL config in code** (relies on connection-string params).
- **⚠ `lib/pg.js` is a separate hand-rolled raw wire-protocol client (`class PgClient`), NOT imported by db.js** —
  standalone diagnostic/script client (cleartext+MD5 auth only, no SASL/SSL). db.js does not use it.
- `query()` awaits memoized `initialize()` every call; transactions use `connect()` + explicit BEGIN/COMMIT/ROLLBACK + `FOR UPDATE`.

## Migrations
No migration runner / no versioned files. **Inline + idempotent, run every boot** in `initialize()` (db.js:31,
memoized once/process, nulled on failure): `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` +
`ALTER COLUMN ... DROP NOT NULL` + `CREATE [UNIQUE] INDEX IF NOT EXISTS`, ordered FK-target-first. Inline
backfills (dependents from `family_profiles` db.js:222; token phones; payment_customers). **Platform seeding**
(db.js:636) upserts `platforms.json` rows by slug.

## The 27 tables (`users.id SERIAL` is the hub; ~all FK `user_id → users(id) ON DELETE CASCADE`)
1. **users** (:39) — auth hub. `phone UNIQUE` (later nullable), `clerk_user_id`, `email`, `password_hash`, `auth_channel` (website/linq/telegram). Partial-unique on clerk_id and LOWER(email).
2. **website_sessions** (:68) — `token_hash CHAR(64) PK` (SHA-256 of token), `expires_at`. 7-day TTL.
3. **email_signup_challenges** (:81) — pending email-OTP signups; `email UNIQUE`, `otp_hash`, `attempt_count`.
4. **family_profiles** (:102) — one row/user, LEGACY single-dependent shape; parent/secondary fields, `merchant_auth_phone`/`_subject_type`, LINQ fields (`linq_phone_number*`, `linq_chat_id`).
5. **family_dependents** (:171) — NEW multi-dependent model. `phone`, `relationship_to_user`, `is_merchant_auth_subject`, **`archived_at` (soft-delete)**. Partial-unique `(user_id,phone) WHERE archived_at IS NULL`; one merchant-auth subject/user.
6. **platforms** (:248) — merchant/MCP registry. `slug UNIQUE`, `mcp_url`, `auth_server_url`, `auth_flow_type`. Seeded from platforms.json (only `zepto`).
7. **oauth_clients** (:261) — per-platform DCR client (`client_id`, `redirect_uri`).
8. **user_platform_consents** (:271) — generic consent PK `(user_id,platform_id)`.
9. **merchant_auth_consents** (:281) — **versioned/audited** consent PK `(user_id,platform_id,purpose)`; `subject_phone`, `consent_text`, `policy_version`, `actor_clerk_user_id`, revoked_at. Purpose = `authenticate_offspring_phone`.
10. **user_platform_tokens** (:299) — merchant OAuth/MCP tokens PK `(user_id,platform_id)`: `access_token`, `refresh_token`, `mcp_session_id`, `authenticated_phone`.
11. **family_delivery_preferences** (:311) — one/user; selected platform + address_id.
12. **family_addresses** (:322) — structured addr; `country_code` (IN/US), `contact_name/phone`, `is_selected` (one selected/user).
13. **family_member_addresses** (:349) — M:N dependent↔address.
14. **family_care_rules** (:363) — spending policy one/user: `approval_mode` (ask_every_time/auto), `monthly_cap`, `per_order_cap`, `allowed_categories TEXT[]`, `blocked_items TEXT[]`.
15. **user_preferences** (:378) — notif toggles.
16. **decision_requests** (:389) — approval inbox. `id UUID`, `status` (pending/resolved/expired), `product JSONB`, `amount`, `reason_code/text`, `payment_context JSONB`, `action_context JSONB`, member/address FKs (SET NULL).
17. **activity_events** (:420) — append-only audit feed; `metadata JSONB`.
18. **merchant_auth_attempts** (:452) — single-use pending OTP challenge; `pending_id PK`, `payload JSONB`.
19. **payment_customers** (:463) — one/user; `provider_customer_id UNIQUE` = `tokko_family_<id>`.
20. **payment_methods** (:479) — saved cards **metadata only** (no PAN): `provider_payment_method_id UNIQUE`, brand, last4, exp, `is_default`.
21. **payment_tokenization_sessions** (:496) — `session_id PK`, completed_at.
22. **checkout_flows** (:511, widest) — Zepto/Prava checkout state machine. `id UUID`; card fields (`card_failure_count`, `card_payment_received`); COD (`allow_cod_fallback`, `fallback_to_cod`); **Prava** (`prava_mandate_id`, `prava_transaction_id`, `prava_charge_status/amount`, `payment_route`, `prava_session_id`, `sandbox_payment_attempt`); `price_breakdown JSONB`, `cart_snapshot JSONB`; status enum. See [tokko-payments-checkout](tokko-payments-checkout.md).
23. **webhook_events** (:562) — idempotency ledger PK `(provider,event_id)`.
24. **address_geocoding_cache** (:572) — `query_key CHAR(64) PK` (hash), lat/lon.
25. **hermes_memories** (:584) — agent long-term memory; `memory_value JSONB`, `confidence` (reinforced +0.05, cap 1), UNIQUE `(user_id,memory_type,cue)`. See [tokko-hermes-agent](tokko-hermes-agent.md).
26. **telegram_hermes_bindings** (:604) — chat_id ↔ user, `selected_address_id`.
27. **telegram_hermes_messages** (:622) — transcript, `role` CHECK user/assistant.

## Notable patterns
Soft-delete only on `family_dependents`. Audit = `activity_events` + versioned `merchant_auth_consents`.
Ownership guards baked into SQL (checkout upsert 403 guard db.js:2552; decision member/address validation;
signup attempt caps). Partial-unique indexes enforce singletons. Nearly all reads/writes filter `WHERE user_id`.
Read-only diagnostics: `scripts/check-db.sql`, `scripts/check-user.sql` (redact tokens).
