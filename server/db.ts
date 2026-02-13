import pg from "pg"

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
})

pool.on("error", (err) => {
  console.error("Unexpected error on idle database client:", err)
})

// --- Existing user/account types & queries (kept for Google OAuth web flow) ---

export interface User {
  id: string
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Account {
  id: string
  accountId: string
  providerId: string
  userId: string
  accessToken: string | null
  refreshToken: string | null
  idToken: string | null
  accessTokenExpiresAt: Date | null
  scope: string | null
  createdAt: Date
  updatedAt: Date
}

export async function findOrCreateUser(
  email: string,
  name: string,
  image: string | null,
): Promise<User> {
  const existing = await pool.query<User>(
    `SELECT id, name, email, "emailVerified", image, "createdAt", "updatedAt"
     FROM "user" WHERE email = $1 LIMIT 1`,
    [email],
  )
  if (existing.rows[0]) return existing.rows[0]

  const now = new Date()
  const result = await pool.query<User>(
    `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, $4, $5, $6)
     RETURNING id, name, email, "emailVerified", image, "createdAt", "updatedAt"`,
    [crypto.randomUUID(), name, email, image, now, now],
  )
  return result.rows[0]
}

export async function getUserById(
  userId: string,
): Promise<{ name: string; email: string; image: string | null } | null> {
  const result = await pool.query<{ name: string; email: string; image: string | null }>(
    `SELECT name, email, image FROM "user" WHERE id = $1 LIMIT 1`,
    [userId],
  )
  return result.rows[0] ?? null
}

export async function getAccountByUserId(
  userId: string,
  providerId: string,
): Promise<Account | null> {
  const result = await pool.query<Account>(
    `SELECT id, "accountId", "providerId", "userId", "accessToken", "refreshToken",
            "idToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt"
     FROM account WHERE "userId" = $1 AND "providerId" = $2 LIMIT 1`,
    [userId, providerId],
  )
  return result.rows[0] ?? null
}

export async function upsertGoogleAccount(
  userId: string,
  accountId: string,
  accessToken: string,
  refreshToken: string | null,
  scope: string,
  expiresAt: Date | null,
): Promise<Account> {
  const now = new Date()
  const result = await pool.query<Account>(
    `INSERT INTO account (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt")
     VALUES ($1, $2, 'google', $3, $4, $5, NULL, $6, $7, $8, $9)
     ON CONFLICT ("providerId", "accountId") DO UPDATE SET
       "accessToken" = EXCLUDED."accessToken",
       "refreshToken" = COALESCE(EXCLUDED."refreshToken", account."refreshToken"),
       "accessTokenExpiresAt" = EXCLUDED."accessTokenExpiresAt",
       scope = EXCLUDED.scope,
       "updatedAt" = EXCLUDED."updatedAt"
     RETURNING id, "accountId", "providerId", "userId", "accessToken", "refreshToken",
               "idToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt"`,
    [crypto.randomUUID(), accountId, userId, accessToken, refreshToken, expiresAt, scope, now, now],
  )
  return result.rows[0]
}

// --- Channel Identity (Telegram, WhatsApp, Discord) ---

export interface ChannelIdentity {
  id: string
  userId: string
  channelType: string
  channelUserId: string
  displayName: string | null
  avatarUrl: string | null
  rawData: unknown | null
  createdAt: Date
}

export async function findOrCreateTelegramUser(
  telegramId: string,
  displayName: string | null,
  avatarUrl: string | null,
  rawData: unknown | null,
): Promise<{ userId: string; channelIdentityId: string }> {
  // Check if this telegram user already exists
  const existing = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM channel_identity
     WHERE channel_type = 'telegram' AND channel_user_id = $1 LIMIT 1`,
    [telegramId],
  )
  if (existing.rows[0]) {
    return { userId: existing.rows[0].user_id, channelIdentityId: existing.rows[0].id }
  }

  // Create new user + channel identity in transaction
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const now = new Date()
    const userId = crypto.randomUUID()
    await client.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt", username)
       VALUES ($1, $2, $3, false, $4, $5, $6, $7)`,
      [userId, displayName ?? "Telegram User", `telegram:${telegramId}@noemail`, avatarUrl, now, now, `tg_${telegramId}`],
    )
    const ciId = crypto.randomUUID()
    await client.query(
      `INSERT INTO channel_identity (id, user_id, channel_type, channel_user_id, display_name, avatar_url, raw_data, created_at)
       VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7)`,
      [ciId, userId, telegramId, displayName, avatarUrl, JSON.stringify(rawData), now],
    )
    await client.query("COMMIT")
    return { userId, channelIdentityId: ciId }
  } catch (e) {
    await client.query("ROLLBACK")
    // Race condition: another request created this user concurrently.
    // Unique constraint violation (23505) — re-check and return existing record.
    const isUniqueViolation = e instanceof Error && "code" in e && (e as { code: string }).code === "23505"
    if (isUniqueViolation) {
      const retry = await pool.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM channel_identity
         WHERE channel_type = 'telegram' AND channel_user_id = $1 LIMIT 1`,
        [telegramId],
      )
      if (retry.rows[0]) {
        return { userId: retry.rows[0].user_id, channelIdentityId: retry.rows[0].id }
      }
    }
    throw e
  } finally {
    client.release()
  }
}

// --- Deployments (persistent, replaces in-memory deploy store) ---

export interface Deployment {
  id: string
  userId: string
  botUsername: string | null
  cloudProvider: string
  projectId: string | null
  vmName: string | null
  vmZone: string | null
  vmIp: string | null
  operationName: string | null
  relayToken: string | null
  webhookSecret: string | null
  railwayServiceId: string | null
  status: string
  error: string | null
  createdAt: Date
  updatedAt: Date
}

// Column alias list — maps snake_case DB columns to camelCase interface fields
const DEPLOYMENT_COLUMNS = `
  id, user_id AS "userId", bot_username AS "botUsername",
  cloud_provider AS "cloudProvider", project_id AS "projectId",
  vm_name AS "vmName", vm_zone AS "vmZone", vm_ip AS "vmIp",
  operation_name AS "operationName", relay_token AS "relayToken",
  webhook_secret AS "webhookSecret", railway_service_id AS "railwayServiceId",
  status, error, created_at AS "createdAt", updated_at AS "updatedAt"
`.replace(/\n/g, " ")

export async function createDeployment(input: {
  id: string
  userId: string
  botUsername: string | null
  cloudProvider: string
  projectId: string | null
  vmName: string | null
  vmZone: string | null
  operationName: string | null
  status: string
  relayToken?: string | null
  webhookSecret?: string | null
  railwayServiceId?: string | null
}): Promise<Deployment> {
  const now = new Date()
  const result = await pool.query<Deployment>(
    `INSERT INTO deployment (id, user_id, bot_username, cloud_provider, project_id,
       vm_name, vm_zone, operation_name, relay_token, webhook_secret, railway_service_id,
       status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${DEPLOYMENT_COLUMNS}`,
    [
      input.id, input.userId, input.botUsername, input.cloudProvider,
      input.projectId ?? null, input.vmName ?? null, input.vmZone ?? null,
      input.operationName ?? null, input.relayToken ?? null,
      input.webhookSecret ?? null, input.railwayServiceId ?? null,
      input.status, now, now,
    ],
  )
  return result.rows[0]
}

export async function getDeploymentByRelayToken(token: string): Promise<Deployment | null> {
  const result = await pool.query<Deployment>(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployment WHERE relay_token = $1 LIMIT 1`,
    [token],
  )
  return result.rows[0] ?? null
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const result = await pool.query<Deployment>(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployment WHERE id = $1 LIMIT 1`,
    [id],
  )
  return result.rows[0] ?? null
}

export async function updateDeployment(
  id: string,
  updates: Partial<Pick<Deployment, "status" | "vmIp" | "error" | "operationName">>,
): Promise<void> {
  const sets: string[] = [`updated_at = NOW()`]
  const values: unknown[] = []
  let idx = 1

  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`)
    values.push(updates.status)
  }
  if (updates.vmIp !== undefined) {
    sets.push(`vm_ip = $${idx++}`)
    values.push(updates.vmIp)
  }
  if (updates.error !== undefined) {
    sets.push(`error = $${idx++}`)
    values.push(updates.error)
  }
  if (updates.operationName !== undefined) {
    sets.push(`operation_name = $${idx++}`)
    values.push(updates.operationName)
  }

  values.push(id)
  await pool.query(
    `UPDATE deployment SET ${sets.join(", ")} WHERE id = $${idx}`,
    values,
  )
}

