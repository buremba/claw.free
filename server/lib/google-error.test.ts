import { describe, expect, it } from "vitest"
import { sanitizeGoogleErrorMessage } from "./google-error.js"

describe("sanitizeGoogleErrorMessage", () => {
  it("removes Google Help Token suffix", () => {
    const input =
      "Billing account is not found. Help Token: AcxmRmLOan0HY-SP6Xm7yaiu-FQummO3"
    expect(sanitizeGoogleErrorMessage(input)).toBe(
      "Billing account is not found.",
    )
  })

  it("keeps message unchanged when no token is present", () => {
    const input = "Compute Engine API is disabled for this project."
    expect(sanitizeGoogleErrorMessage(input)).toBe(input)
  })
})
