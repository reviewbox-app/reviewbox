"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
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
    <section className="min-h-0 space-y-5 overflow-auto text-sm">
      <div>
        <h2 className="text-lg font-medium">Project settings</h2>
        <p className="mt-2 text-muted-foreground">
          Saved in .reviewbox and shared through Git. Executables and
          permissions remain in Application settings.
        </p>
      </div>
      <Label htmlFor="settings-project">Project</Label>
      <select
        id="settings-project"
        className="h-9 w-full rounded-md border bg-background px-3"
        value={repositoryId}
        onChange={(e) => {
          setSettings(null)
          setRepositoryId(e.target.value)
        }}
      >
        {!repositories.length && (
          <option value="">Open a repository first</option>
        )}
        {repositories.map((repo) => (
          <option key={repo.id} value={repo.id}>
            {repo.name} — {repo.path}
          </option>
        ))}
      </select>
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
            <select
              id="project-scope"
              className="h-9 w-full rounded-md border bg-background px-3"
              value={settings.defaultScope}
              onChange={(e) =>
                update({ defaultScope: e.target.value as Scope })
              }
            >
              {["local", "staged", "unstaged", "commit", "range"].map(
                (scope) => (
                  <option key={scope}>{scope}</option>
                )
              )}
            </select>
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
            <Label htmlFor="project-provider">Default agent</Label>
            <select
              id="project-provider"
              className="h-9 w-full rounded-md border bg-background px-3"
              value={settings.provider ?? ""}
              onChange={(e) => update({ provider: e.target.value || null })}
            >
              <option value="">Use application default</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
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
