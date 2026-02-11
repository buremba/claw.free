import { getSessionId } from "../../lib/session"

interface Env {
  KV: KVNamespace
}

interface CreateProjectRequest {
  projectId: string
  displayName: string
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const sessionId = getSessionId(context.request)

  if (!sessionId) {
    return Response.json({ error: "Not logged in" }, { status: 401 })
  }

  const data = await context.env.KV.get(`session:${sessionId}`)
  if (!data) {
    return Response.json({ error: "Session expired" }, { status: 404 })
  }

  const session = JSON.parse(data) as {
    accessToken: string
    projects: { projectId: string; name: string }[]
  }

  const body = (await context.request.json()) as CreateProjectRequest
  const { projectId, displayName } = body

  if (!projectId || !displayName) {
    return Response.json({ error: "Missing projectId or displayName" }, { status: 400 })
  }

  // Create the project
  const createRes = await fetch(
    "https://cloudresourcemanager.googleapis.com/v3/projects",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId, displayName }),
    },
  )

  if (!createRes.ok) {
    const err = await createRes.text()
    return Response.json({ error: err }, { status: createRes.status })
  }

  const operation = (await createRes.json()) as { name: string; done?: boolean }

  // Poll operation until done (max ~15s)
  for (let i = 0; i < 10; i++) {
    if (operation.done) break

    await new Promise((r) => setTimeout(r, 1500))

    const pollRes = await fetch(
      `https://cloudresourcemanager.googleapis.com/v3/${operation.name}`,
      {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      },
    )

    if (pollRes.ok) {
      const pollData = (await pollRes.json()) as { done?: boolean; error?: { message: string } }
      if (pollData.error) {
        return Response.json({ error: pollData.error.message }, { status: 500 })
      }
      if (pollData.done) break
    }
  }

  // Add the new project to the session
  session.projects = [...(session.projects ?? []), { projectId, name: displayName }]
  await context.env.KV.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 600,
  })

  return Response.json({ projectId, name: displayName })
}
