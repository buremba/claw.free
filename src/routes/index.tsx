import { useState, useCallback } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ModelSelector } from "@/components/ModelSelector"
import { ChannelSelector, type Channel } from "@/components/ChannelSelector"
import { CloudSelector, type CloudProvider } from "@/components/CloudSelector"
import { RegionPicker } from "@/components/RegionPicker"
import { DeployModeSelector } from "@/components/DeployModeSelector"
import { OpenClawLogo } from "@/components/OpenClawLogo"
import {
  buildCloudShellUrl,
  buildAuthUrl,
  guessRegion,
  type LlmProvider,
  type Region,
  type DeployMode,
} from "@/lib/wizard-state"

export const Route = createFileRoute("/")({
  component: Home,
})

const PROVIDER_NAMES: Record<LlmProvider, string> = {
  kimi: "NVIDIA",
  claude: "Anthropic",
  openai: "OpenAI",
}

function Home() {
  const [llmProvider, setLlmProvider] = useState<LlmProvider | null>(null)
  const [channel, setChannel] = useState<Channel | null>(null)
  const [cloud, setCloud] = useState<CloudProvider | null>(null)
  const [region, setRegion] = useState<Region>(guessRegion())
  const [deployMode, setDeployMode] = useState<DeployMode>("installer")
  const [telegramToken, setTelegramToken] = useState("")
  const [telegramUserId, setTelegramUserId] = useState("")
  const [nvidiaApiKey, setNvidiaApiKey] = useState("")
  const [detectingUserId, setDetectingUserId] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

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

  const isInstaller = deployMode === "installer"
  const isManaged = deployMode === "managed"

  const managedFieldsFilled =
    telegramToken.trim() !== "" &&
    telegramUserId.trim() !== "" &&
    (llmProvider !== "kimi" || nvidiaApiKey.trim() !== "")

  const canDeploy =
    llmProvider !== null &&
    channel !== null &&
    cloud === "gcp" &&
    (isInstaller || managedFieldsFilled)

  const deployUrl = canDeploy
    ? isInstaller
      ? buildCloudShellUrl({
          step: 0,
          llmProvider: llmProvider!,
          telegramToken: "",
          telegramUserId: "",
          region,
        })
      : buildAuthUrl({
          provider: llmProvider!,
          channel: channel!,
          region,
          telegramToken,
          telegramUserId,
          nvidiaApiKey: llmProvider === "kimi" ? nvidiaApiKey : undefined,
        })
    : "#"

  const providerName = llmProvider ? PROVIDER_NAMES[llmProvider] : null
  const isFreeProvider = llmProvider === "kimi"

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
          {isManaged
            ? "No servers to manage. We never see your prompts or API tokens."
            : "No servers to manage, no credentials shared with us."}
        </p>
      </div>

      {/* Config card */}
      <div className="rounded-2xl border bg-card p-6 sm:p-8 space-y-8">
        {/* Provider selector */}
        <ModelSelector
          value={llmProvider}
          onChange={setLlmProvider}
          deployMode={deployMode}
          nvidiaApiKey={nvidiaApiKey}
          onNvidiaApiKeyChange={setNvidiaApiKey}
        />

        {/* Cloud selector — before channel */}
        <CloudSelector value={cloud} onChange={setCloud} />

        {/* Channel selector */}
        <ChannelSelector value={channel} onChange={setChannel} />

        {/* GCP-specific options */}
        {cloud === "gcp" && (
          <>
            {/* Region picker */}
            <RegionPicker value={region} onChange={setRegion} />

            {/* Deploy mode selector */}
            <DeployModeSelector value={deployMode} onChange={setDeployMode} />

            {/* Installer mode: Telegram hint */}
            {isInstaller && channel === "telegram" && (
              <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground space-y-1.5">
                <p className="font-medium text-foreground">You'll set up Telegram during deployment:</p>
                <p>
                  1. Open{" "}
                  <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                    @BotFather
                  </a>
                  , send{" "}
                  <code className="bg-muted px-1 py-0.5 rounded text-xs">/newbot</code>
                  , and copy the token
                </p>
                <p>2. Cloud Shell will prompt you for the token and auto-detect your user ID</p>
              </div>
            )}

            {/* Managed mode: Telegram inputs */}
            {isManaged && channel === "telegram" && (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground space-y-1.5">
                  <p className="font-medium text-foreground">Set up your Telegram bot:</p>
                  <p>
                    1. Open{" "}
                    <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-primary underline">
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
            )}

            {/* Cost line */}
            <div className="text-sm text-muted-foreground">
              Runs on GCP's always-free tier.{" "}
              <span className="font-medium text-foreground">$0/month</span> for
              the server.
              {isFreeProvider
                ? " Kimi K2.5 is free via NVIDIA — no AI costs either."
                : ` You only pay for AI usage through ${providerName ? `your ${providerName} plan` : "your AI provider"}.`}
            </div>

            {/* Deploy button */}
            <Button
              asChild={canDeploy}
              size="lg"
              className="w-full text-base"
              disabled={!canDeploy}
            >
              {canDeploy ? (
                isInstaller ? (
                  <a href={deployUrl} target="_blank" rel="noopener noreferrer">
                    Open in Cloud Shell
                  </a>
                ) : (
                  <a href={deployUrl}>
                    Login with Google
                  </a>
                )
              ) : isManaged ? (
                "Login with Google"
              ) : (
                "Open in Cloud Shell"
              )}
            </Button>
          </>
        )}
      </div>

      {/* FAQ */}
      <div className="mt-16 space-y-6">
        <h2 className="text-2xl font-bold text-center">How does this work?</h2>
        <div className="space-y-5">
          <FaqItem title="Is this really free?">
            {cloud === "gcp"
              ? "Google Cloud's always-free tier includes an e2-micro VM, 30GB disk, and a public IP — all at $0/month."
              : "Cloud providers like Google Cloud offer always-free tiers with enough compute to run OpenClaw at no cost."}{" "}
            {isFreeProvider
              ? "Kimi K2.5 is available for free through NVIDIA's API, so there are no AI costs either."
              : `You only pay for AI usage through ${providerName ? `your ${providerName} subscription or API plan` : "your AI provider"}.`}
          </FaqItem>

          <FaqItem title="What's the difference between Installer and Managed?">
            <span className="text-foreground font-medium">Installer</span> opens Google Cloud Shell — you run the deploy and manage the server yourself. claw.free never touches your account.{" "}
            <span className="text-foreground font-medium">Managed</span> lets claw.free provision the VM for you. You can see your deployed clawdbots in our dashboard and troubleshoot from there.
          </FaqItem>

          <FaqItem title="Is this secure?">
            We never see your prompts or API tokens — you log in with{" "}
            <span className="text-foreground font-medium">{providerName ?? "your AI provider"}</span> directly on your server.{" "}
            {isInstaller
              ? "In Installer mode, claw.free never sees any of your credentials."
              : "In Managed mode, we use Google OAuth to provision your VM but your API keys and conversations stay on your server."}
          </FaqItem>

        </div>
      </div>
    </div>
  )
}

function FaqItem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <h3 className="font-semibold mb-1.5">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{children}</p>
    </div>
  )
}
