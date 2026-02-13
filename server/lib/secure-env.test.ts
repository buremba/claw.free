import { describe, test, expect } from "vitest"
import {
  makePlaceholder,
  findPlaceholders,
  scanHeadersForPlaceholders,
  hostMatches,
} from "./secure-env.js"

describe("makePlaceholder", () => {
  test("generates CLAW_SE_ prefixed placeholder", () => {
    expect(makePlaceholder("ANTHROPIC_KEY")).toBe("CLAW_SE_ANTHROPIC_KEY")
  })

  test("uppercases the name", () => {
    expect(makePlaceholder("openai_key")).toBe("CLAW_SE_OPENAI_KEY")
  })
})

describe("findPlaceholders", () => {
  test("finds single placeholder", () => {
    expect(findPlaceholders("Bearer CLAW_SE_ANTHROPIC_KEY")).toEqual(["ANTHROPIC_KEY"])
  })

  test("finds multiple placeholders", () => {
    const result = findPlaceholders("CLAW_SE_KEY1 and CLAW_SE_KEY2")
    expect(result).toEqual(["KEY1", "KEY2"])
  })

  test("deduplicates", () => {
    const result = findPlaceholders("CLAW_SE_KEY1 CLAW_SE_KEY1")
    expect(result).toEqual(["KEY1"])
  })

  test("returns empty for no placeholders", () => {
    expect(findPlaceholders("sk-ant-api03-xxx")).toEqual([])
  })

  test("handles placeholder as entire value", () => {
    expect(findPlaceholders("CLAW_SE_OPENAI_KEY")).toEqual(["OPENAI_KEY"])
  })
})

describe("scanHeadersForPlaceholders", () => {
  test("finds placeholders in auth headers", () => {
    const result = scanHeadersForPlaceholders({
      "authorization": "Bearer CLAW_SE_OPENAI_KEY",
      "x-api-key": "CLAW_SE_ANTHROPIC_KEY",
      "content-type": "application/json",
    })
    expect(result.get("authorization")).toEqual(["OPENAI_KEY"])
    expect(result.get("x-api-key")).toEqual(["ANTHROPIC_KEY"])
    expect(result.has("content-type")).toBe(false)
  })

  test("returns empty map when no placeholders", () => {
    const result = scanHeadersForPlaceholders({
      "authorization": "Bearer sk-real-key",
      "content-type": "application/json",
    })
    expect(result.size).toBe(0)
  })
})

describe("hostMatches", () => {
  test("exact match", () => {
    expect(hostMatches("api.anthropic.com", ["api.anthropic.com"])).toBe(true)
  })

  test("case insensitive", () => {
    expect(hostMatches("API.Anthropic.COM", ["api.anthropic.com"])).toBe(true)
  })

  test("wildcard match", () => {
    expect(hostMatches("api.anthropic.com", ["*.anthropic.com"])).toBe(true)
  })

  test("wildcard matches subdomain", () => {
    expect(hostMatches("beta.api.anthropic.com", ["*.anthropic.com"])).toBe(true)
  })

  test("wildcard matches base domain", () => {
    expect(hostMatches("anthropic.com", ["*.anthropic.com"])).toBe(true)
  })

  test("no match", () => {
    expect(hostMatches("evil.com", ["api.anthropic.com"])).toBe(false)
  })

  test("no match with wildcard", () => {
    expect(hostMatches("evil.com", ["*.anthropic.com"])).toBe(false)
  })

  test("multiple allowed hosts", () => {
    expect(hostMatches("api.openai.com", ["api.anthropic.com", "api.openai.com"])).toBe(true)
  })

  test("empty allowed hosts", () => {
    expect(hostMatches("api.anthropic.com", [])).toBe(false)
  })

  // SSRF prevention — these hosts should never appear in allowedHosts,
  // and even if they did, the allowlist-only design means only hosts with
  // registered secrets can be reached through the proxy.
  test("blocks localhost when not in allowlist", () => {
    expect(hostMatches("localhost", ["api.anthropic.com"])).toBe(false)
  })

  test("blocks 127.0.0.1 when not in allowlist", () => {
    expect(hostMatches("127.0.0.1", ["api.anthropic.com"])).toBe(false)
  })

  test("blocks GCP metadata IP when not in allowlist", () => {
    expect(hostMatches("169.254.169.254", ["api.anthropic.com"])).toBe(false)
  })

  test("blocks internal IPs when not in allowlist", () => {
    expect(hostMatches("10.0.0.1", ["api.anthropic.com"])).toBe(false)
    expect(hostMatches("192.168.1.1", ["*.anthropic.com"])).toBe(false)
    expect(hostMatches("172.16.0.1", ["api.openai.com"])).toBe(false)
  })

  test("wildcard does not match unrelated TLDs", () => {
    // Ensure *.anthropic.com does not match anthropic.com.evil.com
    expect(hostMatches("anthropic.com.evil.com", ["*.anthropic.com"])).toBe(false)
  })
})
