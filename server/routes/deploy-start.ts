import type { Context } from "hono"
import { deployStore } from "../deploy-store.js"
import { sanitizeGoogleErrorMessage } from "../lib/google-error.js"
import { resolveGoogleAuth } from "../lib/google-auth.js"
import {
  DEFAULT_SOURCE_IMAGE,
  buildInstanceRequestBody,
  generateVmName,
  sanitizeBotName,
} from "../lib/deploy.js"

interface DeployRequest {
  projectId: string
  telegramToken: string
  region: string
  provider: string
  botName?: string
}

interface GoogleApiError {
  error?: {
    message?: string
    errors?: Array<{ reason?: string }>
    details?: Array<{
      reason?: string
      metadata?: {
        service?: string
        activationUrl?: string
      }
    }>
  }
}

interface ServiceUsageOperation {
  name?: string
  done?: boolean
  error?: {
    message?: string
  }
}

export async function deployStart(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) {
    return c.json({ error: "Not logged in" }, 401)
  }

  const body = (await c.req.json()) as DeployRequest
  const { projectId, telegramToken, region, provider, botName } = body

  if (!projectId || !telegramToken || !region) {
    return c.json({ error: "Missing required fields" }, 400)
  }

  const zone = `${region}-a`
  const normalizedBotName = sanitizeBotName(botName ?? "openclaw-bot")
  const vmName = generateVmName(normalizedBotName)
  const deploymentId = crypto.randomUUID()
  const sourceImage = process.env.DEPLOY_SOURCE_IMAGE ?? DEFAULT_SOURCE_IMAGE

  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
  }

  const computeEnableWarning = await ensureComputeApiEnabled(projectId, headers)
  if (computeEnableWarning) {
    console.warn(computeEnableWarning)
  }

  // 1. Remove legacy public API firewall rule (best effort).
  try {
    await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${projectId}/global/firewalls/openclaw-allow-api`,
      {
        method: "DELETE",
        headers,
      },
    )
  } catch {
    // Rule may not exist.
  }

  // 2. Create VM
  const vmCreate = async (params: { image: string }) =>
    fetch(
      `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(
          buildInstanceRequestBody({
            zone,
            vmName,
            provider: provider ?? "claude",
            telegramToken,
            botName: normalizedBotName,
            sourceImage: params.image,
          }),
        ),
      },
    )

  const vmRes = await vmCreate({ image: sourceImage })

  if (!vmRes.ok) {
    const rawError = await vmRes.text()
    const firstErr = buildDeployErrorMessage(
      rawError,
      projectId,
      computeEnableWarning,
    )
    const status = firstErr.startsWith("Compute Engine API is disabled")
      ? 400
      : 500
    deployStore.set(deploymentId, {
      status: "error",
      error: firstErr,
      projectId,
      zone,
      vmName,
      accountId: auth.accountId,
      accessToken: auth.accessToken,
    })
    return c.json({ deploymentId, error: firstErr }, status as 400 | 500)
  }

  const operation = (await vmRes.json()) as { name: string }

  deployStore.set(deploymentId, {
    status: "creating",
    projectId,
    zone,
    vmName,
    botName: normalizedBotName,
    operationName: operation.name,
    accountId: auth.accountId,
    accessToken: auth.accessToken,
    createdAt: Date.now(),
  })

  return c.json({ deploymentId })
}

async function ensureComputeApiEnabled(
  projectId: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const enableUrl = `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/compute.googleapis.com:enable`

  try {
    const enableRes = await fetch(enableUrl, {
      method: "POST",
      headers,
    })
    if (!enableRes.ok) {
      const rawError = await enableRes.text()
      return buildEnableWarning(rawError, projectId)
    }

    const operation = (await enableRes.json()) as ServiceUsageOperation
    if (operation.done) {
      return operation.error?.message
        ? `Automatic Compute API enable request failed: ${sanitizeGoogleErrorMessage(operation.error.message)}`
        : null
    }
    if (!operation.name) {
      return null
    }

    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const pollRes = await fetch(
        `https://serviceusage.googleapis.com/v1/${operation.name}`,
        { headers },
      )
      if (!pollRes.ok) {
        continue
      }

      const poll = (await pollRes.json()) as ServiceUsageOperation
      if (!poll.done) {
        continue
      }

      return poll.error?.message
        ? `Automatic Compute API enable request failed: ${sanitizeGoogleErrorMessage(poll.error.message)}`
        : null
    }

    return "Automatic Compute API enable request was sent but is still propagating."
  } catch (error) {
    const message = sanitizeGoogleErrorMessage(
      error instanceof Error ? error.message : "unknown network error",
    )
    return `Automatic Compute API enable request failed: ${message}`
  }
}

function buildEnableWarning(rawError: string, projectId: string): string | null {
  const parsed = parseGoogleApiError(rawError)
  const message = sanitizeGoogleErrorMessage(parsed.error?.message ?? rawError)
  if (message.toLowerCase().includes("already enabled")) {
    return null
  }

  const activationUrl =
    parsed.error?.details?.find((detail) => detail.metadata?.activationUrl)
      ?.metadata?.activationUrl ??
    `https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=${projectId}`

  const permissionRelated =
    message.toLowerCase().includes("permission") ||
    message.toLowerCase().includes("insufficient authentication scopes") ||
    message.toLowerCase().includes("insufficientpermissions")

  if (permissionRelated) {
    return `Automatic Compute API enablement was skipped for project ${projectId}. Re-login to grant scope https://www.googleapis.com/auth/service.management and ensure your account can enable services (for example Service Usage Admin/Owner). Manual enable link: ${activationUrl}`
  }

  return `Automatic Compute API enable request failed for project ${projectId}: ${message}`
}

function buildDeployErrorMessage(
  rawError: string,
  projectId: string,
  enableWarning?: string | null,
): string {
  try {
    const payload = JSON.parse(rawError) as GoogleApiError
    const details = payload.error?.details ?? []
    const disabledComputeApi = details.some(
      (detail) =>
        detail.reason === "SERVICE_DISABLED" &&
        detail.metadata?.service === "compute.googleapis.com",
    )
    const notConfigured = payload.error?.errors?.some(
      (error) => error.reason === "accessNotConfigured",
    )

    if (disabledComputeApi || notConfigured) {
      const activationUrl =
        details.find((detail) => detail.metadata?.activationUrl)?.metadata
          ?.activationUrl ??
        `https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=${projectId}`

      const guidance = `Compute Engine API is disabled for project ${projectId}. Enable it at ${activationUrl}, wait 1-2 minutes, then retry deployment.`
      return enableWarning ? `${guidance} ${enableWarning}` : guidance
    }

    return sanitizeGoogleErrorMessage(payload.error?.message ?? rawError)
  } catch {
    return sanitizeGoogleErrorMessage(rawError)
  }
}

function parseGoogleApiError(rawError: string): GoogleApiError {
  try {
    return JSON.parse(rawError) as GoogleApiError
  } catch {
    return {}
  }
}
