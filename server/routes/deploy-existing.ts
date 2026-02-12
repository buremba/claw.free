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

  const projectId = c.req.query("projectId")?.trim()
  if (!projectId) {
    return c.json({ vms: [] })
  }

  const vms: {
    projectId: string
    name: string
    zone: string
    ip: string
    machineType: string
    status: string
  }[] = []

  try {
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${projectId}/aggregated/instances`,
      {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    )
    if (!res.ok) {
      return c.json({ vms })
    }

    const list = (await res.json()) as AggregatedList
    for (const [scopeKey, scope] of Object.entries(list.items ?? {})) {
      for (const instance of scope.instances ?? []) {
        if (instance.labels?.openclaw !== "true") continue

        vms.push({
          projectId,
          name: instance.name,
          zone: scopeKey.replace("zones/", ""),
          ip: instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? "",
          machineType: parseMachineType(instance.machineType),
          status: instance.status,
        })
      }
    }
  } catch {
    // Non-critical
  }

  return c.json({ vms })
}
