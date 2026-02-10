interface Env {
  KV: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const sessionId = url.searchParams.get("id")

  if (!sessionId) {
    return Response.json({ error: "Missing session ID" }, { status: 400 })
  }

  const data = await context.env.KV.get(`session:${sessionId}`)
  if (!data) {
    return Response.json({ error: "Session expired" }, { status: 404 })
  }

  const session = JSON.parse(data) as {
    provider: string
    channel: string
    region: string
    telegramToken?: string
    telegramUserId?: string
    nvidiaApiKey?: string
    projects: { projectId: string; name: string }[]
  }

  // Return session data without secrets (OAuth tokens, API keys)
  return Response.json({
    provider: session.provider,
    channel: session.channel,
    region: session.region,
    telegramToken: session.telegramToken ?? "",
    telegramUserId: session.telegramUserId ?? "",
    projects: session.projects ?? [],
  })
}
