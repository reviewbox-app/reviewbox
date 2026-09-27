import { HugeiconsIcon } from "@hugeicons/react"
import { AiMagicIcon, Route01Icon } from "@hugeicons/core-free-icons"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import type {
  PreparationMode,
  Scope,
  ScopePreview,
} from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { scopeTitles } from "./ReviewScopeStep"
import { ReviewStats } from "./ReviewExplanation"

export function PreparationStep({
  mode,
  ready,
  scope,
  stats,
  onChange,
  onBack,
}: {
  mode: PreparationMode
  ready: boolean
  scope: Scope
  stats: ScopePreview | null
  onChange: (mode: PreparationMode) => void
  onBack: () => void
}) {
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium">
        How should we prepare the reading?
      </h3>
      <RadioGroup
        value={mode}
        aria-label="Review preparation"
        onValueChange={(value) => onChange(value as PreparationMode)}
        className="gap-2"
      >
        {(["rev", "manual"] as const).map((value) => (
          <label
            key={value}
            className={cn(
              "flex gap-3 rounded-3xl border px-4 py-3.5",
              mode === value && "border-primary bg-accent",
              value === "rev" && !ready
                ? "cursor-not-allowed opacity-45"
                : "cursor-pointer hover:bg-accent/40"
            )}
          >
            <RadioGroupItem
              value={value}
              disabled={value === "rev" && !ready}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <HugeiconsIcon
                  icon={value === "rev" ? AiMagicIcon : Route01Icon}
                  size={16}
                />
                {value === "rev" ? "With Rev" : "Myself"}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {value === "manual"
                  ? "Start with an empty tour and create topics as you read."
                  : ready
                    ? "Rev suggests topics and steps. You stay in control of each one."
                    : "Rev is not set up yet · Settings › Rev"}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-secondary px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">You will review</p>
          <p className="mt-0.5 text-sm font-medium">{scopeTitles[scope]}</p>
          <ReviewStats stats={stats} />
        </div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Change
        </Button>
      </div>
    </div>
  )
}
