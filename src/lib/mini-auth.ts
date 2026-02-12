import { createContext, useContext } from "react"

export interface MiniUser {
  id: string
  telegramId: number
  name: string | null
  username: string | null
  photoUrl: string | null
}

export interface MiniAuthState {
  token: string
  user: MiniUser
}

export const MiniAuthContext = createContext<MiniAuthState | null>(null)

export function useMiniAuth() {
  const ctx = useContext(MiniAuthContext)
  if (!ctx) throw new Error("useMiniAuth must be used inside Mini App")
  return ctx
}

export function miniApiFetch(token: string, path: string, opts?: RequestInit) {
  return fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...opts?.headers,
    },
  })
}
