import type { Context } from "hono"
import { resolveGoogleAuth } from "../lib/google-auth.js"
import { sanitizeGoogleErrorMessage } from "../lib/google-error.js"

const COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute"
const SERVICE_MANAGEMENT_SCOPE =
  "https://www.googleapis.com/auth/service.management"

type BlockerActionKind =
  | "reconnect_basic"
  | "reconnect_service_management"
  | "open_url"
  | "none"

interface PreflightBlocker {
  type:
    | "missing_scope"
    | "missing_permission"
    | "mfa_required"
    | "service_disabled"
    | "propagating"
    | "unknown"
  title: string
  message: string
  actionKind: BlockerActionKind
  actionUrl?: string
}

interface PreflightResponse {
  ok: boolean
  checks: {
    hasComputeScope: boolean | null
    hasServiceManagementScope: boolean | null
    computeApiEnabled: boolean
    autoEnableAttempted: boolean
  }
  blocker?: PreflightBlocker
  message?: string
}

interface GoogleApiError {
  error?: {
    code?: number
    message?: string
    errors?: Array<{ reason?: string }>
    details?: Array<{
      reason?: string
      metadata?: {
        service?: string
        activationUrl?: string
      }
    }>
  }
}

interface ServiceUsageOperation {
  name?: string
  done?: boolean
  error?: { message?: string }
}

interface ParsedApiError {
  code: number | null
  message: string
  reasons: Set<string>
  activationUrl: string | null
}

interface ComputeState {
  enabled: boolean
  disabled: boolean
  permissionDenied: boolean
  mfaRequired: boolean
  parsedError: ParsedApiError | null
}

interface EnableAttempt {
  ok: boolean
  permissionDenied: boolean
  mfaRequired: boolean
  scopeDenied: boolean
  parsedError: ParsedApiError | null
}

