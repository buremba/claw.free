// AgentProvider — abstraction over where agent instances run.
// Implementations: GCP (Compute Engine VM) and Railway (service per agent).

export interface CreateAgentInput {
  deploymentId: string
  agentToken: string
  agentName: string
  agentUsername: string | null
  webhookSecret: string
}

export interface CreateAgentResult {
  /** Direct webhook URL if the agent has its own public endpoint (Railway).
   *  Null if webhooks go through the relay tunnel (GCP). */
  webhookUrl: string | null
  /** Provider-specific fields to persist in the deployment record. */
  providerMeta: ProviderMeta
}

export interface ProviderMeta {
  cloudProvider: string
  projectId: string | null
  vmName: string | null
  vmZone: string | null
  operationName: string | null
  relayToken: string | null
  /** Railway-specific: service ID for lifecycle management. */
  railwayServiceId: string | null
}

export interface AgentProvider {
  /** Human-readable name for error messages. */
  readonly name: string

  /** Whether this provider is properly configured (env vars present). */
  isConfigured(): boolean

  /** Provision a new agent instance. */
  createAgent(input: CreateAgentInput): Promise<CreateAgentResult>

  /** Tear down an agent instance. Best-effort, should not throw. */
  deleteAgent(meta: ProviderMeta): Promise<void>
}
