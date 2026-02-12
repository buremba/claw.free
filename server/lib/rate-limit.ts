import type { Context, Next } from "hono"

interface Bucket {
  tokens: number
  lastRefill: number
}

const buckets = new Map<string, Bucket>()

// Clean up old buckets every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > 600_000) buckets.delete(key)
  }
}, 300_000).unref()

function getClientIp(c: Context): string {
  // Use x-real-ip if set by reverse proxy, otherwise use x-forwarded-for.
  //
  // NOTE: In most deployments (Railway, nginx, Cloudflare), the proxy sets
  // and/or overwrites these headers and the leftmost x-forwarded-for value is
  // the original client. If you run the server directly on the internet,
  // x-forwarded-for is client-spoofable.
  const realIp = c.req.header("x-real-ip")
  if (realIp) return realIp

  const xff = c.req.header("x-forwarded-for")
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean)
    // Leftmost is the original client in the common proxy convention.
    return parts[0] ?? "unknown"
  }

  return "unknown"
}

export function rateLimit(maxRequests: number, windowMs: number) {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c)
    const key = `${ip}:${c.req.path}`
    const now = Date.now()

    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: maxRequests, lastRefill: now }
      buckets.set(key, bucket)
    }

    const elapsed = now - bucket.lastRefill
    const refill = Math.floor((elapsed / windowMs) * maxRequests)
    if (refill > 0) {
      bucket.tokens = Math.min(maxRequests, bucket.tokens + refill)
      bucket.lastRefill = now
    }

    if (bucket.tokens <= 0) {
      return c.json({ error: "Too many requests" }, 429)
    }

    bucket.tokens--
    await next()
  }
}
