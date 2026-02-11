import { useState, useEffect, useCallback } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { OpenClawLogo } from "@/components/OpenClawLogo"

interface SessionData {
  provider: string
  channel: string
  region: string
  telegramToken?: string
  telegramUserId?: string
  projects: { projectId: string; name: string }[]
}

interface DeployStatus {
  status: string
  ip?: string
  error?: string
}

export const Route = createFileRoute("/deploy")({
  component: DeployPage,
  validateSearch: (search: Record<string, unknown>) => ({
    session: (search.session as string) ?? "",
  }),
})

function DeployPage() {
  const { session: sessionId } = Route.useSearch()
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedProject, setSelectedProject] = useState("")
  const [telegramToken, setTelegramToken] = useState("")
  const [telegramUserId, setTelegramUserId] = useState("")

  const [deploymentId, setDeploymentId] = useState<string | null>(null)
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [detectingUserId, setDetectingUserId] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setError("No session ID provided. Please start from the home page.")
      setLoading(false)
      return
    }

    fetch(`/api/deploy/session?id=${sessionId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Session expired or invalid")
        return res.json() as Promise<SessionData>
      })
      .then((data) => {
        setSessionData(data)
        if (data.projects.length === 1) {
          setSelectedProject(data.projects[0].projectId)
        }
        if (data.telegramToken) setTelegramToken(data.telegramToken)
        if (data.telegramUserId) setTelegramUserId(data.telegramUserId)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [sessionId])

  // Poll deployment status
  useEffect(() => {
    if (!deploymentId) return

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/deploy/${deploymentId}`)
        if (!res.ok) return
        const data = (await res.json()) as DeployStatus
        setDeployStatus(data)
        if (data.status === "done" || data.status === "error") {
          clearInterval(interval)
        }
      } catch {
        // Retry on next interval
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [deploymentId])

  const detectTelegramUserId = useCallback(async () => {
    if (!telegramToken.trim()) return
    setDetectingUserId(true)
    setDetectError(null)
    try {
      const res = await fetch("/api/telegram/detect-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: telegramToken.trim() }),
      })
      const data = (await res.json()) as { userId?: string; error?: string }
      if (!res.ok || !data.userId) {
        setDetectError(data.error ?? "Could not detect user ID")
      } else {
        setTelegramUserId(data.userId)
      }
    } catch {
      setDetectError("Failed to detect user ID")
    } finally {
      setDetectingUserId(false)
    }
  }, [telegramToken])

  const handleDeploy = useCallback(async () => {
    if (!selectedProject || !telegramToken || !telegramUserId) return
    setDeploying(true)

    try {
      const res = await fetch("/api/deploy/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          projectId: selectedProject,
          telegramToken,
          telegramUserId,
        }),
      })

      const data = (await res.json()) as { deploymentId?: string; error?: string }
      if (!res.ok || !data.deploymentId) {
        setError(data.error ?? "Deployment failed")
        setDeploying(false)
        return
      }

      setDeploymentId(data.deploymentId)
      setDeployStatus({ status: "creating" })
    } catch {
      setError("Failed to start deployment")
      setDeploying(false)
    }
  }, [sessionId, selectedProject, telegramToken, telegramUserId])

  const canDeploy =
    selectedProject !== "" &&
    telegramToken.trim() !== "" &&
    telegramUserId.trim() !== "" &&
    !deploying &&
    !deploymentId

  if (loading) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <OpenClawLogo className="h-12 w-12 mx-auto mb-4 animate-pulse" />
        <p className="text-muted-foreground">Loading session...</p>
      </div>
    )
  }

  if (error && !sessionData) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <OpenClawLogo className="h-12 w-12 mx-auto mb-4" />
        <p className="text-destructive mb-4">{error}</p>
        <Button asChild variant="outline">
          <a href="/">Back to home</a>
        </Button>
      </div>
    )
  }

  if (deploymentId && deployStatus) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16">
        <div className="text-center mb-8">
          <OpenClawLogo className="h-12 w-12 mx-auto mb-4" />
          <h1 className="text-2xl font-bold">Deploying OpenClaw</h1>
        </div>

        <div className="rounded-2xl border bg-card p-6 sm:p-8 space-y-6">
          <DeployProgress status={deployStatus.status} />

          {deployStatus.status === "error" && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
              {deployStatus.error ?? "An error occurred during deployment."}
            </div>
          )}

          {deployStatus.status === "done" && deployStatus.ip && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
                <p className="font-medium text-foreground">Deployment complete!</p>
                <p className="text-muted-foreground">
                  Your VM is running at{" "}
                  <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                    {deployStatus.ip}
                  </code>
                </p>
                <p className="text-muted-foreground">
                  OpenClaw API:{" "}
                  <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                    http://{deployStatus.ip}:18789
                  </code>
                </p>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-1.5 text-muted-foreground">
                <p className="font-medium text-foreground">Next steps:</p>
                <p>1. Open Telegram and message your bot</p>
                <p>2. Follow the auth instructions your bot sends you</p>
                <p>3. Start chatting!</p>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <div className="text-center mb-8">
        <OpenClawLogo className="h-12 w-12 mx-auto mb-4" />
        <h1 className="text-2xl font-bold">Configure deployment</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Select your GCP project and set up Telegram to continue.
        </p>
      </div>

      <div className="rounded-2xl border bg-card p-6 sm:p-8 space-y-8">
        {/* Project picker */}
        <div className="space-y-3">
          <Label htmlFor="project" className="text-base font-semibold">
            GCP Project
          </Label>
          {sessionData && sessionData.projects.length > 1 ? (
            <select
              id="project"
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="">Select a project...</option>
              {sessionData.projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name} ({p.projectId})
                </option>
              ))}
            </select>
          ) : sessionData && sessionData.projects.length === 1 ? (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              {sessionData.projects[0].name} ({sessionData.projects[0].projectId})
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No GCP projects found in your account.</p>
          )}
        </div>

        {/* Telegram setup */}
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Telegram setup</h2>

          <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground space-y-1.5">
            <p>
              1. Open{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                @BotFather
              </a>
              , send{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">/newbot</code>
              , and copy the token below
            </p>
            <p>2. Send any message to your new bot</p>
            <p>3. Click "Detect my ID" to auto-fill your user ID</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="telegram-token">Bot Token</Label>
            <Input
              id="telegram-token"
              type="text"
              placeholder="123456:ABC-DEF..."
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="telegram-user-id">Your User ID</Label>
            <div className="flex gap-2">
              <Input
                id="telegram-user-id"
                type="text"
                placeholder="123456789"
                value={telegramUserId}
                onChange={(e) => setTelegramUserId(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 self-center"
                disabled={!telegramToken.trim() || detectingUserId}
                onClick={detectTelegramUserId}
              >
                {detectingUserId ? "Detecting..." : "Detect my ID"}
              </Button>
            </div>
            {detectError && (
              <p className="text-xs text-destructive">{detectError}</p>
            )}
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        <Button
          size="lg"
          className="w-full text-base"
          disabled={!canDeploy}
          onClick={handleDeploy}
        >
          {deploying ? "Starting..." : "Deploy"}
        </Button>
      </div>
    </div>
  )
}

function DeployProgress({ status }: { status: string }) {
  const steps = [
    { key: "creating", label: "Creating VM..." },
    { key: "booting", label: "Booting..." },
    { key: "done", label: "Done!" },
  ]

  const currentIdx = steps.findIndex((s) => s.key === status)
  const isError = status === "error"

  return (
    <div className="space-y-3">
      {steps.map((step, i) => {
        const isActive = step.key === status
        const isComplete = !isError && currentIdx > i
        const isPending = !isError && currentIdx < i

        return (
          <div key={step.key} className="flex items-center gap-3">
            <div
              className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-medium ${
                isComplete
                  ? "bg-primary text-primary-foreground"
                  : isActive
                    ? "bg-primary/20 text-primary border border-primary"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isComplete ? (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                i + 1
              )}
            </div>
            <span
              className={`text-sm ${
                isActive
                  ? "text-foreground font-medium"
                  : isPending
                    ? "text-muted-foreground"
                    : isComplete
                      ? "text-foreground"
                      : "text-muted-foreground"
              }`}
            >
              {step.label}
            </span>
            {isActive && status !== "done" && (
              <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            )}
          </div>
        )
      })}
    </div>
  )
}
