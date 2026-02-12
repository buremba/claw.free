import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useMiniAuth, miniApiFetch } from "@/lib/mini-auth"
import { Button } from "@/components/ui/button"

interface Bot {
  id: string
  botUsername: string | null
  llmProvider: string
  status: string
  vmIp: string | null
  error: string | null
  createdAt: string
}

function MiniDashboard() {
  const { token, user } = useMiniAuth()
  const [bots, setBots] = useState<Bot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    miniApiFetch(token, "/api/mini/bots")
      .then((res) => res.json())
      .then((data) => setBots(data.bots ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [token])

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold">Your Bots</h1>
        <p className="text-sm text-muted-foreground">
          Welcome{user.name ? `, ${user.name}` : ""}
        </p>
      </div>

      {loading ? (
        <div className="text-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto" />
        </div>
      ) : bots.length === 0 ? (
        <div className="text-center py-12 space-y-4">
          <p className="text-muted-foreground">No bots yet</p>
          <Link to="/mini/create">
            <Button>Create your first bot</Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {bots.map((bot) => (
              <Link
                key={bot.id}
                to="/mini/bot/$id"
                params={{ id: bot.id }}
                className="block rounded-lg border p-4 hover:bg-accent transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">
                      {bot.botUsername ? `@${bot.botUsername}` : "Bot"}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {bot.llmProvider}
                    </p>
                  </div>
                  <StatusBadge status={bot.status} />
                </div>
                {bot.error && (
                  <p className="mt-2 text-xs text-destructive">{bot.error}</p>
                )}
              </Link>
            ))}
          </div>
          <Link to="/mini/create">
            <Button className="w-full">Create another bot</Button>
          </Link>
        </>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    done: "bg-green-500/10 text-green-500",
    running: "bg-green-500/10 text-green-500",
    creating: "bg-yellow-500/10 text-yellow-500",
    booting: "bg-yellow-500/10 text-yellow-500",
    "health-checking": "bg-yellow-500/10 text-yellow-500",
    error: "bg-red-500/10 text-red-500",
    pending: "bg-gray-500/10 text-gray-500",
  }
  return (
    <span className={`text-xs px-2 py-1 rounded-full ${colors[status] ?? colors.pending}`}>
      {status}
    </span>
  )
}

export const Route = createFileRoute("/mini/")({
  component: MiniDashboard,
})
