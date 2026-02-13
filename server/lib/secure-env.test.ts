import { describe, test, expect } from "vitest"
import {
  makePlaceholder,
  findPlaceholders,
  scanHeadersForPlaceholders,
  hostMatches,
  hostMatchesBlocklist,
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

describe("hostMatchesBlocklist", () => {
  test("exact match", () => {
    expect(hostMatchesBlocklist("localhost", ["localhost"])).toBe(true)
  })

  test("case insensitive", () => {
    expect(hostMatchesBlocklist("LOCALHOST", ["localhost"])).toBe(true)
  })

  test("no match", () => {
    expect(hostMatchesBlocklist("api.anthropic.com", ["localhost"])).toBe(false)
  })

  test("wildcard suffix (*.example.com)", () => {
    expect(hostMatchesBlocklist("internal.corp.com", ["*.corp.com"])).toBe(true)
    expect(hostMatchesBlocklist("corp.com", ["*.corp.com"])).toBe(true)
    expect(hostMatchesBlocklist("evil.com", ["*.corp.com"])).toBe(false)
  })

  test("wildcard prefix for IP ranges (10.*)", () => {
    expect(hostMatchesBlocklist("10.0.0.1", ["10.*"])).toBe(true)
    expect(hostMatchesBlocklist("10.255.255.255", ["10.*"])).toBe(true)
    expect(hostMatchesBlocklist("110.0.0.1", ["10.*"])).toBe(false)
  })

  test("192.168.* blocks RFC 1918 range", () => {
    expect(hostMatchesBlocklist("192.168.1.1", ["192.168.*"])).toBe(true)
    expect(hostMatchesBlocklist("192.168.0.1", ["192.168.*"])).toBe(true)
    expect(hostMatchesBlocklist("192.169.1.1", ["192.168.*"])).toBe(false)
  })

  test("172.16.* through 172.31.* blocks", () => {
    expect(hostMatchesBlocklist("172.16.0.1", ["172.16.*"])).toBe(true)
    expect(hostMatchesBlocklist("172.31.255.255", ["172.31.*"])).toBe(true)
    expect(hostMatchesBlocklist("172.32.0.1", ["172.32.*"])).toBe(true) // if in list
    expect(hostMatchesBlocklist("172.15.0.1", ["172.16.*"])).toBe(false)
  })

  test("cloud metadata IPs", () => {
    expect(hostMatchesBlocklist("169.254.169.254", ["169.254.169.254"])).toBe(true)
    expect(hostMatchesBlocklist("metadata.google.internal", ["metadata.google.internal"])).toBe(true)
  })

  test("empty patterns matches nothing", () => {
    expect(hostMatchesBlocklist("anything.com", [])).toBe(false)
  })

  test("multiple patterns", () => {
    const patterns = ["localhost", "127.0.0.1", "10.*", "192.168.*"]
    expect(hostMatchesBlocklist("localhost", patterns)).toBe(true)
    expect(hostMatchesBlocklist("127.0.0.1", patterns)).toBe(true)
    expect(hostMatchesBlocklist("10.0.0.5", patterns)).toBe(true)
    expect(hostMatchesBlocklist("192.168.1.100", patterns)).toBe(true)
    expect(hostMatchesBlocklist("api.anthropic.com", patterns)).toBe(false)
  })
})
