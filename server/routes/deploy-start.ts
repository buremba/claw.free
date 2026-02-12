import type { Context } from "hono"
import { createDeployment } from "../db.js"
import { sanitizeGoogleErrorMessage } from "../lib/google-error.js"
import { resolveGoogleAuth } from "../lib/google-auth.js"
import {
  DEFAULT_SOURCE_IMAGE,
  buildInstanceRequestBody,
  generateVmName,
  sanitizeBotName,
} from "../lib/deploy.js"
import {
  createBotPreAuthKey,
  isHeadscaleConfigured,
} from "../lib/headscale.js"

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
      metadata?: { service?: string; activationUrl?: string }
    }>
  }
}

export async function deployStart(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) return c.json({ error: "Not logged in" }, 401)

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

  // Best-effort: remove legacy firewall rule
  try {
    await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${projectId}/global/firewalls/openclaw-allow-api`,
      { method: "DELETE", headers },
    )
  } catch { /* may not exist */ }

  // Generate overlay network pre-auth key (if Headscale is configured)
  let tailscaleAuthKey: string | undefined
  if (isHeadscaleConfigured()) {
    try {
      tailscaleAuthKey = await createBotPreAuthKey()
    } catch (err) {
      console.error("Failed to create overlay pre-auth key:", err)
    }
  }

  // Generate relay tunnel token + webhook secret (Railway-native connectivity)
  const relayToken = crypto.randomUUID()
  const webhookSecret = crypto.randomUUID()
  const relayUrl = process.env.RELAY_URL ?? process.env.BASE_URL

  const vmRes = await fetch(
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
          sourceImage,
          tailscaleAuthKey,
          headscaleUrl: process.env.HEADSCALE_URL,
          relayUrl,
          relayToken,
        }),
      ),
    },
  )

  if (!vmRes.ok) {
    const rawError = await vmRes.text()
    const errorMsg = buildDeployErrorMessage(rawError, projectId)
    try {
      await createDeployment({
        id: deploymentId, userId: auth.session.userId,
        botUsername: null, cloudProvider: "gcp",
        projectId, vmName, vmZone: zone, operationName: null,
        status: "error",
      })
    } catch { /* best effort */ }
    const status = errorMsg.startsWith("Compute Engine API is disabled") ? 400 : 500
    return c.json({ deploymentId, error: errorMsg }, status as 400 | 500)
  }

  const operation = (await vmRes.json()) as { name: string }

  await createDeployment({
    id: deploymentId, userId: auth.session.userId,
    botUsername: null, cloudProvider: "gcp",
    projectId, vmName, vmZone: zone,
    operationName: operation.name, status: "creating",
    relayToken,
    webhookSecret,
  })

  // Set Telegram webhook with secret token for signature verification
  if (relayUrl) {
    const webhookUrl = `${relayUrl}/relay/hook/${deploymentId}`
    try {
      await fetch(
        `https://api.telegram.org/bot${telegramToken}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
        },
      )
    } catch (err) {
      console.error("Failed to set Telegram webhook:", err)
    }
  }

  return c.json({ deploymentId })
}

function buildDeployErrorMessage(rawError: string, projectId: string): string {
  try {
    const payload = JSON.parse(rawError) as GoogleApiError
    const details = payload.error?.details ?? []
    const disabledComputeApi = details.some(
      (d) => d.reason === "SERVICE_DISABLED" && d.metadata?.service === "compute.googleapis.com",
    )
    const notConfigured = payload.error?.errors?.some(
      (e) => e.reason === "accessNotConfigured",
    )

    if (disabledComputeApi || notConfigured) {
      const activationUrl =
        details.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl ??
        `https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=${projectId}`
      return `Compute Engine API is disabled for project ${projectId}. Enable it at ${activationUrl}, wait 1-2 minutes, then retry deployment.`
    }

    return sanitizeGoogleErrorMessage(payload.error?.message ?? rawError)
  } catch {
    return sanitizeGoogleErrorMessage(rawError)
  }
}
