import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import type { Context } from "hono"
import crypto from "node:crypto"

const SESSION_MAX_AGE_SECONDS = 3600
const COOKIE_NAME = "session"

interface SessionPayload {
  userId: string
  accountId: string
  accessToken?: string
  userName?: string
  userEmail?: string
  userPicture?: string
}

let cachedSecret: string | null = null
let warnedAboutDevSecret = false

function getSecret(): string {
  if (cachedSecret) return cachedSecret

  const secret = process.env.COOKIE_SECRET
  if (secret) {
    cachedSecret = secret
    return secret
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("COOKIE_SECRET env var is required")
  }

  if (!warnedAboutDevSecret) {
    console.warn(
      "COOKIE_SECRET is not set; using an insecure development fallback secret.",
    )
    warnedAboutDevSecret = true
  }
  cachedSecret = "claw-free-dev-cookie-secret"
  return cachedSecret
}

function sign(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret)
  hmac.update(payload)
  return hmac.digest("base64url")
}

function signValue(data: unknown): string {
  const encoded = Buffer.from(JSON.stringify(data)).toString("base64url")
  return `${encoded}.${sign(encoded, getSecret())}`
}

function verifyValue<T>(value: string): T | null {
  const parts = value.split(".")
  if (parts.length !== 2) return null
  const [encoded, signature] = parts
  try {
    const sigBuf = Buffer.from(signature, "base64url")
    const expectedBuf = Buffer.from(sign(encoded, getSecret()), "base64url")
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null
    }
    return JSON.parse(Buffer.from(encoded, "base64url").toString()) as T
  } catch {
    return null
  }
}

export function getSession(c: Context): SessionPayload | null {
  const value = getCookie(c, COOKIE_NAME)
  if (!value) return null
  return verifyValue<SessionPayload>(value)
}

export function setSessionCookie(c: Context, payload: SessionPayload): void {
  setCookie(c, COOKIE_NAME, signValue(payload), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: (process.env.BASE_URL ?? "").startsWith("https://"),
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" })
}

export function signState(data: Record<string, string>): string {
  return signValue(data)
}

export function verifyState(state: string): Record<string, string> | null {
  return verifyValue<Record<string, string>>(state)
}
