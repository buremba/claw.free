import type { Context } from "hono"
import { getAccountByUserId } from "../db.js"
import { getSession } from "./session.js"

interface GoogleAuthContext {
  session: NonNullable<ReturnType<typeof getSession>>
  accessToken: string
  accountId: string
}

export async function resolveGoogleAuth(
  c: Context,
): Promise<GoogleAuthContext | null> {
  const session = getSession(c)
  if (!session) return null

  try {
    const account = await getAccountByUserId(session.userId, "google")
    if (account?.accessToken) {
      return {
        session,
        accessToken: account.accessToken,
        accountId: account.id,
      }
    }
  } catch (error) {
    console.warn("DB lookup failed; falling back to cookie auth context.", error)
  }

  if (!session.accessToken) {
    return null
  }

  return {
    session,
    accessToken: session.accessToken,
    accountId: session.accountId,
  }
}
