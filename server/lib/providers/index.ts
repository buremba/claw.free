// Provider factory — returns the configured AgentProvider.
// Prefers Railway when configured, falls back to GCP.

import type { AgentProvider } from "./types.js"
import { RailwayProvider } from "./railway.js"
import { GcpProvider } from "./gcp.js"

const railway = new RailwayProvider()
const gcp = new GcpProvider()

export function getProvider(): AgentProvider {
  if (railway.isConfigured()) return railway
  if (gcp.isConfigured()) return gcp
  throw new Error("No agent provider configured. Set RAILWAY_API_TOKEN or GCP_SERVICE_ACCOUNT_KEY.")
}

export function hasProvider(): boolean {
  return railway.isConfigured() || gcp.isConfigured()
}

export type { AgentProvider, CreateAgentInput, CreateAgentResult, ProviderMeta } from "./types.js"
