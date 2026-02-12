import type { Context } from "hono"
import { signState } from "../lib/session.js"

export async function authGoogle(c: Context): Promise<Response> {
  const url = new URL(c.req.url)
  const provider = url.searchParams.get("provider") ?? "claude"
  const channel = url.searchParams.get("channel") ?? "telegram"
  const cloud = url.searchParams.get("cloud") ?? "gcp"
  const upgrade = url.searchParams.get("upgrade")
  const clientId = process.env.GOOGLE_CLIENT_ID

  if (!clientId) {
    return c.text(
      "Server misconfigured: GOOGLE_CLIENT_ID env var is required",
      500,
    )
  }

  const baseUrl = process.env.BASE_URL ?? url.origin
  const redirectUri = `${baseUrl}/api/auth/callback/google`
  const scopes = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/compute",
  ]
  if (upgrade === "service-management") {
    scopes.push("https://www.googleapis.com/auth/service.management")
  }
  if (upgrade === "project-read") {
    scopes.push("https://www.googleapis.com/auth/cloudplatformprojects.readonly")
  }

  const statePayload: Record<string, string> = { provider, channel, cloud }
  if (upgrade === "service-management" || upgrade === "project-read") {
    statePayload.upgrade = upgrade
  }

  let state = ""
  try {
    state = signState(statePayload)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to sign OAuth state"
    return c.text(`Server misconfigured: ${message}`, 500)
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  authUrl.searchParams.set("client_id", clientId)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("scope", scopes.join(" "))
  authUrl.searchParams.set("state", state)
  authUrl.searchParams.set("access_type", "offline")
  authUrl.searchParams.set("prompt", "consent")
  authUrl.searchParams.set("include_granted_scopes", "true")

  return c.redirect(authUrl.toString(), 302)
}
