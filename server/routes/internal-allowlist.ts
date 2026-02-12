import type { Context } from "hono"
import { timingSafeEqual } from "node:crypto"

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

export async function internalAllowlist(c: Context): Promise<Response> {
  const internalKey = process.env.INTERNAL_API_KEY
  const receivedKey = c.req.header("X-Internal-Key")
  if (!internalKey || !receivedKey || !timingSafeEqual(Buffer.from(receivedKey), Buffer.from(internalKey))) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  const ip = c.req.query("ip")
  const domain = c.req.query("domain")

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

  // TODO: Per-bot allowlist from database
  // Future: look up deployment by overlay IP → check bot-specific allowed domains

  return c.json({ allowed: false })
}
