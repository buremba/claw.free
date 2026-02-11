import type { Context } from "hono"
import { clearSessionCookie } from "../lib/session.js"

export async function authLogout(c: Context): Promise<Response> {
  const baseUrl = process.env.BASE_URL ?? new URL(c.req.url).origin
  clearSessionCookie(c)
  return c.redirect(`${baseUrl}/`, 302)
}
