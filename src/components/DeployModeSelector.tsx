import type { DeployMode } from "@/lib/wizard-state"

const modes: {
  id: DeployMode
  name: string
  description: string
}[] = [
  {
    id: "installer",
    name: "Installer",
    description: "Run the deploy and manage the server yourself. No data shared with us.",
  },
  {
    id: "managed",
    name: "Managed",
    description: "We deploy for you. We never see your prompts or API tokens — you log in with the provider directly.",
  },
]

export function DeployModeSelector({
  value,
  onChange,
}: {
  value: DeployMode
  onChange: (v: DeployMode) => void
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">How do you want to deploy?</h2>
      <div className="flex gap-2">
        {modes.map((mode) => {
          const selected = value === mode.id
          return (
            <button
              key={mode.id}
              onClick={() => onChange(mode.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-all cursor-pointer ${
                selected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-foreground hover:border-primary/50"
              }`}
            >
              <span>{mode.name}</span>
              {selected && (
                <svg
                  className="h-3.5 w-3.5 text-primary"
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
              )}
            </button>
          )
        })}
      </div>
      <p className="text-sm text-muted-foreground">
        {modes.find((m) => m.id === value)?.description}
      </p>
    </div>
  )
}
