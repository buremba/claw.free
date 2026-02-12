import type { Context } from "hono"
import { verifyState, setSessionCookie } from "../lib/session.js"
import { findOrCreateUser, upsertGoogleAccount } from "../db.js"
import { randomUUID } from "node:crypto"

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}

interface GoogleUserInfo {
  id: string
  name?: string
  email?: string
  picture?: string
}

export async function authCallbackGoogle(c: Context): Promise<Response> {
  const url = new URL(c.req.url)
  const code = url.searchParams.get("code")
  const stateParam = url.searchParams.get("state")
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!code || !stateParam) {
    return c.text("Missing code or state", 400)
  }

  if (!clientId || !clientSecret) {
    return c.text(
      "Server misconfigured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required",
      500,
    )
  }

  let config: Record<string, string> | null = null
  try {
    config = verifyState(stateParam)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to verify OAuth state"
    return c.text(`Server misconfigured: ${message}`, 500)
  }

  if (!config) {
    return c.text("Invalid or expired state", 400)
  }

  const baseUrl = process.env.BASE_URL ?? url.origin

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${baseUrl}/api/auth/callback/google`,
      grant_type: "authorization_code",
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    const status = err.includes("\"invalid_grant\"") ? 400 : 500
    return c.text(`Token exchange failed: ${err}`, status)
  }

  const tokens = (await tokenRes.json()) as TokenResponse

  // Fetch Google user profile
  let googleUserId = ""
  let userName = ""
  let userEmail = ""
  let userPicture = ""
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (userRes.ok) {
      const user = (await userRes.json()) as GoogleUserInfo
      googleUserId = user.id ?? ""
      userName = user.name ?? ""
      userEmail = user.email ?? ""
      userPicture = user.picture ?? ""
    }
  } catch {
    // Non-critical
  }

  if (!userEmail) {
    return c.text("Could not retrieve email from Google", 400)
  }

  const requestedScopes = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/compute",
  ]
  if (config.upgrade === "service-management") {
    requestedScopes.push("https://www.googleapis.com/auth/service.management")
  }
  if (config.upgrade === "project-read") {
    requestedScopes.push(
      "https://www.googleapis.com/auth/cloudplatformprojects.readonly",
    )
  }
  const scopes = normalizeScopes(tokens.scope ?? requestedScopes.join(" "))

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null

  const fallbackUserId = googleUserId ? `google:${googleUserId}` : randomUUID()
  let cookieUserId = fallbackUserId
  let cookieAccountId = `cookie-google:${fallbackUserId}`

  try {
    // Find or create user in DB when available.
    const dbUser = await findOrCreateUser(userEmail, userName, userPicture || null)
    const account = await upsertGoogleAccount(
      dbUser.id,
      googleUserId,
      tokens.access_token,
      tokens.refresh_token ?? null,
      scopes,
      expiresAt,
    )
    cookieUserId = dbUser.id
    cookieAccountId = account.id
  } catch (error) {
    console.warn(
      "Google auth callback could not persist session to DB; using cookie-only fallback session.",
      error,
    )
  }

  // Set signed cookie (includes token for DB-fallback environments).
  setSessionCookie(c, {
    userId: cookieUserId,
    accountId: cookieAccountId,
    accessToken: tokens.access_token,
    userName,
    userEmail,
    userPicture,
  })

  // Redirect to homepage with pre-selected values
  const redirectUrl = new URL("/", baseUrl)
  redirectUrl.searchParams.set("provider", config.provider)
  redirectUrl.searchParams.set("channel", config.channel)
  redirectUrl.searchParams.set("cloud", config.cloud)

  return c.redirect(redirectUrl.toString(), 302)
}

function normalizeScopes(raw: string): string {
  const scopes = raw
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)

  return [...new Set(scopes)].sort().join(" ")
}
