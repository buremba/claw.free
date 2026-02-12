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
}

interface ExistingVm {
  projectId: string
  name: string
  zone: string
  ip: string
  machineType: string
  status: string
}

interface GcpProject {
  projectId: string
  name: string
}

interface DeployStatus {
  status: string
  ip?: string
  error?: string
}

interface FetchProjectsError {
  reason?: "missing_scope" | "permission_denied" | "api_error" | "network_error"
  error?: string
}

interface PreflightBlocker {
  type:
    | "missing_scope"
    | "missing_permission"
    | "mfa_required"
    | "service_disabled"
    | "propagating"
    | "unknown"
  title: string
  message: string
  actionKind:
    | "reconnect_basic"
    | "reconnect_service_management"
    | "open_url"
    | "none"
  actionUrl?: string
}

interface PreflightResult {
  ok: boolean
  checks: {
    hasComputeScope: boolean | null
    hasServiceManagementScope: boolean | null
    computeApiEnabled: boolean
    autoEnableAttempted: boolean
  }
  blocker?: PreflightBlocker
  message?: string
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
  const [projects, setProjects] = useState<GcpProject[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectFetchError, setProjectFetchError] = useState<string | null>(null)
  const [existingVms, setExistingVms] = useState<ExistingVm[]>([])
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)

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
      })
      .catch(() => {})
      .finally(() => setSessionLoading(false))
    // This effect intentionally runs once to hydrate from cookie session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch existing VMs when logged in
  useEffect(() => {
    const projectId = selectedProject.trim()
    if (!isLoggedIn || !projectId) {
      setExistingVms([])
      return
    }

    fetch(`/api/deploy/existing?projectId=${encodeURIComponent(projectId)}`)
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as { vms: ExistingVm[] }
        setExistingVms(data.vms)
      })
      .catch(() => {})
  }, [isLoggedIn, selectedProject])

  useEffect(() => {
    if (!isLoggedIn) {
      setProjects([])
      setProjectsLoading(false)
      setProjectFetchError(null)
      setSelectedProject("")
    }
  }, [isLoggedIn])

  const runPreflight = useCallback(async () => {
    const projectId = selectedProject.trim()
    if (!isLoggedIn || cloud !== "gcp" || !projectId) {
      setPreflight(null)
      setPreflightLoading(false)
      return
    }

    setPreflightLoading(true)
    try {
      const res = await fetch("/api/deploy/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      })
      if (!res.ok) {
        const errorText = await res.text()
        setPreflight({
          ok: false,
          checks: {
            hasComputeScope: null,
            hasServiceManagementScope: null,
            computeApiEnabled: false,
            autoEnableAttempted: false,
          },
          blocker: {
            type: "unknown",
            title: "Preflight failed",
            message: errorText || "Could not validate project readiness.",
            actionKind: "none",
          },
        })
        return
      }

      const data = (await res.json()) as PreflightResult
      setPreflight(data)
    } catch {
      setPreflight({
        ok: false,
        checks: {
          hasComputeScope: null,
          hasServiceManagementScope: null,
          computeApiEnabled: false,
          autoEnableAttempted: false,
        },
        blocker: {
          type: "unknown",
          title: "Network error",
          message: "Could not reach preflight check endpoint. Try re-checking.",
          actionKind: "none",
        },
      })
    } finally {
      setPreflightLoading(false)
    }
  }, [cloud, isLoggedIn, selectedProject])

  useEffect(() => {
    const projectId = selectedProject.trim()
    if (!isLoggedIn || cloud !== "gcp" || !projectId) {
      setPreflight(null)
      setPreflightLoading(false)
      return
    }

    const timer = setTimeout(() => {
      void runPreflight()
    }, 350)
    return () => clearTimeout(timer)
  }, [cloud, isLoggedIn, runPreflight, selectedProject])

  const handleFetchProjects = useCallback(async () => {
    if (!isLoggedIn || cloud !== "gcp") return

    setProjectsLoading(true)
    setProjectFetchError(null)
    try {
      const res = await fetch("/api/deploy/projects")
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as FetchProjectsError
        if (res.status === 403 && data.reason === "missing_scope") {
          const reconnectUrl = buildAuthUrl({
            provider: llmProvider ?? "claude",
            channel: channel ?? "telegram",
            cloud: "gcp",
            upgrade: "project-read",
          })
          window.location.href = reconnectUrl
          return
        }

        setProjectFetchError(data.error ?? "Could not fetch Google Cloud projects.")
        return
      }

      const data = (await res.json()) as { projects: GcpProject[] }
      setProjects(data.projects ?? [])
      if ((data.projects?.length ?? 0) > 0) {
        const selected = selectedProject.trim()
        const hasSelected = Boolean(
          selected &&
            data.projects?.some((project) => project.projectId === selected),
        )
        if (!hasSelected) {
          setSelectedProject(data.projects[0].projectId)
        }
      }
      if ((data.projects?.length ?? 0) === 0) {
        setProjectFetchError(
          "No active projects found for this account. Check the selected Google account and IAM access.",
        )
      }
    } catch {
      setProjectFetchError("Could not fetch Google Cloud projects.")
    } finally {
      setProjectsLoading(false)
    }
  }, [channel, cloud, isLoggedIn, llmProvider, selectedProject])

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
    const projectId = selectedProject.trim()
    if (!projectId || !telegramToken || !region || !botName.trim()) return
    if (!preflight?.ok) return
    setDeploying(true)
    setDeployError(null)

    try {
      const res = await fetch("/api/deploy/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
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
  }, [selectedProject, telegramToken, region, preflight, llmProvider, botName])

  const providerName = llmProvider ? PROVIDER_NAMES[llmProvider] : null
  const isFreeProvider = llmProvider === "kimi"
  const defaultProvider = llmProvider ?? "claude"
  const defaultChannel = channel ?? "telegram"

  // Pre-login: can login when provider + channel + cloud selected
  const canLogin =
    llmProvider !== null && channel !== null && cloud === "gcp"

  const authUrl = canLogin
    ? buildAuthUrl({ provider: llmProvider!, channel: channel!, cloud: cloud! })
    : "#"
  const reconnectBasicUrl = buildAuthUrl({
    provider: defaultProvider,
    channel: defaultChannel,
    cloud: "gcp",
  })
  const upgradeAuthUrl = buildAuthUrl({
    provider: defaultProvider,
    channel: defaultChannel,
    cloud: "gcp",
    upgrade: "service-management",
  })

  // Post-login: can deploy when project + telegram token + region filled
  const canDeploy =
    isLoggedIn &&
    selectedProject.trim() !== "" &&
    botName.trim() !== "" &&
    telegramToken.trim() !== "" &&
    preflight?.ok === true &&
    !preflightLoading &&
    !deploying &&
    !deploymentId

  const preflightBlocker = preflight?.ok ? null : preflight?.blocker
  const preflightPrimaryAction = (() => {
    if (!preflightBlocker) return null
    if (preflightBlocker.actionKind === "reconnect_basic") {
      return { label: "Reconnect Google", href: reconnectBasicUrl }
    }
    if (preflightBlocker.actionKind === "reconnect_service_management") {
      return { label: "Reconnect Google", href: upgradeAuthUrl }
    }
    if (preflightBlocker.actionKind === "open_url" && preflightBlocker.actionUrl) {
      if (preflightBlocker.type === "mfa_required") {
        return { label: "Open Security Settings", href: preflightBlocker.actionUrl }
      }
      if (preflightBlocker.type === "missing_permission") {
        return { label: "Open IAM", href: preflightBlocker.actionUrl }
      }
      return { label: "Open Fix Page", href: preflightBlocker.actionUrl }
    }
    return null
  })()

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
          No servers to manage. No public IP needed. We never see your prompts or API tokens.
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

        {isLoggedIn && cloud === "gcp" && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-100">
            <p className="font-medium text-amber-950 dark:text-amber-50">
              Google Cloud may require 2-step verification
            </p>
            <p className="mt-1">
              Effective around May 13, 2025, Google Cloud started enforcing MFA
              for many users. If Google prompts for 2SV, enable it first.
            </p>
            <a
              href="https://myaccount.google.com/security"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block underline text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
            >
              Open Google security settings
            </a>
          </div>
        )}

        {/* GCP project selector — only post-login */}
        {isLoggedIn && sessionData && cloud === "gcp" && (
          <div className="space-y-3">
            <Label htmlFor="project" className="text-base font-semibold">
              GCP Project ID
            </Label>
            {projects.length > 0 ? (
              <select
                id="project"
                value={selectedProject}
                onChange={(e) => setSelectedProject(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="">Select a project...</option>
                {projects.map((project) => (
                  <option key={project.projectId} value={project.projectId}>
                    {project.name} ({project.projectId})
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id="project"
                type="text"
                placeholder="my-gcp-project-id"
                value={selectedProject}
                onChange={(e) => setSelectedProject(e.target.value)}
              />
            )}

            <div className="text-xs text-muted-foreground space-y-1">
              <p>Where to find Project ID:</p>
              <p>
                1. Open{" "}
                <a
                  href="https://console.cloud.google.com/cloud-resource-manager"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Google Cloud Console
                </a>
              </p>
              <p>2. Use the top project switcher to select your project</p>
              <p>3. Open Project settings and copy "Project ID" (not Name/Number)</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleFetchProjects()}
                disabled={projectsLoading}
              >
                {projectsLoading
                  ? "Fetching projects..."
                  : "Fetch my Google Cloud projects"}
              </Button>
            </div>

            {projectFetchError && (
              <p className="text-xs text-destructive">{projectFetchError}</p>
            )}

            {selectedProject.trim() !== "" && (
              <div
                className={`rounded-lg border p-4 text-sm space-y-3 ${
                  preflight?.ok
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-100"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-100"
                }`}
              >
                {preflightLoading ? (
                  <p>Checking project readiness...</p>
                ) : preflight?.ok ? (
                  <p>{preflight.message ?? "Project is ready. You can deploy now."}</p>
                ) : (
                  <>
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">
                        {preflightBlocker?.title ?? "Project needs attention"}
                      </p>
                      <p>{preflightBlocker?.message ?? "Fix the issue, then re-check."}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {preflightPrimaryAction && (
                        <Button size="sm" asChild>
                          <a
                            href={preflightPrimaryAction.href}
                            target={
                              preflightBlocker?.actionKind === "open_url"
                                ? "_blank"
                                : undefined
                            }
                            rel={
                              preflightBlocker?.actionKind === "open_url"
                                ? "noopener noreferrer"
                                : undefined
                            }
                          >
                            {preflightPrimaryAction.label}
                          </a>
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void runPreflight()}
                        disabled={preflightLoading}
                      >
                        I fixed it, re-check
                      </Button>
                    </div>
                  </>
                )}
              </div>
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
                        Your VM is running in your GCP project. Telegram
                        webhooks are delivered through a secure relay tunnel
                        &mdash; no public IP or firewall rules needed.
                      </p>
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

          <FaqItem title="How does the bot receive messages?">
            Your bot VM connects outbound to our relay server via a WebSocket
            tunnel. Telegram sends webhooks to the relay, which forwards them
            through the tunnel to your VM. No public IP, no firewall rules, no
            port forwarding needed &mdash; just an outbound connection from your VM.
          </FaqItem>

          <FaqItem title="Is this secure?">
            We never see your prompts or API tokens — you log in with{" "}
            <span className="text-foreground font-medium">
              {providerName ?? "your AI provider"}
            </span>{" "}
            directly on your server. Telegram webhooks are verified with a
            per-deployment secret token. The relay tunnel is authenticated with a
            unique token and only forwards webhook payloads &mdash; it never
            stores messages.
          </FaqItem>

          <FaqItem title="Can I also use the Telegram Mini App?">
            Yes! Open{" "}
            <span className="text-foreground font-medium">@ClawFreeBot</span>
            {" "}in Telegram and tap the Mini App button. You can deploy and manage
            bots directly from Telegram without leaving the app.
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
