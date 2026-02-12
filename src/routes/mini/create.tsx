import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useMiniAuth, miniApiFetch } from "@/lib/mini-auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Step = "token" | "provider" | "credentials" | "deploy" | "done"

interface BotInfo {
  id: number
  username: string
  name: string
}

function CreateBot() {
  const { token } = useMiniAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>("token")
  const [botToken, setBotToken] = useState("")
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null)
  const [provider, setProvider] = useState("claude")
  const [llmKey, setLlmKey] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deployStatus, setDeployStatus] = useState("")

  async function validateToken() {
    setLoading(true)
    setError(null)
    try {
      const res = await miniApiFetch(token, "/api/mini/validate-token", {
        method: "POST",
        body: JSON.stringify({ token: botToken }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
      } else {
        setBotInfo(data.bot)
        setStep("provider")
      }
    } catch {
      setError("Validation failed")
    } finally {
      setLoading(false)
    }
  }

  async function deploy() {
    setLoading(true)
    setError(null)
    setStep("deploy")
    try {
      const res = await miniApiFetch(token, "/api/mini/bots", {
        method: "POST",
        body: JSON.stringify({
          botToken,
          llmProvider: provider,
          llmCredentials: llmKey || undefined,
          botName: botInfo?.username,
        }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
        setStep("credentials")
        return
      }
      pollDeployStatus(data.deploymentId)
    } catch {
      setError("Deployment failed")
      setStep("credentials")
    } finally {
      setLoading(false)
    }
  }

  async function pollDeployStatus(id: string) {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      try {
        const res = await miniApiFetch(token, `/api/mini/bots/${id}`)
        const data = await res.json()
        setDeployStatus(data.status)
        if (data.status === "done" || data.status === "running") {
          setStep("done")
          return
        }
        if (data.status === "error") {
          setError(data.error ?? "Deployment failed")
          return
        }
      } catch { break }
    }
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <h1 className="text-xl font-bold">Create a Bot</h1>

      {step === "token" && (
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2">
            <p className="text-sm font-medium">Step 1: Create your bot</p>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Open <strong>@BotFather</strong> in Telegram</li>
              <li>Send <code>/newbot</code></li>
              <li>Follow the prompts to name your bot</li>
              <li>Copy the bot token and paste it below</li>
            </ol>
          </div>
          <div className="space-y-2">
            <Label htmlFor="token">Bot Token</Label>
            <Input
              id="token"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:ABC-DEF..."
              className="font-mono text-sm"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={validateToken} disabled={!botToken || loading} className="w-full">
            {loading ? "Validating..." : "Validate Token"}
          </Button>
        </div>
      )}

      {step === "provider" && botInfo && (
        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">Bot verified</p>
            <p className="font-medium">@{botInfo.username}</p>
          </div>
          <div className="space-y-2">
            <Label>AI Provider</Label>
            <div className="grid grid-cols-3 gap-2">
              {(["claude", "openai", "kimi"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setProvider(p)}
                  className={`rounded-lg border p-3 text-sm font-medium transition-colors ${
                    provider === p
                      ? "border-primary bg-primary/10 text-primary"
                      : "hover:bg-accent"
                  }`}
                >
                  {p === "claude" ? "Claude" : p === "openai" ? "ChatGPT" : "Kimi"}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={() => setStep("credentials")} className="w-full">
            Next
          </Button>
        </div>
      )}

      {step === "credentials" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="llmkey">
              {provider === "claude" ? "Claude API Key" : provider === "openai" ? "OpenAI API Key" : "Kimi API Key"}
              <span className="text-muted-foreground ml-1">(optional)</span>
            </Label>
            <Input
              id="llmkey"
              type="password"
              value={llmKey}
              onChange={(e) => setLlmKey(e.target.value)}
              placeholder="sk-..."
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              You can add this later through your bot.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={deploy} disabled={loading} className="w-full">
            {loading ? "Deploying..." : "Deploy Bot"}
          </Button>
        </div>
      )}

      {step === "deploy" && (
        <div className="text-center py-8 space-y-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <div>
            <p className="font-medium">Deploying your bot...</p>
            <p className="text-sm text-muted-foreground capitalize">{deployStatus || "starting"}</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      )}

      {step === "done" && botInfo && (
        <div className="text-center py-8 space-y-4">
          <div className="text-4xl">&#x2705;</div>
          <div>
            <p className="text-lg font-bold">Bot is live!</p>
            <p className="text-muted-foreground">
              Open @{botInfo.username} in Telegram and send a message.
            </p>
          </div>
          <Button onClick={() => navigate({ to: "/mini" })} className="w-full">
            Back to Dashboard
          </Button>
        </div>
      )}
    </div>
  )
}

export const Route = createFileRoute("/mini/create")({
  component: CreateBot,
})
