import { describe, expect, it } from "vitest"
import { extractSetupMarkerValue, resolveSetupProgress } from "./setup-marker"

describe("extractSetupMarkerValue", () => {
  it("returns setup value from direct setup key", () => {
    expect(
      extractSetupMarkerValue({
        queryValue: {
          items: [{ key: "setup", value: "ready" }],
        },
      }),
    ).toBe("ready")
  })

  it("supports namespaced setup key", () => {
    expect(
      extractSetupMarkerValue({
        queryValue: {
          items: [{ key: "openclaw/setup", value: "failed:boom" }],
        },
      }),
    ).toBe("failed:boom")
  })

  it("falls back to single item value when key is absent", () => {
    expect(
      extractSetupMarkerValue({
        queryValue: {
          items: [{ value: "ready" }],
        },
      }),
    ).toBe("ready")
  })

  it("returns null when marker is missing", () => {
    expect(
      extractSetupMarkerValue({
        queryValue: {
          items: [{ key: "other", value: "x" }],
        },
      }),
    ).toBeNull()
  })

  it("returns null for null input", () => {
    expect(extractSetupMarkerValue(null)).toBeNull()
  })

  it("returns null for undefined input", () => {
    expect(extractSetupMarkerValue(undefined)).toBeNull()
  })

  it("returns null for empty items array", () => {
    expect(
      extractSetupMarkerValue({ queryValue: { items: [] } }),
    ).toBeNull()
  })

  it("returns null for missing queryValue", () => {
    expect(extractSetupMarkerValue({})).toBeNull()
  })

  it("trims whitespace from value", () => {
    expect(
      extractSetupMarkerValue({
        queryValue: { items: [{ key: "setup", value: "  ready  " }] },
      }),
    ).toBe("ready")
  })

  it("returns null for empty-after-trim value", () => {
    expect(
      extractSetupMarkerValue({
        queryValue: { items: [{ key: "setup", value: "   " }] },
      }),
    ).toBeNull()
  })
})

describe("resolveSetupProgress", () => {
  it("returns done for ready marker", () => {
    expect(resolveSetupProgress("ready")).toEqual({ status: "done" })
  })

  it("returns error for failed marker with reason", () => {
    expect(resolveSetupProgress("failed:missing-telegram-token")).toEqual({
      status: "error",
      error: "VM setup failed: missing-telegram-token",
    })
  })

  it("returns error with unknown for failed marker without reason", () => {
    expect(resolveSetupProgress("failed:")).toEqual({
      status: "error",
      error: "VM setup failed: unknown",
    })
  })

  it("returns health-checking when marker is absent", () => {
    expect(resolveSetupProgress(null)).toEqual({ status: "health-checking" })
  })

  it("returns health-checking for undefined", () => {
    expect(resolveSetupProgress(undefined)).toEqual({ status: "health-checking" })
  })

  it("returns health-checking for unrecognized marker values", () => {
    expect(resolveSetupProgress("initializing")).toEqual({ status: "health-checking" })
  })
})
