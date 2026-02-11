import type { Context } from "hono"
import { deployStore, type DeployRecord } from "../deploy-store.js"
import { getAccessTokenByAccountId } from "../db.js"
import { DEPLOY_TIMEOUT_MS, isDeployTimedOut } from "../lib/deploy.js"
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
  const deploymentId = c.req.param("id")
  const record = deployStore.get(deploymentId)

  if (!record) {
    return c.json({ error: "Deployment not found" }, 404)
  }

  if (record.status !== "done" && record.status !== "error") {
    if (isDeployTimedOut(record.createdAt, Date.now(), DEPLOY_TIMEOUT_MS)) {
      record.status = "error"
      record.error = "Deployment timed out after 5 minutes"
      deployStore.set(deploymentId, record)
    } else {
      let accessToken = record.accessToken ?? null
      if (!accessToken) {
        try {
          accessToken = await getAccessTokenByAccountId(record.accountId)
        } catch (error) {
          console.warn(
            "DB lookup failed while checking deploy status; no fallback token available.",
            error,
          )
        }
      }
      if (!accessToken) {
        record.status = "error"
        record.error = "Session expired"
        deployStore.set(deploymentId, record)
      } else {
        const headers = { Authorization: `Bearer ${accessToken}` }

        if (record.status === "creating" && record.operationName) {
          await updateFromCreateOperation(headers, record)
        } else if (
          record.status === "booting" ||
          record.status === "health-checking"
        ) {
          await updateFromVmState(headers, record)
        }

        deployStore.set(deploymentId, record)
      }
    }
  }

  return c.json({
    status: record.status,
    ip: record.ip,
    error: record.error,
  })
}

async function updateFromCreateOperation(
  headers: { Authorization: string },
  record: DeployRecord,
): Promise<void> {
  const opRes = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${record.projectId}/zones/${record.zone}/operations/${record.operationName}`,
    { headers },
  )
  if (!opRes.ok) return

  const op = (await opRes.json()) as GcpOperation
  if (op.status !== "DONE") return

  if (op.error) {
    record.status = "error"
    record.error = op.error.errors.map((e) => e.message).join(", ")
    return
  }

  await updateFromVmState(headers, record)
}

async function updateFromVmState(
  headers: { Authorization: string },
  record: DeployRecord,
): Promise<void> {
  const vmRes = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${record.projectId}/zones/${record.zone}/instances/${record.vmName}`,
    { headers },
  )
  if (!vmRes.ok) {
    record.status = "booting"
    return
  }

  const vm = (await vmRes.json()) as GcpInstance
  const ip = vm.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP
  if (ip) {
    record.ip = ip
  }

  if (vm.status === "TERMINATED" || vm.status === "STOPPING") {
    record.status = "error"
    record.error = `VM entered unexpected state: ${vm.status}`
    return
  }

  if (vm.status !== "RUNNING") {
    record.status = "booting"
    return
  }

  const setupMarker = await fetchSetupMarker(headers, record)
  const setupProgress = resolveSetupProgress(setupMarker)
  record.status = setupProgress.status
  if (setupProgress.status === "error") {
    record.error = setupProgress.error
  } else {
    record.error = undefined
  }
}

async function fetchSetupMarker(
  headers: { Authorization: string },
  record: DeployRecord,
): Promise<string | null> {
  try {
    const guestRes = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${record.projectId}/zones/${record.zone}/instances/${record.vmName}/getGuestAttributes?queryPath=openclaw/setup`,
      { headers },
    )
    if (!guestRes.ok) {
      return null
    }

    const payload = (await guestRes.json()) as GuestAttributesResponse
    return extractSetupMarkerValue(payload)
  } catch {
    return null
  }
}
