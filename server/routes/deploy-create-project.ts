import type { Context } from "hono"
import { resolveGoogleAuth } from "../lib/google-auth.js"

interface CreateProjectRequest {
  projectId: string
  displayName: string
}

export async function deployCreateProject(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) {
    return c.json({ error: "Not logged in" }, 401)
  }

  const body = (await c.req.json()) as CreateProjectRequest
  const { projectId, displayName } = body

  if (!projectId || !displayName) {
    return c.json({ error: "Missing projectId or displayName" }, 400)
  }

  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
  }

  // Create the project
  const createRes = await fetch(
    "https://cloudresourcemanager.googleapis.com/v3/projects",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, displayName }),
    },
  )

  if (!createRes.ok) {
    const err = await createRes.text()
    return c.json({ error: err }, createRes.status as 400)
  }

  const operation = (await createRes.json()) as { name: string; done?: boolean }

  // Poll operation until done (max ~15s)
  for (let i = 0; i < 10; i++) {
    if (operation.done) break

    await new Promise((r) => setTimeout(r, 1500))

    const pollRes = await fetch(
      `https://cloudresourcemanager.googleapis.com/v3/${operation.name}`,
      {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    )

    if (pollRes.ok) {
      const pollData = (await pollRes.json()) as {
        done?: boolean
        error?: { message: string }
      }
      if (pollData.error) {
        return c.json({ error: pollData.error.message }, 500)
      }
      if (pollData.done) break
    }
  }

  return c.json({ projectId, name: displayName })
}
