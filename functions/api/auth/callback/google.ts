import { sessionCookie } from "../../../lib/session"

interface Env {
  KV: KVNamespace
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

interface GcpProject {
  projectId: string
  displayName: string
  state: string
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const code = url.searchParams.get("code")
  const sessionId = url.searchParams.get("state")

  if (!code || !sessionId) {
    return new Response("Missing code or state", { status: 400 })
  }

  const sessionData = await context.env.KV.get(`session:${sessionId}`)
  if (!sessionData) {
    return new Response("Session expired", { status: 400 })
  }

  const config = JSON.parse(sessionData) as {
    provider: string
    channel: string
    cloud: string
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: context.env.GOOGLE_CLIENT_ID,
      client_secret: context.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/api/auth/callback/google`,
      grant_type: "authorization_code",
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    return new Response(`Token exchange failed: ${err}`, { status: 500 })
  }

  const tokens = (await tokenRes.json()) as TokenResponse

  // Fetch user profile
  let userName = ""
  let userEmail = ""
  let userPicture = ""
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (userRes.ok) {
      const user = (await userRes.json()) as {
        name?: string
        email?: string
        picture?: string
      }
      userName = user.name ?? ""
      userEmail = user.email ?? ""
      userPicture = user.picture ?? ""
    }
  } catch {
    // Non-critical — continue without profile info
  }

  // Fetch user's GCP projects
  const projectsRes = await fetch(
    "https://cloudresourcemanager.googleapis.com/v3/projects:search?query=state:ACTIVE",
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  )

  let projects: { projectId: string; name: string }[] = []
  if (projectsRes.ok) {
    const data = (await projectsRes.json()) as { projects?: GcpProject[] }
    projects = (data.projects ?? []).map((p) => ({
      projectId: p.projectId,
      name: p.displayName,
    }))
  } else {
    console.error("Projects API error:", projectsRes.status, await projectsRes.text())
  }

  // Store session with tokens, profile, and projects
  await context.env.KV.put(
    `session:${sessionId}`,
    JSON.stringify({
      ...config,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      userName,
      userEmail,
      userPicture,
      projects,
    }),
    { expirationTtl: 600 },
  )

  // Redirect to homepage with pre-selected values; session lives in a cookie
  const redirectUrl = new URL("/", url.origin)
  redirectUrl.searchParams.set("provider", config.provider)
  redirectUrl.searchParams.set("channel", config.channel)
  redirectUrl.searchParams.set("cloud", config.cloud)

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl.toString(),
      "Set-Cookie": sessionCookie(sessionId, url.origin),
    },
  })
}
