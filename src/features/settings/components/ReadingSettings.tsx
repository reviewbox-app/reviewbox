"use client"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import type { ReadingLevel } from "@/lib/desktop/contracts.generated"
import { useReadingPreferences } from "../hooks/useReadingPreferences"
import { SettingRow } from "./SettingRow"
export function ReadingLevelChoice({
  level,
  onChange,
}: {
  level: ReadingLevel
  onChange: (level: ReadingLevel) => void
}) {
  return (
    <RadioGroup
      aria-label="Reading mode"
      value={level}
      onValueChange={(value) => {
        if (
          value === "essential" ||
          value === "explained" ||
          value === "technical"
        )
          onChange(value)
      }}
      className="gap-3"
    >
      {(
        [
          [
            "essential",
            "Essential",
            "Plain explanations and helpful diagrams.",
          ],
          ["explained", "Explained", "Technical explanations and definitions."],
          ["technical", "Technical", "Technical detail and captured source."],
        ] as const
      ).map(([value, title, detail]) => (
        <label
          key={value}
          className="flex cursor-pointer items-start gap-3 rounded-xl border p-3"
        >
          <RadioGroupItem value={value} className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{detail}</span>
          </span>
        </label>
      ))}
    </RadioGroup>
  )
}
export function ReadingSettings() {
  const preferences = useReadingPreferences()
  return (
    <div className="space-y-5">
      <ReadingLevelChoice
        level={preferences.level}
        onChange={preferences.setLevel}
      />
      <div className="rounded-xl border px-4">
        <SettingRow
          title="Ask when starting a review"
          description="Choose the initial reading mode for each new review. You can always change it while reading."
        >
          <Switch
            checked={preferences.askEachReview}
            onCheckedChange={preferences.setAskEachReview}
            aria-label="Ask when starting a review"
          />
        </SettingRow>
      </div>
    </div>
  )
}
