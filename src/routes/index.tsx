import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { ModelSelector } from "@/components/ModelSelector"
import { ChannelSelector, type Channel } from "@/components/ChannelSelector"
import { CloudSelector, type CloudProvider } from "@/components/CloudSelector"
import { RegionPicker } from "@/components/RegionPicker"
import { OpenClawLogo } from "@/components/OpenClawLogo"
import { buildCloudShellUrl, guessRegion, type LlmProvider, type Region } from "@/lib/wizard-state"

export const Route = createFileRoute("/")({
  component: Home,
})

const CLOUD_NAMES: Record<CloudProvider, string> = {
  gcp: "Google",
  hetzner: "Hetzner",
  aws: "AWS",
  oracle: "Oracle",
}

const PROVIDER_NAMES: Record<LlmProvider, string> = {
  claude: "Anthropic",
  openai: "OpenAI",
}

function Home() {
  const [llmProvider, setLlmProvider] = useState<LlmProvider | null>(null)
  const [channel, setChannel] = useState<Channel | null>(null)
  const [cloud, setCloud] = useState<CloudProvider | null>(null)
  const [region, setRegion] = useState<Region>(guessRegion())

  const canDeploy =
    llmProvider !== null &&
    channel !== null &&
    cloud === "gcp"

  const deployUrl = canDeploy
    ? buildCloudShellUrl({
        step: 0,
        llmProvider,
        telegramToken: "",
        telegramUserId: "",
        region,
      })
    : "#"

  const cloudName = cloud ? CLOUD_NAMES[cloud] : "your cloud provider"
  const providerName = llmProvider ? PROVIDER_NAMES[llmProvider] : "your AI provider"

  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      {/* Hero */}
      <div className="text-center mb-12">
        <OpenClawLogo className="h-16 w-16 mx-auto mb-4 text-primary" />
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          Deploy OpenClaw free
        </h1>
        <p className="text-muted-foreground mt-3 text-lg">
          One-click deploy your own 24/7 AI assistant into your cloud account.
          <br />
          No servers to manage, no credentials shared with us.
        </p>
      </div>

      {/* Config card */}
      <div className="rounded-2xl border bg-card p-6 sm:p-8 space-y-8">
        {/* Provider selector */}
        <ModelSelector value={llmProvider} onChange={setLlmProvider} />

        {/* Channel selector */}
        <ChannelSelector value={channel} onChange={setChannel} />

        {/* Telegram setup hint — only when Telegram is selected */}
        {channel === "telegram" && (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground space-y-1.5">
            <p className="font-medium text-foreground">You'll set up Telegram during deployment:</p>
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
              , and copy the token
            </p>
            <p>
              2. Message{" "}
              <a
                href="https://t.me/userinfobot"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                @userinfobot
              </a>{" "}
              to get your user ID
            </p>
            <p>3. You'll be prompted to enter both during deploy</p>
          </div>
        )}

        {/* Cloud selector */}
        <CloudSelector value={cloud} onChange={setCloud} />

        {/* Region picker — only when GCP is selected */}
        {cloud === "gcp" && (
          <RegionPicker value={region} onChange={setRegion} />
        )}

        {/* Deploy */}
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            Runs on GCP's always-free tier.{" "}
            <span className="font-medium text-foreground">$0/month</span> for
            the server.
          </div>
          <Button
            asChild={canDeploy}
            size="lg"
            className="w-full text-base"
            disabled={!canDeploy}
          >
            {canDeploy ? (
              <a href={deployUrl} target="_blank" rel="noopener noreferrer">
                Login with Google
              </a>
            ) : (
              "Login with Google"
            )}
          </Button>
        </div>
      </div>

      {/* FAQ */}
      <div className="mt-16 space-y-6">
        <h2 className="text-2xl font-bold text-center">How does this work?</h2>
        <div className="space-y-5">
          <FaqItem title="Is this really free?">
            {cloud === "gcp"
              ? "Google Cloud offers an always-free tier that includes an e2-micro VM, 30GB disk, and a public IP — all at $0/month."
              : "Cloud providers like Google Cloud offer always-free tiers with enough compute to run OpenClaw at no cost."}{" "}
            We deploy OpenClaw into{" "}
            <span className="text-foreground font-medium">your own {cloudName} account</span>.
            The server itself costs nothing. You only pay for AI usage through your own{" "}
            <span className="text-foreground font-medium">{providerName}</span> subscription or API plan.
          </FaqItem>

          <FaqItem title="What's the &quot;bring your own cloud&quot; model?">
            claw.free doesn't host anything for you. Instead, it deploys OpenClaw directly into{" "}
            <span className="text-foreground font-medium">your {cloudName} account</span>.
            You own the server, the data, and the configuration. We just automate the setup.
            After deployment, claw.free has no access to your instance.
          </FaqItem>

          <FaqItem title="Is this secure?">
            More secure than a hosted service. Your credentials are only shared with parties you already
            trust:{" "}
            <span className="text-foreground font-medium">{cloudName}</span> for
            compute and{" "}
            <span className="text-foreground font-medium">{providerName}</span> for
            AI. claw.free never sees your API keys, chat history, or cloud credentials.
            The deploy runs entirely through {cloudName}'s own tools.
          </FaqItem>

          <FaqItem title="Do I need to manage the server?">
            No. OpenClaw runs in Docker on the VM and starts automatically. Your bot handles
            LLM authentication for you — just click the link it sends. For updates and
            troubleshooting, your bot includes a built-in management skill.
          </FaqItem>

          <FaqItem title="What are the limitations?">
            The free-tier VM (1GB RAM, 2 shared vCPUs) can handle chat and basic tasks well.
            Heavy workloads like browser automation may be limited. You can always upgrade the VM
            later — it's in your own account.
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
