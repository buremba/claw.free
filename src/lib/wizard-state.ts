export type LlmProvider = "kimi" | "claude" | "openai"
export type Region = "us-west1" | "us-central1" | "us-east1"
export type DeployMode = "installer" | "managed"

export interface WizardState {
  step: number
  llmProvider: LlmProvider | null
  telegramToken: string
  telegramUserId: string
  region: Region
}

export const REGIONS: { id: Region; label: string; location: string }[] = [
  { id: "us-west1", label: "us-west1", location: "Oregon" },
  { id: "us-central1", label: "us-central1", location: "Iowa" },
  { id: "us-east1", label: "us-east1", location: "South Carolina" },
]

export function buildCloudShellUrl(state: WizardState): string {
  // Cloud Shell prompts the user to enter sensitive env vars.
  // GCP_REGION and LLM_PROVIDER are set directly since they're not sensitive.
  const envVars = ["TELEGRAM_TOKEN", "TELEGRAM_USER_ID"]
  if (state.llmProvider === "kimi") {
    envVars.push("NVIDIA_API_KEY")
  }

  const params = new URLSearchParams({
    cloudshell_git_repo: "https://github.com/buremba/claw.free",
    cloudshell_tutorial: "tutorial.md",
    cloudshell_env_vars: envVars.join(","),
  })

  params.set("GCP_REGION", state.region)
  params.set("LLM_PROVIDER", state.llmProvider ?? "kimi")

  if (state.llmProvider === "kimi") {
    params.set("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
    params.set("LLM_MODEL_ID", "moonshotai/kimi-k2.5")
  }

  return `https://shell.cloud.google.com/cloudshell/editor?${params.toString()}`
}

export function buildAuthUrl(params: {
  provider: string
  channel: string
  region: string
  telegramToken?: string
  telegramUserId?: string
  nvidiaApiKey?: string
}): string {
  const qs = new URLSearchParams({
    provider: params.provider,
    channel: params.channel,
    region: params.region,
  })
  if (params.telegramToken) qs.set("telegramToken", params.telegramToken)
  if (params.telegramUserId) qs.set("telegramUserId", params.telegramUserId)
  if (params.nvidiaApiKey) qs.set("nvidiaApiKey", params.nvidiaApiKey)
  return `/api/auth/google?${qs.toString()}`
}

export function guessRegion(): Region {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz.includes("Los_Angeles") || tz.includes("Denver") || tz.includes("Phoenix")) {
      return "us-west1"
    }
    if (tz.includes("New_York") || tz.includes("Detroit") || tz.includes("Indiana")) {
      return "us-east1"
    }
  } catch {
    // ignore
  }
  return "us-central1"
}
