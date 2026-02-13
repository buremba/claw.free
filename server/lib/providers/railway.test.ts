import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RailwayProvider, RAILWAY_API } from "./railway"

// ---------- helpers ----------

/** Build a successful Railway GraphQL JSON response. */
function gqlOk(data: unknown): Response {
  return Response.json({ data })
}

/** Build a Railway GraphQL error response (200 with errors array). */
function gqlError(message: string): Response {
  return Response.json({ errors: [{ message }] })
}

/** Build an HTTP error response (non-200). */
function httpError(status: number, body = "error"): Response {
  return new Response(body, { status })
}

// Project query response used by validateToken and createAgent
const PROJECT_DATA = {
  project: {
    name: "my-project",
    environments: {
      edges: [{ node: { id: "env-1", name: "production" } }],
    },
  },
}

// ---------- setup ----------

let provider: RailwayProvider

beforeEach(() => {
  provider = new RailwayProvider()
  // Provide valid env vars by default
  process.env.RAILWAY_API_TOKEN = "test-token-abc"
  process.env.RAILWAY_PROJECT_ID = "proj-123"
  process.env.RAILWAY_AGENT_IMAGE = "buremba/claw-free-agent:latest"
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.RAILWAY_API_TOKEN
  delete process.env.RAILWAY_PROJECT_ID
  delete process.env.RAILWAY_AGENT_IMAGE
})

// ============================
// isConfigured
// ============================

describe("isConfigured", () => {
  it("returns true when all env vars are set", () => {
    expect(provider.isConfigured()).toBe(true)
  })

  it("returns false when RAILWAY_API_TOKEN is missing", () => {
    delete process.env.RAILWAY_API_TOKEN
    expect(provider.isConfigured()).toBe(false)
  })

  it("returns false when RAILWAY_PROJECT_ID is missing", () => {
    delete process.env.RAILWAY_PROJECT_ID
    expect(provider.isConfigured()).toBe(false)
  })

  it("returns false when RAILWAY_AGENT_IMAGE is missing", () => {
    delete process.env.RAILWAY_AGENT_IMAGE
    expect(provider.isConfigured()).toBe(false)
  })
})

// ============================
// validateToken
// ============================

describe("validateToken", () => {
  it("returns status string for a valid token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(gqlOk(PROJECT_DATA))

    const result = await provider.validateToken()
    expect(result).toContain("my-project")
    expect(result).toContain("1 environment")
  })

  it("pluralizes environments correctly", async () => {
    const twoEnvs = {
      project: {
        name: "proj",
        environments: {
          edges: [
            { node: { id: "e1", name: "production" } },
            { node: { id: "e2", name: "staging" } },
          ],
        },
      },
    }
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(gqlOk(twoEnvs))

    const result = await provider.validateToken()
    expect(result).toContain("2 environments")
  })

  it("throws when RAILWAY_API_TOKEN is missing", async () => {
    delete process.env.RAILWAY_API_TOKEN
    await expect(provider.validateToken()).rejects.toThrow("RAILWAY_API_TOKEN not set")
  })

  it("throws when RAILWAY_PROJECT_ID is missing", async () => {
    delete process.env.RAILWAY_PROJECT_ID
    await expect(provider.validateToken()).rejects.toThrow("RAILWAY_PROJECT_ID not set")
  })

  it("throws on 401 unauthorized", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(httpError(401, "Unauthorized"))

    await expect(provider.validateToken()).rejects.toThrow("Railway API error (401)")
  })

  it("throws on GraphQL error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(gqlError("Invalid project ID"))

    await expect(provider.validateToken()).rejects.toThrow("Invalid project ID")
  })

  it("sends correct auth header and project ID", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(gqlOk(PROJECT_DATA))

    await provider.validateToken()

    expect(spy).toHaveBeenCalledOnce()
    const [url, init] = spy.mock.calls[0]
    expect(url).toBe(RAILWAY_API)
    expect((init as RequestInit).headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer test-token-abc" }),
    )
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.variables.id).toBe("proj-123")
  })
})

// ============================
// gql retry logic
// ============================

