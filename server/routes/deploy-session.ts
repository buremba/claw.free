import type { Context } from "hono"
import { getUserById } from "../db.js"
import { resolveGoogleAuth } from "../lib/google-auth.js"

export async function deploySession(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) {
    return c.json({ error: "Not logged in" }, 401)
  }

  let user:
    | {
        name: string
        email: string
        image: string | null
      }
    | null = null
  try {
    user = await getUserById(auth.session.userId)
  } catch {
    user = null
  }

  return c.json({
    provider: "claude",
    channel: "telegram",
    userName: user?.name ?? auth.session.userName ?? "",
    userEmail: user?.email ?? auth.session.userEmail ?? "",
    userPicture: user?.image ?? auth.session.userPicture ?? "",
  })
}
