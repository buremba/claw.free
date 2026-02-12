import type { Context } from "hono"
import { timingSafeEqual } from "node:crypto"
import { getAllowlistedDomainsForIp, upsertAllowlistDomainForIp } from "../db.js"

// Static allowlist of domains all bots can access (beyond Telegram + LLM APIs
// which are handled directly in Squid config).
// This endpoint is called by the gateway's Squid external_acl helper.
const GLOBAL_ALLOWED_DOMAINS = [
  // Package registries (for skill installation)
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  // GitHub (for skill repos)
  "github.com",
  "raw.githubusercontent.com",
  "api.github.com",
]

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null

  // Squid %DST is typically a domain, but be defensive:
  // - strip port if present
  // - strip trailing dot
  const withoutPort = trimmed.replace(/:\d+$/, "")
  const withoutTrailingDot = withoutPort.replace(/\.$/, "")

  // Allow basic DNS name characters only.
  if (!/^[a-z0-9.-]+$/.test(withoutTrailingDot)) return null
  if (!withoutTrailingDot.includes(".")) return null

  return withoutTrailingDot
}

export async function internalAllowlist(c: Context): Promise<Response> {
  const internalKey = process.env.INTERNAL_API_KEY
  const receivedKey = c.req.header("X-Internal-Key")
  if (!internalKey || !receivedKey || !safeEqual(receivedKey, internalKey)) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  const ip = c.req.query("ip")
  const domainRaw = c.req.query("domain")

  const domain = domainRaw ? normalizeDomain(domainRaw) : null

  if (!ip || !domain) {
    return c.json({ error: "Missing ip or domain parameter" }, 400)
  }

  // Check global allowlist
  const isGlobalAllowed = GLOBAL_ALLOWED_DOMAINS.some(
    (d) => domain === d || domain.endsWith(`.${d}`),
  )

  if (isGlobalAllowed) {
    return c.json({ allowed: true })
  }

  // Per-bot allowlist from database (keyed by overlay src IP).
  const allowedDomains = await getAllowlistedDomainsForIp(ip)
  const isAllowed = allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`))
  if (isAllowed) return c.json({ allowed: true })

  return c.json({ allowed: false })
}

// Internal management: allow a domain for an overlay IP.
// POST /api/internal/allowlist {"ip":"100.64.x.x","domain":"example.com"}
export async function internalAllowlistUpsert(c: Context): Promise<Response> {
  const internalKey = process.env.INTERNAL_API_KEY
  const receivedKey = c.req.header("X-Internal-Key")
  if (!internalKey || !receivedKey || !safeEqual(receivedKey, internalKey)) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  const body = (await c.req.json().catch(() => null)) as { ip?: string; domain?: string } | null
  const ip = body?.ip?.trim()
  const domain = body?.domain ? normalizeDomain(body.domain) : null
  if (!ip || !domain) return c.json({ error: "Missing ip or domain" }, 400)

  await upsertAllowlistDomainForIp(ip, domain)
  return c.json({ ok: true })
}
