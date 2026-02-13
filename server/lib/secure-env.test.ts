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
})
