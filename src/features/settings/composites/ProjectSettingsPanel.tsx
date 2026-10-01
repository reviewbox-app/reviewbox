"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ModelSelector } from "@/features/agents/components/ModelSelector"
import { useProviderStatus } from "@/features/agents/hooks/useProviderStatus"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import type {
  PreparationMode,
  ProjectSettings,
  Repository,
  Scope,
} from "@/lib/desktop/contracts.generated"

const scopeItems: { value: Scope; label: string }[] = [
  "local",
  "staged",
  "unstaged",
  "commit",
  "range",
].map((value) => ({ value: value as Scope, label: value }))
const preparationItems: { value: PreparationMode; label: string }[] = [
  { value: "rev", label: "With Rev" },
  { value: "manual", label: "Myself" },
]
const providerItems = [
  { value: "", label: "Use application default" },
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
]

export function ProjectSettingsPanel() {
  const { settings: providerSettings } = useProviderStatus()
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repositoryId, setRepositoryId] = useState("")
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const repositoryItems = repositories.length
    ? repositories.map((repo) => ({
        value: repo.id,
        label: `${repo.name} — ${repo.path}`,
      }))
    : [{ value: "", label: "Open a repository first" }]
  const effectiveProvider =
    settings?.provider ?? providerSettings?.defaultProvider ?? ""
  const providerConfig = providerSettings?.providers.find(
    (p) => p.provider === effectiveProvider
  )
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
      <Select
        items={repositoryItems}
        value={repositoryId}
        onValueChange={(value) => {
          if (value !== null) {
            setSettings(null)
            setRepositoryId(value)
          }
        }}
      >
        <SelectTrigger id="settings-project" className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {repositoryItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
            <Select
              items={scopeItems}
              value={settings.defaultScope}
              onValueChange={(value) => {
                if (value !== null) {
                  update({ defaultScope: value })
                }
              }}
            >
              <SelectTrigger id="project-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Label>
            <Checkbox
              checked={!settings.includeUntracked}
              onCheckedChange={(value) =>
                update({ includeUntracked: value !== true })
              }
            />
            Exclude untracked files by default
          </Label>
          <div className="space-y-2">
            <Label htmlFor="project-preparation">Default preparation</Label>
            <Select
              items={preparationItems}
              value={settings.defaultPreparation}
              onValueChange={(value) => {
                if (value !== null) {
                  update({ defaultPreparation: value })
                }
              }}
            >
              <SelectTrigger id="project-preparation" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {preparationItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-provider">
              Rev’s harness for this project
            </Label>
            <Select
              items={providerItems}
              value={settings.provider ?? ""}
              onValueChange={(value) => {
                if (value !== null) {
                  update({ provider: value || null, model: null })
                }
              }}
            >
              <SelectTrigger id="project-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-model">Model override</Label>
            <ModelSelector
              key={`${repositoryId}:${effectiveProvider}:${providerConfig?.executable ?? ""}`}
              id="project-model"
              provider={effectiveProvider}
              executable={providerConfig?.executable}
              defaultLabel="Use application settings"
              value={settings.model}
              disabled={busy}
              onChange={(model) =>
                update({
                  model,
                  ...(model ? { provider: effectiveProvider } : {}),
                })
              }
            />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>
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
