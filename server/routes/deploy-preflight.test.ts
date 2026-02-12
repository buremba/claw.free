import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveGoogleAuthMock = vi.fn()

vi.mock("../lib/google-auth.js", () => ({
  resolveGoogleAuth: (...args: unknown[]) => resolveGoogleAuthMock(...args),
}))

import { deployPreflight } from "./deploy-preflight.js"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("deployPreflight", () => {
  beforeEach(() => {
    resolveGoogleAuthMock.mockReset()
    resolveGoogleAuthMock.mockResolvedValue({
      session: { userId: "u1", accountId: "a1" },
      accessToken: "token-123",
      accountId: "a1",
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns reconnect blocker when service.management scope is missing", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          scope: "openid email https://www.googleapis.com/auth/compute",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 403,
              message: "Compute Engine API has not been used in project test.",
              errors: [{ reason: "accessNotConfigured" }],
              details: [
                {
                  reason: "SERVICE_DISABLED",
                  metadata: {
                    service: "compute.googleapis.com",
                    activationUrl:
                      "https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=test-proj",
                  },
                },
              ],
            },
          },
          403,
        ),
      )

    const app = new Hono()
    app.post("/api/deploy/preflight", deployPreflight)
    const res = await app.request("/api/deploy/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "test-proj" }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      ok: boolean
      blocker?: { actionKind?: string; type?: string }
    }
    expect(data.ok).toBe(false)
    expect(data.blocker?.type).toBe("missing_scope")
    expect(data.blocker?.actionKind).toBe("reconnect_service_management")
  })

  it("auto-enables Compute API and returns ready when scopes and IAM allow it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          scope:
            "openid email https://www.googleapis.com/auth/compute https://www.googleapis.com/auth/service.management",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 403,
              message: "Compute Engine API disabled.",
              errors: [{ reason: "accessNotConfigured" }],
              details: [
                {
                  reason: "SERVICE_DISABLED",
                  metadata: { service: "compute.googleapis.com" },
                },
              ],
            },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ done: true }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }))

    const app = new Hono()
    app.post("/api/deploy/preflight", deployPreflight)
    const res = await app.request("/api/deploy/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "test-proj" }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      ok: boolean
      checks: { autoEnableAttempted: boolean; computeApiEnabled: boolean }
    }
    expect(data.ok).toBe(true)
    expect(data.checks.autoEnableAttempted).toBe(true)
    expect(data.checks.computeApiEnabled).toBe(true)
  })

  it("returns MFA blocker when Google requires 2-step verification", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          scope: "openid email https://www.googleapis.com/auth/compute",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 403,
              message:
                "Google Cloud has begun to enforce 2-step verification for this account.",
            },
          },
          403,
        ),
      )

    const app = new Hono()
    app.post("/api/deploy/preflight", deployPreflight)
    const res = await app.request("/api/deploy/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "test-proj" }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      ok: boolean
      blocker?: { type?: string; actionKind?: string; actionUrl?: string }
    }
    expect(data.ok).toBe(false)
    expect(data.blocker?.type).toBe("mfa_required")
    expect(data.blocker?.actionKind).toBe("open_url")
    expect(data.blocker?.actionUrl).toBe("https://myaccount.google.com/security")
  })

  it("strips Help Token from service-disabled blocker messages", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          scope:
            "openid email https://www.googleapis.com/auth/compute https://www.googleapis.com/auth/service.management",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 403,
              message:
                "Compute Engine API has not been used in project test-proj before or it is disabled.",
              errors: [{ reason: "accessNotConfigured" }],
              details: [
                {
                  reason: "SERVICE_DISABLED",
                  metadata: { service: "compute.googleapis.com" },
                },
              ],
            },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 400,
              message:
                "Billing account for project '123' is not found. Billing must be enabled for activation of service(s) 'compute.googleapis.com' to proceed. Help Token: AcxmRmLOan0HY-SP6Xm7yaiu-FQummO3",
            },
          },
          400,
        ),
      )

    const app = new Hono()
    app.post("/api/deploy/preflight", deployPreflight)
    const res = await app.request("/api/deploy/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "test-proj" }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      ok: boolean
      blocker?: { type?: string; message?: string }
    }
    expect(data.ok).toBe(false)
    expect(data.blocker?.type).toBe("service_disabled")
    expect(data.blocker?.message).not.toContain("Help Token:")
    expect(data.blocker?.message).toContain("Billing account for project")
    expect(data.blocker?.message).toContain(
      "OpenClaw deploys to Google Cloud's free-tier eligible setup by default",
    )
  })
})
