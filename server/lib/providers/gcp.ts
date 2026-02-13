// GCP Compute Engine provider — creates e2-micro VMs on the platform's GCP project.
// Agent VMs receive webhooks through the WebSocket relay tunnel.

import type { AgentProvider, CreateAgentInput, CreateAgentResult, ProviderMeta } from "./types.js"
import {
  DEFAULT_SOURCE_IMAGE,
  buildInstanceRequestBody,
  generateVmName,
  sanitizeBotName,
} from "../deploy.js"
import {
  createBotPreAuthKey,
  deleteNode,
  findNodeByHostname,
  isHeadscaleConfigured,
} from "../headscale.js"

export class GcpProvider implements AgentProvider {
  readonly name = "GCP"

  isConfigured(): boolean {
    return Boolean(process.env.GCP_SERVICE_ACCOUNT_KEY && process.env.GCP_PROJECT_ID)
  }

  async validateToken(): Promise<string> {
    const gcpKey = process.env.GCP_SERVICE_ACCOUNT_KEY
    if (!gcpKey) throw new Error("GCP_SERVICE_ACCOUNT_KEY not set")
    const accessToken = await getServiceAccountToken(gcpKey)
    if (!accessToken) throw new Error("Failed to authenticate with GCP service account")
    return "GCP service account token is valid"
  }

  async createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
    const gcpKey = process.env.GCP_SERVICE_ACCOUNT_KEY!
    const gcpProject = process.env.GCP_PROJECT_ID!

    const normalizedName = sanitizeBotName(input.agentName)
    const vmName = generateVmName(normalizedName)
    const zone = "us-central1-a"
    const sourceImage = process.env.DEPLOY_SOURCE_IMAGE ?? DEFAULT_SOURCE_IMAGE

    const accessToken = await getServiceAccountToken(gcpKey)
    if (!accessToken) {
      throw new Error("Failed to authenticate with GCP service account")
    }

    // Optional: overlay network pre-auth key
    let tailscaleAuthKey: string | undefined
    if (isHeadscaleConfigured()) {
      try {
        tailscaleAuthKey = await createBotPreAuthKey()
      } catch (err) {
        console.error("Failed to create overlay pre-auth key:", err)
      }
    }

    // Relay tunnel credentials — agent VM connects outbound to relay server
    const relayToken = crypto.randomUUID()
    const relayUrl = process.env.RELAY_URL ?? process.env.BASE_URL

    const instanceBody = buildInstanceRequestBody({
      zone,
      vmName,
      provider: "claude",
      telegramToken: input.agentToken,
      botName: normalizedName,
      sourceImage,
      tailscaleAuthKey,
      headscaleUrl: process.env.HEADSCALE_URL,
      relayUrl,
      relayToken,
    })

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${gcpProject}/zones/${zone}/instances`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(instanceBody),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`VM creation failed: ${err.slice(0, 200)}`)
    }

    const operation = (await res.json()) as { name: string }

    return {
      // GCP agents use relay tunnel — webhooks go through the relay server
      webhookUrl: relayUrl ? `${relayUrl}/relay/hook/${input.deploymentId}` : null,
      providerMeta: {
        cloudProvider: "gcp",
        projectId: gcpProject,
        vmName,
        vmZone: zone,
        operationName: operation.name,
        relayToken,
        railwayServiceId: null,
      },
    }
  }

  async deleteAgent(meta: ProviderMeta): Promise<void> {
    // Remove from overlay network
    if (isHeadscaleConfigured() && meta.vmName) {
      try {
        const node = await findNodeByHostname(meta.vmName)
        if (node) await deleteNode(node.nodeId)
      } catch { /* best effort */ }
    }

    // Delete GCP VM
    if (meta.vmName && meta.projectId && meta.vmZone) {
      const gcpKey = process.env.GCP_SERVICE_ACCOUNT_KEY
      if (gcpKey) {
        const accessToken = await getServiceAccountToken(gcpKey)
        if (accessToken) {
          try {
            await fetch(
              `https://compute.googleapis.com/compute/v1/projects/${meta.projectId}/zones/${meta.vmZone}/instances/${meta.vmName}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${accessToken}` },
              },
            )
          } catch { /* best effort */ }
        }
      }
    }
  }
}

async function getServiceAccountToken(keyJson: string): Promise<string | null> {
  try {
    const key = JSON.parse(keyJson) as {
      client_email: string
      private_key: string
      token_uri: string
    }

    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({
        iss: key.client_email,
        scope: "https://www.googleapis.com/auth/compute",
        aud: key.token_uri,
        iat: now,
        exp: now + 3600,
      }),
    ).toString("base64url")

    const { createSign } = await import("node:crypto")
    const signer = createSign("RSA-SHA256")
    signer.update(`${header}.${payload}`)
    const signature = signer.sign(key.private_key, "base64url")

    const jwt = `${header}.${payload}.${signature}`

    const res = await fetch(key.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    })

    if (!res.ok) return null
    const data = (await res.json()) as { access_token: string }
    return data.access_token
  } catch {
    return null
  }
}
