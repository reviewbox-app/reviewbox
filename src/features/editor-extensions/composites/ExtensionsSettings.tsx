"use client"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { SettingRow } from "@/features/settings/components/SettingRow"
import { extensions, useEditorExtensions } from "../services/extensions.store"
import {
  retryEngine,
  useEditorEngines,
  useEditorEngineStatus,
  engineEnabled,
} from "../services/engines"

export function ExtensionsSettings() {
  useEditorEngineStatus()
  const { preferences, busy, error, setEnabled, setPrettierOnSave } =
    useEditorExtensions()
  const engines = useEditorEngines((s) => s.engines)
  return (
    <>
      {Object.entries(engines)
        .filter(([id, state]) => engineEnabled(id) && state.phase !== "ready")
        .map(([id, state]) => (
          <Alert key={id} size="sm" variant="faded">
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>
                <strong>
                  {extensions.find((e) => e.engine === id)?.name ?? id}
                </strong>
                : {state.message}
              </span>
              {state.phase === "failed" && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void retryEngine(id).catch(() => {})}
                >
                  Retry
                </Button>
              )}
            </AlertDescription>
          </Alert>
        ))}
      <div className="rounded-3xl border px-5">
        {extensions.map((item) => (
          <SettingRow
            key={item.id}
            title={item.name}
            description={item.description}
          >
            <Switch
              aria-label={item.name}
              checked={preferences.enabled[item.id] !== false}
              disabled={busy !== null}
              onCheckedChange={(value) => void setEnabled(item.id, value)}
            />
          </SettingRow>
        ))}
        <SettingRow
          title="Prettier on save"
          description="Format during manual saves. Project save settings also apply."
        >
          <Switch
            aria-label="Prettier on save"
            checked={preferences.prettierOnSave !== false}
            disabled={!preferences.enabled.prettier}
            onCheckedChange={(enabled) => void setPrettierOnSave(enabled)}
          />
        </SettingRow>
      </div>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  )
}
