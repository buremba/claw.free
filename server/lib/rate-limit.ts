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
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  )
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
