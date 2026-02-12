import type { Context } from "hono"
import { resolveGoogleAuth } from "../lib/google-auth.js"
import { sanitizeGoogleErrorMessage } from "../lib/google-error.js"

const PROJECTS_READ_SCOPE =
  "https://www.googleapis.com/auth/cloudplatformprojects.readonly"
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const CLOUD_PLATFORM_READ_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform.read-only"

interface TokenInfoResponse {
  scope?: string
}

interface ProjectItem {
  projectId?: string
  displayName?: string
}

interface SearchProjectsResponse {
  projects?: ProjectItem[]
}

interface GoogleApiError {
  error?: {
    message?: string
    code?: number
    errors?: Array<{ reason?: string }>
  }
}

export async function deployProjects(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) {
    return c.json({ error: "Not logged in" }, 401)
  }

  const scopes = await fetchGrantedScopes(auth.accessToken)
  const hasProjectReadScope = scopes
    ? scopes.has(PROJECTS_READ_SCOPE) ||
      scopes.has(CLOUD_PLATFORM_SCOPE) ||
      scopes.has(CLOUD_PLATFORM_READ_SCOPE)
    : null

  if (hasProjectReadScope === false) {
    return c.json(
      {
        error:
          "Missing scope to list Google Cloud projects. Reconnect and grant project read access.",
        reason: "missing_scope",
      },
      403,
    )
  }

  try {
    const res = await fetch(
      "https://cloudresourcemanager.googleapis.com/v3/projects:search?query=state:ACTIVE",
      {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      },
    )

    if (!res.ok) {
      const raw = await res.text()
      const parsed = parseGoogleApiError(raw)
      const permissionDenied =
        parsed.error?.code === 403 ||
        parsed.error?.errors?.some((item) => item.reason === "forbidden")

      return c.json(
        {
          error: sanitizeGoogleErrorMessage(
            parsed.error?.message ??
              "Could not fetch projects from Google Cloud Resource Manager.",
          ),
          reason: permissionDenied ? "permission_denied" : "api_error",
        },
        permissionDenied ? 403 : 502,
      )
    }

    const payload = (await res.json()) as SearchProjectsResponse
    const projects = (payload.projects ?? [])
      .filter((project) => Boolean(project.projectId))
      .map((project) => ({
        projectId: project.projectId!,
        name: project.displayName ?? project.projectId!,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return c.json({ projects })
  } catch (error) {
    const message = sanitizeGoogleErrorMessage(
      error instanceof Error ? error.message : "Unknown error while fetching projects",
    )
    return c.json({ error: message, reason: "network_error" }, 502)
  }
}

async function fetchGrantedScopes(
  accessToken: string,
): Promise<Set<string> | null> {
  try {
    const tokenInfoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    )
    if (!tokenInfoRes.ok) return null

    const payload = (await tokenInfoRes.json()) as TokenInfoResponse
    const scopes = (payload.scope ?? "")
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
    return new Set(scopes)
  } catch {
    return null
  }
}

function parseGoogleApiError(raw: string): GoogleApiError {
  try {
    return JSON.parse(raw) as GoogleApiError
  } catch {
    return {}
  }
}
