import type { Context } from "hono"
import { getMiniAuth } from "./mini-auth.js"
import {
  getDeploymentsByUserId,
  getDeployment,
  createDeployment,
  deleteDeployment,
} from "../db.js"
import { validateBotToken, isValidBotToken } from "../lib/telegram.js"
import {
  DEFAULT_SOURCE_IMAGE,
  buildInstanceRequestBody,
  generateVmName,
  sanitizeBotName,
} from "../lib/deploy.js"
import {
  createBotPreAuthKey,
  deleteNode,
  findNodeByHostname,
  isHeadscaleConfigured,
} from "../lib/headscale.js"

const MAX_BOT_NAME_LENGTH = 255

export async function miniListBots(c: Context): Promise<Response> {
  const auth = getMiniAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const deployments = await getDeploymentsByUserId(auth.userId)
  return c.json({
    bots: deployments.map((d) => ({
      id: d.id,
      botUsername: d.botUsername,
      status: d.status,
      vmIp: d.vmIp,
      error: d.error,
      createdAt: d.createdAt,
    })),
  })
}

export async function miniGetBot(c: Context): Promise<Response> {
  const auth = getMiniAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const deployment = await getDeployment(c.req.param("id"))
  if (!deployment || deployment.userId !== auth.userId) {
    return c.json({ error: "Not found" }, 404)
  }

  return c.json({
    id: deployment.id,
    botUsername: deployment.botUsername,
    status: deployment.status,
    vmIp: deployment.vmIp,
    vmName: deployment.vmName,
    error: deployment.error,
    createdAt: deployment.createdAt,
  })
}

interface CreateBotRequest {
  botToken: string
  botName?: string
}

