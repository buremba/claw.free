import { getSessionId } from "../../lib/session"

interface Env {
  KV: KVNamespace
}

interface GcpInstance {
  name: string
  zone: string
  status: string
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

export interface ExistingVm {
  projectId: string
  zone: string
  ip: string
  status: string
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
    accessToken: string
    projects: { projectId: string; name: string }[]
  }

  const vms: ExistingVm[] = []

  for (const project of session.projects ?? []) {
    try {
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${project.projectId}/aggregated/instances?filter=name="openclaw-vm"`,
        {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        },
      )
      if (!res.ok) continue

      const list = (await res.json()) as AggregatedList
      for (const [scopeKey, scope] of Object.entries(list.items ?? {})) {
        for (const instance of scope.instances ?? []) {
          const zone = scopeKey.replace("zones/", "")
          const ip =
            instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? ""
          vms.push({
            projectId: project.projectId,
            zone,
            ip,
            status: instance.status,
          })
        }
      }
    } catch {
      // Skip projects we can't query
    }
  }

  return Response.json({ vms })
}