export async function getDeploymentsByUserId(userId: string): Promise<Deployment[]> {
  const result = await pool.query<Deployment>(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployment WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  )
  return result.rows
}

export async function deleteDeployment(id: string): Promise<void> {
  await pool.query(`DELETE FROM deployment WHERE id = $1`, [id])
}

// --- Secure environment variables (encrypted secrets for proxy injection) ---

export interface SecureEnv {
  id: string
  deploymentId: string
  name: string
  encryptedValue: string
  allowedHosts: string[]
  createdAt: Date
}

const SECURE_ENV_COLUMNS = `
  id, deployment_id AS "deploymentId", name,
  encrypted_value AS "encryptedValue",
  allowed_hosts AS "allowedHosts",
  created_at AS "createdAt"
`.replace(/\n/g, " ")

export async function createSecureEnv(input: {
  deploymentId: string
  name: string
  encryptedValue: string
  allowedHosts: string[]
}): Promise<SecureEnv> {
  const result = await pool.query<SecureEnv>(
    `INSERT INTO secure_env (id, deployment_id, name, encrypted_value, allowed_hosts)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (deployment_id, name) DO UPDATE SET
       encrypted_value = EXCLUDED.encrypted_value,
       allowed_hosts = EXCLUDED.allowed_hosts
     RETURNING ${SECURE_ENV_COLUMNS}`,
    [crypto.randomUUID(), input.deploymentId, input.name, input.encryptedValue, input.allowedHosts],
  )
  return result.rows[0]
}

