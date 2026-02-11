import type { Context } from "hono"
import { getUserById } from "../db.js"
import { resolveGoogleAuth } from "../lib/google-auth.js"

interface GcpProject {
  projectId: string
  displayName: string
}

export async function deploySession(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) {
    return c.json({ error: "Not logged in" }, 401)
  }

  let user:
    | {
        name: string
        email: string
        image: string | null
      }
    | null = null
  try {
    user = await getUserById(auth.session.userId)
  } catch {
    user = null
  }

  // Fetch projects on-demand from Google API
  let projects: { projectId: string; name: string }[] = []
  try {
    const projectsRes = await fetch(
      "https://cloudresourcemanager.googleapis.com/v3/projects:search?query=state:ACTIVE",
      {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    )
    if (projectsRes.ok) {
      const data = (await projectsRes.json()) as { projects?: GcpProject[] }
      projects = (data.projects ?? []).map((p) => ({
        projectId: p.projectId,
        name: p.displayName,
      }))
    }
  } catch {
    // Non-critical
  }

  return c.json({
    provider: "claude",
    channel: "telegram",
    userName: user?.name ?? auth.session.userName ?? "",
    userEmail: user?.email ?? auth.session.userEmail ?? "",
    userPicture: user?.image ?? auth.session.userPicture ?? "",
    projects,
  })
}
