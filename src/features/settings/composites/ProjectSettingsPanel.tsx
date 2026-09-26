"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import type {
  ProjectSettings,
  Repository,
  Scope,
} from "@/lib/desktop/contracts.generated"

export function ProjectSettingsPanel() {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repositoryId, setRepositoryId] = useState("")
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    reviewCommands
      .repositories()
      .then((value) => {
        if (alive) {
          setRepositories(value)
          setRepositoryId(value[0]?.id ?? "")
        }
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (!repositoryId) return
    let alive = true
    reviewCommands
      .projectSettings(repositoryId)
      .then((value) => {
        if (alive) {
          setSettings(value)
          setError("")
          setSaved(false)
        }
      })
      .catch((e) => {
        if (alive) {
          setSettings(null)
          setError(errorMessage(e))
        }
      })
    return () => {
      alive = false
    }
  }, [repositoryId])
  const update = (value: Partial<ProjectSettings>) => {
    setSettings((previous) => (previous ? { ...previous, ...value } : previous))
    setSaved(false)
  }
  return (
    <section className="max-w-xl space-y-5 text-sm">
      <div>
        <p className="text-muted-foreground">
          Saved in .reviewbox and shared through Git. Executables and
          permissions remain in Application settings.
        </p>
      </div>
      <Label htmlFor="settings-project">Project</Label>
      <NativeSelect
        id="settings-project"
        className="w-full"
        value={repositoryId}
        onChange={(e) => {
          setSettings(null)
          setRepositoryId(e.target.value)
        }}
      >
        {!repositories.length && (
          <NativeSelectOption value="">
            Open a repository first
          </NativeSelectOption>
        )}
        {repositories.map((repo) => (
          <NativeSelectOption key={repo.id} value={repo.id}>
            {repo.name} — {repo.path}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {settings && (
        <form
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            setError("")
            try {
              setSettings(
                await reviewCommands.configureProject(repositoryId, settings)
              )
              setSaved(true)
            } catch (e) {
              setError(errorMessage(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-language">Explanation language</Label>
            <Input
              id="project-language"
              value={settings.language}
              required
              onChange={(e) => update({ language: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-scope">Default review scope</Label>
            <NativeSelect
              id="project-scope"
              className="w-full"
              value={settings.defaultScope}
              onChange={(e) =>
                update({ defaultScope: e.target.value as Scope })
              }
            >
              {["local", "staged", "unstaged", "commit", "range"].map(
                (scope) => (
                  <NativeSelectOption key={scope}>{scope}</NativeSelectOption>
                )
              )}
            </NativeSelect>
          </div>
          <Label>
            <Checkbox
              checked={settings.includeUntracked}
              onCheckedChange={(value) =>
                update({ includeUntracked: value === true })
              }
            />
            Include untracked files by default
          </Label>
          <div className="space-y-2">
            <Label htmlFor="project-provider">
              Rev’s harness for this project
            </Label>
            <NativeSelect
              id="project-provider"
              className="w-full"
              value={settings.provider ?? ""}
              onChange={(e) => update({ provider: e.target.value || null })}
            >
              <NativeSelectOption value="">
                Use application default
              </NativeSelectOption>
              <NativeSelectOption value="codex">Codex</NativeSelectOption>
              <NativeSelectOption value="claude">
                Claude Code
              </NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-model">Model override</Label>
            <Input
              id="project-model"
              placeholder="Use application default"
              value={settings.model ?? ""}
              onChange={(e) => update({ model: e.target.value.trim() || null })}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={busy}>
              {busy ? "Saving…" : "Save project settings"}
            </Button>
            {saved && <span role="status">Saved in .reviewbox</span>}
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
