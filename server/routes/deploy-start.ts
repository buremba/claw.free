import type { Context } from "hono"
import { deployStore } from "../deploy-store.js"
import { resolveGoogleAuth } from "../lib/google-auth.js"
import {
  DEFAULT_STARTUP_SCRIPT_URL,
  DEFAULT_SOURCE_IMAGE,
  FALLBACK_SOURCE_IMAGE,
  buildInstanceRequestBody,
  generateVmName,
  sanitizeBotName,
  shouldFallbackToDebian,
} from "../lib/deploy.js"

interface DeployRequest {
  projectId: string
  telegramToken: string
  region: string
  provider: string
  botName?: string
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
  let sourceImage = process.env.DEPLOY_SOURCE_IMAGE ?? DEFAULT_SOURCE_IMAGE

  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
  }

  // 1. Enable Compute Engine API and wait for it to propagate
  try {
    const enableRes = await fetch(
      `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/compute.googleapis.com:enable`,
      { method: "POST", headers },
    )
    if (enableRes.ok) {
      const op = (await enableRes.json()) as { name?: string; done?: boolean }
      if (op.name && !op.done) {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          const pollRes = await fetch(
            `https://serviceusage.googleapis.com/v1/${op.name}`,
            { headers },
          )
          if (pollRes.ok) {
            const pollData = (await pollRes.json()) as { done?: boolean }
            if (pollData.done) break
          }
        }
      }
    }
  } catch {
    // May already be enabled
  }

  // 2. Remove legacy public API firewall rule (best effort).
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

  // 3. Create VM
  const vmCreate = async (params: {
    image: string
    startupScriptUrl?: string
  }) =>
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
            startupScriptUrl: params.startupScriptUrl,
          }),
        ),
      },
    )

  let vmRes = await vmCreate({ image: sourceImage })

  if (!vmRes.ok) {
    const firstErr = await vmRes.text()
    if (shouldFallbackToDebian(firstErr)) {
      sourceImage = FALLBACK_SOURCE_IMAGE
      const fallbackScriptUrl =
        process.env.STARTUP_SCRIPT_URL ?? DEFAULT_STARTUP_SCRIPT_URL
      vmRes = await vmCreate({
        image: sourceImage,
        startupScriptUrl: fallbackScriptUrl,
      })
      if (!vmRes.ok) {
        const fallbackErr = await vmRes.text()
        const err = `${firstErr}\n\nFallback error:\n${fallbackErr}`
        deployStore.set(deploymentId, {
          status: "error",
          error: err,
          projectId,
          zone,
          vmName,
          accountId: auth.accountId,
          accessToken: auth.accessToken,
        })
        return c.json({ deploymentId, error: err }, 500)
      }
    } else {
      deployStore.set(deploymentId, {
        status: "error",
        error: firstErr,
        projectId,
        zone,
        vmName,
        accountId: auth.accountId,
        accessToken: auth.accessToken,
      })
      return c.json({ deploymentId, error: firstErr }, 500)
    }
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
