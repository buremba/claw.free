import type { Context } from "hono"
import { getDeployment, updateDeployment, type Deployment } from "../db.js"
import { DEPLOY_TIMEOUT_MS, isDeployTimedOut } from "../lib/deploy.js"
import { resolveGoogleAuth } from "../lib/google-auth.js"
import { getSession } from "../lib/session.js"
import {
  extractSetupMarkerValue,
  resolveSetupProgress,
  type GuestAttributesResponse,
} from "../lib/setup-marker.js"

interface GcpOperation {
  status: string
  error?: { errors: { code: string; message: string }[] }
}

interface GcpInstance {
  status: string
  networkInterfaces?: {
    accessConfigs?: { natIP?: string }[]
  }[]
}

export async function deployStatus(c: Context): Promise<Response> {
  const session = getSession(c)
  if (!session) return c.json({ error: "Not logged in" }, 401)

  const deploymentId = c.req.param("id")
  const record = await getDeployment(deploymentId)

  if (!record || record.userId !== session.userId) {
    return c.json({ error: "Deployment not found" }, 404)
  }

  if (record.status !== "done" && record.status !== "error") {
    if (isDeployTimedOut(record.createdAt.getTime(), Date.now(), DEPLOY_TIMEOUT_MS)) {
      await updateDeployment(deploymentId, { status: "error", error: "Deployment timed out after 5 minutes" })
      return c.json({ status: "error", ip: record.vmIp, error: "Deployment timed out after 5 minutes" })
    }

    const auth = await resolveGoogleAuth(c)
    if (!auth?.accessToken) {
      await updateDeployment(deploymentId, { status: "error", error: "Session expired" })
      return c.json({ status: "error", ip: record.vmIp, error: "Session expired" })
    }

    const headers = { Authorization: `Bearer ${auth.accessToken}` }
    const updates: Partial<Pick<Deployment, "status" | "vmIp" | "error">> = {}

    if (record.status === "creating" && record.operationName) {
      await pollCreateOperation(headers, record, updates)
    } else if (record.status === "booting" || record.status === "health-checking") {
      await pollVmState(headers, record, updates)
    }

    if (Object.keys(updates).length > 0) {
      await updateDeployment(deploymentId, updates)
    }

    return c.json({
      status: updates.status ?? record.status,
      ip: updates.vmIp ?? record.vmIp,
      error: updates.error ?? record.error,
    })
  }

  return c.json({ status: record.status, ip: record.vmIp, error: record.error })
}

async function pollCreateOperation(
  headers: { Authorization: string },
  record: Deployment,
  updates: Partial<Pick<Deployment, "status" | "vmIp" | "error">>,
): Promise<void> {
  const opRes = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${record.projectId}/zones/${record.vmZone}/operations/${record.operationName}`,
    { headers },
  )
  if (!opRes.ok) return

  const op = (await opRes.json()) as GcpOperation
  if (op.status !== "DONE") return

  if (op.error) {
    updates.status = "error"
    updates.error = op.error.errors.map((e) => e.message).join(", ")
    return
  }

  await pollVmState(headers, record, updates)
}

async function pollVmState(
  headers: { Authorization: string },
  record: Deployment,
  updates: Partial<Pick<Deployment, "status" | "vmIp" | "error">>,
): Promise<void> {
  const vmRes = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${record.projectId}/zones/${record.vmZone}/instances/${record.vmName}`,
    { headers },
  )
  if (!vmRes.ok) {
    updates.status = "booting"
    return
  }

  const vm = (await vmRes.json()) as GcpInstance
  const ip = vm.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP
  if (ip) updates.vmIp = ip

  if (vm.status === "TERMINATED" || vm.status === "STOPPING") {
    updates.status = "error"
    updates.error = `VM entered unexpected state: ${vm.status}`
    return
  }

  if (vm.status !== "RUNNING") {
    updates.status = "booting"
    return
  }

  const setupMarker = await fetchSetupMarker(headers, record)
  const progress = resolveSetupProgress(setupMarker)
  updates.status = progress.status
  if (progress.status === "error") {
    updates.error = progress.error
  }
}

async function fetchSetupMarker(
  headers: { Authorization: string },
  record: Deployment,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${record.projectId}/zones/${record.vmZone}/instances/${record.vmName}/getGuestAttributes?queryPath=openclaw/setup`,
      { headers },
    )
    if (!res.ok) return null
    return extractSetupMarkerValue((await res.json()) as GuestAttributesResponse)
  } catch {
    return null
  }
}
