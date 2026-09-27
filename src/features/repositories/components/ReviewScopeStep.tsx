import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type {
  CaptureRequest,
  ReviewPreview,
  Scope,
} from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { GitReferenceSelect } from "./GitReferenceSelect"

export const scopeTitles: Record<Scope, string> = {
  local: "Local changes",
  unstaged: "Unstaged changes",
  staged: "Staged changes",
  commit: "A commit",
  range: "A range of commits",
}
export function fileCount(count: number) {
  return `${count} ${count === 1 ? "file" : "files"}`
}

export function ReviewScopeStep({
  request,
  preview,
  onChange,
}: {
  request: CaptureRequest
  preview: ReviewPreview | null
  onChange: (value: Partial<CaptureRequest>) => void
}) {
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium">What do you want to review?</h3>
      <RadioGroup
        aria-label="Review scope"
        value={request.scope}
        onValueChange={(value) => onChange({ scope: value as Scope })}
        className="gap-2"
      >
        {(["local", "unstaged", "staged", "commit", "range"] as Scope[]).map(
          (scope) => {
            const stats = preview?.scopes.find((s) => s.scope === scope)
            const local =
              scope === "local" || scope === "staged" || scope === "unstaged"
            const canIncludeUntracked =
              (scope === "local" || scope === "unstaged") &&
              (preview?.untrackedFiles ?? 0) > 0
            const disabled =
              local &&
              !!stats &&
              !stats.error &&
              stats.files === 0 &&
              !canIncludeUntracked
            const detail =
              scope === "commit"
                ? "What one commit changed"
                : scope === "range"
                  ? "Everything that changed between two points"
                  : !stats
                    ? "Counting files…"
                    : stats.error
                      ? "Could not read this scope"
                      : disabled
                        ? "No changes"
                        : `${scope === "local" ? "Staged and unstaged · " : ""}${fileCount(stats.files)}${scope === "staged" && stats.partiallyStagedFiles ? ` · ${stats.partiallyStagedFiles} partially staged` : ""}`
            return (
              <div
                key={scope}
                className={cn(
                  "min-w-0 rounded-3xl border transition-colors",
                  request.scope === scope
                    ? "border-primary bg-accent"
                    : "hover:bg-accent/40",
                  disabled && "opacity-45"
                )}
              >
                <label
                  className={cn(
                    "flex gap-3 px-4 py-3.5",
                    disabled ? "cursor-not-allowed" : "cursor-pointer"
                  )}
                >
                  <RadioGroupItem
                    value={scope}
                    disabled={disabled}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {scopeTitles[scope]}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {detail}
                    </span>
                  </span>
                </label>
                {request.scope === scope && scope === "commit" && (
                  <div className="mr-4 mb-3.5 ml-11">
                    <GitReferenceSelect
                      repositoryId={request.repositoryId}
                      label="Commit"
                      value={request.target ?? "HEAD"}
                      onChange={(target) => onChange({ target })}
                    />
                  </div>
                )}
                {request.scope === scope && scope === "range" && (
                  <div className="mr-4 mb-3.5 ml-11 flex min-w-0 items-center gap-2">
                    <GitReferenceSelect
                      repositoryId={request.repositoryId}
                      label="Base reference"
                      value={request.base ?? "HEAD~1"}
                      onChange={(base) => onChange({ base })}
                    />
                    <span aria-hidden className="text-muted-foreground">
                      ›
                    </span>
                    <GitReferenceSelect
                      repositoryId={request.repositoryId}
                      label="Target reference"
                      value={request.target ?? "HEAD"}
                      onChange={(target) => onChange({ target })}
                    />
                  </div>
                )}
              </div>
            )
          }
        )}
      </RadioGroup>
      {(request.scope === "local" || request.scope === "unstaged") && (
        <Label className="items-start gap-3 font-normal">
          <Checkbox
            className="mt-0.5"
            checked={!request.includeUntracked}
            onCheckedChange={(checked) =>
              onChange({ includeUntracked: checked !== true })
            }
          />
          <span>
            <span className="block text-sm">Exclude untracked files</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              New files Git does not track yet
              {preview ? ` · ${fileCount(preview.untrackedFiles)}` : ""}
            </span>
          </span>
        </Label>
      )}
    </div>
  )
}
