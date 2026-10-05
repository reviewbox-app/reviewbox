"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { call, errorMessage } from "@/lib/desktop/review.commands"
import type {
  ProjectSkillImport,
  ProjectSkillPreferences,
} from "@/lib/desktop/contracts.generated"
import { SettingRow } from "./SettingRow"

const choices = [
  { value: "inherit", label: "Use application setting" },
  { value: "enabled", label: "Import missing skills" },
  { value: "disabled", label: "Do not import" },
]

export function ProjectSkillSettings({
  repositoryId,
}: {
  repositoryId?: string
}) {
  const [preferences, setPreferences] =
    useState<ProjectSkillPreferences | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [report, setReport] = useState<ProjectSkillImport | null>(null)
  useEffect(() => {
    let alive = true
    call<ProjectSkillPreferences>("project_skill_preferences")
      .then((value) => {
        if (alive) setPreferences(value)
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [repositoryId])

  async function update(value: ProjectSkillPreferences) {
    setBusy(true)
    setError("")
    setReport(null)
    try {
      setPreferences(
        await call<ProjectSkillPreferences>("configure_project_skills", {
          preferences: value,
        })
      )
    } catch (cause) {
      setError(errorMessage(cause))
      setPreferences(
        await call<ProjectSkillPreferences>("project_skill_preferences").catch(
          () => null
        )
      )
    } finally {
      setBusy(false)
    }
  }
  const override =
    repositoryId && preferences ? preferences.projects[repositoryId] : undefined
  return (
    <div className="space-y-2">
      <SettingRow
        title="Project agent skills"
        description="Import ReviewBox skills into .agents/skills and reference them in AGENTS.md when opening a project. Existing files are never replaced or removed. This preference stays on this device."
      >
        {repositoryId ? (
          <Select
            items={choices}
            value={
              override === undefined
                ? "inherit"
                : override
                  ? "enabled"
                  : "disabled"
            }
            disabled={busy || !preferences}
            onValueChange={(value) => {
              if (!value || !preferences) return
              const projects = { ...preferences.projects }
              if (value === "inherit") delete projects[repositoryId]
              else projects[repositoryId] = value === "enabled"
              void update({ ...preferences, projects })
            }}
          >
            <SelectTrigger aria-label="Project skill import">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Switch
            aria-label="Import project agent skills"
            checked={preferences?.enabled ?? true}
            disabled={busy || !preferences}
            onCheckedChange={(enabled) => {
              if (preferences) void update({ ...preferences, enabled })
            }}
          />
        )}
      </SettingRow>
      {repositoryId && (
        <div className="space-y-2 pb-3">
          {preferences && !preferences.enabled && (
            <p className="text-xs text-muted-foreground">
              Imports are disabled in the application settings.
            </p>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !preferences?.enabled || override === false}
            onClick={async () => {
              setBusy(true)
              setError("")
              setReport(null)
              try {
                setReport(
                  await call<ProjectSkillImport>("import_project_skills", {
                    repositoryId,
                  })
                )
              } catch (cause) {
                setError(errorMessage(cause))
              } finally {
                setBusy(false)
              }
            }}
          >
            Import missing files
          </Button>
          {report && (
            <p role="status" className="text-xs text-muted-foreground">
              {report.created.length} files added; {report.preserved.length}{" "}
              existing files preserved.
            </p>
          )}
          {report?.error && (
            <p role="alert" className="text-xs text-destructive">
              {report.error.message}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
