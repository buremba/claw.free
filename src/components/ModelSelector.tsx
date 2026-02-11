import { ClaudeIcon, OpenAIIcon, GeminiIcon, KimiIcon } from "@/components/icons"
import type { LlmProvider } from "@/lib/wizard-state"
import type { ComponentType } from "react"

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
    hint: "Free via NVIDIA — your bot will guide you through API key setup.",
  },
  {
    id: "claude",
    name: "Claude",
    icon: ClaudeIcon,
    available: true,
    hint: "Your bot will guide you through Anthropic API key setup.",
  },
  {
    id: "openai",
    name: "ChatGPT",
    icon: OpenAIIcon,
    available: true,
    hint: "Your bot will guide you through OpenAI API key setup.",
  },
  { id: "gemini", name: "Gemini", icon: GeminiIcon, available: false },
]

export function ModelSelector({
  value,
  onChange,
}: {
  value: LlmProvider | null
  onChange: (v: LlmProvider) => void
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

      {selected?.hint && (
        <p className="text-sm text-muted-foreground">{selected.hint}</p>
      )}
    </div>
  )
}
