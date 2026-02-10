import { useEffect } from "react"
import { createRootRoute, Outlet } from "@tanstack/react-router"

function RootComponent() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = (e: MediaQueryListEvent | MediaQueryList) =>
      document.documentElement.classList.toggle("dark", e.matches)

    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
    </div>
  )
}

export const Route = createRootRoute({
  component: RootComponent,
})
