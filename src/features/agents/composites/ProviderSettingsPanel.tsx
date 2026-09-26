"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
      className="space-y-4 border-t pt-5"
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
          <Label htmlFor="default-provider">Default harness</Label>
          <select
            id="default-provider"
            className="w-full rounded-lg border bg-background p-2"
            value={settings.defaultProvider}
            onChange={(e) =>
              setSettings({ ...settings, defaultProvider: e.target.value })
            }
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
          {settings.providers.map((provider) => (
            <fieldset
              key={provider.provider}
              className="space-y-3 rounded-xl border p-3"
            >
              <legend className="px-2">{provider.provider}</legend>
              <Label htmlFor={`executable-${provider.provider}`}>
                CLI executable
              </Label>
              <Input
                id={`executable-${provider.provider}`}
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
              <Label htmlFor={`model-${provider.provider}`}>
                Model override (optional)
              </Label>
              <Input
                id={`model-${provider.provider}`}
                value={provider.model ?? ""}
                placeholder="Use the harness default"
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
            </fieldset>
          ))}
          <Button disabled={busy}>Save and detect again</Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