export async function miniCreateBot(c: Context): Promise<Response> {
  const auth = getMiniAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const body = (await c.req.json()) as CreateBotRequest
  const { botToken, botName } = body

  if (!botToken) {
    return c.json({ error: "Missing bot token" }, 400)
  }

  if (!isValidBotToken(botToken)) {
    return c.json({ error: "Invalid bot token format" }, 400)
  }

  // Validate bot token with Telegram
  const botInfo = await validateBotToken(botToken)
  if (!botInfo) {
    return c.json({ error: "Bot token is invalid or revoked" }, 400)
  }

  // For Mode A (platform GCP), we use our service account
  const gcpKey = process.env.GCP_SERVICE_ACCOUNT_KEY
  const gcpProject = process.env.GCP_PROJECT_ID
  if (!gcpKey || !gcpProject) {
    return c.json({ error: "Platform deployment not configured" }, 500)
  }

  const botNameRaw = botName ?? botInfo.username ?? "openclaw-bot"
  if (botNameRaw.length > MAX_BOT_NAME_LENGTH) {
    return c.json({ error: "Bot name too long" }, 400)
  }
  const normalizedBotName = sanitizeBotName(botNameRaw)
  const vmName = generateVmName(normalizedBotName)
  const deploymentId = crypto.randomUUID()
  const zone = "us-central1-a"
  const sourceImage = process.env.DEPLOY_SOURCE_IMAGE ?? DEFAULT_SOURCE_IMAGE

  // Get access token from service account
  const accessToken = await getServiceAccountToken(gcpKey)
  if (!accessToken) {
    return c.json({ error: "Failed to authenticate with cloud provider" }, 500)
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  }

  // Generate overlay network pre-auth key (if Headscale is configured)
  let tailscaleAuthKey: string | undefined
  if (isHeadscaleConfigured()) {
    try {
      tailscaleAuthKey = await createBotPreAuthKey()
    } catch (err) {
      console.error("Failed to create overlay pre-auth key:", err)
    }
  }

  // Generate relay tunnel token (Railway-native connectivity)
  const relayToken = crypto.randomUUID()
  const relayUrl = process.env.RELAY_URL ?? process.env.BASE_URL

  const instanceBody = buildInstanceRequestBody({
    zone,
    vmName,
    provider: "claude",
    telegramToken: botToken,
    botName: normalizedBotName,
    sourceImage,
    tailscaleAuthKey,
    headscaleUrl: process.env.HEADSCALE_URL,
    relayUrl,
    relayToken,
  })

  const vmRes = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${gcpProject}/zones/${zone}/instances`,
    { method: "POST", headers, body: JSON.stringify(instanceBody) },
  )

  if (!vmRes.ok) {
    const err = await vmRes.text()
    return c.json({ error: `VM creation failed: ${err.slice(0, 200)}` }, 500)
  }

  const operation = (await vmRes.json()) as { name: string }

  await createDeployment({
    id: deploymentId,
    userId: auth.userId,
    botUsername: botInfo.username,
    projectId: gcpProject,
    vmName,
    vmZone: zone,
    operationName: operation.name,
    status: "creating",
    relayToken,
  })

  // Set Telegram webhook URL to point to our relay endpoint.
  // Telegram will POST updates here → relay forwards via WebSocket tunnel → bot VM.
  if (relayUrl) {
    const webhookUrl = `${relayUrl}/relay/hook/${deploymentId}`
    try {
      await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl }),
        },
      )
    } catch (err) {
      console.error("Failed to set Telegram webhook:", err)
    }
  }

  return c.json({ deploymentId, botUsername: botInfo.username })
}

export async function miniDeleteBot(c: Context): Promise<Response> {
  const auth = getMiniAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const deployment = await getDeployment(c.req.param("id"))
  if (!deployment || deployment.userId !== auth.userId) {
    return c.json({ error: "Not found" }, 404)
  }

  // Remove from overlay network (best effort)
  if (isHeadscaleConfigured() && deployment.vmName) {
    try {
      const node = await findNodeByHostname(deployment.vmName)
      if (node) await deleteNode(node.nodeId)
    } catch { /* best effort */ }
  }

  // Delete GCP VM if it exists
  if (deployment.vmName && deployment.projectId && deployment.vmZone) {
    const gcpKey = process.env.GCP_SERVICE_ACCOUNT_KEY
    if (gcpKey) {
      const accessToken = await getServiceAccountToken(gcpKey)
      if (accessToken) {
        try {
          await fetch(
            `https://compute.googleapis.com/compute/v1/projects/${deployment.projectId}/zones/${deployment.vmZone}/instances/${deployment.vmName}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${accessToken}` },
            },
          )
        } catch { /* best effort */ }
      }
    }
  }

  await deleteDeployment(deployment.id)
  return c.json({ ok: true })
}

export async function miniValidateToken(c: Context): Promise<Response> {
  const auth = getMiniAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const body = (await c.req.json()) as { token?: string }
  if (!body.token) return c.json({ error: "Missing token" }, 400)

  if (!isValidBotToken(body.token)) {
    return c.json({ error: "Invalid token format" }, 400)
  }

  const botInfo = await validateBotToken(body.token)
  if (!botInfo) {
    return c.json({ error: "Token is invalid or revoked" }, 400)
  }

  return c.json({
    valid: true,
    bot: { id: botInfo.id, username: botInfo.username, name: botInfo.first_name },
  })
}

async function getServiceAccountToken(keyJson: string): Promise<string | null> {
  try {
    const key = JSON.parse(keyJson) as {
      client_email: string
      private_key: string
      token_uri: string
    }

    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({
        iss: key.client_email,
        scope: "https://www.googleapis.com/auth/compute",
        aud: key.token_uri,
        iat: now,
        exp: now + 3600,
      }),
    ).toString("base64url")

    const { createSign } = await import("node:crypto")
    const signer = createSign("RSA-SHA256")
    signer.update(`${header}.${payload}`)
    const signature = signer.sign(key.private_key, "base64url")

    const jwt = `${header}.${payload}.${signature}`

    const res = await fetch(key.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    })

    if (!res.ok) return null
    const data = (await res.json()) as { access_token: string }
    return data.access_token
  } catch {
    return null
  }
}
