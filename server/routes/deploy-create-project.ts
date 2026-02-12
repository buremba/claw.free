import type { Context } from "hono"
import { resolveGoogleAuth } from "../lib/google-auth.js"

export async function deployCreateProject(c: Context): Promise<Response> {
  const auth = await resolveGoogleAuth(c)
  if (!auth) {
    return c.json({ error: "Not logged in" }, 401)
  }
  return c.json(
    {
      error:
        "Project creation from claw.free is disabled in least-privilege mode. Create your GCP project in Google Cloud Console, then deploy using its Project ID.",
    },
    403,
  )
}
