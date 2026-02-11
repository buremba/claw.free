export function getSessionId(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? ""
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/)
  return match ? match[1] : null
}

export function sessionCookie(sessionId: string, origin: string): string {
  const secure = origin.startsWith("https://") ? "; Secure" : ""
  return `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`
}
