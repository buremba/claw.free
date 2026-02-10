import { TelegramIcon, DiscordIcon, WhatsAppIcon } from "@/components/icons"
import type { ComponentType } from "react"

export type Channel = "telegram" | "discord" | "whatsapp"

const channels: {
  id: Channel
  name: string
  icon: ComponentType<{ className?: string }>
  available: boolean
}[] = [
  { id: "telegram", name: "Telegram", icon: TelegramIcon, available: true },
  { id: "discord", name: "Discord", icon: DiscordIcon, available: false },
  { id: "whatsapp", name: "WhatsApp", icon: WhatsAppIcon, available: false },
]

export function ChannelSelector({
  value,
  onChange,
}: {
  value: Channel | null
  onChange: (v: Channel) => void
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Which channel do you want to use?</h2>
      <div className="flex gap-2">
        {channels.map((ch) => {
          const selected = value === ch.id
          const Icon = ch.icon
          return (
            <button
              key={ch.id}
              disabled={!ch.available}
              onClick={() => {
                if (ch.available) onChange(ch.id)
              }}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all ${
                !ch.available
                  ? "opacity-40 cursor-not-allowed border-border text-muted-foreground"
                  : selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-foreground hover:border-primary/50 cursor-pointer"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{ch.name}</span>
              {selected && (
                <svg className="h-3 w-3 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              {!ch.available && <span className="text-xs text-muted-foreground">Soon</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
