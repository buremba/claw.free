// Railway provider — creates a separate Railway service for each agent.
// Each agent gets its own public URL; Telegram webhooks go directly to it.
// No relay tunnel needed.

import type { AgentProvider, CreateAgentInput, CreateAgentResult, ProviderMeta } from "./types.js"
import { sanitizeBotName } from "../deploy.js"

export const RAILWAY_API = "https://backboard.railway.com/graphql/v2"

/** Max retry attempts for transient network errors. */
const MAX_RETRIES = 3
/** Base delay in ms for exponential backoff (doubles each retry). */
const RETRY_BASE_MS = 500

export class RailwayProvider implements AgentProvider {
  readonly name = "Railway"

  isConfigured(): boolean {
    return Boolean(
      process.env.RAILWAY_API_TOKEN &&
      process.env.RAILWAY_PROJECT_ID &&
      process.env.RAILWAY_AGENT_IMAGE,
    )
  }

  async validateToken(): Promise<string> {
    const token = process.env.RAILWAY_API_TOKEN
    if (!token) throw new Error("RAILWAY_API_TOKEN not set")
    const projectId = process.env.RAILWAY_PROJECT_ID
    if (!projectId) throw new Error("RAILWAY_PROJECT_ID not set")

    // Lightweight query: fetch the project name and environments to verify
    // both the token and project ID are valid in a single round-trip.
    const data = await this.gql<{
      project: { name: string; environments: { edges: Array<{ node: { id: string; name: string } }> } }
    }>(token, {
      query: `query($id: String!) {
        project(id: $id) {
          name
          environments { edges { node { id name } } }
        }
      }`,
      variables: { id: projectId },
    })

    const envCount = data.project.environments.edges.length
    return `Railway token valid — project "${data.project.name}" (${envCount} environment${envCount !== 1 ? "s" : ""})`
  }

  async createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
    const token = process.env.RAILWAY_API_TOKEN!
    const projectId = process.env.RAILWAY_PROJECT_ID!
    const agentImage = process.env.RAILWAY_AGENT_IMAGE!

    const serviceName = `agent-${sanitizeBotName(input.agentName).slice(0, 40)}-${input.deploymentId.slice(0, 8)}`

    // 1. Create service with Docker image
    const service = await this.gql<{ serviceCreate: { id: string } }>(token, {
      query: `mutation($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id }
      }`,
      variables: {
        input: {
          projectId,
          name: serviceName,
          source: { image: agentImage },
        },
      },
    })
    const serviceId = service.serviceCreate.id

    // 2. Get the default environment ID
    const envData = await this.gql<{
      project: { environments: { edges: Array<{ node: { id: string; name: string } }> } }
    }>(token, {
      query: `query($id: String!) {
        project(id: $id) {
          environments { edges { node { id name } } }
        }
      }`,
      variables: { id: projectId },
    })
    const prodEnv = envData.project.environments.edges.find(
      (e) => e.node.name === "production",
    ) ?? envData.project.environments.edges[0]
    if (!prodEnv) {
      throw new Error("No Railway environment found")
    }
    const environmentId = prodEnv.node.id

    // 3. Set environment variables (skip deploy until all vars set)
    const vars: Record<string, string> = {
      TELEGRAM_TOKEN: input.agentToken,
      BOT_NAME: input.agentName,
      WEBHOOK_SECRET: input.webhookSecret,
      DEPLOYMENT_ID: input.deploymentId,
      OPENCLAW_GATEWAY_TOKEN: crypto.randomUUID(),
      NODE_OPTIONS: "--max-old-space-size=1024",
    }
    for (const [name, value] of Object.entries(vars)) {
      await this.gql(token, {
        query: `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
        variables: {
          input: { projectId, environmentId, serviceId, name, value, skipDeploys: true },
        },
      })
    }

    // 4. Create a public domain for the service
    const domainResult = await this.gql<{
      serviceDomainCreate: { domain: string }
    }>(token, {
      query: `mutation($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) { domain }
      }`,
      variables: { input: { serviceId, environmentId } },
    })
    const domain = domainResult.serviceDomainCreate.domain

    // 5. Set the public URL so the agent can reference it if needed — triggers deploy
    await this.gql(token, {
      query: `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
      variables: {
        input: { projectId, environmentId, serviceId, name: "PUBLIC_URL", value: `https://${domain}` },
      },
    })

    // Clear any existing webhook — openclaw handles Telegram via polling
    try {
      await fetch(
        `https://api.telegram.org/bot${input.agentToken}/deleteWebhook`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
    } catch { /* best effort */ }

    return {
      // No webhookUrl — openclaw manages Telegram polling internally
      webhookUrl: null,
      providerMeta: {
        cloudProvider: "railway",
        projectId,
        vmName: serviceName,
        vmZone: null,
        operationName: null,
        relayToken: null,
        railwayServiceId: serviceId,
      },
    }
  }

  async deleteAgent(meta: ProviderMeta): Promise<void> {
    const token = process.env.RAILWAY_API_TOKEN
    if (!token || !meta.railwayServiceId) return

    try {
      await this.gql(token, {
        query: `mutation($id: String!) { serviceDelete(id: $id) }`,
        variables: { id: meta.railwayServiceId },
      })
    } catch { /* best effort */ }
  }

  /** Execute a GraphQL request against the Railway API with retry on transient failures. */
  async gql<T = unknown>(
    token: string,
    body: { query: string; variables?: unknown },
  ): Promise<T> {
    let lastError: Error | undefined
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.gqlOnce<T>(token, body)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        // Only retry on network / 5xx errors, not on 4xx or GraphQL logic errors
        if (!isRetryable(lastError) || attempt === MAX_RETRIES) {
          throw lastError
        }
        const delay = RETRY_BASE_MS * 2 ** attempt
        await sleep(delay)
      }
    }
    throw lastError!
  }

  private async gqlOnce<T = unknown>(
    token: string,
    body: { query: string; variables?: unknown },
  ): Promise<T> {
    const res = await fetch(RAILWAY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      const err = new Error(`Railway API error (${res.status}): ${text.slice(0, 200)}`)
      ;(err as NodeJS.ErrnoException).code = `HTTP_${res.status}`
      throw err
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (json.errors?.length) {
      throw new Error(`Railway GraphQL error: ${json.errors[0].message}`)
    }
    if (!json.data) {
      throw new Error("Railway API returned no data")
    }
    return json.data
  }
}

/** Determines if an error is worth retrying (network failures, 5xx). */
function isRetryable(err: Error): boolean {
  // Network-level errors (ECONNRESET, ETIMEDOUT, fetch failures, etc.)
  const code = (err as NodeJS.ErrnoException).code
  if (code && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|UND_ERR|FETCH_ERROR)/.test(code)) {
    return true
  }
  // HTTP 5xx from the Railway API
  if (/Railway API error \(5\d\d\)/.test(err.message)) {
    return true
  }
  // fetch() itself can throw TypeError on network failures
  if (err.name === "TypeError" && /fetch|network/i.test(err.message)) {
    return true
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
