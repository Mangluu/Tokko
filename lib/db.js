const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

let pool = null;
let initialization = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    const localConfig = connectionString
      ? { connectionString }
      : {
          host: process.env.PGHOST || "localhost",
          port: Number(process.env.PGPORT || 5432),
          user: process.env.PGUSER || "plantri",
          password: process.env.PGPASSWORD || "",
          database: process.env.PGDATABASE || "plantri",
        };
    pool = new Pool({
      ...localConfig,
      max: Number(process.env.PGPOOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (error) => console.error("[db] idle client error:", error.message));
  }
  return pool;
}

async function initialize() {
  if (initialization) return initialization;
  initialization = (async () => {
    const db = getPool();
    await db.query("SELECT 1");
    console.log("[db] connected to PostgreSQL");

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(16) UNIQUE,
        clerk_user_id TEXT,
        email TEXT,
        password_hash TEXT,
        auth_channel VARCHAR(20) NOT NULL DEFAULT 'website',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`ALTER TABLE users ALTER COLUMN phone DROP NOT NULL`);
    await db.query(`ALTER TABLE users ALTER COLUMN phone TYPE VARCHAR(16)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
    await db.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_channel VARCHAR(20) NOT NULL DEFAULT 'website'`
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_clerk_user_id_idx
       ON users (clerk_user_id) WHERE clerk_user_id IS NOT NULL`
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx
       ON users (LOWER(email)) WHERE email IS NOT NULL`
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS website_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS website_sessions_user_idx
       ON website_sessions (user_id, expires_at)`
    );
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_signup_challenges (
        id VARCHAR(80) PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        otp_hash CHAR(64),
        expires_at TIMESTAMPTZ NOT NULL,
        attempt_count SMALLINT NOT NULL DEFAULT 0,
        last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `ALTER TABLE email_signup_challenges
       ALTER COLUMN otp_hash DROP NOT NULL`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS email_signup_challenges_expiry_idx
       ON email_signup_challenges (expires_at)`
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS family_profiles (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        primary_parent_name TEXT NOT NULL,
        primary_parent_phone VARCHAR(16) NOT NULL,
        primary_parent_age SMALLINT CHECK (
          primary_parent_age BETWEEN 0 AND 120
        ),
        primary_parent_gender TEXT,
        secondary_parent_name TEXT,
        secondary_parent_phone VARCHAR(16),
        offspring_name TEXT,
        offspring_phone VARCHAR(16),
        dependent_relationship TEXT DEFAULT 'child',
        merchant_auth_phone VARCHAR(16),
        merchant_auth_subject_type VARCHAR(20) NOT NULL DEFAULT 'dependent',
        onboarding_source VARCHAR(20) NOT NULL DEFAULT 'website',
        linq_phone_number_id TEXT,
        linq_phone_number VARCHAR(16),
        linq_chat_id TEXT,
        last_linq_activity_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `ALTER TABLE family_profiles
       ADD COLUMN IF NOT EXISTS dependent_relationship TEXT NOT NULL DEFAULT 'child'`
    );
    await db.query(
      `ALTER TABLE family_profiles
       ADD COLUMN IF NOT EXISTS primary_parent_age SMALLINT CHECK (
         primary_parent_age BETWEEN 0 AND 120
       )`
    );
    await db.query(
      `ALTER TABLE family_profiles
       ADD COLUMN IF NOT EXISTS primary_parent_gender TEXT`
    );
    await db.query(
      `ALTER TABLE family_profiles ALTER COLUMN offspring_phone DROP NOT NULL`
    );
    await db.query(
      `ALTER TABLE family_profiles ALTER COLUMN dependent_relationship DROP NOT NULL`
    );
    await db.query(
      `ALTER TABLE family_profiles
       ADD COLUMN IF NOT EXISTS merchant_auth_phone VARCHAR(16)`
    );
    await db.query(
      `ALTER TABLE family_profiles
       ADD COLUMN IF NOT EXISTS merchant_auth_subject_type VARCHAR(20)
       NOT NULL DEFAULT 'dependent'`
    );
    await db.query(
      `UPDATE family_profiles
       SET merchant_auth_phone = offspring_phone
       WHERE merchant_auth_phone IS NULL`
    );
    await db.query(
      `ALTER TABLE family_profiles ALTER COLUMN primary_parent_phone DROP NOT NULL`
    );
    await db.query(
      `ALTER TABLE family_profiles ALTER COLUMN merchant_auth_phone DROP NOT NULL`
    );
    await db.query(
      `ALTER TABLE family_profiles ALTER COLUMN merchant_auth_subject_type DROP NOT NULL`
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS family_dependents (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        phone VARCHAR(16) NOT NULL,
        relationship_to_user TEXT NOT NULL,
        age SMALLINT CHECK (age BETWEEN 0 AND 120),
        gender TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        is_merchant_auth_subject BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, phone)
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS family_dependents_user_position_idx
       ON family_dependents (user_id, position, id)`
    );
    await db.query(
      `ALTER TABLE family_dependents
       ADD COLUMN IF NOT EXISTS age SMALLINT CHECK (age BETWEEN 0 AND 120)`
    );
    await db.query(
      `ALTER TABLE family_dependents
       ADD COLUMN IF NOT EXISTS gender TEXT`
    );
    await db.query(
      `ALTER TABLE family_dependents
       ADD COLUMN IF NOT EXISTS channel VARCHAR(30) NOT NULL DEFAULT 'phone'`
    );
    await db.query(
      `ALTER TABLE family_dependents
       ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`
    );
    await db.query(
      `ALTER TABLE family_dependents
       ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`
    );
    await db.query(
      `ALTER TABLE family_dependents
       DROP CONSTRAINT IF EXISTS family_dependents_user_id_phone_key`
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS family_dependents_active_phone_idx
       ON family_dependents (user_id, phone) WHERE archived_at IS NULL`
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS family_dependents_merchant_subject_idx
       ON family_dependents (user_id) WHERE is_merchant_auth_subject`
    );
    await db.query(`
      INSERT INTO family_dependents (
        user_id, name, phone, relationship_to_user,
        position, is_merchant_auth_subject
      )
      SELECT
        user_id,
        COALESCE(offspring_name, 'Dependent'),
        offspring_phone,
        dependent_relationship,
        0,
        merchant_auth_subject_type = 'dependent'
          AND merchant_auth_phone = offspring_phone
      FROM family_profiles
      WHERE offspring_phone IS NOT NULL
      ON CONFLICT (user_id, phone) WHERE archived_at IS NULL DO UPDATE SET
        name = EXCLUDED.name,
        relationship_to_user = EXCLUDED.relationship_to_user,
        is_merchant_auth_subject = EXCLUDED.is_merchant_auth_subject,
        updated_at = NOW()
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS platforms (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        mcp_url TEXT,
        auth_server_url TEXT,
        oauth_scopes TEXT DEFAULT '',
        auth_flow_type VARCHAR(30) DEFAULT 'oauth2_otp',
        enabled BOOLEAN DEFAULT true
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        platform_id INTEGER PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_platform_consents (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform_id INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
        consented BOOLEAN DEFAULT false,
        consented_at TIMESTAMPTZ,
        PRIMARY KEY (user_id, platform_id)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS merchant_auth_consents (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform_id INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
        subject_phone VARCHAR(16) NOT NULL,
        purpose TEXT NOT NULL,
        consented BOOLEAN NOT NULL DEFAULT false,
        consent_text TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        source VARCHAR(20) NOT NULL,
        actor_clerk_user_id TEXT,
        consented_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, platform_id, purpose)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_platform_tokens (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform_id INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
        access_token TEXT,
        refresh_token TEXT,
        mcp_session_id TEXT,
        authenticated_phone VARCHAR(16),
        token_expires_at TIMESTAMPTZ,
        PRIMARY KEY (user_id, platform_id)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS family_delivery_preferences (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        platform_slug VARCHAR(50) NOT NULL DEFAULT 'zepto',
        address_id TEXT NOT NULL,
        label TEXT,
        formatted_address TEXT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS family_addresses (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        formatted_address TEXT NOT NULL,
        address_line1 TEXT,
        address_line2 TEXT,
        city TEXT,
        state TEXT,
        postal_code TEXT,
        country_code VARCHAR(2) NOT NULL DEFAULT 'IN',
        contact_name TEXT,
        contact_phone VARCHAR(16),
        is_selected BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS family_addresses_user_idx
       ON family_addresses (user_id, created_at, id)`
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS family_addresses_selected_idx
       ON family_addresses (user_id) WHERE is_selected`
    );
    await db.query(`
      CREATE TABLE IF NOT EXISTS family_member_addresses (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        member_id BIGINT NOT NULL REFERENCES family_dependents(id) ON DELETE CASCADE,
        address_id BIGINT NOT NULL REFERENCES family_addresses(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (member_id, address_id)
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS family_member_addresses_user_idx
       ON family_member_addresses (user_id, address_id, member_id)`
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS family_care_rules (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        approval_mode VARCHAR(30) NOT NULL DEFAULT 'ask_every_time',
        monthly_cap NUMERIC(12, 2),
        per_order_cap NUMERIC(12, 2),
        currency VARCHAR(3) NOT NULL DEFAULT 'INR',
        repeat_known_essentials BOOLEAN NOT NULL DEFAULT false,
        allowed_categories TEXT[] NOT NULL DEFAULT '{}',
        blocked_items TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        decision_alerts BOOLEAN NOT NULL DEFAULT true,
        delivery_updates BOOLEAN NOT NULL DEFAULT true,
        weekly_digest BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS decision_requests (
        id UUID PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        member_id BIGINT REFERENCES family_dependents(id) ON DELETE SET NULL,
        request_type VARCHAR(40) NOT NULL DEFAULT 'purchase_approval',
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        original_request TEXT,
        merchant_name TEXT,
        product JSONB NOT NULL DEFAULT '{}'::jsonb,
        amount NUMERIC(12, 2),
        currency VARCHAR(3) NOT NULL DEFAULT 'INR',
        address_id BIGINT REFERENCES family_addresses(id) ON DELETE SET NULL,
        reason_code VARCHAR(60),
        reason_text TEXT NOT NULL,
        payment_context JSONB NOT NULL DEFAULT '{}'::jsonb,
        action_context JSONB NOT NULL DEFAULT '{}'::jsonb,
        resolution VARCHAR(30),
        resolution_note TEXT,
        expires_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS decision_requests_user_status_idx
       ON decision_requests (user_id, status, created_at DESC)`
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS activity_events (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type VARCHAR(60) NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        entity_type VARCHAR(40),
        entity_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS activity_events_user_created_idx
       ON activity_events (user_id, created_at DESC, id DESC)`
    );
    await db.query(
      `ALTER TABLE user_platform_tokens
       ADD COLUMN IF NOT EXISTS authenticated_phone VARCHAR(16)`
    );
    await db.query(`
      UPDATE user_platform_tokens AS tokens
      SET authenticated_phone = consents.subject_phone
      FROM merchant_auth_consents AS consents
      WHERE tokens.user_id = consents.user_id
        AND tokens.platform_id = consents.platform_id
        AND tokens.authenticated_phone IS NULL
        AND consents.purpose = 'authenticate_offspring_phone'
        AND consents.consented = true
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS merchant_auth_attempts (
        pending_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_customers (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(30) NOT NULL,
        provider_customer_id TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      INSERT INTO payment_customers (user_id, provider, provider_customer_id)
      SELECT profiles.user_id, 'prava', 'tokko_family_' || profiles.user_id
      FROM family_profiles AS profiles
      ON CONFLICT (user_id) DO NOTHING
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_methods (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(30) NOT NULL,
        provider_payment_method_id TEXT UNIQUE NOT NULL,
        type VARCHAR(30) NOT NULL,
        brand VARCHAR(30),
        last4 VARCHAR(4),
        exp_month INTEGER,
        exp_year INTEGER,
        is_default BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_tokenization_sessions (
        session_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(30) NOT NULL,
        expires_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS payment_tokenization_sessions_user_idx
       ON payment_tokenization_sessions (user_id, created_at DESC)`
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS checkout_flows (
        id UUID PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform VARCHAR(30) NOT NULL DEFAULT 'zepto',
        status VARCHAR(40) NOT NULL,
        address_id TEXT,
        card_brand VARCHAR(30),
        card_last4 VARCHAR(4),
        card_failure_count SMALLINT NOT NULL DEFAULT 0,
        card_payment_received BOOLEAN NOT NULL DEFAULT false,
        allow_cod_fallback BOOLEAN NOT NULL DEFAULT true,
        fallback_to_cod BOOLEAN NOT NULL DEFAULT false,
        card_order_id TEXT,
        zepto_order_id TEXT,
        last_failed_order_id TEXT,
        prava_mandate_id TEXT,
        prava_transaction_id TEXT,
        prava_charge_reference TEXT,
        prava_charge_status VARCHAR(40),
        prava_charge_amount VARCHAR(30),
        prava_charge_reported_at TIMESTAMPTZ,
        payment_route VARCHAR(30),
        prava_session_id TEXT,
        prava_session_approval_url TEXT,
        sandbox_payment_attempt BOOLEAN NOT NULL DEFAULT false,
        price_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
        cart_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
        failure_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `ALTER TABLE checkout_flows
       ADD COLUMN IF NOT EXISTS prava_mandate_id TEXT,
       ADD COLUMN IF NOT EXISTS prava_transaction_id TEXT,
       ADD COLUMN IF NOT EXISTS prava_charge_reference TEXT,
       ADD COLUMN IF NOT EXISTS prava_charge_status VARCHAR(40),
       ADD COLUMN IF NOT EXISTS prava_charge_amount VARCHAR(30),
       ADD COLUMN IF NOT EXISTS prava_charge_reported_at TIMESTAMPTZ,
       ADD COLUMN IF NOT EXISTS payment_route VARCHAR(30),
       ADD COLUMN IF NOT EXISTS prava_session_id TEXT,
       ADD COLUMN IF NOT EXISTS prava_session_approval_url TEXT,
       ADD COLUMN IF NOT EXISTS sandbox_payment_attempt BOOLEAN NOT NULL DEFAULT false`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS checkout_flows_user_updated_idx
       ON checkout_flows (user_id, updated_at DESC)`
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        provider VARCHAR(30) NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider, event_id)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS address_geocoding_cache (
        query_key CHAR(64) PRIMARY KEY,
        query_text TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        provider VARCHAR(40) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS hermes_memories (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        memory_type VARCHAR(40) NOT NULL,
        cue TEXT NOT NULL,
        memory_value JSONB NOT NULL DEFAULT '{}'::jsonb,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.6,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, memory_type, cue)
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS hermes_memories_user_confidence_idx
       ON hermes_memories (user_id, confidence DESC, updated_at DESC)`
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS telegram_hermes_bindings (
        chat_id VARCHAR(64) PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        telegram_username VARCHAR(100),
        selected_address_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `ALTER TABLE telegram_hermes_bindings
       ADD COLUMN IF NOT EXISTS selected_address_id BIGINT`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS telegram_hermes_bindings_user_idx
       ON telegram_hermes_bindings (user_id)`
    );
    await db.query(`
      CREATE TABLE IF NOT EXISTS telegram_hermes_messages (
        id BIGSERIAL PRIMARY KEY,
        chat_id VARCHAR(64) NOT NULL
          REFERENCES telegram_hermes_bindings(chat_id) ON DELETE CASCADE,
        role VARCHAR(12) NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS telegram_hermes_messages_chat_idx
       ON telegram_hermes_messages (chat_id, id DESC)`
    );

    const platformsFile = path.join(__dirname, "..", "platforms.json");
    if (fs.existsSync(platformsFile)) {
      const configuredPlatforms = JSON.parse(fs.readFileSync(platformsFile, "utf8"));
      for (const platform of configuredPlatforms) {
        await db.query(
          `INSERT INTO platforms
             (slug, name, mcp_url, auth_server_url, oauth_scopes, auth_flow_type, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (slug) DO UPDATE SET
             name = EXCLUDED.name,
             mcp_url = EXCLUDED.mcp_url,
             auth_server_url = EXCLUDED.auth_server_url,
             oauth_scopes = EXCLUDED.oauth_scopes,
             auth_flow_type = EXCLUDED.auth_flow_type,
             enabled = EXCLUDED.enabled`,
          [
            platform.slug,
            platform.name,
            platform.mcp_url || "",
            platform.auth_server_url || "",
            platform.oauth_scopes || "",
            platform.auth_flow_type || "oauth2_otp",
            platform.enabled !== false,
          ]
        );
      }
      console.log(`[db] seeded ${configuredPlatforms.length} platform(s)`);
    }
    console.log("[db] tables ready");
  })().catch((error) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

async function query(text, params = []) {
  await initialize();
  return getPool().query(text, params);
}

async function getHermesMemories(userId, limit = 40) {
  const result = await query(
    `SELECT memory_type, cue, memory_value, confidence, evidence_count,
            last_used_at, updated_at
     FROM hermes_memories
     WHERE user_id = $1
     ORDER BY confidence DESC, evidence_count DESC, updated_at DESC
     LIMIT $2`,
    [Number(userId), Math.max(1, Math.min(Number(limit) || 40, 100))]
  );
  return result.rows.map((row) => ({
    type: row.memory_type,
    cue: row.cue,
    value: row.memory_value || {},
    confidence: Number(row.confidence),
    evidenceCount: Number(row.evidence_count),
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at,
  }));
}

async function upsertHermesMemory(userId, memory) {
  const memoryType = String(memory?.type || "").trim().slice(0, 40);
  const cue = String(memory?.cue || "").trim().slice(0, 500);
  if (!memoryType || !cue) return null;
  const confidence = Math.max(
    0.1,
    Math.min(Number(memory?.confidence) || 0.6, 1)
  );
  const result = await query(
    `INSERT INTO hermes_memories (
       user_id, memory_type, cue, memory_value, confidence
     )
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (user_id, memory_type, cue) DO UPDATE SET
       memory_value = EXCLUDED.memory_value,
       confidence = LEAST(
         1,
         GREATEST(
           hermes_memories.confidence,
           EXCLUDED.confidence
         ) + 0.05
       ),
       evidence_count = hermes_memories.evidence_count + 1,
       updated_at = NOW()
     RETURNING memory_type, cue, memory_value, confidence, evidence_count,
               last_used_at, updated_at`,
    [
      Number(userId),
      memoryType,
      cue,
      JSON.stringify(memory?.value || {}),
      confidence,
    ]
  );
  const row = result.rows[0];
  return {
    type: row.memory_type,
    cue: row.cue,
    value: row.memory_value || {},
    confidence: Number(row.confidence),
    evidenceCount: Number(row.evidence_count),
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at,
  };
}

async function getTelegramHermesBinding(chatId) {
  const result = await query(
    `SELECT binding.chat_id, binding.user_id, binding.telegram_username,
            binding.created_at, binding.updated_at, users.email
     FROM telegram_hermes_bindings AS binding
     JOIN users ON users.id = binding.user_id
     WHERE binding.chat_id = $1`,
    [String(chatId)]
  );
  return result.rows[0] || null;
}

async function saveTelegramHermesBinding(chatId, userId, username = null) {
  const result = await query(
    `INSERT INTO telegram_hermes_bindings (
       chat_id, user_id, telegram_username
     )
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       telegram_username = COALESCE(
         EXCLUDED.telegram_username,
         telegram_hermes_bindings.telegram_username
       ),
       selected_address_id = CASE
         WHEN telegram_hermes_bindings.user_id = EXCLUDED.user_id
           THEN telegram_hermes_bindings.selected_address_id
         ELSE NULL
       END,
       updated_at = NOW()
     RETURNING *`,
    [String(chatId), Number(userId), username ? String(username).slice(0, 100) : null]
  );
  return result.rows[0];
}

async function getTelegramAddressSession(chatId) {
  const result = await query(
    `SELECT binding.chat_id, binding.user_id, binding.selected_address_id,
            address.label, address.formatted_address
     FROM telegram_hermes_bindings AS binding
     LEFT JOIN family_addresses AS address
       ON address.id = binding.selected_address_id
      AND address.user_id = binding.user_id
     WHERE binding.chat_id = $1`,
    [String(chatId)]
  );
  return result.rows[0] || null;
}

async function resetTelegramAddressSession(chatId) {
  const result = await query(
    `UPDATE telegram_hermes_bindings
     SET selected_address_id = NULL, updated_at = NOW()
     WHERE chat_id = $1
     RETURNING chat_id, user_id, selected_address_id`,
    [String(chatId)]
  );
  return result.rows[0] || null;
}

async function confirmTelegramAddressSession(chatId, addressId) {
  const result = await query(
    `UPDATE telegram_hermes_bindings AS binding
     SET selected_address_id = address.id, updated_at = NOW()
     FROM family_addresses AS address
     WHERE binding.chat_id = $1
       AND address.id = $2
       AND address.user_id = binding.user_id
     RETURNING binding.chat_id, binding.user_id, binding.selected_address_id,
               address.label, address.formatted_address`,
    [String(chatId), String(addressId)]
  );
  return result.rows[0] || null;
}

async function getTelegramHermesMessages(chatId, limit = 24) {
  const result = await query(
    `SELECT role, content, created_at
     FROM (
       SELECT id, role, content, created_at
       FROM telegram_hermes_messages
       WHERE chat_id = $1
       ORDER BY id DESC
       LIMIT $2
     ) AS recent
     ORDER BY id`,
    [String(chatId), Math.max(1, Math.min(Number(limit) || 24, 50))]
  );
  return result.rows.map((row) => ({
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

async function saveTelegramHermesMessage(chatId, role, content) {
  const normalizedRole = role === "assistant" ? "assistant" : "user";
  const normalizedContent = String(content || "").trim().slice(0, 6_000);
  if (!normalizedContent) return null;
  const result = await query(
    `INSERT INTO telegram_hermes_messages (chat_id, role, content)
     VALUES ($1, $2, $3)
     RETURNING role, content, created_at`,
    [String(chatId), normalizedRole, normalizedContent]
  );
  return result.rows[0];
}

async function getOrCreateWebsiteUser(clerkUserId, verifiedEmail = null) {
  const email = verifiedEmail ? String(verifiedEmail).trim().toLowerCase() : null;
  let result = await query(
    `SELECT * FROM users WHERE clerk_user_id = $1`,
    [clerkUserId]
  );
  if (result.rows[0]) {
    const updated = await query(
      `UPDATE users
       SET email = COALESCE(email, $2), last_login_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [result.rows[0].id, email]
    );
    return updated.rows[0];
  }
  if (email) {
    result = await query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    if (result.rows[0]) {
      if (
        result.rows[0].clerk_user_id &&
        result.rows[0].clerk_user_id !== clerkUserId
      ) {
        throw Object.assign(
          new Error("This email is already linked to another Google account"),
          { status: 409 }
        );
      }
      const linked = await query(
        `UPDATE users
         SET clerk_user_id = $2, last_login_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [result.rows[0].id, clerkUserId]
      );
      return linked.rows[0];
    }
  }
  result = await query(
    `INSERT INTO users (clerk_user_id, email, auth_channel)
     VALUES ($1, $2, 'website')
     RETURNING *`,
    [clerkUserId, email]
  );
  return result.rows[0];
}

async function createEmailUser(email, passwordHash) {
  await initialize();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1) FOR UPDATE`,
      [email]
    );
    if (existing.rows[0]?.password_hash) {
      throw Object.assign(new Error("An account with this email already exists"), {
        status: 409,
      });
    }
    let user;
    if (existing.rows[0]) {
      const result = await client.query(
        `UPDATE users SET
           email = LOWER($2),
           password_hash = $3,
           auth_channel = 'website',
           last_login_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id, email, passwordHash]
      );
      user = result.rows[0];
    } else {
      const result = await client.query(
        `INSERT INTO users (email, password_hash, auth_channel)
         VALUES (LOWER($1), $2, 'website')
         RETURNING *`,
        [email, passwordHash]
      );
      user = result.rows[0];
    }
    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw Object.assign(new Error("An account with this email already exists"), {
        status: 409,
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createEmailSignupChallenge({
  id,
  email,
  passwordHash,
  otpHash = null,
  expiresAt,
}) {
  await query(`DELETE FROM email_signup_challenges WHERE expires_at <= NOW()`);
  const result = await query(
    `INSERT INTO email_signup_challenges (
       id, email, password_hash, otp_hash, expires_at
     )
     VALUES ($1, LOWER($2), $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       id = EXCLUDED.id,
       password_hash = EXCLUDED.password_hash,
       otp_hash = EXCLUDED.otp_hash,
       expires_at = EXCLUDED.expires_at,
       attempt_count = 0,
       last_sent_at = NOW(),
       created_at = NOW()
     WHERE email_signup_challenges.last_sent_at <= NOW() - INTERVAL '60 seconds'
     RETURNING id, email, expires_at`,
    [id, email, passwordHash, otpHash, expiresAt]
  );
  if (!result.rows[0]) {
    throw Object.assign(
      new Error("Please wait one minute before requesting another code"),
      { status: 429 }
    );
  }
  return result.rows[0];
}

async function deleteEmailSignupChallenge(id) {
  await query(`DELETE FROM email_signup_challenges WHERE id = $1`, [id]);
}

async function completeEmailSignupChallenge(id, {
  email,
  clerkUserId,
}) {
  await initialize();
  const client = await getPool().connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const challengeResult = await client.query(
      `SELECT * FROM email_signup_challenges WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) {
      throw Object.assign(
        new Error("This verification request is invalid or has been replaced"),
        { status: 400 }
      );
    }
    if (new Date(challenge.expires_at).getTime() <= Date.now()) {
      await client.query(
        `DELETE FROM email_signup_challenges WHERE id = $1`,
        [id]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      throw Object.assign(
        new Error("This verification code has expired. Request a new code."),
        { status: 410 }
      );
    }
    if (Number(challenge.attempt_count) >= 5) {
      throw Object.assign(
        new Error("Too many incorrect codes. Request a new code."),
        { status: 429 }
      );
    }
    if (
      typeof email !== "string" ||
      challenge.email.toLowerCase() !== email.trim().toLowerCase() ||
      (
        clerkUserId !== null &&
        (
          typeof clerkUserId !== "string" ||
          !/^user_[A-Za-z0-9]+$/.test(clerkUserId)
        )
      )
    ) {
      throw Object.assign(
        new Error("The verified Clerk signup does not match this request"),
        { status: 400 }
      );
    }

    const existing = await client.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1) FOR UPDATE`,
      [challenge.email]
    );
    if (existing.rows[0]?.password_hash) {
      throw Object.assign(
        new Error("An account with this email already exists"),
        { status: 409 }
      );
    }
    if (
      clerkUserId &&
      existing.rows[0]?.clerk_user_id &&
      existing.rows[0].clerk_user_id !== clerkUserId
    ) {
      throw Object.assign(
        new Error("This email is already linked to a different Clerk account"),
        { status: 409 }
      );
    }
    let user;
    if (existing.rows[0]) {
      const result = await client.query(
        `UPDATE users SET
           email = LOWER($2),
           password_hash = $3,
           clerk_user_id = COALESCE(clerk_user_id, $4),
           auth_channel = 'website',
           last_login_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          existing.rows[0].id,
          challenge.email,
          challenge.password_hash,
          clerkUserId,
        ]
      );
      user = result.rows[0];
    } else {
      const result = await client.query(
        `INSERT INTO users (
           email, password_hash, clerk_user_id, auth_channel
         )
         VALUES (LOWER($1), $2, $3, 'website')
         RETURNING *`,
        [challenge.email, challenge.password_hash, clerkUserId]
      );
      user = result.rows[0];
    }
    await client.query(
      `DELETE FROM email_signup_challenges WHERE id = $1`,
      [id]
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return user;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw Object.assign(
        new Error("An account with this email already exists"),
        { status: 409 }
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getUserByEmail(email) {
  const result = await query(
    `SELECT * FROM users WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  return result.rows[0] || null;
}

async function createWebsiteSession(userId, tokenHash, expiresAt) {
  await query(`DELETE FROM website_sessions WHERE expires_at <= NOW()`);
  await query(
    `INSERT INTO website_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [tokenHash, userId, expiresAt]
  );
}

async function getWebsiteSession(tokenHash) {
  const result = await query(
    `UPDATE website_sessions AS session SET last_seen_at = NOW()
     FROM users
     WHERE session.token_hash = $1
       AND session.expires_at > NOW()
       AND users.id = session.user_id
     RETURNING users.*, session.token_hash, session.expires_at`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function deleteWebsiteSession(tokenHash) {
  await query(`DELETE FROM website_sessions WHERE token_hash = $1`, [tokenHash]);
}

async function touchUserLogin(userId) {
  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);
}

async function upsertExternalUser(
  phone,
  email = null,
  authChannel = "linq"
) {
  const channel = ["linq", "telegram"].includes(authChannel)
    ? authChannel
    : "linq";
  await initialize();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (email) {
      const emailResult = await client.query(
        `SELECT * FROM users WHERE LOWER(email) = LOWER($1) FOR UPDATE`,
        [email]
      );
      const emailUser = emailResult.rows[0];
      if (emailUser) {
        if (emailUser.phone && emailUser.phone !== phone) {
          throw Object.assign(
            new Error("This email is already linked to a different parent phone"),
            { status: 409 }
          );
        }
        const updated = await client.query(
          `UPDATE users SET
             phone = $2,
             email = LOWER($3),
             auth_channel = CASE
               WHEN password_hash IS NULL THEN $4
               ELSE auth_channel
             END,
             last_login_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [emailUser.id, phone, email, channel]
        );
        await client.query("COMMIT");
        return updated.rows[0];
      }
    }
    const result = await client.query(
      `INSERT INTO users (phone, email, auth_channel)
       VALUES ($1, LOWER($2), $3)
       ON CONFLICT (phone) DO UPDATE SET
         email = COALESCE(users.email, EXCLUDED.email),
         auth_channel = CASE
           WHEN users.password_hash IS NULL THEN EXCLUDED.auth_channel
           ELSE users.auth_channel
         END,
         last_login_at = NOW()
       RETURNING *`,
      [phone, email, channel]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw Object.assign(
        new Error("The supplied email or phone belongs to another family"),
        { status: 409 }
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function upsertLinqUser(phone, email = null) {
  return upsertExternalUser(phone, email, "linq");
}

async function linkWebsiteUserPhone(
  userId,
  { clerkUserId = null, email = null },
  phone
) {
  await initialize();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const targetResult = await client.query(
      `SELECT * FROM users WHERE phone = $1 FOR UPDATE`,
      [phone]
    );
    const target = targetResult.rows[0];
    if (!target || Number(target.id) === Number(userId)) {
      const updated = await client.query(
        `UPDATE users SET
           phone = $2,
           clerk_user_id = COALESCE($3, clerk_user_id),
           email = COALESCE(LOWER($4), email),
           auth_channel = 'website'
         WHERE id = $1
         RETURNING *`,
        [userId, phone, clerkUserId, email]
      );
      await client.query("COMMIT");
      return updated.rows[0];
    }
    if (target.clerk_user_id && target.clerk_user_id !== clerkUserId) {
      throw Object.assign(
        new Error("This parent phone is already linked to another account"),
        { status: 409 }
      );
    }
    if (
      target.email &&
      email &&
      target.email.toLowerCase() !== email.toLowerCase()
    ) {
      throw Object.assign(
        new Error("This parent phone is already linked to another account"),
        { status: 409 }
      );
    }
    const currentProfile = await client.query(
      `SELECT user_id FROM family_profiles WHERE user_id = $1`,
      [userId]
    );
    if (currentProfile.rows[0]) {
      throw Object.assign(
        new Error("This parent phone is already linked to another family"),
        { status: 409 }
      );
    }
    const current = await client.query(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    await client.query(
      `UPDATE users SET
         clerk_user_id = COALESCE($2, clerk_user_id),
         email = COALESCE(LOWER($3), email),
         password_hash = COALESCE(password_hash, $4),
         auth_channel = 'website',
         last_login_at = NOW()
       WHERE id = $1`,
      [
        target.id,
        clerkUserId,
        email,
        current.rows[0]?.password_hash || null,
      ]
    );
    await client.query(
      `UPDATE website_sessions SET user_id = $2 WHERE user_id = $1`,
      [userId, target.id]
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    const linked = await client.query(`SELECT * FROM users WHERE id = $1`, [
      target.id,
    ]);
    await client.query("COMMIT");
    return linked.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getUserById(id) {
  const result = await query(`SELECT * FROM users WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function getUserByPhone(phone) {
  const result = await query(`SELECT * FROM users WHERE phone = $1`, [phone]);
  return result.rows[0] || null;
}

async function getFamilyUsersByPhone(phone) {
  const result = await query(
    `WITH family_matches AS (
       SELECT DISTINCT users.id, users.email
       FROM users
       JOIN family_profiles profiles ON profiles.user_id = users.id
       WHERE profiles.primary_parent_phone = $1
          OR profiles.secondary_parent_phone = $1
          OR profiles.offspring_phone = $1
          OR EXISTS (
            SELECT 1
            FROM family_dependents dependents
            WHERE dependents.user_id = users.id
              AND dependents.phone = $1
              AND dependents.archived_at IS NULL
          )
     ),
     direct_matches AS (
       SELECT users.id, users.email
       FROM users
       WHERE users.phone = $1
         AND NOT EXISTS (SELECT 1 FROM family_matches)
     )
     SELECT * FROM family_matches
     UNION ALL
     SELECT * FROM direct_matches
     ORDER BY id
     LIMIT 2`,
    [phone]
  );
  return result.rows;
}

async function getRecentUserIds(limit = 20) {
  const result = await query(
    `SELECT id
     FROM users
     ORDER BY id DESC
     LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 50)]
  );
  return result.rows.map((row) => Number(row.id));
}

async function getProfile(userId) {
  const [profileResult, dependentResult] = await Promise.all([
    query(`SELECT * FROM family_profiles WHERE user_id = $1`, [userId]),
    query(
      `SELECT *
       FROM family_dependents
       WHERE user_id = $1
         AND archived_at IS NULL
       ORDER BY position, id`,
      [userId]
    ),
  ]);
  const profile = profileResult.rows[0] || null;
  if (!profile) return null;
  profile.dependents = dependentResult.rows;
  return profile;
}

async function resolveLinqUser(fromPhone, linqPhone) {
  const result = await query(
    `SELECT users.id, profiles.linq_phone_number, profiles.primary_parent_phone,
            profiles.secondary_parent_phone, profiles.offspring_phone
     FROM family_profiles profiles
     JOIN users ON users.id = profiles.user_id
     WHERE profiles.linq_phone_number = $2
       AND (
         $1 IN (
           profiles.primary_parent_phone,
           COALESCE(profiles.secondary_parent_phone, ''),
           profiles.offspring_phone
         )
         OR EXISTS (
           SELECT 1
           FROM family_dependents dependents
           WHERE dependents.user_id = profiles.user_id
             AND dependents.phone = $1
             AND dependents.archived_at IS NULL
         )
       )
     LIMIT 1`,
    [fromPhone, linqPhone]
  );
  return result.rows[0] || null;
}

async function saveProfile(userId, profile, source) {
  await initialize();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO family_profiles (
         user_id, primary_parent_name, primary_parent_phone,
         primary_parent_age, primary_parent_gender,
         secondary_parent_name, secondary_parent_phone,
         offspring_name, offspring_phone, dependent_relationship,
         merchant_auth_phone, merchant_auth_subject_type, onboarding_source
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (user_id) DO UPDATE SET
         primary_parent_name = EXCLUDED.primary_parent_name,
         primary_parent_phone = EXCLUDED.primary_parent_phone,
         primary_parent_age = EXCLUDED.primary_parent_age,
         primary_parent_gender = EXCLUDED.primary_parent_gender,
         secondary_parent_name = EXCLUDED.secondary_parent_name,
         secondary_parent_phone = EXCLUDED.secondary_parent_phone,
         offspring_name = EXCLUDED.offspring_name,
         offspring_phone = EXCLUDED.offspring_phone,
         dependent_relationship = EXCLUDED.dependent_relationship,
         merchant_auth_phone = EXCLUDED.merchant_auth_phone,
         merchant_auth_subject_type = EXCLUDED.merchant_auth_subject_type,
         onboarding_source = EXCLUDED.onboarding_source,
         updated_at = NOW()
       RETURNING *`,
      [
        userId,
        profile.primaryParentName,
        profile.primaryParentPhone,
        profile.primaryParentAge,
        profile.primaryParentGender,
        profile.secondaryParentName,
        profile.secondaryParentPhone,
        profile.dependentName,
        profile.dependentPhone,
        profile.dependentRelationship,
        profile.merchantAuthPhone,
        profile.merchantAuthSubjectType,
        source,
      ]
    );
    await client.query(
      `INSERT INTO payment_customers (
         user_id, provider, provider_customer_id
       )
       VALUES ($1, 'prava', $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, `tokko_family_${userId}`]
    );
    const dependents = Array.isArray(profile.dependents)
      ? profile.dependents
      : profile.dependentPhone
        ? [
            {
              name: profile.dependentName,
              phone: profile.dependentPhone,
              relationshipToUser: profile.dependentRelationship,
            },
          ]
        : [];
    const savedDependents = [];
    const retainedIds = [];
    for (const [position, dependent] of dependents.entries()) {
      const memberValues = [
        userId,
        dependent.name,
        dependent.phone,
        dependent.relationshipToUser,
        dependent.age,
        dependent.gender,
        position,
        profile.merchantAuthSubjectType === "dependent" &&
          dependent.phone === profile.merchantAuthPhone,
      ];
      const memberId = Number(dependent.id);
      let saved;
      if (Number.isInteger(memberId) && memberId > 0) {
        saved = await client.query(
          `UPDATE family_dependents
           SET name = $2,
               phone = $3,
               relationship_to_user = $4,
               age = $5,
               gender = $6,
               position = $7,
               is_merchant_auth_subject = $8,
               archived_at = NULL,
               updated_at = NOW()
           WHERE user_id = $1 AND id = $9
           RETURNING *`,
          [...memberValues, memberId]
        );
      }
      if (!saved?.rows?.length) {
        saved = await client.query(
          `INSERT INTO family_dependents (
             user_id, name, phone, relationship_to_user,
             age, gender, position, is_merchant_auth_subject
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          memberValues
        );
      }
      savedDependents.push(saved.rows[0]);
      retainedIds.push(Number(saved.rows[0].id));
    }
    await client.query(
      `UPDATE family_dependents
       SET archived_at = NOW(),
           is_merchant_auth_subject = false,
           updated_at = NOW()
       WHERE user_id = $1
         AND archived_at IS NULL
         AND NOT (id = ANY($2::bigint[]))`,
      [userId, retainedIds]
    );
    await client.query("COMMIT");
    return { ...result.rows[0], dependents: savedDependents };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function saveLinqAssignment(userId, assignment, chatId = null) {
  const result = await query(
    `UPDATE family_profiles SET
       linq_phone_number_id = $2,
       linq_phone_number = $3,
       linq_chat_id = COALESCE($4, linq_chat_id),
       updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId, assignment.id, assignment.phone_number, chatId]
  );
  return result.rows[0] ? getProfile(userId) : null;
}

async function getAllPlatforms() {
  const result = await query(
    `SELECT * FROM platforms WHERE enabled = $1 ORDER BY id`,
    [true]
  );
  return result.rows;
}

async function getPlatformBySlug(slug) {
  const result = await query(`SELECT * FROM platforms WHERE slug = $1`, [slug]);
  return result.rows[0] || null;
}

async function getOAuthClient(platformId, redirectUri) {
  const result = await query(
    `SELECT * FROM oauth_clients WHERE platform_id = $1 AND redirect_uri = $2`,
    [platformId, redirectUri]
  );
  return result.rows[0] || null;
}

async function saveOAuthClient(platformId, clientId, redirectUri) {
  await query(
    `INSERT INTO oauth_clients (platform_id, client_id, redirect_uri)
     VALUES ($1, $2, $3)
     ON CONFLICT (platform_id) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       redirect_uri = EXCLUDED.redirect_uri,
       updated_at = NOW()`,
    [platformId, clientId, redirectUri]
  );
}

async function getUserConsents(userId) {
  const result = await query(
    `SELECT consent.*, platform.slug, platform.name, platform.mcp_url,
            platform.auth_server_url, platform.auth_flow_type
     FROM user_platform_consents consent
     JOIN platforms platform ON platform.id = consent.platform_id
     WHERE consent.user_id = $1`,
    [userId]
  );
  return result.rows;
}

async function setConsent(userId, platformId, consented) {
  await query(
    `INSERT INTO user_platform_consents
       (user_id, platform_id, consented, consented_at)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() ELSE NULL END)
     ON CONFLICT (user_id, platform_id) DO UPDATE SET
       consented = EXCLUDED.consented,
       consented_at = EXCLUDED.consented_at`,
    [userId, platformId, consented]
  );
}

async function setMerchantAuthConsent({
  userId,
  platformId,
  subjectPhone,
  purpose,
  consented,
  consentText,
  policyVersion,
  source,
  actorClerkUserId,
}) {
  const result = await query(
    `INSERT INTO merchant_auth_consents (
       user_id, platform_id, subject_phone, purpose, consented,
       consent_text, policy_version, source, actor_clerk_user_id,
       consented_at, revoked_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       CASE WHEN $5 THEN NOW() ELSE NULL END,
       CASE WHEN $5 THEN NULL ELSE NOW() END
     )
     ON CONFLICT (user_id, platform_id, purpose) DO UPDATE SET
       subject_phone = EXCLUDED.subject_phone,
       consented = EXCLUDED.consented,
       consent_text = EXCLUDED.consent_text,
       policy_version = EXCLUDED.policy_version,
       source = EXCLUDED.source,
       actor_clerk_user_id = EXCLUDED.actor_clerk_user_id,
       consented_at = EXCLUDED.consented_at,
       revoked_at = EXCLUDED.revoked_at,
       updated_at = NOW()
     RETURNING *`,
    [
      userId,
      platformId,
      subjectPhone,
      purpose,
      consented,
      consentText,
      policyVersion,
      source,
      actorClerkUserId || null,
    ]
  );
  return result.rows[0];
}

async function getMerchantAuthConsent(userId, platformId, purpose) {
  const result = await query(
    `SELECT * FROM merchant_auth_consents
     WHERE user_id = $1 AND platform_id = $2 AND purpose = $3`,
    [userId, platformId, purpose]
  );
  return result.rows[0] || null;
}

async function getToken(userId, platformId) {
  const result = await query(
    `SELECT * FROM user_platform_tokens WHERE user_id = $1 AND platform_id = $2`,
    [userId, platformId]
  );
  return result.rows[0] || null;
}

async function getDeliveryPreference(userId, platformSlug = "zepto") {
  const result = await query(
    `SELECT user_id, platform_slug, address_id, label, formatted_address,
            confirmed_at, updated_at
     FROM family_delivery_preferences
     WHERE user_id = $1 AND platform_slug = $2`,
    [Number(userId), String(platformSlug)]
  );
  return result.rows[0] || null;
}

async function saveDeliveryPreference(
  userId,
  { platformSlug = "zepto", addressId, label = null, formattedAddress }
) {
  const result = await query(
    `INSERT INTO family_delivery_preferences (
       user_id, platform_slug, address_id, label, formatted_address,
       confirmed_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       platform_slug = EXCLUDED.platform_slug,
       address_id = EXCLUDED.address_id,
       label = EXCLUDED.label,
       formatted_address = EXCLUDED.formatted_address,
       confirmed_at = NOW(),
       updated_at = NOW()
     RETURNING user_id, platform_slug, address_id, label, formatted_address,
               confirmed_at, updated_at`,
    [
      Number(userId),
      String(platformSlug),
      String(addressId),
      label ? String(label) : null,
      String(formattedAddress),
    ]
  );
  return result.rows[0];
}

async function clearDeliveryPreference(userId, platformSlug = "zepto") {
  await query(
    `DELETE FROM family_delivery_preferences
     WHERE user_id = $1 AND platform_slug = $2`,
    [Number(userId), String(platformSlug)]
  );
}

async function getFamilyAddresses(userId) {
  const result = await query(
    `SELECT addresses.id, addresses.user_id, addresses.label,
            addresses.formatted_address, addresses.address_line1,
            addresses.address_line2, addresses.city, addresses.state,
            addresses.postal_code, addresses.country_code,
            addresses.contact_name, addresses.contact_phone,
            addresses.is_selected, addresses.created_at, addresses.updated_at,
            COALESCE(
              ARRAY_AGG(active_members.id ORDER BY active_members.id)
                FILTER (WHERE active_members.id IS NOT NULL),
              '{}'::bigint[]
            ) AS member_ids
     FROM family_addresses AS addresses
     LEFT JOIN family_member_addresses AS assignments
       ON assignments.address_id = addresses.id
      AND assignments.user_id = addresses.user_id
     LEFT JOIN family_dependents AS active_members
       ON active_members.id = assignments.member_id
      AND active_members.user_id = addresses.user_id
      AND active_members.archived_at IS NULL
     WHERE addresses.user_id = $1
     GROUP BY addresses.id
     ORDER BY addresses.is_selected DESC, addresses.updated_at DESC, addresses.id DESC`,
    [Number(userId)]
  );
  return result.rows;
}

async function createFamilyAddress(userId, address) {
  const result = await query(
    `INSERT INTO family_addresses (
       user_id, label, formatted_address, address_line1, address_line2,
       city, state, postal_code, country_code, contact_name, contact_phone,
       is_selected
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       NOT EXISTS (SELECT 1 FROM family_addresses WHERE user_id = $1)
     )
     RETURNING id, user_id, label, formatted_address, address_line1,
               address_line2, city, state, postal_code, country_code,
               contact_name, contact_phone, is_selected, created_at, updated_at`,
    [
      Number(userId),
      String(address.label),
      String(address.formattedAddress),
      address.addressLine1 ? String(address.addressLine1) : null,
      address.addressLine2 ? String(address.addressLine2) : null,
      address.city ? String(address.city) : null,
      address.state ? String(address.state) : null,
      address.postalCode ? String(address.postalCode) : null,
      String(address.countryCode || "IN").toUpperCase(),
      address.contactName ? String(address.contactName) : null,
      address.contactPhone ? String(address.contactPhone) : null,
    ]
  );
  return result.rows[0];
}

async function updateFamilyAddress(userId, addressId, address) {
  const result = await query(
    `UPDATE family_addresses
     SET label = $3,
         formatted_address = $4,
         address_line1 = $5,
         address_line2 = $6,
         city = $7,
         state = $8,
         postal_code = $9,
         country_code = $10,
         contact_name = $11,
         contact_phone = $12,
         updated_at = NOW()
     WHERE user_id = $1 AND id = $2
     RETURNING *`,
    [
      Number(userId),
      String(addressId),
      String(address.label),
      String(address.formattedAddress),
      address.addressLine1 ? String(address.addressLine1) : null,
      address.addressLine2 ? String(address.addressLine2) : null,
      address.city ? String(address.city) : null,
      address.state ? String(address.state) : null,
      address.postalCode ? String(address.postalCode) : null,
      String(address.countryCode || "IN").toUpperCase(),
      address.contactName ? String(address.contactName) : null,
      address.contactPhone ? String(address.contactPhone) : null,
    ]
  );
  return result.rows[0] || null;
}

async function assignFamilyAddress(userId, addressId, memberIds = []) {
  await initialize();
  const normalized = [...new Set(
    (Array.isArray(memberIds) ? memberIds : [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
  )];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const address = await client.query(
      `SELECT id FROM family_addresses WHERE user_id = $1 AND id = $2 FOR UPDATE`,
      [Number(userId), String(addressId)]
    );
    if (!address.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }
    const validMembers = normalized.length
      ? await client.query(
          `SELECT id FROM family_dependents
           WHERE user_id = $1 AND archived_at IS NULL AND id = ANY($2::bigint[])`,
          [Number(userId), normalized]
        )
      : { rows: [] };
    if (validMembers.rows.length !== normalized.length) {
      throw Object.assign(new Error("One or more family members were not found"), {
        status: 404,
      });
    }
    await client.query(
      `DELETE FROM family_member_addresses WHERE user_id = $1 AND address_id = $2`,
      [Number(userId), String(addressId)]
    );
    for (const member of validMembers.rows) {
      await client.query(
        `INSERT INTO family_member_addresses (user_id, member_id, address_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [Number(userId), Number(member.id), String(addressId)]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteFamilyAddress(userId, addressId) {
  await initialize();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const removed = await client.query(
      `DELETE FROM family_addresses
       WHERE user_id = $1 AND id = $2
       RETURNING id, is_selected`,
      [Number(userId), String(addressId)]
    );
    if (!removed.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }
    if (removed.rows[0].is_selected) {
      await client.query(
        `UPDATE family_addresses
         SET is_selected = true, updated_at = NOW()
         WHERE id = (
           SELECT id FROM family_addresses
           WHERE user_id = $1
           ORDER BY updated_at DESC, id DESC
           LIMIT 1
         )`,
        [Number(userId)]
      );
    }
    await client.query("COMMIT");
    return removed.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function selectFamilyAddress(userId, addressId) {
  const result = await query(
    `WITH target AS (
       SELECT id FROM family_addresses WHERE user_id = $1 AND id = $2
     ), cleared AS (
       UPDATE family_addresses
       SET is_selected = false, updated_at = NOW()
       WHERE user_id = $1 AND is_selected AND EXISTS (SELECT 1 FROM target)
     )
     UPDATE family_addresses
     SET is_selected = true, updated_at = NOW()
     WHERE user_id = $1 AND id = $2 AND EXISTS (SELECT 1 FROM target)
     RETURNING id, user_id, label, formatted_address, address_line1,
               address_line2, city, state, postal_code, country_code,
               contact_name, contact_phone, is_selected, created_at, updated_at`,
    [Number(userId), String(addressId)]
  );
  return result.rows[0] || null;
}

async function getCareRules(userId) {
  const result = await query(
    `SELECT user_id, approval_mode, monthly_cap, per_order_cap, currency,
            repeat_known_essentials, allowed_categories, blocked_items,
            created_at, updated_at
     FROM family_care_rules
     WHERE user_id = $1`,
    [Number(userId)]
  );
  return result.rows[0] || null;
}

async function saveCareRules(userId, rules) {
  const result = await query(
    `INSERT INTO family_care_rules (
       user_id, approval_mode, monthly_cap, per_order_cap, currency,
       repeat_known_essentials, allowed_categories, blocked_items
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[])
     ON CONFLICT (user_id) DO UPDATE SET
       approval_mode = EXCLUDED.approval_mode,
       monthly_cap = EXCLUDED.monthly_cap,
       per_order_cap = EXCLUDED.per_order_cap,
       currency = EXCLUDED.currency,
       repeat_known_essentials = EXCLUDED.repeat_known_essentials,
       allowed_categories = EXCLUDED.allowed_categories,
       blocked_items = EXCLUDED.blocked_items,
       updated_at = NOW()
     RETURNING user_id, approval_mode, monthly_cap, per_order_cap, currency,
               repeat_known_essentials, allowed_categories, blocked_items,
               created_at, updated_at`,
    [
      Number(userId),
      rules.approvalMode,
      rules.monthlyCap,
      rules.perOrderCap,
      rules.currency,
      rules.repeatKnownEssentials,
      rules.allowedCategories,
      rules.blockedItems,
    ]
  );
  return result.rows[0];
}

async function getUserPreferences(userId) {
  const result = await query(
    `SELECT user_id, decision_alerts, delivery_updates, weekly_digest,
            created_at, updated_at
     FROM user_preferences
     WHERE user_id = $1`,
    [Number(userId)]
  );
  return result.rows[0] || null;
}

async function saveUserPreferences(userId, preferences) {
  const result = await query(
    `INSERT INTO user_preferences (
       user_id, decision_alerts, delivery_updates, weekly_digest
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       decision_alerts = EXCLUDED.decision_alerts,
       delivery_updates = EXCLUDED.delivery_updates,
       weekly_digest = EXCLUDED.weekly_digest,
       updated_at = NOW()
     RETURNING user_id, decision_alerts, delivery_updates, weekly_digest,
               created_at, updated_at`,
    [
      Number(userId),
      preferences.decisionAlerts,
      preferences.deliveryUpdates,
      preferences.weeklyDigest,
    ]
  );
  return result.rows[0];
}

async function getDecisionRequests(userId, { status = null, limit = 50 } = {}) {
  const result = await query(
    `SELECT requests.*,
            members.name AS member_name,
            members.phone AS member_phone,
            addresses.label AS address_label,
            addresses.formatted_address
     FROM decision_requests AS requests
     LEFT JOIN family_dependents AS members ON members.id = requests.member_id
     LEFT JOIN family_addresses AS addresses ON addresses.id = requests.address_id
     WHERE requests.user_id = $1
       AND ($2::text IS NULL OR requests.status = $2)
     ORDER BY
       CASE requests.status WHEN 'pending' THEN 0 ELSE 1 END,
       requests.created_at DESC
     LIMIT $3`,
    [Number(userId), status, Number(limit)]
  );
  return result.rows;
}

async function createDecisionRequest(userId, decision) {
  const result = await query(
    `INSERT INTO decision_requests (
       id, user_id, member_id, request_type, status, title,
       original_request, merchant_name, product, amount, currency,
       address_id, reason_code, reason_text, payment_context,
       action_context, expires_at
     )
     SELECT $1, $2, members.id, $4, 'pending', $5, $6, $7,
            $8::jsonb, $9, $10, addresses.id, $12, $13,
            $14::jsonb, $15::jsonb, $16
     FROM (SELECT 1) AS seed
     LEFT JOIN family_dependents AS members
       ON members.id = $3 AND members.user_id = $2 AND members.archived_at IS NULL
     LEFT JOIN family_addresses AS addresses
       ON addresses.id = $11 AND addresses.user_id = $2
     WHERE ($3::bigint IS NULL OR members.id IS NOT NULL)
       AND ($11::bigint IS NULL OR addresses.id IS NOT NULL)
     RETURNING *`,
    [
      decision.id,
      Number(userId),
      decision.memberId,
      decision.requestType,
      decision.title,
      decision.originalRequest,
      decision.merchantName,
      JSON.stringify(decision.product || {}),
      decision.amount,
      decision.currency,
      decision.addressId,
      decision.reasonCode,
      decision.reasonText,
      JSON.stringify(decision.paymentContext || {}),
      JSON.stringify(decision.actionContext || {}),
      decision.expiresAt,
    ]
  );
  return result.rows[0] || null;
}

async function resolveDecisionRequest(userId, decisionId, resolution, note = null) {
  await initialize();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT * FROM decision_requests
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [String(decisionId), Number(userId)]
    );
    if (!current.rows.length) {
      await client.query("ROLLBACK");
      return { outcome: "not_found", decision: null };
    }
    const decision = current.rows[0];
    if (decision.status !== "pending") {
      await client.query("COMMIT");
      return {
        outcome: decision.resolution === resolution ? "unchanged" : "conflict",
        decision,
      };
    }
    if (decision.expires_at && new Date(decision.expires_at).getTime() <= Date.now()) {
      const expired = await client.query(
        `UPDATE decision_requests
         SET status = 'expired', updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [String(decisionId)]
      );
      await client.query("COMMIT");
      return { outcome: "expired", decision: expired.rows[0] };
    }
    const updated = await client.query(
      `UPDATE decision_requests
       SET status = 'resolved', resolution = $3, resolution_note = $4,
           resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [String(decisionId), Number(userId), resolution, note]
    );
    await client.query("COMMIT");
    return { outcome: "resolved", decision: updated.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordActivityEvent(userId, event) {
  const result = await query(
    `INSERT INTO activity_events (
       user_id, event_type, title, detail, entity_type, entity_id, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [
      Number(userId),
      event.eventType,
      event.title,
      event.detail || null,
      event.entityType || null,
      event.entityId ? String(event.entityId) : null,
      JSON.stringify(event.metadata || {}),
    ]
  );
  return result.rows[0];
}

async function getActivityEvents(userId, limit = 50) {
  const result = await query(
    `SELECT * FROM activity_events
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [Number(userId), Number(limit)]
  );
  return result.rows;
}

async function saveMerchantAuthAttempt(
  pendingId,
  userId,
  platformId,
  payload,
  expiresAt
) {
  await query(
    `INSERT INTO merchant_auth_attempts
       (pending_id, user_id, platform_id, payload, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (pending_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       platform_id = EXCLUDED.platform_id,
       payload = EXCLUDED.payload,
       expires_at = EXCLUDED.expires_at`,
    [pendingId, userId, platformId, JSON.stringify(payload), expiresAt]
  );
}

async function getLatestMerchantAuthAttempt(userId, platformId) {
  const result = await query(
    `SELECT pending_id, expires_at, created_at
     FROM merchant_auth_attempts
     WHERE user_id = $1
       AND platform_id = $2
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [Number(userId), Number(platformId)]
  );
  return result.rows[0] || null;
}

async function consumeMerchantAuthAttempt(pendingId, userId) {
  await initialize();
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT * FROM merchant_auth_attempts
       WHERE pending_id = $1 AND user_id = $2 AND expires_at > NOW()
       FOR UPDATE`,
      [pendingId, userId]
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `DELETE FROM merchant_auth_attempts WHERE pending_id = $1`,
      [pendingId]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function saveToken(
  userId,
  platformId,
  { accessToken, refreshToken, mcpSessionId, authenticatedPhone, expiresAt }
) {
  await query(
    `INSERT INTO user_platform_tokens (
       user_id, platform_id, access_token, refresh_token,
       mcp_session_id, authenticated_phone, token_expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, platform_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       mcp_session_id = EXCLUDED.mcp_session_id,
       authenticated_phone = COALESCE(
         EXCLUDED.authenticated_phone,
         user_platform_tokens.authenticated_phone
       ),
       token_expires_at = EXCLUDED.token_expires_at`,
    [
      userId,
      platformId,
      accessToken,
      refreshToken || null,
      mcpSessionId || null,
      authenticatedPhone || null,
      expiresAt || null,
    ]
  );
}

async function clearToken(userId, platformId) {
  await query(
    `DELETE FROM user_platform_tokens WHERE user_id = $1 AND platform_id = $2`,
    [userId, platformId]
  );
}

async function clearMcpSession(userId, platformId) {
  await query(
    `UPDATE user_platform_tokens SET mcp_session_id = NULL
     WHERE user_id = $1 AND platform_id = $2`,
    [userId, platformId]
  );
}

async function getPaymentCustomer(userId) {
  const result = await query(
    `SELECT * FROM payment_customers WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function savePaymentCustomer(userId, provider, providerCustomerId) {
  const result = await query(
    `INSERT INTO payment_customers (user_id, provider, provider_customer_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       provider_customer_id = EXCLUDED.provider_customer_id,
       updated_at = NOW()
     RETURNING *`,
    [userId, provider, providerCustomerId]
  );
  return result.rows[0];
}

async function savePaymentMethod(
  userId,
  provider,
  providerCustomerId,
  paymentMethod
) {
  await initialize();
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE payment_methods SET is_default = false
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider]
    );
    const result = await client.query(
      `INSERT INTO payment_methods (
         user_id, provider, provider_payment_method_id, type,
         brand, last4, exp_month, exp_year, is_default
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (provider_payment_method_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         brand = EXCLUDED.brand,
         last4 = EXCLUDED.last4,
         exp_month = EXCLUDED.exp_month,
         exp_year = EXCLUDED.exp_year,
         is_default = true,
         updated_at = NOW()
       RETURNING *`,
      [
        userId,
        provider,
        paymentMethod.providerPaymentMethodId,
        paymentMethod.type,
        paymentMethod.brand,
        paymentMethod.last4,
        paymentMethod.expMonth,
        paymentMethod.expYear,
      ]
    );
    await client.query(
      `INSERT INTO payment_customers (user_id, provider, provider_customer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         provider_customer_id = EXCLUDED.provider_customer_id,
         updated_at = NOW()`,
      [userId, provider, providerCustomerId]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function syncPaymentMethods(
  userId,
  provider,
  providerCustomerId,
  paymentMethods
) {
  if (!Array.isArray(paymentMethods) || paymentMethods.length === 0) {
    return getPaymentMethods(userId, provider);
  }
  await initialize();
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const paymentMethod of paymentMethods) {
      await client.query(
        `INSERT INTO payment_methods (
           user_id, provider, provider_payment_method_id, type,
           brand, last4, exp_month, exp_year, is_default
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
         ON CONFLICT (provider_payment_method_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           provider = EXCLUDED.provider,
           type = EXCLUDED.type,
           brand = EXCLUDED.brand,
           last4 = EXCLUDED.last4,
           exp_month = EXCLUDED.exp_month,
           exp_year = EXCLUDED.exp_year,
           updated_at = NOW()`,
        [
          userId,
          provider,
          paymentMethod.providerPaymentMethodId,
          paymentMethod.type,
          paymentMethod.brand,
          paymentMethod.last4,
          paymentMethod.expMonth,
          paymentMethod.expYear,
        ]
      );
    }
    const preferred =
      paymentMethods.find((method) => method.isDefault)
      || paymentMethods[0];
    await client.query(
      `UPDATE payment_methods
       SET is_default =
         CASE WHEN provider_payment_method_id = $3 THEN true ELSE false END
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider, preferred.providerPaymentMethodId]
    );
    await client.query(
      `INSERT INTO payment_customers (user_id, provider, provider_customer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         provider_customer_id = EXCLUDED.provider_customer_id,
         updated_at = NOW()`,
      [userId, provider, providerCustomerId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getPaymentMethods(userId, provider);
}

async function getPaymentMethods(userId, provider = null) {
  const result = await query(
    `SELECT id, provider, provider_payment_method_id, type, brand, last4,
            exp_month, exp_year, is_default, created_at
     FROM payment_methods
     WHERE user_id = $1
       AND ($2::text IS NULL OR provider = $2)
     ORDER BY is_default DESC, created_at DESC`,
    [userId, provider]
  );
  return result.rows;
}

async function savePaymentTokenizationSession(
  userId,
  provider,
  sessionId,
  expiresAt
) {
  const result = await query(
    `INSERT INTO payment_tokenization_sessions (
       session_id, user_id, provider, expires_at
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       provider = EXCLUDED.provider,
       expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [sessionId, userId, provider, expiresAt]
  );
  return result.rows[0];
}

async function getPaymentTokenizationSession(userId, provider, sessionId) {
  const result = await query(
    `SELECT *
     FROM payment_tokenization_sessions
     WHERE session_id = $1
       AND user_id = $2
       AND provider = $3
       AND completed_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [sessionId, userId, provider]
  );
  return result.rows[0] || null;
}

async function getRecentPaymentTokenizationSessions(
  userId,
  provider = "prava",
  limit = 5
) {
  const result = await query(
    `SELECT session_id, provider, expires_at, completed_at, created_at
     FROM payment_tokenization_sessions
     WHERE user_id = $1
       AND provider = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [
      userId,
      provider,
      Math.min(Math.max(Number(limit) || 5, 1), 10),
    ]
  );
  return result.rows;
}

async function completePaymentTokenizationSession(
  userId,
  provider,
  sessionId
) {
  const result = await query(
    `UPDATE payment_tokenization_sessions
     SET completed_at = NOW()
     WHERE session_id = $1
       AND user_id = $2
       AND provider = $3
       AND completed_at IS NULL
     RETURNING *`,
    [sessionId, userId, provider]
  );
  return result.rows[0] || null;
}

async function saveCheckoutFlow(flow) {
  const result = await query(
    `INSERT INTO checkout_flows (
       id, user_id, platform, status, address_id, card_brand, card_last4,
       card_failure_count, card_payment_received, allow_cod_fallback,
       fallback_to_cod, card_order_id, zepto_order_id, last_failed_order_id,
       prava_mandate_id, prava_transaction_id, prava_charge_reference,
       prava_charge_status, prava_charge_amount, prava_charge_reported_at,
       payment_route, prava_session_id, prava_session_approval_url,
       sandbox_payment_attempt, price_breakdown, cart_snapshot, failure_message
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20,
       $21, $22, $23,
       $24, $25::jsonb, $26::jsonb, $27
     )
     ON CONFLICT (id) DO UPDATE SET
       platform = EXCLUDED.platform,
       status = EXCLUDED.status,
       address_id = EXCLUDED.address_id,
       card_brand = EXCLUDED.card_brand,
       card_last4 = EXCLUDED.card_last4,
       card_failure_count = EXCLUDED.card_failure_count,
       card_payment_received = EXCLUDED.card_payment_received,
       allow_cod_fallback = EXCLUDED.allow_cod_fallback,
       fallback_to_cod = EXCLUDED.fallback_to_cod,
       card_order_id = EXCLUDED.card_order_id,
       zepto_order_id = EXCLUDED.zepto_order_id,
       last_failed_order_id = EXCLUDED.last_failed_order_id,
       prava_mandate_id = EXCLUDED.prava_mandate_id,
       prava_transaction_id = EXCLUDED.prava_transaction_id,
       prava_charge_reference = EXCLUDED.prava_charge_reference,
       prava_charge_status = EXCLUDED.prava_charge_status,
       prava_charge_amount = EXCLUDED.prava_charge_amount,
       prava_charge_reported_at = EXCLUDED.prava_charge_reported_at,
       payment_route = EXCLUDED.payment_route,
       prava_session_id = EXCLUDED.prava_session_id,
       prava_session_approval_url = EXCLUDED.prava_session_approval_url,
       sandbox_payment_attempt = EXCLUDED.sandbox_payment_attempt,
       price_breakdown = EXCLUDED.price_breakdown,
       cart_snapshot = EXCLUDED.cart_snapshot,
       failure_message = EXCLUDED.failure_message,
       updated_at = NOW()
     WHERE checkout_flows.user_id = EXCLUDED.user_id
     RETURNING *`,
    [
      flow.id,
      flow.userId,
      flow.platform || "zepto",
      flow.status,
      flow.addressId || null,
      flow.cardBrand || null,
      flow.cardLast4 || null,
      Number(flow.cardFailureCount || 0),
      flow.cardPaymentReceived === true,
      flow.allowCodFallback !== false,
      flow.fallbackToCod === true,
      flow.cardOrderId || null,
      flow.zeptoOrderId || null,
      flow.lastFailedOrderId || null,
      flow.pravaMandateId || null,
      flow.pravaTransactionId || null,
      flow.pravaChargeReference || null,
      flow.pravaChargeStatus || null,
      flow.pravaChargeAmount || null,
      flow.pravaChargeReportedAt || null,
      flow.paymentRoute || null,
      flow.pravaSessionId || null,
      flow.pravaSessionApprovalUrl || null,
      flow.sandboxPaymentAttempt === true,
      JSON.stringify(flow.priceBreakdown || {}),
      JSON.stringify(flow.cartSnapshot || []),
      flow.failureMessage || null,
    ]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("Checkout flow belongs to another account"), {
      status: 403,
    });
  }
  return result.rows[0];
}

async function getCheckoutFlow(userId, id) {
  const result = await query(
    `SELECT * FROM checkout_flows WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

async function getRecentCheckoutFlows(userId, limit = 10) {
  const result = await query(
    `SELECT * FROM checkout_flows
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(Number(limit) || 10, 1), 25)]
  );
  return result.rows;
}

async function recordWebhookEvent(provider, eventId, eventType) {
  const result = await query(
    `INSERT INTO webhook_events (provider, event_id, event_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING event_id`,
    [provider, eventId, eventType || null]
  );
  return result.rowCount === 1;
}

async function getAddressGeocode(queryKey) {
  const result = await query(
    `SELECT latitude, longitude, provider
     FROM address_geocoding_cache
     WHERE query_key = $1`,
    [queryKey]
  );
  return result.rows[0] || null;
}

async function saveAddressGeocode({
  queryKey,
  queryText,
  latitude,
  longitude,
  provider,
}) {
  const result = await query(
    `INSERT INTO address_geocoding_cache (
       query_key, query_text, latitude, longitude, provider
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (query_key) DO UPDATE SET
       query_text = EXCLUDED.query_text,
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       provider = EXCLUDED.provider,
       updated_at = NOW()
     RETURNING latitude, longitude, provider`,
    [queryKey, queryText, latitude, longitude, provider]
  );
  return result.rows[0];
}

async function getDiagnostics() {
  const [server, counts] = await Promise.all([
    query(
      `SELECT NOW() AS server_time,
              current_database() AS database_name,
              current_setting('server_version') AS server_version`
    ),
    query(`
      SELECT 'users' AS table_name, COUNT(*)::bigint AS row_count FROM users
      UNION ALL
      SELECT 'website_sessions', COUNT(*)::bigint FROM website_sessions
      UNION ALL
      SELECT 'email_signup_challenges', COUNT(*)::bigint
      FROM email_signup_challenges
      UNION ALL
      SELECT 'family_profiles', COUNT(*)::bigint FROM family_profiles
      UNION ALL
      SELECT 'family_dependents', COUNT(*)::bigint FROM family_dependents
      UNION ALL
      SELECT 'merchant_auth_consents', COUNT(*)::bigint FROM merchant_auth_consents
      UNION ALL
      SELECT 'payment_customers', COUNT(*)::bigint FROM payment_customers
      UNION ALL
      SELECT 'payment_methods', COUNT(*)::bigint FROM payment_methods
      UNION ALL
      SELECT 'payment_tokenization_sessions', COUNT(*)::bigint
      FROM payment_tokenization_sessions
      UNION ALL
      SELECT 'checkout_flows', COUNT(*)::bigint FROM checkout_flows
      UNION ALL
      SELECT 'user_platform_tokens', COUNT(*)::bigint FROM user_platform_tokens
      UNION ALL
      SELECT 'family_delivery_preferences', COUNT(*)::bigint
      FROM family_delivery_preferences
      UNION ALL
      SELECT 'family_addresses', COUNT(*)::bigint FROM family_addresses
      UNION ALL
      SELECT 'family_member_addresses', COUNT(*)::bigint
      FROM family_member_addresses
      UNION ALL
      SELECT 'family_care_rules', COUNT(*)::bigint FROM family_care_rules
      UNION ALL
      SELECT 'user_preferences', COUNT(*)::bigint FROM user_preferences
      UNION ALL
      SELECT 'decision_requests', COUNT(*)::bigint FROM decision_requests
      UNION ALL
      SELECT 'activity_events', COUNT(*)::bigint FROM activity_events
      UNION ALL
      SELECT 'merchant_auth_attempts', COUNT(*)::bigint FROM merchant_auth_attempts
      UNION ALL
      SELECT 'webhook_events', COUNT(*)::bigint FROM webhook_events
      UNION ALL
      SELECT 'address_geocoding_cache', COUNT(*)::bigint
      FROM address_geocoding_cache
      UNION ALL
      SELECT 'hermes_memories', COUNT(*)::bigint FROM hermes_memories
      UNION ALL
      SELECT 'telegram_hermes_bindings', COUNT(*)::bigint
      FROM telegram_hermes_bindings
      UNION ALL
      SELECT 'telegram_hermes_messages', COUNT(*)::bigint
      FROM telegram_hermes_messages
      UNION ALL
      SELECT 'platforms', COUNT(*)::bigint FROM platforms
      UNION ALL
      SELECT 'oauth_clients', COUNT(*)::bigint FROM oauth_clients
      ORDER BY table_name
    `),
  ]);
  return {
    connected: true,
    serverTime: server.rows[0].server_time,
    databaseName: server.rows[0].database_name,
    serverVersion: server.rows[0].server_version,
    tables: Object.fromEntries(
      counts.rows.map((entry) => [entry.table_name, Number(entry.row_count)])
    ),
  };
}

async function close() {
  if (pool) await pool.end();
  pool = null;
  initialization = null;
}

module.exports = {
  assignFamilyAddress,
  clearDeliveryPreference,
  clearMcpSession,
  clearToken,
  close,
  completeEmailSignupChallenge,
  consumeMerchantAuthAttempt,
  createEmailSignupChallenge,
  createEmailUser,
  createFamilyAddress,
  createDecisionRequest,
  createWebsiteSession,
  deleteEmailSignupChallenge,
  deleteWebsiteSession,
  deleteFamilyAddress,
  getAllPlatforms,
  getAddressGeocode,
  getActivityEvents,
  getCareRules,
  getCheckoutFlow,
  getDiagnostics,
  getDeliveryPreference,
  getDecisionRequests,
  getFamilyUsersByPhone,
  getFamilyAddresses,
  getHermesMemories,
  getLatestMerchantAuthAttempt,
  getMerchantAuthConsent,
  getOAuthClient,
  getOrCreateWebsiteUser,
  getPaymentCustomer,
  getPaymentMethods,
  getPaymentTokenizationSession,
  getRecentPaymentTokenizationSessions,
  getRecentCheckoutFlows,
  getTelegramHermesBinding,
  getTelegramAddressSession,
  getTelegramHermesMessages,
  getPlatformBySlug,
  getProfile,
  getRecentUserIds,
  resolveLinqUser,
  getToken,
  getUserById,
  getUserByEmail,
  getUserByPhone,
  getUserConsents,
  getUserPreferences,
  getWebsiteSession,
  initialize,
  linkWebsiteUserPhone,
  recordWebhookEvent,
  recordActivityEvent,
  saveLinqAssignment,
  saveAddressGeocode,
  saveCheckoutFlow,
  saveCareRules,
  saveDeliveryPreference,
  saveMerchantAuthAttempt,
  saveOAuthClient,
  savePaymentCustomer,
  savePaymentMethod,
  syncPaymentMethods,
  savePaymentTokenizationSession,
  saveProfile,
  saveUserPreferences,
  saveToken,
  selectFamilyAddress,
  updateFamilyAddress,
  saveTelegramHermesBinding,
  resetTelegramAddressSession,
  confirmTelegramAddressSession,
  saveTelegramHermesMessage,
  setConsent,
  setMerchantAuthConsent,
  touchUserLogin,
  upsertExternalUser,
  upsertLinqUser,
  upsertHermesMemory,
  completePaymentTokenizationSession,
  resolveDecisionRequest,
};
