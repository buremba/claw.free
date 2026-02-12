import { describe, expect, it } from "vitest"
import {
  DEFAULT_MACHINE_TYPE,
  DEFAULT_SOURCE_IMAGE,
  buildInstanceRequestBody,
  buildMetadataItems,
  generateVmName,
  isDeployTimedOut,
  parseMachineType,
  sanitizeBotName,
} from "./deploy"

describe("sanitizeBotName", () => {
  it("normalizes mixed characters into a safe slug", () => {
    expect(sanitizeBotName("  My Bot!!!  ")).toBe("my-bot")
  })

  it("prepends a valid prefix when name does not start with a letter", () => {
    expect(sanitizeBotName("123-bot")).toBe("openclaw-123-bot")
  })
})

describe("generateVmName", () => {
  it("produces a valid gce vm name with suffix", () => {
    const vmName = generateVmName("My Bot")
    expect(vmName).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/)
    expect(vmName.length).toBeLessThanOrEqual(63)
    expect(vmName).toMatch(/-[a-f0-9]{6}$/)
  })
})

describe("buildMetadataItems", () => {
  it("includes required deployment metadata", () => {
    const items = buildMetadataItems({
      provider: "kimi",
      telegramToken: "token",
      botName: "bot-a",
    })
    expect(items).toContainEqual({
      key: "enable-guest-attributes",
      value: "TRUE",
    })
    expect(items).toContainEqual({
      key: "TELEGRAM_TOKEN",
      value: "token",
    })
    expect(items).toContainEqual({
      key: "LLM_PROVIDER",
      value: "kimi",
    })
    expect(items).toContainEqual({
      key: "BOT_NAME",
      value: "bot-a",
    })
  })
})

describe("buildInstanceRequestBody", () => {
  it("builds gce instance payload with private networking, labels, and metadata", () => {
    const payload = buildInstanceRequestBody({
      zone: "us-central1-a",
      vmName: "openclaw-bot-abc123",
      provider: "kimi",
      telegramToken: "token",
      botName: "bot-a",
      sourceImage: DEFAULT_SOURCE_IMAGE,
    }) as {
      machineType: string
      labels: Record<string, string>
      networkInterfaces: { network: string; accessConfigs?: unknown[] }[]
      metadata: { items: { key: string; value: string }[] }
    }

    expect(payload.machineType).toBe(
      "zones/us-central1-a/machineTypes/e2-small",
    )
    expect(payload.labels).toEqual({ openclaw: "true", managedby: "clawfree" })
    expect(payload.networkInterfaces[0]?.network).toBe("global/networks/default")
    expect(payload.networkInterfaces[0]?.accessConfigs).toBeUndefined()
    expect(payload.metadata.items).toContainEqual({
      key: "BOT_NAME",
      value: "bot-a",
    })
    expect(payload.metadata.items).toContainEqual({
      key: "LLM_PROVIDER",
      value: "kimi",
    })
  })

  it("uses custom machine type when provided", () => {
    const payload = buildInstanceRequestBody({
      zone: "us-west1-a",
      vmName: "openclaw-bot-def456",
      provider: "claude",
      telegramToken: "token",
      botName: "bot-b",
      sourceImage: DEFAULT_SOURCE_IMAGE,
      machineType: "e2-small",
    }) as { machineType: string }

    expect(payload.machineType).toBe("zones/us-west1-a/machineTypes/e2-small")
    expect(DEFAULT_MACHINE_TYPE).toBe("e2-small")
  })
})

describe("sanitizeBotName edge cases", () => {
  it("returns fallback for empty input", () => {
    expect(sanitizeBotName("")).toBe("bot")
  })

  it("strips all special characters leaving fallback", () => {
    expect(sanitizeBotName("!!!")).toBe("bot")
  })

  it("truncates very long names", () => {
    const long = "a".repeat(100)
    const name = generateVmName(long)
    expect(name.length).toBeLessThanOrEqual(63)
  })
})

describe("utility helpers", () => {
  it("extracts machine type name from compute url", () => {
    expect(
      parseMachineType("zones/us-central1-a/machineTypes/e2-micro"),
    ).toBe("e2-micro")
    expect(parseMachineType(undefined)).toBe("")
  })

  it("returns empty string for url with no segments", () => {
    expect(parseMachineType("e2-micro")).toBe("e2-micro")
  })

  it("marks deployments timed out correctly", () => {
    expect(isDeployTimedOut(Date.now() - 310000, Date.now(), 300000)).toBe(true)
    expect(isDeployTimedOut(Date.now() - 1000, Date.now(), 300000)).toBe(false)
  })

  it("returns false for undefined createdAt", () => {
    expect(isDeployTimedOut(undefined)).toBe(false)
  })
})
