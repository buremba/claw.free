import { createHmac } from "node:crypto"

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

  if (computedHash !== hash) return null

  try {
    return JSON.parse(params.get("user") ?? "{}") as TelegramUser
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
