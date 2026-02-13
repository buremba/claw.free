// Railway provider — creates a separate Railway service for each agent.
// Each agent gets its own public URL; Telegram webhooks go directly to it.
// No relay tunnel needed.

import type { AgentProvider, CreateAgentInput, CreateAgentResult, ProviderMeta } from "./types.js"
import { sanitizeBotName } from "../deploy.js"

const RAILWAY_API = "https://backboard.railway.com/graphql/v2"

export class RailwayProvider implements AgentProvider {
  readonly name = "Railway"

  isConfigured(): boolean {
    return Boolean(
      process.env.RAILWAY_API_TOKEN &&
      process.env.RAILWAY_PROJECT_ID &&
      process.env.RAILWAY_AGENT_IMAGE,
    )
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
      webhookUrl: null, // openclaw manages Telegram polling internally
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

  private async gql<T = unknown>(
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
      throw new Error(`Railway API error (${res.status}): ${text.slice(0, 200)}`)
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
