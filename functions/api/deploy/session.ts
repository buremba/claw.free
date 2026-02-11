import { getSessionId } from "../../lib/session"

interface Env {
  KV: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const sessionId = getSessionId(context.request)

  if (!sessionId) {
    return Response.json({ error: "Not logged in" }, { status: 401 })
  }

  const data = await context.env.KV.get(`session:${sessionId}`)
  if (!data) {
    return Response.json({ error: "Session expired" }, { status: 404 })
  }

  const session = JSON.parse(data) as {
    provider: string
    channel: string
    userName?: string
    userEmail?: string
    userPicture?: string
    projects: { projectId: string; name: string }[]
  }

  return Response.json({
    provider: session.provider,
    channel: session.channel,
    userName: session.userName ?? "",
    userEmail: session.userEmail ?? "",
    userPicture: session.userPicture ?? "",
    projects: session.projects ?? [],
  })
}
