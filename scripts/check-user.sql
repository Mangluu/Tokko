\if :{?user_id}
\else
  \echo 'Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v user_id=42 -f scripts/check-user.sql'
  \quit
\endif

\set QUIET 1
\pset pager off
\set QUIET 0

BEGIN TRANSACTION READ ONLY;

\echo
\echo '== User =='
SELECT id, clerk_user_id, phone, email, auth_channel, created_at, last_login_at
FROM users
WHERE id = :user_id;

\echo
\echo '== Website sessions (tokens are not displayed) =='
SELECT
  COUNT(*) AS active_sessions,
  MAX(last_seen_at) AS latest_activity,
  MAX(expires_at) AS latest_expiry
FROM website_sessions
WHERE user_id = :user_id
  AND expires_at > NOW();

\echo
\echo '== Family profile =='
SELECT *
FROM family_profiles
WHERE user_id = :user_id;

\echo
\echo '== Dependents =='
SELECT
  id,
  name,
  phone,
  relationship_to_user,
  position,
  is_merchant_auth_subject,
  created_at,
  updated_at
FROM family_dependents
WHERE user_id = :user_id
ORDER BY position, id;

\echo
\echo '== Merchant consent audit =='
SELECT
  platforms.slug,
  consent.subject_phone,
  consent.purpose,
  consent.consented,
  consent.policy_version,
  consent.source,
  consent.consented_at,
  consent.revoked_at,
  consent.updated_at
FROM merchant_auth_consents AS consent
JOIN platforms ON platforms.id = consent.platform_id
WHERE consent.user_id = :user_id;

\echo
\echo '== Safe payment metadata =='
SELECT
  provider,
  type,
  brand,
  last4,
  exp_month,
  exp_year,
  is_default,
  created_at
FROM payment_methods
WHERE user_id = :user_id
ORDER BY is_default DESC, created_at DESC;

\echo
\echo '== Merchant connection state (tokens are not displayed) =='
SELECT
  platforms.slug,
  (tokens.access_token IS NOT NULL) AS has_access_token,
  (tokens.refresh_token IS NOT NULL) AS has_refresh_token,
  (tokens.mcp_session_id IS NOT NULL) AS has_mcp_session,
  tokens.token_expires_at
FROM user_platform_tokens AS tokens
JOIN platforms ON platforms.id = tokens.platform_id
WHERE tokens.user_id = :user_id;

COMMIT;
