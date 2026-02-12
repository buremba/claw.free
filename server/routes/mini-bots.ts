import type { Context } from "hono"
import { getMiniAuth } from "./mini-auth.js"
import {
  getDeploymentsByUserId,
  getDeployment,
  createDeployment,
  deleteDeployment,
} from "../db.js"
import { validateBotToken, isValidBotToken } from "../lib/telegram.js"
import { sanitizeBotName } from "../lib/deploy.js"
import { getProvider, hasProvider } from "../lib/providers/index.js"

const MAX_AGENT_NAME_LENGTH = 255

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

interface CreateAgentRequest {
  botToken: string
  botName?: string
}

export async function miniCreateBot(c: Context): Promise<Response> {
  const auth = getMiniAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  if (!hasProvider()) {
    return c.json({ error: "No agent provider configured" }, 500)
  }

  const body = (await c.req.json()) as CreateAgentRequest
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

  const agentNameRaw = botName ?? botInfo.username ?? "openclaw-agent"
  if (agentNameRaw.length > MAX_AGENT_NAME_LENGTH) {
    return c.json({ error: "Agent name too long" }, 400)
  }

  const deploymentId = crypto.randomUUID()
  const webhookSecret = crypto.randomUUID()

  // Use the configured provider (Railway or GCP)
  const provider = getProvider()
  let result
  try {
    result = await provider.createAgent({
      deploymentId,
      agentToken: botToken,
      agentName: sanitizeBotName(agentNameRaw),
      agentUsername: botInfo.username,
      webhookSecret,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: `Agent creation failed: ${msg.slice(0, 200)}` }, 500)
  }

  const { providerMeta: meta } = result

  await createDeployment({
    id: deploymentId,
    userId: auth.userId,
    botUsername: botInfo.username,
    cloudProvider: meta.cloudProvider,
    projectId: meta.projectId,
    vmName: meta.vmName,
    vmZone: meta.vmZone,
    operationName: meta.operationName,
    status: "creating",
    relayToken: meta.relayToken,
    webhookSecret,
    railwayServiceId: meta.railwayServiceId,
  })

  // Set Telegram webhook URL with secret token for signature verification.
  // Telegram includes X-Telegram-Bot-Api-Secret-Token header on every webhook.
  const webhookUrl = result.webhookUrl
    ?? (process.env.RELAY_URL ?? process.env.BASE_URL
      ? `${process.env.RELAY_URL ?? process.env.BASE_URL}/relay/hook/${deploymentId}`
      : null)

  if (webhookUrl) {
    try {
      await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
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

  return c.json({ deploymentId, botUsername: botInfo.username })
}

export async function miniDeleteBot(c: Context): Promise<Response> {
  const auth = getMiniAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const deployment = await getDeployment(c.req.param("id"))
  if (!deployment || deployment.userId !== auth.userId) {
    return c.json({ error: "Not found" }, 404)
  }

  // Use the provider abstraction to tear down the agent
  if (hasProvider()) {
    try {
      const provider = getProvider()
      await provider.deleteAgent({
        cloudProvider: deployment.cloudProvider,
        projectId: deployment.projectId,
        vmName: deployment.vmName,
        vmZone: deployment.vmZone,
        operationName: deployment.operationName,
        relayToken: deployment.relayToken,
        railwayServiceId: deployment.railwayServiceId,
      })
    } catch { /* best effort */ }
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
