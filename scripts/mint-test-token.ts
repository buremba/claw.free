/**
 * Mints a Bearer token for testing the mini bot API locally.
 * Creates a test user in the DB if one doesn't exist.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/mint-test-token.ts
 *
 * The token is printed to stdout and can be used as:
 *   curl -H "Authorization: Bearer <token>" http://localhost:8788/api/mini/bots
 */

import crypto from "node:crypto"
import pg from "pg"

const COOKIE_SECRET = process.env.COOKIE_SECRET || "claw-free-dev-cookie-secret"
const TELEGRAM_ID = "12345"
const EXP = String(Math.floor(Date.now() / 1000) + 86400) // 24 hours

function sign(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret)
  hmac.update(payload)
  return hmac.digest("base64url")
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set. Run with: npx tsx --env-file=.env scripts/mint-test-token.ts")
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

  try {
    // Check if test telegram user already exists
    const existing = await pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM channel_identity WHERE channel_type = 'telegram' AND channel_user_id = $1 LIMIT 1`,
      [TELEGRAM_ID],
    )

    let userId: string
    if (existing.rows[0]) {
      userId = existing.rows[0].user_id
      console.log(`Found existing test user: ${userId}`)
    } else {
      // Create user + channel identity
      userId = crypto.randomUUID()
      const now = new Date()
      await pool.query(
        `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt", username)
         VALUES ($1, $2, $3, false, NULL, $4, $5, $6)`,
        [userId, "Test User", `telegram:${TELEGRAM_ID}@noemail`, now, now, `tg_${TELEGRAM_ID}`],
      )
      const ciId = crypto.randomUUID()
      await pool.query(
        `INSERT INTO channel_identity (id, user_id, channel_type, channel_user_id, display_name, created_at)
         VALUES ($1, $2, 'telegram', $3, 'Test User', $4)`,
        [ciId, userId, TELEGRAM_ID, now],
      )
      console.log(`Created test user: ${userId}`)
    }

    const data = { userId, telegramId: TELEGRAM_ID, exp: EXP }
    const encoded = Buffer.from(JSON.stringify(data)).toString("base64url")
    const token = `${encoded}.${sign(encoded, COOKIE_SECRET)}`

    console.log(`\nBearer token:\n${token}`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