describe("gql retry logic", () => {
  it("does not retry on 4xx errors", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(httpError(400, "Bad Request"))

    await expect(
      provider.gql("tok", { query: "{ test }" }),
    ).rejects.toThrow("Railway API error (400)")

    // Only one attempt — no retries for 4xx
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("does not retry on GraphQL logic errors", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(gqlError("Not found"))

    await expect(
      provider.gql("tok", { query: "{ test }" }),
    ).rejects.toThrow("Not found")

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("retries on 500 errors and succeeds", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(httpError(500, "Internal Server Error"))
      .mockResolvedValueOnce(gqlOk({ ok: true }))

    const result = await provider.gql("tok", { query: "{ test }" })
    expect(result).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("retries on 502 errors", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(httpError(502, "Bad Gateway"))
      .mockResolvedValueOnce(httpError(503, "Service Unavailable"))
      .mockResolvedValueOnce(gqlOk({ done: true }))

    const result = await provider.gql("tok", { query: "{ test }" })
    expect(result).toEqual({ done: true })
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it("retries on network TypeError and succeeds", async () => {
    const networkErr = new TypeError("fetch failed")
    const spy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(gqlOk({ recovered: true }))

    const result = await provider.gql("tok", { query: "{ test }" })
    expect(result).toEqual({ recovered: true })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("retries on ECONNRESET and succeeds", async () => {
    const connErr = new Error("connect ECONNRESET")
    ;(connErr as NodeJS.ErrnoException).code = "ECONNRESET"

    const spy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(connErr)
      .mockResolvedValueOnce(gqlOk({ ok: true }))

    const result = await provider.gql("tok", { query: "{ test }" })
    expect(result).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("gives up after max retries on persistent 500", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(httpError(500, "down")))

    await expect(
      provider.gql("tok", { query: "{ test }" }),
    ).rejects.toThrow("Railway API error (500)")

    // 1 initial + 3 retries = 4 attempts
    expect(spy).toHaveBeenCalledTimes(4)
  })
})

// ============================
// createAgent
// ============================

describe("createAgent", () => {
  const input = {
    deploymentId: "dep-11111111-2222-3333-4444-555555555555",
    agentToken: "123456789:AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDD",
    agentName: "test-bot",
    agentUsername: "test_bot",
    webhookSecret: "ws-secret",
  }

  it("creates service, sets vars, creates domain, returns meta", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      // 1. serviceCreate
      .mockResolvedValueOnce(gqlOk({ serviceCreate: { id: "svc-1" } }))
      // 2. project environments
      .mockResolvedValueOnce(gqlOk(PROJECT_DATA))
      // 3-8. variableUpsert × 6
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      // 9. serviceDomainCreate
      .mockResolvedValueOnce(gqlOk({ serviceDomainCreate: { domain: "test.up.railway.app" } }))
      // 10. variableUpsert for PUBLIC_URL
      .mockResolvedValueOnce(gqlOk(true))
      // 11. deleteWebhook (Telegram)
      .mockResolvedValueOnce(Response.json({ ok: true }))

    const result = await provider.createAgent(input)

    expect(result.providerMeta.cloudProvider).toBe("railway")
    expect(result.providerMeta.railwayServiceId).toBe("svc-1")
    expect(result.providerMeta.projectId).toBe("proj-123")
    expect(result.providerMeta.vmName).toContain("agent-test-bot")

    // Verify service was created with the right image
    const createCall = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
    expect(createCall.variables.input.source.image).toBe("buremba/claw-free-agent:latest")

    // Verify domain creation happened
    const domainCall = JSON.parse(fetchSpy.mock.calls[8][1]!.body as string)
    expect(domainCall.query).toContain("serviceDomainCreate")
  })

  it("throws when no environment found", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(gqlOk({ serviceCreate: { id: "svc-1" } }))
      .mockResolvedValueOnce(gqlOk({
        project: { environments: { edges: [] } },
      }))

    await expect(provider.createAgent(input)).rejects.toThrow("No Railway environment found")
  })

  it("uses first environment when production not found", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(gqlOk({ serviceCreate: { id: "svc-1" } }))
      .mockResolvedValueOnce(gqlOk({
        project: {
          environments: {
            edges: [{ node: { id: "env-staging", name: "staging" } }],
          },
        },
      }))
      // var upserts + domain + public url + deleteWebhook
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(gqlOk({ serviceDomainCreate: { domain: "x.up.railway.app" } }))
      .mockResolvedValueOnce(gqlOk(true))
      .mockResolvedValueOnce(Response.json({ ok: true }))

    const result = await provider.createAgent(input)
    expect(result.providerMeta.railwayServiceId).toBe("svc-1")
  })
})

// ============================
// deleteAgent
// ============================

describe("deleteAgent", () => {
  it("calls serviceDelete mutation", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(gqlOk(true))

    await provider.deleteAgent({
      cloudProvider: "railway",
      projectId: "proj-123",
      vmName: "agent-test",
      vmZone: null,
      operationName: null,
      relayToken: null,
      railwayServiceId: "svc-99",
    })

    expect(spy).toHaveBeenCalledOnce()
    const body = JSON.parse(spy.mock.calls[0][1]!.body as string)
    expect(body.variables.id).toBe("svc-99")
  })

  it("does nothing when railwayServiceId is null", async () => {
    const spy = vi.spyOn(globalThis, "fetch")

    await provider.deleteAgent({
      cloudProvider: "railway",
      projectId: null,
      vmName: null,
      vmZone: null,
      operationName: null,
      relayToken: null,
      railwayServiceId: null,
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it("does nothing when token is missing", async () => {
    delete process.env.RAILWAY_API_TOKEN
    const spy = vi.spyOn(globalThis, "fetch")

    await provider.deleteAgent({
      cloudProvider: "railway",
      projectId: "proj-123",
      vmName: "agent-test",
      vmZone: null,
      operationName: null,
      relayToken: null,
      railwayServiceId: "svc-99",
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it("swallows errors gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"))

    // Should not throw
    await provider.deleteAgent({
      cloudProvider: "railway",
      projectId: "proj-123",
      vmName: "agent-test",
      vmZone: null,
      operationName: null,
      relayToken: null,
      railwayServiceId: "svc-99",
    })
  })
})
