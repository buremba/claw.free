export const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000
export const DEFAULT_MACHINE_TYPE = "e2-small"
export const DEFAULT_SOURCE_IMAGE =
  "projects/owletto-484401/global/images/family/nixos-openclaw"

const VM_NAME_MAX_LENGTH = 63
const VM_SUFFIX_LENGTH = 6
const VM_NAME_PREFIX = "openclaw"

export interface DeployMetadataInput {
  provider: string
  telegramToken: string
  botName: string
}

export interface BuildInstanceInput {
  zone: string
  vmName: string
  provider: string
  telegramToken: string
  botName: string
  sourceImage: string
  machineType?: string
}

export function sanitizeBotName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

  const withFallback = cleaned || "bot"
  const withPrefix = /^[a-z]/.test(withFallback)
    ? withFallback
    : `${VM_NAME_PREFIX}-${withFallback}`

  return withPrefix.replace(/-+/g, "-").replace(/^-|-$/g, "")
}

export function generateVmName(botName: string): string {
  const base = sanitizeBotName(botName)
  const maxBaseLength = VM_NAME_MAX_LENGTH - VM_SUFFIX_LENGTH - 1
  const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/g, "") || "bot"
  return `${trimmedBase}-${randomHex(VM_SUFFIX_LENGTH)}`
}

export function buildMetadataItems(input: DeployMetadataInput): {
  key: string
  value: string
}[] {
  return [
    { key: "enable-guest-attributes", value: "TRUE" },
    { key: "TELEGRAM_TOKEN", value: input.telegramToken },
    { key: "LLM_PROVIDER", value: input.provider },
    { key: "BOT_NAME", value: input.botName },
  ]
}

export function buildInstanceRequestBody(input: BuildInstanceInput): unknown {
  const machineType = input.machineType ?? DEFAULT_MACHINE_TYPE
  return {
    name: input.vmName,
    machineType: `zones/${input.zone}/machineTypes/${machineType}`,
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: input.sourceImage,
          diskSizeGb: "30",
          diskType: `zones/${input.zone}/diskTypes/pd-standard`,
        },
      },
    ],
    networkInterfaces: [
      {
        network: "global/networks/default",
      },
    ],
    labels: {
      openclaw: "true",
      managedby: "clawfree",
    },
    metadata: {
      items: buildMetadataItems({
        provider: input.provider,
        telegramToken: input.telegramToken,
        botName: input.botName,
      }),
    },
  }
}

export function parseMachineType(machineTypeUrl: string | undefined): string {
  if (!machineTypeUrl) return ""
  const parts = machineTypeUrl.split("/")
  return parts[parts.length - 1] ?? ""
}

export function isDeployTimedOut(
  createdAt: number | undefined,
  now = Date.now(),
  timeoutMs = DEPLOY_TIMEOUT_MS,
): boolean {
  if (!createdAt) return false
  return now - createdAt > timeoutMs
}

function randomHex(length: number): string {
  const byteLength = Math.ceil(length / 2)
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length)
}
