import { describe, expect, it, beforeEach } from "vitest"
import { signState, verifyState } from "./session"

beforeEach(() => {
  // Ensure deterministic secret for tests
  process.env.COOKIE_SECRET = "test-secret-for-unit-tests"
})

describe("signState / verifyState", () => {
  it("round-trips state data", () => {
    const data = { redirect: "/dashboard", nonce: "abc123" }
    const signed = signState(data)
    const verified = verifyState(signed)
    expect(verified).toEqual(data)
  })

  it("rejects tampered payload", () => {
    const signed = signState({ key: "value" })
    const [payload, sig] = signed.split(".")
    // Flip a character in the payload
    const tampered = payload.slice(0, -1) + "X" + "." + sig
    expect(verifyState(tampered)).toBeNull()
  })

  it("rejects tampered signature", () => {
    const signed = signState({ key: "value" })
    const tampered = signed.slice(0, -1) + "X"
    expect(verifyState(tampered)).toBeNull()
  })

  it("rejects value without separator", () => {
    expect(verifyState("noseparatorhere")).toBeNull()
  })

  it("rejects empty string", () => {
    expect(verifyState("")).toBeNull()
  })

  it("produces different signatures for different data", () => {
    const a = signState({ v: "1" })
    const b = signState({ v: "2" })
    expect(a).not.toBe(b)
  })

  it("produces consistent signatures for same data", () => {
    const data = { v: "same" }
    expect(signState(data)).toBe(signState(data))
  })
})
