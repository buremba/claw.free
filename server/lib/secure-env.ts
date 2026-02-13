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

// ── Network policy (SSRF prevention) ─────────────────────────────────
// Three-layer evaluation, configured via env vars:
//
//   PROXY_BLOCKED_HOSTS  — comma-separated, always denied, overrides everything.
//                          Defaults to private/internal ranges if unset.
//   PROXY_ALLOWED_HOSTS  — comma-separated, always allowed for all deployments
//                          (e.g. common LLM APIs). No default.
//   Per-deployment        — hosts in secure_env allowedHosts for the deployment.
//
// Evaluation order:
//   1. Blocklist (env)          → DENY
//   2. Per-deployment secrets   → ALLOW
//   3. Global allowlist (env)   → ALLOW
//   4. Default                  → DENY

// Private/reserved ranges that should never be proxy targets.
// Applied when PROXY_BLOCKED_HOSTS is not explicitly set.
const DEFAULT_BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  // Link-local / cloud metadata
  "169.254.169.254",
  "metadata.google.internal",
  // RFC 1918
  "10.*",
  "172.16.*", "172.17.*", "172.18.*", "172.19.*",
  "172.20.*", "172.21.*", "172.22.*", "172.23.*",
  "172.24.*", "172.25.*", "172.26.*", "172.27.*",
  "172.28.*", "172.29.*", "172.30.*", "172.31.*",
  "192.168.*",
]

function parseHostList(envValue: string | undefined): string[] {
  if (!envValue) return []
  return envValue.split(",").map((h) => h.trim()).filter(Boolean)
}

/**
 * IP/host blocklist pattern matching.
 * Supports: exact, *.suffix wildcard, and 10.* style prefix wildcards.
 */
export function hostMatchesBlocklist(targetHost: string, patterns: string[]): boolean {
  const t = targetHost.toLowerCase()
  for (const raw of patterns) {
    const p = raw.toLowerCase()
    if (p === t) return true
    // Wildcard suffix: *.example.com
    if (p.startsWith("*.")) {
      const suffix = p.slice(1)
      if (t.endsWith(suffix) || t === p.slice(2)) return true
    }
    // Wildcard prefix for IP ranges: 10.*, 192.168.*
    if (p.endsWith(".*")) {
      const prefix = p.slice(0, -1) // "10."
      if (t.startsWith(prefix)) return true
    }
  }
  return false
}

function getBlockedHosts(): string[] {
  const env = process.env.PROXY_BLOCKED_HOSTS
  // Explicit empty string means "disable blocklist"
  if (env === "") return []
  if (env) return parseHostList(env)
  return DEFAULT_BLOCKED_HOSTS
}

function getGlobalAllowedHosts(): string[] {
  return parseHostList(process.env.PROXY_ALLOWED_HOSTS)
}

/**
 * Full network policy check for the proxy. Returns { allowed, reason }.
 *
 * 1. Blocklist (env PROXY_BLOCKED_HOSTS) → DENY
 * 2. Per-deployment secrets               → ALLOW
 * 3. Global allowlist (env PROXY_ALLOWED_HOSTS) → ALLOW
 * 4. Default                              → DENY
 */
export async function checkProxyAccess(
  deploymentId: string,
  targetHost: string,
): Promise<{ allowed: boolean; reason: string }> {
  // 1. Hard blocklist — always denied
  const blocked = getBlockedHosts()
  if (hostMatchesBlocklist(targetHost, blocked)) {
    return { allowed: false, reason: `Host "${targetHost}" is blocked by network policy (PROXY_BLOCKED_HOSTS).` }
  }

  // 2. Per-deployment secrets — if any secret's allowedHosts matches, allow
  const deploymentPatterns = await getAllowedHostsForDeployment(deploymentId)
  if (hostMatches(targetHost, deploymentPatterns)) {
    return { allowed: true, reason: "per-deployment secret" }
  }

  // 3. Global allowlist — hosts any deployment can reach
  const globalAllowed = getGlobalAllowedHosts()
  if (globalAllowed.length > 0 && hostMatches(targetHost, globalAllowed)) {
    return { allowed: true, reason: "global allowlist (PROXY_ALLOWED_HOSTS)" }
  }

  // 4. Default deny
  return {
    allowed: false,
    reason: `No secrets registered for host "${targetHost}" and it is not in PROXY_ALLOWED_HOSTS.`,
  }
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
