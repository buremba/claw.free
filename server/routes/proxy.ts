// Generic outbound proxy with automatic secret injection.
//
// Inspired by Deno Sandbox's placeholder-token pattern and Fly Tokenizer.
// This proxy is GENERIC — it works for any HTTP API, not just specific
// LLM providers. It detects placeholder tokens in ANY request header and
// swaps them with real secrets on the fly.
//
// URL format:  /proxy/<scheme>/<host>/<path>
// Example:     /proxy/https/api.anthropic.com/v1/messages
//
// The agent configures its API base URLs to point through this proxy:
//   baseUrl: "https://claw.free/proxy/https/api.anthropic.com"
//   apiKey:  "CLAW_SE_ANTHROPIC_KEY"   ← placeholder, not a real key
//
// The proxy:
//   1. Authenticates the agent (Proxy-Authorization or X-Relay-Token)
//   2. Extracts the target URL from the path
//   3. Scans ALL request headers for CLAW_SE_* placeholder patterns
//   4. Resolves each placeholder to the real encrypted secret
//   5. Validates the target host is in the secret's allowed-hosts list
//   6. Replaces the placeholder with the real value
//   7. Forwards the request to the upstream service
//   8. Streams the response back to the agent
//
// Security properties:
//   - Agent never sees real API keys (only placeholders)
//   - Placeholders are useless outside this proxy (upstream rejects them)
//   - Host restrictions prevent exfiltration (secret X only works for host Y)
//   - Each deployment has its own isolated set of secrets

import type { Context } from "hono"
import { timingSafeEqual } from "node:crypto"
import { getDeploymentByRelayToken, getDeployment } from "../db.js"
import { swapHeaderSecrets } from "../lib/secure-env.js"

const PROXY_TIMEOUT_MS = 120_000 // 2 minutes (LLM responses can be slow)

// Headers that should not be forwarded to upstream
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "x-relay-token", "x-deployment-id",
])

// Maximum request body size (10 MB)
const MAX_BODY_SIZE = 10 * 1024 * 1024

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * Authenticate the request and return the deployment ID.
 * Supports relay token auth (agent-side).
 */
async function authenticateProxy(c: Context): Promise<string | null> {
  // Primary: X-Relay-Token header (same token the relay tunnel uses)
  const relayToken = c.req.header("X-Relay-Token")
  if (relayToken) {
    const deployment = await getDeploymentByRelayToken(relayToken)
    if (deployment) return deployment.id
  }

  // Fallback: Proxy-Authorization header with relay token
  const proxyAuth = c.req.header("Proxy-Authorization")
  if (proxyAuth) {
    const match = proxyAuth.match(/^Bearer\s+(.+)$/i)
    if (match) {
      const deployment = await getDeploymentByRelayToken(match[1])
      if (deployment) return deployment.id
    }
  }

  return null
}

/**
 * Parse the proxy target URL from the request path.
 * /proxy/https/api.anthropic.com/v1/messages → https://api.anthropic.com/v1/messages
 */
function parseTargetUrl(c: Context): { url: string; host: string; scheme: string } | null {
  const fullPath = c.req.path
  // Match: /proxy/<scheme>/<host>/<rest...>
  const match = fullPath.match(/^\/proxy\/(https?)\/([\w.-]+(?::\d+)?)(\/.*)?$/)
  if (!match) return null

  const scheme = match[1]
  const host = match[2]
  const path = match[3] ?? "/"
  const queryString = new URL(c.req.url).search

  return {
    url: `${scheme}://${host}${path}${queryString}`,
    host,
    scheme,
  }
}

/**
 * Build upstream headers from the incoming request, stripping hop-by-hop
 * headers and setting the correct Host.
 */
function buildUpstreamHeaders(
  incomingHeaders: Headers,
  targetHost: string,
): Record<string, string> {
  const headers: Record<string, string> = {}

  incomingHeaders.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lower) && lower !== "host") {
      headers[key] = value
    }
  })

  headers["host"] = targetHost
  return headers
}

/**
 * Generic proxy handler — matches all methods on /proxy/*
 *
 * ALL /proxy/:scheme/:host/* requests route here.
 */
export async function proxyHandler(c: Context): Promise<Response> {
  // 1. Authenticate
  const deploymentId = await authenticateProxy(c)
  if (!deploymentId) {
    return c.json({ error: "Unauthorized — provide X-Relay-Token or Proxy-Authorization header" }, 401)
  }

  // 2. Parse target URL
  const target = parseTargetUrl(c)
  if (!target) {
    return c.json({
      error: "Invalid proxy URL. Format: /proxy/<scheme>/<host>/<path>",
      example: "/proxy/https/api.anthropic.com/v1/messages",
    }, 400)
  }

  // 3. Build upstream headers
  const upstreamHeaders = buildUpstreamHeaders(c.req.raw.headers, target.host)

  // 4. Scan and swap placeholder secrets in headers
  const { headers: resolvedHeaders, blocked } = await swapHeaderSecrets(
    deploymentId,
    upstreamHeaders,
    target.host,
  )

  if (blocked.length > 0) {
    return c.json({
      error: "Secret resolution failed",
      details: `The following secrets could not be resolved for host "${target.host}": ${blocked.join(", ")}. ` +
        "Either the secret doesn't exist or the target host is not in the secret's allowed-hosts list.",
    }, 403)
  }

  // 5. Forward request to upstream
  const method = c.req.method
  const hasBody = method !== "GET" && method !== "HEAD"

  const fetchInit: RequestInit & { duplex?: string } = {
    method,
    headers: resolvedHeaders,
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  }

  if (hasBody) {
    fetchInit.body = c.req.raw.body
    fetchInit.duplex = "half"
  }

  try {
    const upstream = await fetch(target.url, fetchInit)

    // 6. Stream response back — pass through status, headers, and body
    const responseHeaders = new Headers()
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      // Don't forward hop-by-hop or encoding headers (our runtime handles these)
      if (!HOP_BY_HOP_HEADERS.has(lower)) {
        responseHeaders.set(key, value)
      }
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"

    if (message.includes("timeout") || message.includes("abort")) {
      return c.json({ error: `Upstream request timed out (${PROXY_TIMEOUT_MS / 1000}s)` }, 504)
    }

    return c.json({ error: `Failed to reach upstream: ${message}` }, 502)
  }
}
