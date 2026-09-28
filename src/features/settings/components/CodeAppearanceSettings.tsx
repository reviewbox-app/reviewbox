"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
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
  return (
    <>
      <SettingRow
        title="Code colors"
        description="Rich syntax colors in code, pseudo-code and previews. ReviewBox surfaces stay unchanged."
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
            <NativeSelect
              value={profileId}
              aria-label="VS Code profile"
              onChange={(event) => setSelected(event.target.value)}
            >
              {appearance.profiles.map((profile) => (
                <NativeSelectOption key={profile.id} value={profile.id}>
                  {profile.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
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
