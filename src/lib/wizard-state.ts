export type LlmProvider = "kimi" | "claude" | "openai"
export type Region = "us-west1" | "us-central1" | "us-east1"

export const REGIONS: { id: Region; label: string; location: string }[] = [
  { id: "us-west1", label: "us-west1", location: "Oregon" },
  { id: "us-central1", label: "us-central1", location: "Iowa" },
  { id: "us-east1", label: "us-east1", location: "South Carolina" },
]

export function buildAuthUrl(params: {
  provider: string
  channel: string
  cloud: string
  upgrade?: "service-management" | "project-read"
}): string {
  const qs = new URLSearchParams({
    provider: params.provider,
    channel: params.channel,
    cloud: params.cloud,
  })
  if (params.upgrade) {
    qs.set("upgrade", params.upgrade)
  }
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
