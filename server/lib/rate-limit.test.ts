import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { rateLimit } from "./rate-limit"

describe("rateLimit", () => {
  it("uses the leftmost x-forwarded-for entry as client IP", async () => {
    const app = new Hono()
    app.get("/ip", rateLimit(1, 60_000), (c) => c.text("ok"))

    // Two different clients behind same proxy chain should not share the bucket.
    const r1 = await app.request("/ip", {
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
    })
    const r2 = await app.request("/ip", {
      headers: { "x-forwarded-for": "3.3.3.3, 2.2.2.2" },
    })

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
  })

  it("allows requests under the limit", async () => {
    const app = new Hono()
    app.get("/test", rateLimit(3, 60_000), (c) => c.text("ok"))

    const res1 = await app.request("/test")
    const res2 = await app.request("/test")
    const res3 = await app.request("/test")
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(res3.status).toBe(200)
  })

  it("blocks requests over the limit", async () => {
    const app = new Hono()
    app.get("/limited", rateLimit(2, 60_000), (c) => c.text("ok"))

    await app.request("/limited")
    await app.request("/limited")
    const res = await app.request("/limited")
    expect(res.status).toBe(429)
  })
})
