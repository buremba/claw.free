interface Env {
  KV: KVNamespace
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const provider = url.searchParams.get("provider") ?? "claude"
  const channel = url.searchParams.get("channel") ?? "telegram"
  const cloud = url.searchParams.get("cloud") ?? "gcp"

  const sessionId = crypto.randomUUID()

  await context.env.KV.put(
    `session:${sessionId}`,
    JSON.stringify({ provider, channel, cloud }),
    { expirationTtl: 300 },
  )

  const redirectUri = `${url.origin}/api/auth/callback/google`
  const scopes = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/compute",
    "https://www.googleapis.com/auth/cloud-platform",
  ].join(" ")

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  authUrl.searchParams.set("client_id", context.env.GOOGLE_CLIENT_ID)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("scope", scopes)
  authUrl.searchParams.set("state", sessionId)
  authUrl.searchParams.set("access_type", "offline")
  authUrl.searchParams.set("prompt", "consent")

  return Response.redirect(authUrl.toString(), 302)
}
