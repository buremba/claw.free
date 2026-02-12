export function sanitizeGoogleErrorMessage(message: string): string {
  return message
    .replace(/\s*Help Token:\s*\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}
