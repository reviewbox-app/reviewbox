"use client"
import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { GitCommitIcon } from "@hugeicons/core-free-icons"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import type {
  GitCommitDetail,
  GitCommitSummary,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { sourceControlCommands } from "../services/source-control.commands"

export function CommitCard({
  repositoryId,
  commit,
}: {
  repositoryId: string
  commit: GitCommitSummary
}) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [error, setError] = useState("")
  const [open, setOpen] = useState(false)
  const load = () => {
    if (!detail && !error)
      void sourceControlCommands
        .detail(repositoryId, commit.oid)
        .then(setDetail)
        .catch((cause) => setError(errorMessage(cause)))
  }
  return (
    <HoverCard
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) load()
      }}
    >
      <HoverCardTrigger
        render={
          <button
            type="button"
            aria-label={`Inspect commit ${commit.oid.slice(0, 7)}: ${commit.subject}`}
            onFocus={() => {
              setOpen(true)
              load()
            }}
            onBlur={() => setOpen(false)}
          />
        }
        className="flex w-full items-center gap-3 rounded-2xl border border-primary/20 bg-primary/10 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <HugeiconsIcon icon={GitCommitIcon} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {commit.subject}
          </span>
          <span className="text-xs text-muted-foreground">
            {commit.author} · {new Date(commit.date).toLocaleDateString()}
          </span>
        </span>
        <span className="font-mono text-xs text-primary">
          {commit.oid.slice(0, 7)}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-[min(480px,85vw)] space-y-3">
        <p className="text-sm font-medium">{commit.subject}</p>
        <p className="text-xs text-muted-foreground">
          {commit.author} · {new Date(commit.date).toLocaleString()} ·{" "}
          {commit.oid.slice(0, 7)}
        </p>
        {detail ? (
          <>
            <p className="flex gap-2 text-xs text-muted-foreground">
              {detail.files.length} files changed
              <span className="text-diff-added">
                +
                {detail.files.reduce(
                  (sum, file) => sum + (file.additions ?? 0),
                  0
                )}
              </span>
              <span className="text-diff-removed">
                −
                {detail.files.reduce(
                  (sum, file) => sum + (file.deletions ?? 0),
                  0
                )}
              </span>
            </p>
            <p className="text-xs whitespace-pre-wrap text-muted-foreground">
              {detail.message !== commit.subject ? detail.message : null}
            </p>
            <ul className="max-h-56 space-y-2 overflow-auto border-t pt-3">
              {detail.files.map((file) => (
                <li key={file.path} className="flex gap-2 text-xs">
                  <FileIcon path={file.path} />
                  <span className="min-w-0 flex-1 break-all">
                    {file.previousPath ? `${file.previousPath} → ` : ""}
                    {file.path}
                  </span>
                  <span className="text-diff-added">
                    {file.additions === null ? "binary" : `+${file.additions}`}
                  </span>
                  <span className="text-diff-removed">
                    {file.deletions === null ? "" : `−${file.deletions}`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {error || "Loading commit details…"}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
