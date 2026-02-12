import type { Context } from "hono"
import { validateInitData } from "../lib/telegram.js"
import { findOrCreateTelegramUser } from "../db.js"
import { signState, verifyState } from "../lib/session.js"

const MINI_TOKEN_MAX_AGE = 3600 // 1 hour

export async function miniAuth(c: Context): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as { initData?: string } | null
  const initData = body?.initData
  if (!initData) {
    return c.json({ error: "Missing initData" }, 400)
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    return c.json({ error: "Server misconfigured" }, 500)
  }

  const telegramUser = validateInitData(initData, botToken)
  if (!telegramUser) {
    return c.json({ error: "Invalid or expired initData" }, 401)
  }

  const displayName = [telegramUser.first_name, telegramUser.last_name]
    .filter(Boolean)
    .join(" ") || null

  const { userId } = await findOrCreateTelegramUser(
    String(telegramUser.id),
    displayName,
    telegramUser.photo_url ?? null,
    telegramUser,
  )

  // Issue a signed token (reusing existing HMAC signing infrastructure)
  const token = signState({
    userId,
    telegramId: String(telegramUser.id),
    exp: String(Math.floor(Date.now() / 1000) + MINI_TOKEN_MAX_AGE),
  })

  return c.json({
    token,
    user: {
      id: userId,
      telegramId: telegramUser.id,
      name: displayName,
      username: telegramUser.username,
      photoUrl: telegramUser.photo_url,
    },
  })
}

export interface MiniAuthContext {
  userId: string
  telegramId: string
}

export function getMiniAuth(c: Context): MiniAuthContext | null {
  const header = c.req.header("authorization")
  if (!header?.startsWith("Bearer ")) return null

  const token = header.slice(7)
  const payload = verifyState(token)
  if (!payload?.userId || !payload?.exp) return null

  const exp = Number(payload.exp)
  if (Math.floor(Date.now() / 1000) > exp) return null

  return { userId: payload.userId, telegramId: payload.telegramId }
}
