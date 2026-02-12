import { createFileRoute, Outlet } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { MiniAuthContext, type MiniAuthState } from "@/lib/mini-auth"

function getTelegramWebApp() {
  return (window as unknown as { Telegram?: { WebApp?: { expand: () => void; initData: string; themeParams?: Record<string, string> } } }).Telegram?.WebApp
}

async function authenticate(): Promise<MiniAuthState | string> {
  const tg = getTelegramWebApp()
  tg?.expand?.()

  if (tg?.themeParams) {
    const root = document.documentElement
    if (tg.themeParams.bg_color) root.style.setProperty("--tg-bg", tg.themeParams.bg_color)
    if (tg.themeParams.text_color) root.style.setProperty("--tg-text", tg.themeParams.text_color)
  }

  const initData = tg?.initData
  if (!initData) return "Open this page inside Telegram"

  const res = await fetch("/api/mini/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData }),
  })
  const data = await res.json()
  if (data.error) return data.error as string
  return { token: data.token, user: data.user } as MiniAuthState
}

function MiniLayout() {
  const [state, setState] = useState<{ auth: MiniAuthState | null; error: string | null }>({ auth: null, error: null })
  const didInit = useRef(false)

  useEffect(() => {
    if (didInit.current) return
    didInit.current = true

    authenticate()
      .then((result) => {
        if (typeof result === "string") {
          setState({ auth: null, error: result })
        } else {
          setState({ auth: result, error: null })
        }
      })
      .catch(() => setState({ auth: null, error: "Authentication failed" }))
  }, [])

  if (state.error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="text-center">
          <p className="text-lg font-semibold text-destructive">{state.error}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Open this page from the Telegram bot.
          </p>
        </div>
      </div>
    )
  }

  if (!state.auth) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-3 text-sm text-muted-foreground">Authenticating...</p>
        </div>
      </div>
    )
  }

  return (
    <MiniAuthContext.Provider value={state.auth}>
      <div className="min-h-screen bg-background text-foreground p-4">
        <Outlet />
      </div>
    </MiniAuthContext.Provider>
  )
}

export const Route = createFileRoute("/mini")({
  component: MiniLayout,
})