export async function deployPreflight(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) {
    return c.json({ error: "Not logged in" }, 401)
  }

  const body = (await c.req.json().catch(() => null)) as
    | { projectId?: string }
    | null
  const projectId = body?.projectId?.trim()
  if (!projectId) {
    return c.json({ error: "Missing projectId" }, 400)
  }

  const checks: PreflightResponse["checks"] = {
    hasComputeScope: null,
    hasServiceManagementScope: null,
    computeApiEnabled: false,
    autoEnableAttempted: false,
  }

  const scopes = await fetchGrantedScopes(auth.accessToken)
  if (scopes) {
    checks.hasComputeScope = scopes.has(COMPUTE_SCOPE)
    checks.hasServiceManagementScope = scopes.has(SERVICE_MANAGEMENT_SCOPE)
  }

  if (checks.hasComputeScope === false) {
    return c.json({
      ok: false,
      checks,
      blocker: {
        type: "missing_scope",
        title: "Google permissions need refresh",
        message:
          "Your current token is missing Compute permission. Reconnect Google to continue deployment.",
        actionKind: "reconnect_basic",
      },
    } satisfies PreflightResponse)
  }

  const authHeader = { Authorization: `Bearer ${auth.accessToken}` }
  const computeState = await checkComputeApiState(projectId, authHeader)
  if (computeState.enabled) {
    checks.computeApiEnabled = true
    return c.json({
      ok: true,
      checks,
      message: "Project is ready. You can deploy now.",
    } satisfies PreflightResponse)
  }

  if (computeState.mfaRequired) {
    return c.json({
      ok: false,
      checks,
      blocker: {
        type: "mfa_required",
        title: "2-step verification required",
        message:
          "Google Cloud may require 2-step verification (MFA) for API access. Enable 2SV in your Google account security settings, then re-check.",
        actionKind: "open_url",
        actionUrl: "https://myaccount.google.com/security",
      },
    } satisfies PreflightResponse)
  }

  if (!computeState.disabled) {
    if (computeState.permissionDenied) {
      return c.json({
        ok: false,
        checks,
        blocker: {
          type: "missing_permission",
          title: "Missing project permissions",
          message:
            "Your account cannot access this project for deployment. Ask a project admin for required IAM roles or use a different account/project.",
          actionKind: "open_url",
          actionUrl: `https://console.cloud.google.com/iam-admin/iam?project=${projectId}`,
        },
      } satisfies PreflightResponse)
    }

    return c.json({
      ok: false,
      checks,
      blocker: {
        type: "unknown",
        title: "Could not validate project readiness",
        message:
          computeState.parsedError?.message ??
          "Unknown Google API error while checking project readiness.",
        actionKind: "none",
      },
    } satisfies PreflightResponse)
  }

  if (checks.hasServiceManagementScope === false) {
    return c.json({
      ok: false,
      checks,
      blocker: {
        type: "missing_scope",
        title: "One extra permission needed",
        message:
          "Compute Engine API is disabled for this project. Reconnect once so claw.free can enable it automatically.",
        actionKind: "reconnect_service_management",
      },
    } satisfies PreflightResponse)
  }

  checks.autoEnableAttempted = true
  const enableAttempt = await tryEnableComputeApi(projectId, authHeader)
  if (enableAttempt.ok) {
    const postEnableState = await checkComputeApiState(projectId, authHeader)
    if (postEnableState.enabled) {
      checks.computeApiEnabled = true
      return c.json({
        ok: true,
        checks,
        message: "Compute Engine API is enabled. Project is ready to deploy.",
      } satisfies PreflightResponse)
    }

    const activationUrl =
      postEnableState.parsedError?.activationUrl ??
      computeState.parsedError?.activationUrl ??
      buildComputeActivationUrl(projectId)

    return c.json({
      ok: false,
      checks,
      blocker: {
        type: "propagating",
        title: "API enablement is propagating",
        message:
          "Compute Engine API enablement was requested, but Google is still propagating. Wait 1-2 minutes, then click re-check.",
        actionKind: "open_url",
        actionUrl: activationUrl,
      },
    } satisfies PreflightResponse)
  }

  if (enableAttempt.mfaRequired) {
    return c.json({
      ok: false,
      checks,
      blocker: {
        type: "mfa_required",
        title: "2-step verification required",
        message:
          "Google blocked API enablement until 2-step verification is enabled on your account. Turn it on, then re-check.",
        actionKind: "open_url",
        actionUrl: "https://myaccount.google.com/security",
      },
    } satisfies PreflightResponse)
  }

  if (enableAttempt.scopeDenied) {
    return c.json({
      ok: false,
      checks,
      blocker: {
        type: "missing_scope",
        title: "One extra permission needed",
        message:
          "Automatic API enablement requires one additional Google scope. Reconnect once to grant it.",
        actionKind: "reconnect_service_management",
      },
    } satisfies PreflightResponse)
  }

  if (enableAttempt.permissionDenied) {
    return c.json({
      ok: false,
      checks,
      blocker: {
        type: "missing_permission",
        title: "Missing API enable permission",
        message:
          "Your account cannot enable services in this project. Ask for Service Usage Admin (or Owner), or enable Compute Engine API manually.",
        actionKind: "open_url",
        actionUrl: `https://console.cloud.google.com/iam-admin/iam?project=${projectId}`,
      },
    } satisfies PreflightResponse)
  }

  const activationUrl =
    enableAttempt.parsedError?.activationUrl ??
    computeState.parsedError?.activationUrl ??
    buildComputeActivationUrl(projectId)

  return c.json({
    ok: false,
    checks,
    blocker: {
      type: "service_disabled",
      title: "Compute Engine API is still disabled",
      message: buildServiceDisabledBlockerMessage(enableAttempt.parsedError),
      actionKind: "open_url",
      actionUrl: activationUrl,
    },
  } satisfies PreflightResponse)
}

async function fetchGrantedScopes(
  accessToken: string,
): Promise<Set<string> | null> {
  try {
    const tokenInfo = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    )
    if (!tokenInfo.ok) {
      return null
    }

    const payload = (await tokenInfo.json()) as { scope?: string }
    const scopes = (payload.scope ?? "")
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
    return new Set(scopes)
  } catch {
    return null
  }
}

