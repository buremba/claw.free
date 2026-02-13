// Secure environment variable management — Deno Sandbox-inspired pattern.
//
// Agents never see real API keys. Instead they get placeholder tokens like
// `CLAW_SE_ANTHROPIC_KEY` that only resolve to real values when the outbound
// proxy detects them in HTTP headers AND the target host is in the secret's
// allowed-hosts list.
//
// This is the "Pattern B: Placeholder Replacement" approach used by Deno
// Sandbox and Fly Tokenizer. Even if a placeholder leaks, it's useless
// outside the proxy because:
//   1. It's not a real API key — upstream services reject it
//   2. The proxy only swaps it when the target host matches
//   3. The proxy only accepts requests from authenticated deployments

import { encrypt, decrypt } from "./crypto.js"
import {
  createSecureEnv,
  getSecureEnvByDeployment,
  getSecureEnvByName,
  deleteSecureEnv,
  deleteAllSecureEnv,
  getAllowedHostsForDeployment,
} from "../db.js"

// ── Placeholder format ──────────────────────────────────────────────
// CLAW_SE_<SECRET_NAME>
// Example: CLAW_SE_ANTHROPIC_KEY, CLAW_SE_OPENAI_KEY, CLAW_SE_GITHUB_TOKEN
//
// The placeholder is intentionally simple — authentication is handled by
// the proxy layer (via Proxy-Authorization / relay token), not by the
// placeholder itself. The secret name identifies WHICH secret to use.

const PLACEHOLDER_PREFIX = "CLAW_SE_"
const PLACEHOLDER_REGEX = /CLAW_SE_([A-Z0-9_]+)/g

export function makePlaceholder(secretName: string): string {
  return `${PLACEHOLDER_PREFIX}${secretName.toUpperCase()}`
}

/**
 * Scan a string for placeholder tokens. Returns all secret names found.
 */
export function findPlaceholders(value: string): string[] {
  const names: string[] = []
  let match: RegExpExecArray | null
  // Reset regex state
  PLACEHOLDER_REGEX.lastIndex = 0
  while ((match = PLACEHOLDER_REGEX.exec(value)) !== null) {
    if (!names.includes(match[1])) {
      names.push(match[1])
    }
  }
  return names
}

/**
 * Scan all headers for placeholder tokens. Returns a map of
 * headerName → [secretNames found in that header's value].
 */
export function scanHeadersForPlaceholders(
  headers: Record<string, string>,
): Map<string, string[]> {
  const results = new Map<string, string[]>()
  for (const [key, value] of Object.entries(headers)) {
    const names = findPlaceholders(value)
    if (names.length > 0) {
      results.set(key, names)
    }
  }
  return results
}

// ── Host matching ───────────────────────────────────────────────────
// Supports exact match and wildcard prefix: *.example.com

export function hostMatches(targetHost: string, allowedHosts: string[]): boolean {
  const normalizedTarget = targetHost.toLowerCase()
  for (const pattern of allowedHosts) {
    const normalizedPattern = pattern.toLowerCase()
    if (normalizedPattern === normalizedTarget) return true
    if (normalizedPattern.startsWith("*.")) {
      const suffix = normalizedPattern.slice(1) // ".example.com"
      if (normalizedTarget.endsWith(suffix) || normalizedTarget === normalizedPattern.slice(2)) {
        return true
      }
    }
  }
  return false
}

// ── Host allowlist (SSRF prevention) ─────────────────────────────────
// The proxy only allows requests to hosts that appear in at least one
// secret's allowedHosts for the deployment. No registered secret = no access.
// This prevents agents from using the proxy as an open relay to hit
// internal services (169.254.169.254, localhost, etc.).

/**
 * Check whether a deployment has any secret whose allowedHosts match
 * the given target host. This is the top-level SSRF gate.
 */
export async function isHostAllowedForDeployment(
  deploymentId: string,
  targetHost: string,
): Promise<boolean> {
  const allPatterns = await getAllowedHostsForDeployment(deploymentId)
  return hostMatches(targetHost, allPatterns)
}

// ── Secret CRUD (wrappers around db + crypto) ───────────────────────

export interface SecureEnvEntry {
  name: string
  allowedHosts: string[]
  placeholder: string
  createdAt: Date
}

/**
 * Store a secret. The value is encrypted before being written to the database.
 * Returns the placeholder token the agent should use.
 */
export async function storeSecret(
  deploymentId: string,
  name: string,
  plainValue: string,
  allowedHosts: string[],
): Promise<SecureEnvEntry> {
  const upperName = name.toUpperCase()
  const encryptedValue = encrypt(plainValue)
  const row = await createSecureEnv({
    deploymentId,
    name: upperName,
    encryptedValue,
    allowedHosts,
  })
  return {
    name: row.name,
    allowedHosts: row.allowedHosts,
    placeholder: makePlaceholder(row.name),
    createdAt: row.createdAt,
  }
}

/**
 * List secrets for a deployment (names + hosts only, never the actual values).
 */
export async function listSecrets(deploymentId: string): Promise<SecureEnvEntry[]> {
  const rows = await getSecureEnvByDeployment(deploymentId)
  return rows.map((row) => ({
    name: row.name,
    allowedHosts: row.allowedHosts,
    placeholder: makePlaceholder(row.name),
    createdAt: row.createdAt,
  }))
}

/**
 * Resolve a placeholder to its real value for a given deployment.
 * Returns null if the secret doesn't exist or the target host is not allowed.
 */
export async function resolveSecret(
  deploymentId: string,
  secretName: string,
  targetHost: string,
): Promise<string | null> {
  const row = await getSecureEnvByName(deploymentId, secretName.toUpperCase())
  if (!row) return null

  // Enforce host restriction — the secret can only be sent to allowed hosts
  if (!hostMatches(targetHost, row.allowedHosts)) {
    console.warn(
      `Secure env: blocked ${secretName} for deployment ${deploymentId} — ` +
      `host "${targetHost}" not in allowed list [${row.allowedHosts.join(", ")}]`,
    )
    return null
  }

  return decrypt(row.encryptedValue)
}

/**
 * Process headers for a proxy request: find all placeholders, resolve them,
 * and return new headers with real values substituted.
 *
 * Returns the modified headers and a list of any secrets that failed to resolve
 * (missing secret or host not allowed).
 */
export async function swapHeaderSecrets(
  deploymentId: string,
  headers: Record<string, string>,
  targetHost: string,
): Promise<{ headers: Record<string, string>; blocked: string[] }> {
  const found = scanHeadersForPlaceholders(headers)
  if (found.size === 0) {
    return { headers, blocked: [] }
  }

  const newHeaders = { ...headers }
  const blocked: string[] = []

  for (const [headerName, secretNames] of found) {
    let headerValue = newHeaders[headerName]
    for (const secretName of secretNames) {
      const realValue = await resolveSecret(deploymentId, secretName, targetHost)
      if (realValue !== null) {
        headerValue = headerValue.replace(makePlaceholder(secretName), realValue)
      } else {
        blocked.push(secretName)
      }
    }
    newHeaders[headerName] = headerValue
  }

  return { headers: newHeaders, blocked }
}

export { deleteSecureEnv as removeSecret, deleteAllSecureEnv as removeAllSecrets }
