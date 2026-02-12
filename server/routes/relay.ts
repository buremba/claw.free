import type { Context } from "hono"
import { timingSafeEqual } from "node:crypto"
import { getDeployment } from "../db.js"
import {
  forwardViaTunnel,
  isTunnelConnected,
  getTunnelStats,
} from "../lib/relay.js"

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * Webhook receiver — Telegram sends webhooks here.
 * POST /relay/hook/:deploymentId
 *
 * Validates X-Telegram-Bot-Api-Secret-Token against the stored webhook_secret
 * before forwarding through the tunnel.
 */
export async function relayWebhook(c: Context): Promise<Response> {
  const deploymentId = c.req.param("deploymentId")

  const deployment = await getDeployment(deploymentId)
  if (!deployment) {
    return c.json({ error: "Unknown deployment" }, 404)
  }

  // Validate webhook secret — Telegram includes this header on every webhook call
  // when secret_token was set via setWebhook. Prevents spoofed webhook requests.
  const receivedSecret = c.req.header("x-telegram-bot-api-secret-token")
  if (deployment.webhookSecret) {
    if (!receivedSecret || !safeEqual(receivedSecret, deployment.webhookSecret)) {
      return c.json({ error: "Invalid webhook secret" }, 403)
    }
  }

  if (!isTunnelConnected(deploymentId)) {
    // 503 = service temporarily unavailable (bot is booting or reconnecting).
    // Telegram retries 503s. 502 would imply our infrastructure is broken.
    return c.json({ error: "Bot not connected" }, 503)
  }

  // Forward the entire HTTP request through the tunnel
  const body = await c.req.text()
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => {
    if (key.startsWith("content-") || key === "x-telegram-bot-api-secret-token") {
      headers[key] = value
    }
  })

  const response = await forwardViaTunnel(deploymentId, {
    method: c.req.method,
    path: "/webhook",
    headers,
    body,
  })

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

/**
 * Relay status endpoint — shows connected tunnels.
 * GET /relay/status
 * Requires X-Internal-Key header when INTERNAL_API_KEY is set.
 */
export async function relayStatus(c: Context): Promise<Response> {
  const internalKey = process.env.INTERNAL_API_KEY
  // Require key if configured; deny if not configured (don't expose by default)
  const receivedKey = c.req.header("X-Internal-Key")
  if (!internalKey || !receivedKey || !safeEqual(receivedKey, internalKey)) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  const stats = getTunnelStats()
  return c.json(stats)
}
