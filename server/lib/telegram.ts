import { createHmac, timingSafeEqual } from "node:crypto"

export interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  photo_url?: string
  language_code?: string
}

export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 300,
): TelegramUser | null {
  const params = new URLSearchParams(initData)
  const hash = params.get("hash")
  if (!hash) return null
  params.delete("hash")

  const authDate = Number(params.get("auth_date") ?? "0")
  if (authDate === 0) return null

  const now = Math.floor(Date.now() / 1000)
  if (now - authDate > maxAgeSeconds) return null

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")

  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest()
  const computedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex")

  const computedBuf = Buffer.from(computedHash, "hex")
  const hashBuf = Buffer.from(hash, "hex")
  if (computedBuf.length !== hashBuf.length || !timingSafeEqual(computedBuf, hashBuf)) {
    return null
  }

  try {
    const parsed = JSON.parse(params.get("user") ?? "{}") as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    const user = parsed as Record<string, unknown>
    if (typeof user.id !== "number") return null
    if (typeof user.first_name !== "string" || user.first_name.length === 0) return null
    return {
      id: user.id,
      first_name: user.first_name,
      last_name: typeof user.last_name === "string" ? user.last_name : undefined,
      username: typeof user.username === "string" ? user.username : undefined,
      photo_url: typeof user.photo_url === "string" ? user.photo_url : undefined,
      language_code: typeof user.language_code === "string" ? user.language_code : undefined,
    }
  } catch {
    return null
  }
}

const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{35}$/

export function isValidBotToken(token: string): boolean {
  return BOT_TOKEN_REGEX.test(token)
}

export interface TelegramBotInfo {
  id: number
  is_bot: boolean
  first_name: string
  username: string
}

export async function validateBotToken(
  token: string,
): Promise<TelegramBotInfo | null> {
  if (!isValidBotToken(token)) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    if (!res.ok) return null
    const data = (await res.json()) as { ok: boolean; result?: TelegramBotInfo }
    return data.ok ? (data.result ?? null) : null
  } catch {
    return null
  }
}
