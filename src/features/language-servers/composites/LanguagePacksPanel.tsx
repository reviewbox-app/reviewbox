"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import type { LanguagePack } from "@/lib/desktop/contracts.generated"
import { call, errorMessage } from "@/lib/desktop/review.commands"
import {
  refreshLanguageRegistry,
  registryCommands,
  useLanguageRegistry,
} from "../services/languageRegistry.service"

export function LanguagePacksPanel() {
  const registry = useLanguageRegistry((s) => s.registry)
  const [text, setText] = useState("")
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void refreshLanguageRegistry().catch((e) => setError(errorMessage(e)))
  }, [])
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError("")
    try {
      await work()
      await refreshLanguageRegistry()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Custom language packs</p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setText("")
            setOpen(true)
          }}
        >
          Import pack
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Add language definitions, TextMate grammars and server recipes.
        Importing a pack does not install its server.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {registry?.packs.map((pack) => (
        <div
          key={pack.id}
          className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
        >
          <span className="flex-1 text-sm">
            {pack.name} · {pack.version}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(() =>
                registryCommands.save({ ...pack, enabled: !pack.enabled })
              )
            }
          >
            {pack.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void act(() => call("export_language_pack", { packId: pack.id }))
            }
          >
            Export
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(() => registryCommands.remove(pack.id))}
          >
            Remove pack
          </Button>
        </div>
      ))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle>Import language pack</DialogTitle>
          <DialogDescription>
            Review and import a local JSON manifest. Server installation remains
            a separate action.
          </DialogDescription>
          <input
            aria-label="Choose language pack"
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void file.text().then(setText)
            }}
          />
          <textarea
            aria-label="Language pack JSON"
            className="h-72 w-full rounded-xl bg-muted p-3 font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !text.trim()}
              onClick={() =>
                void act(async () => {
                  const pack = JSON.parse(text) as LanguagePack
                  await registryCommands.save(pack)
                  setOpen(false)
                })
              }
            >
              Import pack
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
