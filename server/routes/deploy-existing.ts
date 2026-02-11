import type { Context } from "hono"
import { parseMachineType } from "../lib/deploy.js"
import { resolveGoogleAuth } from "../lib/google-auth.js"

interface GcpInstance {
  name: string
  status: string
  labels?: Record<string, string>
  machineType?: string
  networkInterfaces?: {
    accessConfigs?: { natIP?: string }[]
  }[]
}

interface AggregatedList {
  items?: Record<
    string,
    { instances?: GcpInstance[] }
  >
}

export async function deployExisting(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) {
    return c.json({ error: "Not logged in" }, 401)
  }

  // Fetch projects on-demand
  let projects: { projectId: string }[] = []
  try {
    const projectsRes = await fetch(
      "https://cloudresourcemanager.googleapis.com/v3/projects:search?query=state:ACTIVE",
      {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    )
    if (projectsRes.ok) {
      const data = (await projectsRes.json()) as {
        projects?: { projectId: string }[]
      }
      projects = data.projects ?? []
    }
  } catch {
    // Non-critical
  }

  const vms: {
    projectId: string
    name: string
    zone: string
    ip: string
    machineType: string
    status: string
  }[] = []

  for (const project of projects) {
    try {
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${project.projectId}/aggregated/instances`,
        {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        },
      )
      if (!res.ok) continue

      const list = (await res.json()) as AggregatedList
      for (const [scopeKey, scope] of Object.entries(list.items ?? {})) {
        for (const instance of scope.instances ?? []) {
          if (instance.labels?.openclaw !== "true") continue

          vms.push({
            projectId: project.projectId,
            name: instance.name,
            zone: scopeKey.replace("zones/", ""),
            ip: instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? "",
            machineType: parseMachineType(instance.machineType),
            status: instance.status,
          })
        }
      }
    } catch {
      // Skip projects we can't query
    }
  }

  return c.json({ vms })
}
