// API routes for managing secure environment variables.
//
// These are called by the claw.free dashboard/mini-app to store API keys
// that should never be visible to agents. The agent only sees a placeholder
// token like CLAW_SE_ANTHROPIC_KEY, which the outbound proxy swaps with
// the real value at request time.

import type { Context } from "hono"
import { getDeployment } from "../db.js"
import {
  storeSecret,
  listSecrets,
  removeSecret,
  removeAllSecrets,
} from "../lib/secure-env.js"

/**
 * Authenticate the request and verify ownership of the deployment.
 * Supports both session-based auth (mini-app) and internal API key auth.
 */
async function authenticateDeploymentOwner(
  c: Context,
  deploymentId: string,
): Promise<{ ok: true; deployment: NonNullable<Awaited<ReturnType<typeof getDeployment>>> } | { ok: false; error: Response }> {
  const deployment = await getDeployment(deploymentId)
  if (!deployment) {
    return { ok: false, error: c.json({ error: "Deployment not found" }, 404) }
  }

  // Internal API key auth (for server-to-server calls, e.g. from bootstrap provider)
  const internalKey = process.env.INTERNAL_API_KEY
  const receivedKey = c.req.header("X-Internal-Key")
  if (internalKey && receivedKey) {
    const bufA = Buffer.from(receivedKey)
    const bufB = Buffer.from(internalKey)
    const { timingSafeEqual } = await import("node:crypto")
    if (bufA.length === bufB.length && timingSafeEqual(bufA, bufB)) {
      return { ok: true, deployment }
    }
  }

  // Relay token auth (for agent-side calls, e.g. from bootstrap provider on the VM)
  const relayAuth = c.req.header("X-Relay-Token")
  if (relayAuth && deployment.relayToken) {
    const { timingSafeEqual } = await import("node:crypto")
    const bufA = Buffer.from(relayAuth)
    const bufB = Buffer.from(deployment.relayToken)
    if (bufA.length === bufB.length && timingSafeEqual(bufA, bufB)) {
      return { ok: true, deployment }
    }
  }

  return { ok: false, error: c.json({ error: "Unauthorized" }, 401) }
}

/**
 * POST /api/deployments/:id/env
 * Store a secret for a deployment.
 *
 * Body: { name: string, value: string, allowedHosts: string[] }
 * Returns: { name, allowedHosts, placeholder }
 */
export async function secureEnvCreate(c: Context): Promise<Response> {
  const deploymentId = c.req.param("id")
  const auth = await authenticateDeploymentOwner(c, deploymentId)
  if (!auth.ok) return auth.error

  const body = await c.req.json().catch(() => null) as {
    name?: string
    value?: string
    allowedHosts?: string[]
  } | null

  if (!body?.name || typeof body.name !== "string") {
    return c.json({ error: "Missing 'name' (string)" }, 400)
  }
  if (!body.value || typeof body.value !== "string") {
    return c.json({ error: "Missing 'value' (string)" }, 400)
  }
  if (!Array.isArray(body.allowedHosts) || body.allowedHosts.length === 0) {
    return c.json({ error: "Missing 'allowedHosts' (non-empty string array)" }, 400)
  }

  // Validate name: uppercase alphanumeric + underscores only
  const name = body.name.toUpperCase()
  if (!/^[A-Z0-9_]+$/.test(name)) {
    return c.json({ error: "Name must contain only uppercase letters, digits, and underscores" }, 400)
  }

  const entry = await storeSecret(
    deploymentId,
    name,
    body.value,
    body.allowedHosts,
  )

  return c.json({
    name: entry.name,
    allowedHosts: entry.allowedHosts,
    placeholder: entry.placeholder,
  }, 201)
}

/**
 * GET /api/deployments/:id/env
 * List all secrets for a deployment (names and allowed hosts only, never values).
 */
export async function secureEnvList(c: Context): Promise<Response> {
  const deploymentId = c.req.param("id")
  const auth = await authenticateDeploymentOwner(c, deploymentId)
  if (!auth.ok) return auth.error

  const entries = await listSecrets(deploymentId)
  return c.json({
    secrets: entries.map((e) => ({
      name: e.name,
      allowedHosts: e.allowedHosts,
      placeholder: e.placeholder,
    })),
  })
}

/**
 * DELETE /api/deployments/:id/env/:name
 * Remove a secret for a deployment.
 */
export async function secureEnvDelete(c: Context): Promise<Response> {
  const deploymentId = c.req.param("id")
  const auth = await authenticateDeploymentOwner(c, deploymentId)
  if (!auth.ok) return auth.error

  const name = c.req.param("name")?.toUpperCase()
  if (!name) {
    return c.json({ error: "Missing secret name" }, 400)
  }

  await removeSecret(deploymentId, name)
  return c.json({ ok: true })
}
