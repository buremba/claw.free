export type LlmProvider = "claude" | "openai"
export type Region = "us-west1" | "us-central1" | "us-east1"

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
  // Cloud Shell prompts the user to enter TELEGRAM_TOKEN and TELEGRAM_USER_ID.
  // GCP_REGION and LLM_PROVIDER are set directly since they're not sensitive.
  const params = new URLSearchParams({
    cloudshell_git_repo: "https://github.com/buremba/claw.free",
    cloudshell_tutorial: "tutorial.md",
    cloudshell_env_vars: "TELEGRAM_TOKEN,TELEGRAM_USER_ID",
    "cloudshell_open_in_editor": "true",
  })

  // Non-sensitive values can be passed as print= params (Cloud Shell sets them as env vars)
  params.set("GCP_REGION", state.region)
  params.set("LLM_PROVIDER", state.llmProvider ?? "claude")

  return `https://shell.cloud.google.com/cloudshell/editor?${params.toString()}`
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
