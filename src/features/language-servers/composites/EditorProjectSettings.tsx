"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  bufferLanguage,
  updateEditor,
  useEditorStore,
  type EditorBuffer,
} from "@/features/code-editor/stores/editor.store"
import type { LiveLanguageProjectSettings } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { liveCommands } from "../services/liveLanguage.commands"
import { useLiveLanguages } from "../services/liveMonaco"

function object(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Settings must be a JSON object.")
  return parsed as Record<string, unknown>
}

export function EditorProjectSettings({
  repositoryId,
  buffer,
  serverId,
  preferredServerId,
}: {
  repositoryId: string
  buffer: EditorBuffer
  serverId?: string
  preferredServerId?: string
}) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState("language")
  const [value, setValue] = useState<LiveLanguageProjectSettings | null>(null)
  const [environment, setEnvironment] = useState("{}")
  const [settings, setSettings] = useState("{}")
  const [initialization, setInitialization] = useState("null")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const session = useLiveLanguages((s) => s.sessions[buffer.id])
  const selectedServer = preferredServerId ?? session?.serverId ?? serverId
  const activeSession = session?.serverId === selectedServer ? session : null
  const preferences = useEditorStore(
    (s) => s.sessions[repositoryId]?.saveActions
  )
  const language = bufferLanguage(repositoryId, buffer)
  const key = scope === "project" ? "*" : language
  const actions = preferences?.[key] ??
    preferences?.["*"] ?? { formatOnSave: true, organizeImportsOnSave: true }
  const update = (patch: Partial<typeof actions>) =>
    updateEditor(repositoryId, (s) => ({
      ...s,
      saveActions: { ...s.saveActions, [key]: { ...actions, ...patch } },
    }))
  const show = async () => {
    setOpen(true)
    setError("")
    setValue(null)
    if (!selectedServer) return
    try {
      const saved = await liveCommands.projectSettings(
        repositoryId,
        selectedServer,
        buffer.path
      )
      setValue(saved)
      setEnvironment(JSON.stringify(saved.environment, null, 2))
      setSettings(JSON.stringify(saved.settings ?? {}, null, 2))
      setInitialization(JSON.stringify(saved.initializationOptions, null, 2))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => void show()}>
        Project settings
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogTitle>Editor project settings</DialogTitle>
          <DialogDescription>
            Local preferences for this checkout. Save actions run on manual
            saves; auto-save keeps your text unchanged.
          </DialogDescription>
          <Label htmlFor="editor-save-scope">Save actions</Label>
          <select
            id="editor-save-scope"
            className="rounded-xl bg-input p-2 text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="language">{language}</option>
            <option value="project">Project defaults</option>
          </select>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="editor-format-save">Format on manual save</Label>
            <Switch
              id="editor-format-save"
              checked={actions.formatOnSave}
              onCheckedChange={(formatOnSave) => update({ formatOnSave })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="editor-imports-save">
              Organize imports on manual save
            </Label>
            <Switch
              id="editor-imports-save"
              checked={actions.organizeImportsOnSave}
              onCheckedChange={(organizeImportsOnSave) =>
                update({ organizeImportsOnSave })
              }
            />
          </div>
          {scope === "language" && preferences?.[key] && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                updateEditor(repositoryId, (s) => {
                  const saveActions = { ...s.saveActions }
                  delete saveActions[key]
                  return { ...s, saveActions }
                })
              }
            >
              Use project defaults
            </Button>
          )}
          {activeSession && (
            <p className="text-xs break-all text-muted-foreground">
              Project root: {activeSession.context.rootUri}
            </p>
          )}
          {!!activeSession?.context.missing.length && (
            <p role="status" className="text-sm">
              {activeSession.context.missing.join(" · ")}
            </p>
          )}
          {value && (
            <details className="space-y-3">
              <summary className="cursor-pointer text-sm">
                Language server configuration
              </summary>
              <Label htmlFor="editor-project-root">
                Project root override (checkout-relative)
              </Label>
              <Input
                id="editor-project-root"
                placeholder="Automatic"
                value={value.root ?? ""}
                onChange={(e) =>
                  setValue({ ...value, root: e.target.value || null })
                }
              />
              <Label htmlFor="editor-project-env">Environment (JSON)</Label>
              <Textarea
                id="editor-project-env"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
              />
              <Label htmlFor="editor-project-config">
                Language settings (JSON)
              </Label>
              <Textarea
                id="editor-project-config"
                value={settings}
                onChange={(e) => setSettings(e.target.value)}
              />
              <Label htmlFor="editor-project-init">
                Initialization options (JSON, null uses pack defaults)
              </Label>
              <Textarea
                id="editor-project-init"
                value={initialization}
                onChange={(e) => setInitialization(e.target.value)}
              />
              <Button
                disabled={busy}
                onClick={async () => {
                  if (!selectedServer) return
                  setBusy(true)
                  setError("")
                  try {
                    const env = object(environment)
                    if (Object.values(env).some((v) => typeof v !== "string"))
                      throw new Error("Environment values must be strings.")
                    const next = await liveCommands.saveProjectSettings(
                      repositoryId,
                      selectedServer,
                      {
                        ...value,
                        environment: env as Record<string, string>,
                        settings: object(settings),
                        initializationOptions:
                          initialization.trim() === "null"
                            ? null
                            : object(initialization),
                      },
                      buffer.path
                    )
                    setValue(next)
                  } catch (e) {
                    setError(errorMessage(e))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Save server configuration
              </Button>
            </details>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
