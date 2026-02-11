import { useState, useEffect, useCallback } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ModelSelector } from "@/components/ModelSelector"
import { ChannelSelector, type Channel } from "@/components/ChannelSelector"
import { CloudSelector, type CloudProvider } from "@/components/CloudSelector"
import { RegionPicker } from "@/components/RegionPicker"
import { OpenClawLogo } from "@/components/OpenClawLogo"
import {
  buildAuthUrl,
  guessRegion,
  type LlmProvider,
  type Region,
} from "@/lib/wizard-state"

interface SessionData {
  provider: string
  channel: string
  userName: string
  userEmail: string
  userPicture: string
  projects: { projectId: string; name: string }[]
}

interface ExistingVm {
  projectId: string
  name: string
  zone: string
  ip: string
  machineType: string
  status: string
}

interface DeployStatus {
  status: string
  ip?: string
  error?: string
}

export const Route = createFileRoute("/")({
  component: Home,
  validateSearch: (search: Record<string, unknown>) => ({
    provider: search.provider as string | undefined,
    channel: search.channel as string | undefined,
    cloud: search.cloud as string | undefined,
  }),
})

const PROVIDER_NAMES: Record<LlmProvider, string> = {
  kimi: "NVIDIA",
  claude: "Anthropic",
  openai: "OpenAI",
}

