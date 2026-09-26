"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { SettingRow } from "@/features/settings/components/SettingRow"
import { harnessNames } from "../hooks/useRevStatus"
import type { ProviderSettings } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { agentCommands } from "../services/agent.commands"
export function ProviderSettingsPanel({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    agentCommands
      .settings()
      .then((v) => {
        if (alive) setSettings(v)
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [])
  return (
    <form
      className="rounded-3xl border px-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (!settings) return
        setBusy(true)
        void agentCommands
          .configure(settings)
          .then((value) => {
            setSettings(value)
            setError("")
            onSaved()
          })
          .catch((e) => setError(errorMessage(e)))
          .finally(() => setBusy(false))
      }}
    >
      {settings && (
        <>
          <SettingRow
            title="Rev’s harness"
            description="Used by Rev for suggestions, questions and explanations."
          >
            <NativeSelect
              id="default-provider"
              aria-label="Rev’s harness"
              className="w-44"
              value={settings.defaultProvider}
              onChange={(e) =>
                setSettings({ ...settings, defaultProvider: e.target.value })
              }
            >
              {Object.entries(harnessNames).map(([value, name]) => (
                <NativeSelectOption key={value} value={value}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SettingRow>
          {settings.providers.map((provider) => (
            <SettingRow
              key={provider.provider}
              title={`${harnessNames[provider.provider] ?? provider.provider} executable and model`}
              description="The model stays the harness default unless you override it."
            >
              <div className="flex w-72 flex-col gap-2">
                <Input
                  id={`executable-${provider.provider}`}
                  aria-label={`${provider.provider} executable`}
                  className="font-mono text-xs"
                  value={provider.executable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      providers: settings.providers.map((p) =>
                        p.provider === provider.provider
                          ? { ...p, executable: e.target.value }
                          : p
                      ),
                    })
                  }
                />
                <Input
                  id={`model-${provider.provider}`}
                  aria-label={`${provider.provider} model override`}
                  value={provider.model ?? ""}
                  placeholder="Harness default model"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      providers: settings.providers.map((p) =>
                        p.provider === provider.provider
                          ? { ...p, model: e.target.value || null }
                          : p
                      ),
                    })
                  }
                />
              </div>
            </SettingRow>
          ))}
          <div className="flex items-center justify-end gap-3 py-4">
            {error && (
              <p role="alert" className="flex-1 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button disabled={busy}>Save and detect again</Button>
          </div>
        </>
      )}
      {!settings && error && (
        <p role="alert" className="py-4 text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