async function checkComputeApiState(
  projectId: string,
  headers: Record<string, string>,
): Promise<ComputeState> {
  try {
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones?maxResults=1`,
      { headers },
    )
    if (res.ok) {
      return {
        enabled: true,
        disabled: false,
        permissionDenied: false,
        mfaRequired: false,
        parsedError: null,
      }
    }

    const parsed = parseGoogleApiError(await res.text())
    const disabled = isServiceDisabled(parsed)
    return {
      enabled: false,
      disabled,
      permissionDenied: !disabled && isPermissionDenied(parsed),
      mfaRequired: isMfaRequired(parsed),
      parsedError: parsed,
    }
  } catch {
    return {
      enabled: false,
      disabled: false,
      permissionDenied: false,
      mfaRequired: false,
      parsedError: null,
    }
  }
}

async function tryEnableComputeApi(
  projectId: string,
  headers: Record<string, string>,
): Promise<EnableAttempt> {
  try {
    const enableRes = await fetch(
      `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/compute.googleapis.com:enable`,
      {
        method: "POST",
        headers,
      },
    )

    if (!enableRes.ok) {
      const parsed = parseGoogleApiError(await enableRes.text())
      return {
        ok: false,
        permissionDenied: isPermissionDenied(parsed),
        mfaRequired: isMfaRequired(parsed),
        scopeDenied: isScopeDenied(parsed),
        parsedError: parsed,
      }
    }

    const operation = (await enableRes.json()) as ServiceUsageOperation
    if (operation.done) {
      if (operation.error?.message) {
        const parsed = parseGoogleApiError(operation.error.message)
        return {
          ok: false,
          permissionDenied: isPermissionDenied(parsed),
          mfaRequired: isMfaRequired(parsed),
          scopeDenied: isScopeDenied(parsed),
          parsedError: parsed,
        }
      }
      return {
        ok: true,
        permissionDenied: false,
        mfaRequired: false,
        scopeDenied: false,
        parsedError: null,
      }
    }

    if (!operation.name) {
      return {
        ok: true,
        permissionDenied: false,
        mfaRequired: false,
        scopeDenied: false,
        parsedError: null,
      }
    }

    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const pollRes = await fetch(
        `https://serviceusage.googleapis.com/v1/${operation.name}`,
        { headers },
      )
      if (!pollRes.ok) {
        continue
      }

      const poll = (await pollRes.json()) as ServiceUsageOperation
      if (!poll.done) {
        continue
      }

      if (poll.error?.message) {
        const parsed = parseGoogleApiError(poll.error.message)
        return {
          ok: false,
          permissionDenied: isPermissionDenied(parsed),
          mfaRequired: isMfaRequired(parsed),
          scopeDenied: isScopeDenied(parsed),
          parsedError: parsed,
        }
      }

      return {
        ok: true,
        permissionDenied: false,
        mfaRequired: false,
        scopeDenied: false,
        parsedError: null,
      }
    }

    return {
      ok: true,
      permissionDenied: false,
      mfaRequired: false,
      scopeDenied: false,
      parsedError: null,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown network error"
    return {
      ok: false,
      permissionDenied: false,
      mfaRequired: false,
      scopeDenied: false,
      parsedError: {
        code: null,
        message,
        reasons: new Set<string>(),
        activationUrl: buildComputeActivationUrl(projectId),
      },
    }
  }
}

function parseGoogleApiError(raw: string): ParsedApiError {
  let payload: GoogleApiError = {}
  try {
    payload = JSON.parse(raw) as GoogleApiError
  } catch {
    // Not JSON from Google; treat as plain text message.
  }

  const message = sanitizeGoogleErrorMessage(payload.error?.message ?? raw)
  const reasons = new Set<string>()
  for (const item of payload.error?.errors ?? []) {
    if (item.reason) reasons.add(item.reason)
  }
  for (const detail of payload.error?.details ?? []) {
    if (detail.reason) reasons.add(detail.reason)
  }

  return {
    code: payload.error?.code ?? null,
    message,
    reasons,
    activationUrl:
      payload.error?.details?.find((detail) => detail.metadata?.activationUrl)
        ?.metadata?.activationUrl ?? null,
  }
}

function isServiceDisabled(parsed: ParsedApiError): boolean {
  return (
    parsed.reasons.has("SERVICE_DISABLED") ||
    parsed.reasons.has("accessNotConfigured") ||
    /has not been used in project|is disabled/i.test(parsed.message)
  )
}

function isScopeDenied(parsed: ParsedApiError): boolean {
  return (
    parsed.reasons.has("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
    /insufficient authentication scopes|insufficientpermissions/i.test(
      parsed.message,
    )
  )
}

function isPermissionDenied(parsed: ParsedApiError): boolean {
  return (
    parsed.code === 403 &&
    !isServiceDisabled(parsed) &&
    !isScopeDenied(parsed) &&
    /permission|not authorized|forbidden|permission denied/i.test(parsed.message)
  )
}

function isMfaRequired(parsed: ParsedApiError): boolean {
  return (
    parsed.reasons.has("MFA_REQUIRED") ||
    /2-step verification|multi-factor|mfa/i.test(parsed.message)
  )
}

function isBillingRequired(parsed: ParsedApiError): boolean {
  return (
    parsed.reasons.has("BILLING_DISABLED") ||
    /billing account|billing must be enabled|cloud billing/i.test(parsed.message)
  )
}

function buildServiceDisabledBlockerMessage(
  parsed: ParsedApiError | null,
): string {
  const fallback =
    "Google did not enable Compute Engine API automatically. Enable it manually, then re-check."
  if (!parsed) return fallback
  if (!isBillingRequired(parsed)) return parsed.message

  return `${parsed.message} OpenClaw deploys to Google Cloud's free-tier eligible setup by default, and your card details stay within Google Cloud billing (OpenClaw never sees your card).`
}

function buildComputeActivationUrl(projectId: string): string {
  return `https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=${projectId}`
}