function Home() {
  const search = Route.useSearch()

  const [llmProvider, setLlmProvider] = useState<LlmProvider | null>(
    (search.provider as LlmProvider) ?? null,
  )
  const [channel, setChannel] = useState<Channel | null>(
    (search.channel as Channel) ?? null,
  )
  const [cloud, setCloud] = useState<CloudProvider | null>(
    (search.cloud as CloudProvider) ?? null,
  )
  const [region, setRegion] = useState<Region>(guessRegion())
  const [botName, setBotName] = useState("my-openclaw-bot")
  const [telegramToken, setTelegramToken] = useState("")

  // Session state — determined by cookie, not URL
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [selectedProject, setSelectedProject] = useState("")
  const [existingVms, setExistingVms] = useState<ExistingVm[]>([])

  // Create project state
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState("")
  const [creatingProject, setCreatingProject] = useState(false)
  const [createProjectError, setCreateProjectError] = useState<string | null>(null)

  // Deploy state
  const [deploymentId, setDeploymentId] = useState<string | null>(null)
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)

  const isLoggedIn = sessionData !== null

  // Try fetching session on mount (cookie-based auth)
  useEffect(() => {
    fetch("/api/deploy/session")
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as SessionData
        setSessionData(data)
        if (!llmProvider) setLlmProvider(data.provider as LlmProvider)
        if (!channel) setChannel(data.channel as Channel)
        if (!cloud) setCloud("gcp")
        if (data.projects.length === 1) {
          setSelectedProject(data.projects[0].projectId)
        }
      })
      .catch(() => {})
      .finally(() => setSessionLoading(false))
    // This effect intentionally runs once to hydrate from cookie session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch existing VMs when logged in
  useEffect(() => {
    if (!isLoggedIn) return

    fetch("/api/deploy/existing")
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as { vms: ExistingVm[] }
        setExistingVms(data.vms)
      })
      .catch(() => {})
  }, [isLoggedIn])

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
          setDeploying(false)
        }
      } catch {
        // Retry on next interval
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [deploymentId])

  const handleDeploy = useCallback(async () => {
    if (!selectedProject || !telegramToken || !region || !botName.trim()) return
    setDeploying(true)
    setDeployError(null)

    try {
      const res = await fetch("/api/deploy/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: selectedProject,
          telegramToken,
          region,
          provider: llmProvider,
          botName,
        }),
      })

      const data = (await res.json()) as {
        deploymentId?: string
        error?: string
      }
      if (!res.ok || !data.deploymentId) {
        setDeployError(data.error ?? "Deployment failed")
        setDeploying(false)
        return
      }

      setDeploymentId(data.deploymentId)
      setDeployStatus({ status: "creating" })
    } catch {
      setDeployError("Failed to start deployment")
      setDeploying(false)
    }
  }, [selectedProject, telegramToken, region, llmProvider, botName])

  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim()) return
    setCreatingProject(true)
    setCreateProjectError(null)

    const projectId = newProjectName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30)

    try {
      const res = await fetch("/api/deploy/create-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, displayName: newProjectName.trim() }),
      })

      const data = (await res.json()) as {
        projectId?: string
        name?: string
        error?: string
      }
      if (!res.ok || !data.projectId) {
        setCreateProjectError(data.error ?? "Failed to create project")
        setCreatingProject(false)
        return
      }

      // Update session data with the new project
      setSessionData((prev) =>
        prev
          ? {
              ...prev,
              projects: [
                ...prev.projects,
                { projectId: data.projectId!, name: data.name! },
              ],
            }
          : prev,
      )
      setSelectedProject(data.projectId)
      setShowCreateProject(false)
      setNewProjectName("")
    } catch {
      setCreateProjectError("Failed to create project")
    } finally {
      setCreatingProject(false)
    }
  }, [newProjectName])

  const providerName = llmProvider ? PROVIDER_NAMES[llmProvider] : null
  const isFreeProvider = llmProvider === "kimi"

  // Pre-login: can login when provider + channel + cloud selected
  const canLogin =
    llmProvider !== null && channel !== null && cloud === "gcp"

  const authUrl = canLogin
    ? buildAuthUrl({ provider: llmProvider!, channel: channel!, cloud: cloud! })
    : "#"

  // Post-login: can deploy when project + telegram token + region filled
  const canDeploy =
    isLoggedIn &&
    selectedProject !== "" &&
    botName.trim() !== "" &&
    telegramToken.trim() !== "" &&
    !deploying &&
    !deploymentId

  // Initial loading — check if session cookie exists
  if (sessionLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <OpenClawLogo className="h-16 w-16 mx-auto mb-4 animate-pulse" />
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      {/* Hero */}
      <div className="text-center mb-12">
        <OpenClawLogo className="h-16 w-16 mx-auto mb-4" />
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          Deploy OpenClaw for free
        </h1>
        <p className="text-muted-foreground mt-3 text-lg">
          One-click deploy your own 24/7 AI assistant into your cloud account.
          <br />
          No servers to manage. We never see your prompts or API tokens.
        </p>
      </div>

      {/* Welcome + existing bots — only when logged in */}
      {isLoggedIn && (
        <>
          <div className="rounded-lg border bg-primary/5 border-primary/20 p-4 mb-6 text-sm text-foreground flex items-center gap-3">
            {sessionData.userPicture && (
              <img
                src={sessionData.userPicture}
                alt=""
                className="h-8 w-8 rounded-full shrink-0"
                referrerPolicy="no-referrer"
              />
            )}
            <span className="flex-1" title={sessionData.userEmail || undefined}>
              Logged in as{" "}
              <span className="font-medium">
                {sessionData.userName || sessionData.userEmail || "Google user"}
              </span>
            </span>
            <a
              href="/api/auth/logout"
              className="text-muted-foreground hover:text-foreground transition-colors text-xs shrink-0"
            >
              Logout
            </a>
          </div>

          {existingVms.length > 0 && (
            <div className="rounded-2xl border bg-card p-6 sm:p-8 mb-6">
              <h2 className="text-lg font-semibold mb-4">
                Your deployed bots
              </h2>
              <div className="space-y-3">
                {existingVms.map((vm) => (
                  <div
                    key={`${vm.projectId}-${vm.zone}-${vm.name}`}
                    className="flex items-center justify-between rounded-lg border bg-muted/30 p-4 text-sm"
                  >
                    <div className="space-y-0.5">
                      <p className="font-medium text-foreground">
                        {vm.name}
                      </p>
                      <p className="text-muted-foreground">
                        {vm.projectId} &middot; {vm.zone}
                      </p>
                      <p className="text-muted-foreground">
                        Machine type:{" "}
                        <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                          {vm.machineType || "unknown"}
                        </code>{" "}
                        &middot;{" "}
                        {vm.ip ? (
                          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                            {vm.ip}
                          </code>
                        ) : (
                          "No external IP"
                        )}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        vm.status === "RUNNING"
                          ? "bg-green-500/10 text-green-500"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {vm.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Config card */}
      <div className="rounded-2xl border bg-card p-6 sm:p-8 space-y-8">
        <ModelSelector value={llmProvider} onChange={setLlmProvider} />

        {/* Cloud selector */}
        <CloudSelector value={cloud} onChange={setCloud} />

        {/* GCP project selector — only post-login */}
        {isLoggedIn && sessionData && cloud === "gcp" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="project" className="text-base font-semibold">
                GCP Project
              </Label>
              {!showCreateProject && (
                <button
                  onClick={() => setShowCreateProject(true)}
                  className="text-xs text-primary hover:underline"
                >
                  Create new project
                </button>
              )}
            </div>

            {showCreateProject ? (
              <div className="space-y-3">
                <Input
                  placeholder="Project name..."
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  disabled={creatingProject}
                />
                {createProjectError && (
                  <p className="text-xs text-destructive">{createProjectError}</p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!newProjectName.trim() || creatingProject}
                    onClick={handleCreateProject}
                  >
                    {creatingProject ? "Creating..." : "Create"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={creatingProject}
                    onClick={() => {
                      setShowCreateProject(false)
                      setNewProjectName("")
                      setCreateProjectError(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : sessionData.projects.length > 1 ? (
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
            ) : sessionData.projects.length === 1 ? (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                {sessionData.projects[0].name} (
                {sessionData.projects[0].projectId})
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No GCP projects found. Create one above to get started.
              </p>
            )}
          </div>
        )}

        {/* Region picker — below cloud/project selector */}
        {cloud === "gcp" && (
          <RegionPicker value={region} onChange={setRegion} />
        )}

        {/* Channel selector */}
        <ChannelSelector value={channel} onChange={setChannel} />

        {/* Telegram token — only post-login */}
        {isLoggedIn && channel === "telegram" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bot-name">Bot Name</Label>
              <Input
                id="bot-name"
                type="text"
                placeholder="my-openclaw-bot"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Used as your VM name (a unique suffix is added automatically).
              </p>
            </div>

            <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground">
                Create your Telegram bot:
              </p>
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
                <code className="bg-muted px-1 py-0.5 rounded text-xs">
                  /newbot
                </code>
              </p>
              <p>2. Copy the token and paste it below</p>
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
          </div>
        )}

        {/* GCP-specific bottom section */}
        {cloud === "gcp" && (
          <>
            {/* Cost line */}
            <div className="text-sm text-muted-foreground">
              Runs on GCP's always-free tier.{" "}
              <span className="font-medium text-foreground">$0/month</span> for
              the server.
              {isFreeProvider
                ? " Kimi K2.5 is free via NVIDIA — no AI costs either."
                : ` You only pay for AI usage through ${providerName ? `your ${providerName} plan` : "your AI provider"}.`}
            </div>

            {/* Deploy error */}
            {deployError && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
                {deployError}
              </div>
            )}

            {/* Deploy progress inline */}
            {deploymentId && deployStatus && (
              <div className="space-y-6">
                <DeployProgress status={deployStatus.status} />

                {deployStatus.status === "error" && (
                  <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
                    {deployStatus.error ??
                      "An error occurred during deployment."}
                  </div>
                )}

                {deployStatus.status === "done" && (
                  <div className="space-y-4">
                    <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
                      <p className="font-medium text-foreground">
                        Deployment complete!
                      </p>
                      <p className="text-muted-foreground">
                        Your VM is running in your GCP project.
                      </p>
                      <p className="text-muted-foreground">
                        Network mode: private by default (no public gateway URL).
                      </p>
                      {deployStatus.ip && (
                        <p className="text-muted-foreground">
                          Existing public IP detected:{" "}
                          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                            {deployStatus.ip}
                          </code>
                        </p>
                      )}
                    </div>

                    <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-1.5 text-muted-foreground">
                      <p className="font-medium text-foreground">
                        Next steps:
                      </p>
                      <p>
                        Startup can take 1-2 minutes after VM provisioning.
                      </p>
                      <p>1. Open Telegram and message your bot</p>
                      <p>
                        2. The first person to message becomes the bot owner
                      </p>
                      <p>
                        3. Follow the auth instructions your bot sends you
                      </p>
                      <p>4. Start chatting!</p>
                    </div>

                    <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-3 text-muted-foreground">
                      <p className="font-medium text-foreground">
                        Access options
                      </p>
                      <p>
                        Default (recommended): use your bot from Telegram only.
                        No public gateway URL needed.
                      </p>
                      <p>
                        Private admin access: enable Tailscale or GCP IAP to
                        reach this VM securely without exposing it publicly.
                      </p>
                      <p>
                        Public URL (advanced): use Cloudflare Tunnel or
                        Tailscale Funnel if you need internet access. Keep this
                        optional and protect access with auth.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Action button */}
            {!deploymentId &&
              (isLoggedIn ? (
                <Button
                  size="lg"
                  className="w-full text-base"
                  disabled={!canDeploy}
                  onClick={handleDeploy}
                >
                  {deploying ? "Starting..." : "Deploy my bot"}
                </Button>
              ) : (
                <Button
                  asChild={canLogin}
                  size="lg"
                  className="w-full text-base"
                  disabled={!canLogin}
                >
                  {canLogin ? (
                    <a href={authUrl}>Login with Google</a>
                  ) : (
                    "Login with Google"
                  )}
                </Button>
              ))}
          </>
        )}
      </div>

      {/* FAQ */}
      <div className="mt-16 space-y-6">
        <h2 className="text-2xl font-bold text-center">How does this work?</h2>
        <div className="space-y-5">
          <FaqItem title="Is this really free?">
            {cloud === "gcp"
              ? "Google Cloud's always-free tier includes an e2-micro VM and 30GB disk at $0/month."
              : "Cloud providers like Google Cloud offer always-free tiers with enough compute to run OpenClaw at no cost."}{" "}
            {isFreeProvider
              ? "Kimi K2.5 is available for free through NVIDIA's API, so there are no AI costs either."
              : `You only pay for AI usage through ${providerName ? `your ${providerName} subscription or API plan` : "your AI provider"}.`}
          </FaqItem>

          <FaqItem title="Is this secure?">
            We never see your prompts or API tokens — you log in with{" "}
            <span className="text-foreground font-medium">
              {providerName ?? "your AI provider"}
            </span>{" "}
            directly on your server. We use Google OAuth to provision your VM but
            your API keys and conversations stay on your server.
          </FaqItem>
        </div>
      </div>
    </div>
  )
}

function FaqItem({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <h3 className="font-semibold mb-1.5">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {children}
      </p>
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
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={3}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
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
