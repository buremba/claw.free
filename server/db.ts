import pg from "pg"

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
})

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

export async function getAccessTokenByAccountId(
  accountId: string,
): Promise<string | null> {
  const result = await pool.query<{ accessToken: string | null }>(
    `SELECT "accessToken" FROM account WHERE id = $1 LIMIT 1`,
    [accountId],
  )
  return result.rows[0]?.accessToken ?? null
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
