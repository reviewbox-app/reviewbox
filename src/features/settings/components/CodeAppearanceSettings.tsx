"use client"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { HighlightedCode } from "@/features/code-editor/components/HighlightedCode"
import { useAppearancePreferences } from "../hooks/useAppearancePreferences"
import { SettingRow } from "./SettingRow"

export function CodeAppearanceSettings() {
  const { preferences, fonts, update, saving, error } =
    useAppearancePreferences()
  const themes = [
    { value: "tokyo-night", label: "Tokyo Night" },
    { value: "reviewbox", label: "ReviewBox" },
  ]
  const family = preferences?.codeFontFamily ?? "Geist Mono"
  const families = [...new Set([family, ...fonts])].map((value) => ({
    value,
    label: fonts.includes(value) ? value : `${value} (unavailable)`,
  }))
  const weights = Array.from({ length: 9 }, (_, i) => ({
    value: String((i + 1) * 100),
    label: `${(i + 1) * 100}${i === 3 ? " · Regular" : i === 6 ? " · Bold" : ""}`,
  }))
  return (
    <>
      <SettingRow
        title="Code theme"
        description="Syntax colors in the editor, reviews and code previews."
      >
        <Select
          items={themes}
          value={preferences?.codeTheme ?? "tokyo-night"}
          disabled={saving}
          onValueChange={(value) => {
            if (value === "tokyo-night" || value === "reviewbox")
              void update({ codeTheme: value })
          }}
        >
          <SelectTrigger aria-label="Code theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {themes.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Code font"
        description="System monospace fonts, with Geist Mono as fallback."
      >
        <Select
          items={families}
          value={family}
          disabled={saving}
          onValueChange={(value) => {
            if (value) void update({ codeFontFamily: value })
          }}
        >
          <SelectTrigger aria-label="Code font">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {families.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Font weight"
        description="Used across all code surfaces."
      >
        <Select
          items={weights}
          value={String(preferences?.codeFontWeight ?? 400)}
          disabled={saving}
          onValueChange={(value) => {
            if (value) void update({ codeFontWeight: Number(value) })
          }}
        >
          <SelectTrigger aria-label="Code font weight">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {weights.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <div
        className="code-font rounded-xl bg-muted/40 p-3 text-xs"
        aria-label="Code font preview"
      >
        <HighlightedCode
          language="typescript"
          source="const review = { ready: true } // ReviewBox"
        />
      </div>
      <SettingRow
        title="File icons"
        description="ReviewBox icons, based on Material Icon Theme. Included for everyone and available offline."
      />
      {error && (
        <Alert size="sm" variant="faded">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  )
}
