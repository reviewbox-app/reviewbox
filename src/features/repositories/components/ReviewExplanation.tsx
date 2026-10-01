import type {
  PreparationMode,
  Scope,
  ScopePreview,
} from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import {
  AiMagicIcon,
  File01Icon,
  GitBranchIcon,
  GitCommitIcon,
  Layers01Icon,
  PinIcon,
  Route01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { fileCount } from "./ReviewScopeStep"

const copy: Record<Scope, { title: string; text: string }> = {
  local: {
    title: "Everything you changed since the last commit",
    text: "Staged and unstaged files are reviewed together. If a file is partially staged, ReviewBox keeps both versions.",
  },
  unstaged: {
    title: "What you have not staged yet",
    text: "Read through your work in progress before staging it. Changes already staged stay outside this review.",
  },
  staged: {
    title: "What will go into the next commit",
    text: "Review exactly what you are about to commit. Unstaged changes stay outside this review.",
  },
  commit: {
    title: "Exactly what one commit changed",
    text: "Choose a commit on the left. It is compared with its first parent, just like in Git history.",
  },
  range: {
    title: "Everything that changed between two points",
    text: "Choose a base and a target, for example main and your branch. The changes between them are reviewed as one set.",
  },
}

export function FrozenFilesNotice({
  starting = false,
}: {
  starting?: boolean
}) {
  return (
    <div className="flex w-full max-w-[480px] gap-3 rounded-3xl border bg-card p-4">
      <HugeiconsIcon icon={PinIcon} size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium">Files are frozen when you start</p>
        <p className="mt-1 text-xs leading-4 text-muted-foreground">
          {starting
            ? "Once copied, these files stay unchanged during the review. Refresh will offer newer versions if the code changes."
            : "During the review, you read the files as they were when you started. If you change the code afterwards, Refresh will offer the newer versions."}
        </p>
      </div>
    </div>
  )
}

export function ReviewStats({ stats }: { stats: ScopePreview | null }) {
  return (
    <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
      {stats ? (
        <>
          {fileCount(stats.files)} ·{" "}
          <span className="text-foreground">
            +{stats.additions} −{stats.deletions}
          </span>
          {stats.binaryFiles > 0 && <> · {stats.binaryFiles} binary</>}
        </>
      ) : (
        "Counting files…"
      )}
    </span>
  )
}

function Layer({
  label,
  detail,
  included = false,
  commit = false,
}: {
  label: string
  detail: string
  included?: boolean
  commit?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-2xl border bg-muted/50 px-3 py-2.5",
        included && "border-primary/40 bg-primary/10"
      )}
    >
      <HugeiconsIcon
        icon={commit ? GitCommitIcon : File01Icon}
        size={16}
        className={cn("shrink-0", included && "text-primary")}
      />
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={label}
      >
        {label}
      </span>
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        {detail}
      </span>
      {included && (
        <HugeiconsIcon
          icon={Tick02Icon}
          size={14}
          className="shrink-0 text-primary"
        />
      )}
    </div>
  )
}

export function ScopeExplanation({
  scope,
  stats,
  all,
  base,
  target,
}: {
  scope: Scope
  stats: ScopePreview | null
  all: ScopePreview[]
  base: string
  target: string
}) {
  const local = scope === "local" || scope === "staged" || scope === "unstaged"
  return (
    <div className="w-full max-w-[480px] space-y-6">
      <div className="flex size-10 items-center justify-center rounded-2xl bg-muted">
        <HugeiconsIcon
          icon={scope === "commit" ? GitCommitIcon : GitBranchIcon}
          size={20}
        />
      </div>
      <div>
        <h3 className="text-xl leading-7 font-medium">{copy[scope].title}</h3>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          {copy[scope].text}
        </p>
      </div>
      <div className="space-y-1.5">
        {local ? (
          <>
            <Layer
              commit
              label="Last commit"
              detail={scope === "unstaged" ? "not included" : "starting point"}
            />
            <Layer
              label="Staged"
              included={scope !== "unstaged"}
              detail={
                scope === "unstaged"
                  ? "starting point"
                  : fileCount(all.find((s) => s.scope === "staged")?.files ?? 0)
              }
            />
            <Layer
              label="Unstaged"
              included={scope !== "staged"}
              detail={
                scope === "staged"
                  ? "not included"
                  : fileCount(
                      all.find((s) => s.scope === "unstaged")?.files ?? 0
                    )
              }
            />
          </>
        ) : (
          <>
            <Layer
              commit
              label={
                scope === "commit"
                  ? `Parent · ${stats?.base?.slice(0, 7) ?? "empty tree"}`
                  : base
              }
              detail="starting point"
            />
            {scope === "range" && stats?.commitCount != null && (
              <Layer
                label={`${stats.commitCount} commits between them`}
                detail="included"
                included
              />
            )}
            <Layer
              commit
              label={target}
              detail={
                scope === "range" ? "target" : fileCount(stats?.files ?? 0)
              }
              included
            />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 rounded-2xl bg-accent px-3.5 py-3">
        <HugeiconsIcon icon={Layers01Icon} size={16} />
        <span className="flex-1 text-sm font-medium">Review files</span>
        <ReviewStats stats={stats} />
      </div>
    </div>
  )
}

export function PreparationExplanation({ mode }: { mode: PreparationMode }) {
  const rev = mode === "rev"
  const points = rev
    ? [
        "Rev reads the review files",
        "It writes the steps for all three reading modes",
        "Start reading once the documents are ready",
      ]
    : [
        "Each file appears once, with all its captured changes",
        "Read and validate files in Technical mode",
        "Prepare a guided review with Rev whenever you need it",
      ]
  return (
    <div className="w-full max-w-[480px] space-y-6">
      <div className="flex size-10 items-center justify-center rounded-2xl bg-muted">
        <HugeiconsIcon icon={rev ? AiMagicIcon : Route01Icon} size={20} />
      </div>
      <div>
        <h3 className="text-xl font-medium">
          {rev ? "Rev prepares a reading tour" : "Review the files yourself"}
        </h3>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          {rev
            ? "Rev explains the captured changes as an ordered reading path, with documents and references ready before you begin."
            : "Open the captured source directly, file by file. No documents are generated for a manual review."}
        </p>
      </div>
      <ol className="space-y-3">
        {points.map((point, i) => (
          <li key={point} className="flex gap-3 text-sm">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
              {i + 1}
            </span>
            {point}
          </li>
        ))}
      </ol>
      {rev && (
        <p className="text-xs text-muted-foreground">
          Rev never validates code. That decision is yours.
        </p>
      )}
    </div>
  )
}