export async function getSecureEnvByDeployment(deploymentId: string): Promise<SecureEnv[]> {
  const result = await pool.query<SecureEnv>(
    `SELECT ${SECURE_ENV_COLUMNS} FROM secure_env WHERE deployment_id = $1 ORDER BY name`,
    [deploymentId],
  )
  return result.rows
}

export async function getSecureEnvByName(deploymentId: string, name: string): Promise<SecureEnv | null> {
  const result = await pool.query<SecureEnv>(
    `SELECT ${SECURE_ENV_COLUMNS} FROM secure_env WHERE deployment_id = $1 AND name = $2 LIMIT 1`,
    [deploymentId, name],
  )
  return result.rows[0] ?? null
}

export async function deleteSecureEnv(deploymentId: string, name: string): Promise<void> {
  await pool.query(
    `DELETE FROM secure_env WHERE deployment_id = $1 AND name = $2`,
    [deploymentId, name],
  )
}

export async function deleteAllSecureEnv(deploymentId: string): Promise<void> {
  await pool.query(`DELETE FROM secure_env WHERE deployment_id = $1`, [deploymentId])
}

/**
 * Get all distinct allowed host patterns across all secrets for a deployment.
 * Used by the proxy to enforce allowlist-only access — if no secret's allowedHosts
 * matches the target host, the request is blocked (SSRF prevention).
 */
export async function getAllowedHostsForDeployment(deploymentId: string): Promise<string[]> {
  const result = await pool.query<{ host: string }>(
    `SELECT DISTINCT unnest(allowed_hosts) AS host FROM secure_env WHERE deployment_id = $1`,
    [deploymentId],
  )
  return result.rows.map((r) => r.host)
}

// --- Outbound allowlist (per bot IP) ---

export async function getAllowlistedDomainsForIp(ip: string): Promise<string[]> {
  const result = await pool.query<{ domain: string }>(
    `SELECT domain FROM bot_allowlist WHERE ip = $1`,
    [ip],
  )
  return result.rows.map((r) => r.domain)
}

export async function upsertAllowlistDomainForIp(ip: string, domain: string): Promise<void> {
  await pool.query(
    `INSERT INTO bot_allowlist (id, ip, domain)
     VALUES ($1, $2, $3)
     ON CONFLICT (ip, domain) DO NOTHING`,
    [crypto.randomUUID(), ip, domain],
  )
}

// --- Schema migration ---

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "user" (
      -- NOTE: This project historically used TEXT IDs in production.
      -- Keep IDs as TEXT to remain compatible with existing Railway DBs.
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      "emailVerified" BOOLEAN DEFAULT false,
      image TEXT,
      "createdAt" TIMESTAMPTZ DEFAULT now(),
      "updatedAt" TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      "accountId" TEXT NOT NULL,
      "providerId" TEXT NOT NULL,
      "userId" TEXT REFERENCES "user"(id),
      "accessToken" TEXT,
      "refreshToken" TEXT,
      "idToken" TEXT,
      "accessTokenExpiresAt" TIMESTAMPTZ,
      scope TEXT,
      "createdAt" TIMESTAMPTZ DEFAULT now(),
      "updatedAt" TIMESTAMPTZ DEFAULT now(),
      UNIQUE("providerId", "accountId")
    );

    CREATE TABLE IF NOT EXISTS channel_identity (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES "user"(id),
      channel_type TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      raw_data JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(channel_type, channel_user_id)
    );

    CREATE TABLE IF NOT EXISTS deployment (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES "user"(id),
      bot_username TEXT,
      cloud_provider TEXT DEFAULT 'gcp',
      project_id TEXT,
      vm_name TEXT,
      vm_zone TEXT,
      vm_ip TEXT,
      operation_name TEXT,
      relay_token TEXT UNIQUE,
      webhook_secret TEXT,
      railway_service_id TEXT,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bot_allowlist (
      id TEXT PRIMARY KEY,
      ip TEXT NOT NULL,
      domain TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(ip, domain)
    );

    CREATE TABLE IF NOT EXISTS secure_env (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployment(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      allowed_hosts TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(deployment_id, name)
    );

    -- Migrations for existing deployments
    ALTER TABLE deployment ADD COLUMN IF NOT EXISTS relay_token TEXT;
    ALTER TABLE deployment ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
    ALTER TABLE deployment ADD COLUMN IF NOT EXISTS railway_service_id TEXT;

    -- Migrations for user table (production DB has these columns)
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS username TEXT;
    UPDATE "user" SET username = 'user_' || id WHERE username IS NULL;
    ALTER TABLE "user" ALTER COLUMN username SET NOT NULL;
  `)
}
