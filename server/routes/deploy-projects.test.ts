import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveGoogleAuthMock = vi.fn()

vi.mock("../lib/google-auth.js", () => ({
  resolveGoogleAuth: (...args: unknown[]) => resolveGoogleAuthMock(...args),
}))

import { deployProjects } from "./deploy-projects.js"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("deployProjects", () => {
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

  it("returns missing_scope when token lacks project-read scopes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          scope: "openid email https://www.googleapis.com/auth/compute",
        }),
      )

    const app = new Hono()
    app.get("/api/deploy/projects", deployProjects)
    const res = await app.request("/api/deploy/projects")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(403)
    const data = (await res.json()) as { reason?: string }
    expect(data.reason).toBe("missing_scope")
  })

  it("returns project list when scope and API call succeed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          scope:
            "openid email https://www.googleapis.com/auth/compute https://www.googleapis.com/auth/cloudplatformprojects.readonly",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          projects: [
            { projectId: "b-project", displayName: "Beta Project" },
            { projectId: "a-project", displayName: "Alpha Project" },
          ],
        }),
      )

    const app = new Hono()
    app.get("/api/deploy/projects", deployProjects)
    const res = await app.request("/api/deploy/projects")

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      projects: Array<{ projectId: string; name: string }>
    }
    expect(data.projects).toEqual([
      { projectId: "a-project", name: "Alpha Project" },
      { projectId: "b-project", name: "Beta Project" },
    ])
  })

  it("returns permission_denied when API rejects project listing", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          scope:
            "openid email https://www.googleapis.com/auth/cloudplatformprojects.readonly",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 403,
              message:
                "Permission denied on resource project for cloudresourcemanager.projects.search",
              errors: [{ reason: "forbidden" }],
            },
          },
          403,
        ),
      )

    const app = new Hono()
    app.get("/api/deploy/projects", deployProjects)
    const res = await app.request("/api/deploy/projects")

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(403)
    const data = (await res.json()) as { reason?: string }
    expect(data.reason).toBe("permission_denied")
  })
})
