import { describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { internalAllowlist } from "./internal-allowlist"

vi.mock("../db.js", () => ({
  getAllowlistedDomainsForIp: vi.fn(async (ip: string) => {
    if (ip === "100.64.0.10") return ["example.com", "foo.bar"]
    return []
  }),
  upsertAllowlistDomainForIp: vi.fn(async () => {}),
}))

describe("internalAllowlist", () => {
  it("rejects missing internal key", async () => {
    const app = new Hono()
    app.get("/api/internal/allowlist", internalAllowlist)

    const res = await app.request("/api/internal/allowlist?ip=1&domain=example.com")
    expect(res.status).toBe(401)
  })

  it("allows globally allowed domains", async () => {
    process.env.INTERNAL_API_KEY = "k"
    const app = new Hono()
    app.get("/api/internal/allowlist", internalAllowlist)

    const res = await app.request("/api/internal/allowlist?ip=100.64.0.10&domain=github.com", {
      headers: { "X-Internal-Key": "k" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: true })
  })

  it("allows per-ip allowlisted domains and subdomains, normalizing ports", async () => {
    process.env.INTERNAL_API_KEY = "k"
    const app = new Hono()
    app.get("/api/internal/allowlist", internalAllowlist)

    const res = await app.request("/api/internal/allowlist?ip=100.64.0.10&domain=api.example.com:443", {
      headers: { "X-Internal-Key": "k" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: true })
  })

  it("denies unknown domains", async () => {
    process.env.INTERNAL_API_KEY = "k"
    const app = new Hono()
    app.get("/api/internal/allowlist", internalAllowlist)

    const res = await app.request("/api/internal/allowlist?ip=100.64.0.10&domain=not-allowed.example", {
      headers: { "X-Internal-Key": "k" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: false })
  })
})

