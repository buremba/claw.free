import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useMiniAuth, miniApiFetch } from "@/lib/mini-auth"
import { Button } from "@/components/ui/button"

interface BotDetail {
  id: string
  botUsername: string | null
  status: string
  vmIp: string | null
  vmName: string | null
  error: string | null
  createdAt: string
}

function BotDetailPage() {
  const { id } = Route.useParams()
  const { token } = useMiniAuth()
  const navigate = useNavigate()
  const [bot, setBot] = useState<BotDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    miniApiFetch(token, `/api/mini/bots/${id}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setBot(null)
        else setBot(data)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [token, id])

  async function handleDelete() {
    if (!confirm("Delete this bot and its VM?")) return
    setDeleting(true)
    try {
      await miniApiFetch(token, `/api/mini/bots/${id}`, { method: "DELETE" })
      navigate({ to: "/mini" })
    } catch {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!bot) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Bot not found</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate({ to: "/mini" })}>
          Back
        </Button>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold">
          {bot.botUsername ? `@${bot.botUsername}` : "Bot Detail"}
        </h1>
        <p className="text-sm text-muted-foreground capitalize">{bot.status}</p>
      </div>

      <div className="rounded-lg border divide-y">
        <Row label="Status" value={bot.status} />
        <Row label="VM IP" value={bot.vmIp ?? "-"} />
        <Row label="VM Name" value={bot.vmName ?? "-"} />
        <Row
          label="Created"
          value={new Date(bot.createdAt).toLocaleDateString()}
        />
      </div>

      {bot.error && (
        <div className="rounded-lg border border-destructive/50 p-3">
          <p className="text-sm text-destructive">{bot.error}</p>
        </div>
      )}

      <div className="space-y-2">
        <Button variant="outline" className="w-full" onClick={() => navigate({ to: "/mini" })}>
          Back to Dashboard
        </Button>
        <Button
          variant="destructive"
          className="w-full"
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting ? "Deleting..." : "Delete Bot"}
        </Button>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  )
}

export const Route = createFileRoute("/mini/bot/$id")({
  component: BotDetailPage,
})
