\set QUIET 1
\pset pager off
\set QUIET 0

BEGIN TRANSACTION READ ONLY;

\echo
\echo '== Database connection =='
SELECT
  current_database() AS database,
  current_user AS connected_as,
  current_setting('server_version') AS postgres_version,
  NOW() AS checked_at;

\echo
\echo '== Required tables =='
SELECT
  expected.table_name,
  CASE WHEN actual.table_name IS NULL THEN 'MISSING' ELSE 'OK' END AS status
FROM (
  VALUES
    ('users'),
    ('website_sessions'),
    ('family_profiles'),
    ('family_dependents'),
    ('merchant_auth_consents'),
    ('payment_customers'),
    ('payment_methods'),
    ('payment_tokenization_sessions'),
    ('user_platform_tokens'),
    ('merchant_auth_attempts'),
    ('webhook_events'),
    ('platforms'),
    ('oauth_clients')
) AS expected(table_name)
LEFT JOIN information_schema.tables AS actual
  ON actual.table_schema = 'public'
 AND actual.table_name = expected.table_name
ORDER BY expected.table_name;

\echo
\echo '== Row counts =='
SELECT 'users' AS table_name, COUNT(*) AS rows FROM users
UNION ALL SELECT 'website_sessions', COUNT(*) FROM website_sessions
UNION ALL SELECT 'family_profiles', COUNT(*) FROM family_profiles
UNION ALL SELECT 'family_dependents', COUNT(*) FROM family_dependents
UNION ALL SELECT 'merchant_auth_consents', COUNT(*) FROM merchant_auth_consents
UNION ALL SELECT 'payment_customers', COUNT(*) FROM payment_customers
UNION ALL SELECT 'payment_methods', COUNT(*) FROM payment_methods
UNION ALL SELECT 'payment_tokenization_sessions', COUNT(*) FROM payment_tokenization_sessions
UNION ALL SELECT 'user_platform_tokens', COUNT(*) FROM user_platform_tokens
UNION ALL SELECT 'merchant_auth_attempts', COUNT(*) FROM merchant_auth_attempts
UNION ALL SELECT 'webhook_events', COUNT(*) FROM webhook_events
UNION ALL SELECT 'platforms', COUNT(*) FROM platforms
UNION ALL SELECT 'oauth_clients', COUNT(*) FROM oauth_clients
ORDER BY table_name;

\echo
\echo '== Recent onboarding records (no raw tokens) =='
SELECT
  users.id AS user_id,
  users.auth_channel,
  profiles.onboarding_source,
  profiles.primary_parent_name,
  profiles.offspring_name AS dependent_name,
  profiles.dependent_relationship,
  profiles.merchant_auth_subject_type,
  (
    SELECT COUNT(*)
    FROM family_dependents AS dependents
    WHERE dependents.user_id = users.id
  ) AS dependent_count,
  CASE
    WHEN profiles.primary_parent_phone IS NULL THEN NULL
    ELSE REPEAT('*', GREATEST(LENGTH(profiles.primary_parent_phone) - 4, 0))
         || RIGHT(profiles.primary_parent_phone, 4)
  END AS parent_phone_masked,
  profiles.linq_phone_number,
  consent.consented AS zepto_phone_consent,
  methods.brand AS card_brand,
  methods.last4 AS card_last4,
  (tokens.access_token IS NOT NULL) AS zepto_connected,
  profiles.updated_at
FROM users
LEFT JOIN family_profiles AS profiles ON profiles.user_id = users.id
LEFT JOIN platforms AS zepto ON zepto.slug = 'zepto'
LEFT JOIN merchant_auth_consents AS consent
  ON consent.user_id = users.id
 AND consent.platform_id = zepto.id
 AND consent.purpose = 'authenticate_offspring_phone'
LEFT JOIN payment_methods AS methods
  ON methods.user_id = users.id
 AND methods.is_default = true
LEFT JOIN user_platform_tokens AS tokens
  ON tokens.user_id = users.id
 AND tokens.platform_id = zepto.id
ORDER BY users.id DESC
LIMIT 20;

COMMIT;
