import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ReadingLevelChoice } from "@/features/settings/components/ReadingSettings"
import type {
  PreparationMode,
  ReadingLevel,
  Scope,
  ScopePreview,
} from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { AiMagicIcon, Route01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { ReviewStats } from "./ReviewExplanation"
import { scopeTitles } from "./ReviewScopeStep"

export function PreparationStep({
  mode,
  ready,
  scope,
  stats,
  onChange,
  onBack,
  readingLevel,
  onReadingLevelChange,
}: {
  readingLevel?: ReadingLevel
  onReadingLevelChange?: (level: ReadingLevel) => void
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
        onValueChange={(value) => {
          if (value === "rev" || value === "manual") onChange(value)
        }}
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
                  ? "Review captured files directly in Technical mode."
                  : ready
                    ? "Rev prepares a guided review in all three reading modes."
                    : "Rev is not set up yet · Settings › Rev"}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {mode === "rev" && readingLevel && onReadingLevelChange && (
        <ReadingLevelChoice
          level={readingLevel}
          onChange={onReadingLevelChange}
        />
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-accent px-4 py-3.5">
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
