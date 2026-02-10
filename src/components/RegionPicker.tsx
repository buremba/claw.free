import { REGIONS, type Region } from "@/lib/wizard-state"

export function RegionPicker({
  value,
  onChange,
}: {
  value: Region
  onChange: (v: Region) => void
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Pick a GCP region</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          All three are eligible for GCP's always-free tier.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {REGIONS.map((region) => (
          <button
            key={region.id}
            onClick={() => onChange(region.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-all cursor-pointer ${
              value === region.id
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-foreground hover:border-primary/50"
            }`}
          >
            <span>{region.label}</span>
            <span className="text-muted-foreground">({region.location})</span>
            {value === region.id && (
              <svg className="h-3.5 w-3.5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
