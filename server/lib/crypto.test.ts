import { describe, expect, it, beforeEach } from "vitest"
import { encrypt, decrypt } from "./crypto"

beforeEach(() => {
  // 32 bytes = 64 hex chars
  process.env.ENCRYPTION_KEY = "a".repeat(64)
})

describe("encrypt / decrypt", () => {
  it("round-trips plaintext", () => {
    const plaintext = "my-secret-bot-token-123:abc"
    const encrypted = encrypt(plaintext)
    expect(encrypted).not.toBe(plaintext)
    expect(decrypt(encrypted)).toBe(plaintext)
  })

  it("produces different ciphertext for same plaintext (random IV)", () => {
    const plaintext = "same-input"
    const a = encrypt(plaintext)
    const b = encrypt(plaintext)
    expect(a).not.toBe(b)
    expect(decrypt(a)).toBe(plaintext)
    expect(decrypt(b)).toBe(plaintext)
  })

  it("handles empty string", () => {
    const encrypted = encrypt("")
    expect(decrypt(encrypted)).toBe("")
  })

  it("handles unicode", () => {
    const plaintext = "token-with-emoji-🔑"
    expect(decrypt(encrypt(plaintext))).toBe(plaintext)
  })

  it("rejects tampered ciphertext", () => {
    const encrypted = encrypt("secret")
    const tampered = encrypted.slice(0, -2) + "XX"
    expect(() => decrypt(tampered)).toThrow()
  })
})
