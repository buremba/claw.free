import { GoogleCloudIcon, HetznerIcon, AWSIcon, OracleIcon } from "@/components/icons"
import type { ComponentType } from "react"

export type CloudProvider = "gcp" | "hetzner" | "aws" | "oracle"

const clouds: {
  id: CloudProvider
  name: string
  icon: ComponentType<{ className?: string }>
  available: boolean
  free?: boolean
}[] = [
  { id: "gcp", name: "Google Cloud", icon: GoogleCloudIcon, available: true, free: true },
  { id: "hetzner", name: "Hetzner", icon: HetznerIcon, available: false },
  { id: "aws", name: "AWS", icon: AWSIcon, available: false },
  { id: "oracle", name: "Oracle", icon: OracleIcon, available: false },
]

export function CloudSelector({
  value,
  onChange,
}: {
  value: CloudProvider | null
  onChange: (v: CloudProvider) => void
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Which cloud provider?</h2>
      <div className="flex gap-2">
        {clouds.map((c) => {
          const selected = value === c.id
          const Icon = c.icon
          return (
            <button
              key={c.id}
              disabled={!c.available}
              onClick={() => {
                if (c.available) onChange(c.id)
              }}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-all ${
                !c.available
                  ? "opacity-40 cursor-not-allowed border-border text-muted-foreground"
                  : selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-foreground hover:border-primary/50 cursor-pointer"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{c.name}</span>
              {c.free && (
                <span className="text-xs font-semibold text-green-500">Free</span>
              )}
              {c.available && (
                <svg className={`h-3 w-3 ${selected ? "text-primary" : "invisible"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              {!c.available && <span className="text-xs text-muted-foreground">Soon</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
