import { describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { validateInitData, isValidBotToken } from "./telegram"

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"

function buildInitData(user: object, botToken: string, authDate?: number): string {
  const params = new URLSearchParams()
  params.set("user", JSON.stringify(user))
  params.set("auth_date", String(authDate ?? Math.floor(Date.now() / 1000)))

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest()
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex")

  params.set("hash", hash)
  return params.toString()
}

describe("validateInitData", () => {
  it("validates correct initData", () => {
    const user = { id: 12345, first_name: "Test", username: "testuser" }
    const initData = buildInitData(user, BOT_TOKEN)
    const result = validateInitData(initData, BOT_TOKEN)
    expect(result).toEqual(user)
  })

  it("rejects wrong bot token", () => {
    const user = { id: 12345, first_name: "Test" }
    const initData = buildInitData(user, BOT_TOKEN)
    const result = validateInitData(initData, "999:wrong-token-aaaaaaaaaaaaaaaaaaaaaaaa")
    expect(result).toBeNull()
  })

  it("rejects expired initData", () => {
    const user = { id: 12345, first_name: "Test" }
    const oldDate = Math.floor(Date.now() / 1000) - 600 // 10 min ago
    const initData = buildInitData(user, BOT_TOKEN, oldDate)
    const result = validateInitData(initData, BOT_TOKEN, 300)
    expect(result).toBeNull()
  })

  it("rejects missing hash", () => {
    const result = validateInitData("user=%7B%7D&auth_date=1234", BOT_TOKEN)
    expect(result).toBeNull()
  })

  it("rejects empty string", () => {
    expect(validateInitData("", BOT_TOKEN)).toBeNull()
  })
})

describe("isValidBotToken", () => {
  it("accepts valid token format", () => {
    // 35 chars after colon
    expect(isValidBotToken("123456789:AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDD")).toBe(true)
  })

  it("rejects too short", () => {
    expect(isValidBotToken("123:abc")).toBe(false)
  })

  it("rejects no colon", () => {
    expect(isValidBotToken("123456789ABCdefGHIjklMNOpqrstuvwxyz12345")).toBe(false)
  })

  it("rejects empty", () => {
    expect(isValidBotToken("")).toBe(false)
  })
})
