"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { languageServerCommands } from "../services/languageServer.commands"
import { errorMessage } from "@/lib/desktop/review.commands"
import type {
  LanguageServerConfig,
  LanguageServerSettings,
} from "@/lib/desktop/contracts.generated"
export function LanguageServerSettingsPanel() {
  const [settings, setSettings] = useState<LanguageServerSettings | null>(null)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let alive = true
    languageServerCommands
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
  const update = (id: string, patch: Partial<LanguageServerConfig>) => {
    if (settings)
      setSettings({
        ...settings,
        servers: settings.servers.map((s) =>
          s.id === id ? { ...s, ...patch } : s
        ),
      })
    setSaved(false)
  }
  return (
    <section className="space-y-5">
      <p className="text-muted-foreground">
        Configure language servers already installed on your Mac. They run on a
        copy of the frozen source files. ReviewBox does not install tools.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {settings?.servers.map((server) => (
        <fieldset key={server.id} className="space-y-3 rounded-xl border p-4">
          <legend className="px-2">{server.name}</legend>
          <Label htmlFor={`${server.id}-name`}>Name</Label>
          <Input
            id={`${server.id}-name`}
            value={server.name}
            onChange={(e) => update(server.id, { name: e.target.value })}
          />
          <Label htmlFor={`${server.id}-exe`}>Executable</Label>
          <Input
            id={`${server.id}-exe`}
            value={server.executable}
            onChange={(e) => update(server.id, { executable: e.target.value })}
          />
          <Label htmlFor={`${server.id}-args`}>Arguments (one per line)</Label>
          <textarea
            id={`${server.id}-args`}
            className="min-h-16 w-full rounded-lg border bg-background p-2 font-mono text-xs"
            value={server.arguments.join("\n")}
            onChange={(e) =>
              update(server.id, {
                arguments: e.target.value.split("\n").filter(Boolean),
              })
            }
          />
          <Label htmlFor={`${server.id}-ext`}>
            Extensions, separated by commas
          </Label>
          <Input
            id={`${server.id}-ext`}
            value={server.extensions.join(",")}
            onChange={(e) =>
              update(server.id, {
                extensions: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              settings &&
              setSettings({
                ...settings,
                servers: settings.servers.filter((s) => s.id !== server.id),
              })
            }
          >
            Remove
          </Button>
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={!settings}
          onClick={() =>
            settings &&
            setSettings({
              ...settings,
              servers: [
                ...settings.servers,
                {
                  id: crypto.randomUUID(),
                  name: "Language server",
                  extensions: ["py"],
                  executable: "",
                  arguments: [],
                },
              ],
            })
          }
        >
          Add language server
        </Button>
        <Button
          disabled={!settings}
          onClick={() => {
            if (settings)
              void languageServerCommands
                .configure(settings)
                .then((value) => {
                  setSettings(value)
                  setSaved(true)
                })
                .catch((e) => setError(errorMessage(e)))
          }}
        >
          Save configuration
        </Button>
      </div>
      {saved && (
        <p role="status" className="text-review-validated">
          Configuration saved.
        </p>
      )}
    </section>
  )
}
