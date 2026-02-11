export interface GuestAttributesResponse {
  queryValue?: {
    items?: Array<{
      key?: string
      value?: string
    }>
  }
}

export type SetupProgress =
  | { status: "done" }
  | { status: "health-checking" }
  | { status: "error"; error: string }

export function extractSetupMarkerValue(
  guest: GuestAttributesResponse | null | undefined,
): string | null {
  const items = guest?.queryValue?.items
  if (!Array.isArray(items) || items.length === 0) return null

  const directMatch = items.find(
    (item) =>
      typeof item?.value === "string" &&
      (item.key === "setup" ||
        item.key === "openclaw/setup" ||
        item.key?.endsWith("/setup")),
  )
  if (directMatch?.value) {
    const value = directMatch.value.trim()
    return value.length > 0 ? value : null
  }

  if (
    items.length === 1 &&
    typeof items[0]?.value === "string" &&
    (items[0]?.key == null || items[0]?.key === "")
  ) {
    const value = items[0].value.trim()
    return value.length > 0 ? value : null
  }

  return null
}

export function resolveSetupProgress(
  markerValue: string | null | undefined,
): SetupProgress {
  if (!markerValue) {
    return { status: "health-checking" }
  }

  if (markerValue === "ready") {
    return { status: "done" }
  }

  if (markerValue.startsWith("failed:")) {
    const reason = markerValue.slice("failed:".length).trim() || "unknown"
    return { status: "error", error: `VM setup failed: ${reason}` }
  }

  return { status: "health-checking" }
}
