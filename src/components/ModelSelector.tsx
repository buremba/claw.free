import { ClaudeIcon, OpenAIIcon, GeminiIcon, KimiIcon } from "@/components/icons"
import type { LlmProvider, DeployMode } from "@/lib/wizard-state"
import type { ComponentType } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const providers: {
  id: LlmProvider | "gemini"
  name: string
  icon: ComponentType<{ className?: string }>
  available: boolean
  free?: boolean
  hint?: string
}[] = [
  {
    id: "kimi",
    name: "Kimi K2.5",
    icon: KimiIcon,
    available: true,
    free: true,
    hint: "Free via NVIDIA — sign up and get an API key.",
  },
  {
    id: "claude",
    name: "Claude",
    icon: ClaudeIcon,
    available: true,
    hint: "Requires an Anthropic API key or Claude Pro subscription.",
  },
  {
    id: "openai",
    name: "ChatGPT",
    icon: OpenAIIcon,
    available: true,
    hint: "Requires an OpenAI API key or ChatGPT Plus subscription.",
  },
  { id: "gemini", name: "Gemini", icon: GeminiIcon, available: false },
]

export function ModelSelector({
  value,
  onChange,
  deployMode,
  nvidiaApiKey,
  onNvidiaApiKeyChange,
}: {
  value: LlmProvider | null
  onChange: (v: LlmProvider) => void
  deployMode?: DeployMode
  nvidiaApiKey?: string
  onNvidiaApiKeyChange?: (v: string) => void
}) {
  const selected = providers.find((p) => p.id === value)

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Which provider do you want as default?</h2>
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => {
          const isSelected = value === p.id
          const Icon = p.icon
          return (
            <button
              key={p.id}
              disabled={!p.available}
              onClick={() => {
                if (p.available && p.id !== "gemini") {
                  onChange(p.id as LlmProvider)
                }
              }}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all ${
                !p.available
                  ? "opacity-40 cursor-not-allowed border-border text-muted-foreground"
                  : isSelected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-foreground hover:border-primary/50 cursor-pointer"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{p.name}</span>
              {p.free && (
                <span className="text-xs font-semibold text-green-500">Free</span>
              )}
              {p.available && (
                <svg className={`h-3 w-3 ${isSelected ? "text-primary" : "invisible"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              {!p.available && <span className="text-xs text-muted-foreground">Soon</span>}
            </button>
          )
        })}
      </div>

      {/* Subscription / setup hint */}
      {selected?.hint && (
        <p className="text-sm text-muted-foreground">{selected.hint}</p>
      )}

      {/* Kimi: NVIDIA API key setup */}
      {value === "kimi" && (
        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground space-y-1.5">
            <p className="font-medium text-foreground">Get your free NVIDIA API key:</p>
            <p>
              1.{" "}
              <a
                href="https://build.nvidia.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                Sign up at build.nvidia.com
              </a>
            </p>
            <p>
              2.{" "}
              <a
                href="https://build.nvidia.com/settings/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                Generate an API key
              </a>
            </p>
            {deployMode === "installer" && (
              <p>3. You'll be prompted to enter it during deploy</p>
            )}
          </div>

          {deployMode === "managed" && onNvidiaApiKeyChange && (
            <div className="space-y-2">
              <Label htmlFor="nvidia-api-key">NVIDIA API Key</Label>
              <Input
                id="nvidia-api-key"
                type="text"
                placeholder="nvapi-..."
                value={nvidiaApiKey ?? ""}
                onChange={(e) => onNvidiaApiKeyChange(e.target.value)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
