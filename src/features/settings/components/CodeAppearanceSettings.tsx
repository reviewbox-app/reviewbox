"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAppearancePreferences } from "../hooks/useAppearancePreferences"
import { SettingRow } from "./SettingRow"
import {
  loadFileIcons,
  useFileIcons,
} from "@/features/file-icons/stores/useFileIcons.store"
import { fileIconImportWarnings } from "@/features/file-icons/helpers/fileIcons.helpers"

export function CodeAppearanceSettings() {
  const appearance = useAppearancePreferences()
  const icons = useFileIcons()
  useEffect(() => {
    void loadFileIcons()
  }, [])
  const warnings = [
    ...new Set([
      ...(appearance.preferences?.importWarnings ?? []),
      ...(icons.catalog
        ? fileIconImportWarnings(icons.catalog, icons.preferences)
        : []),
    ]),
  ]
  const [selected, setSelected] = useState<string | null>(null)
  const profileId =
    selected ??
    appearance.profiles.find(
      (p) => p.name === appearance.preferences?.importedProfile
    )?.id ??
    appearance.profiles[0]?.id
  const profileItems = appearance.profiles.map((profile) => ({
    value: profile.id,
    label: profile.name,
  }))
  return (
    <>
      <SettingRow
        title="Code colors"
        description="Rich syntax colors in code and previews. ReviewBox surfaces stay unchanged."
      >
        <Tabs
          value={appearance.preferences?.codeTheme ?? "tokyo-night"}
          onValueChange={(value) =>
            appearance.setCodeTheme(
              value === "reviewbox" ? "reviewbox" : "tokyo-night"
            )
          }
        >
          <TabsList>
            <TabsTrigger value="tokyo-night">Tokyo Night</TabsTrigger>
            <TabsTrigger value="reviewbox">ReviewBox</TabsTrigger>
          </TabsList>
        </Tabs>
      </SettingRow>
      <SettingRow
        title="File icons"
        description={
          appearance.preferences?.importedProfile
            ? `Material Icon Theme · imported from ${appearance.preferences.importedProfile}`
            : "Material Icon Theme, available offline."
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {appearance.profiles.length > 1 && (
            <Select
              items={profileItems}
              value={profileId}
              onValueChange={(value) => {
                if (value !== null) {
                  setSelected(value)
                }
              }}
            >
              <SelectTrigger aria-label="VS Code profile">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {profileItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={!profileId || appearance.saving}
            onClick={() => profileId && void appearance.importIcons(profileId)}
          >
            Import VS Code icons
          </Button>
        </div>
      </SettingRow>
      {appearance.error || warnings.length ? (
        <Alert size="sm" variant="faded" className="my-3">
          <AlertDescription>
            {appearance.error ?? warnings.join(" ")}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  )
}
