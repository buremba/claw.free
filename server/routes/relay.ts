import type { Context } from "hono"
import { getDeployment } from "../db.js"
import {
  forwardViaTunnel,
  isTunnelConnected,
  getTunnelStats,
} from "../lib/relay.js"

/**
 * Webhook receiver — Telegram sends webhooks here.
 * POST /relay/hook/:deploymentId
 */
export async function relayWebhook(c: Context): Promise<Response> {
  const deploymentId = c.req.param("deploymentId")

  const deployment = await getDeployment(deploymentId)
  if (!deployment) {
    return c.json({ error: "Unknown deployment" }, 404)
  }

  if (!isTunnelConnected(deploymentId)) {
    // Telegram will retry — return 502 so it knows to try again
    return c.json({ error: "Bot not connected" }, 502)
  }

  // Forward the entire HTTP request through the tunnel
  const body = await c.req.text()
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => {
    // Only forward relevant headers
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
 */
export async function relayStatus(c: Context): Promise<Response> {
  const internalKey = process.env.INTERNAL_API_KEY
  if (internalKey && c.req.header("X-Internal-Key") !== internalKey) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  const stats = getTunnelStats()
  return c.json(stats)
}
