import { ClaudeIcon, OpenAIIcon, GeminiIcon } from "@/components/icons"
import type { LlmProvider } from "@/lib/wizard-state"
import type { ComponentType } from "react"

const providers: {
  id: LlmProvider | "gemini"
  name: string
  icon: ComponentType<{ className?: string }>
  available: boolean
}[] = [
  { id: "claude", name: "Claude", icon: ClaudeIcon, available: true },
  { id: "openai", name: "GPT-4o", icon: OpenAIIcon, available: true },
  { id: "gemini", name: "Gemini", icon: GeminiIcon, available: false },
]

export function ModelSelector({
  value,
  onChange,
}: {
  value: LlmProvider | null
  onChange: (v: LlmProvider) => void
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Which provider do you want as default?</h2>
      <div className="flex gap-2">
        {providers.map((p) => {
          const selected = value === p.id
          const Icon = p.icon
          return (
            <button
              key={p.id}
              disabled={!p.available}
              onClick={() => {
                if (p.available && (p.id === "claude" || p.id === "openai")) {
                  onChange(p.id)
                }
              }}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all ${
                !p.available
                  ? "opacity-40 cursor-not-allowed border-border text-muted-foreground"
                  : selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-foreground hover:border-primary/50 cursor-pointer"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{p.name}</span>
              {selected && (
                <svg className="h-3 w-3 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              {!p.available && <span className="text-xs text-muted-foreground">Soon</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
