"use client"
import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowReloadHorizontalIcon,
  GitBranchIcon,
  GitCommitIcon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { GitRecoveryActions } from "../components/GitRecoveryActions"
import { CommitCard } from "../components/CommitCard"
import type { SourceControlSession } from "../hooks/useSourceControl"
import { sourceControlCommands as commands } from "../services/source-control.commands"
import type { GitOperation } from "@/lib/desktop/contracts.generated"

export function ReviewOverview({
  git,
  onLocal,
  onStart,
  onResume,
}: {
  git: SourceControlSession
  onLocal: () => void
  onStart: () => void
  onResume?: () => void
}) {
  const { state, busy, fetch, mutate } = git
  const [remote, setRemote] = useState<string | null>(null)
  const [lastOperation, setLastOperation] = useState<GitOperation | null>(null)
  const repositoryId = state?.repositoryId
  useEffect(() => {
    if (!repositoryId) return
    let alive = true
    void commands
      .lastOperation(repositoryId)
      .then((value) => {
        if (alive) setLastOperation(value)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [repositoryId])
  const publish = !state?.upstream
  const selectedRemote =
    remote && state?.remotes.includes(remote)
      ? remote
      : state?.remotes.length === 1
        ? state.remotes[0]
        : null
  const blocked =
    state?.blockedReason ||
    (!state?.remotes.length
      ? "Configure a Git remote in another tool to publish this branch."
      : null)
  return (
    <main className="min-h-0 flex-1 overflow-auto px-6 pb-10">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <Empty className="min-h-[min(45vh,380px)] border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={SourceCodeIcon} />
            </EmptyMedia>
            <EmptyTitle>Read your changes</EmptyTitle>
            <EmptyDescription>
              Explore local changes or start a review with Rev or on your own.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              {state && (
                <Button variant="secondary" onClick={onLocal}>
                  {state.files.length
                    ? "View local changes"
                    : "View local code"}
                </Button>
              )}
              <Button onClick={onResume ?? onStart}>
                {onResume ? "Resume current review" : "Start review"}
              </Button>
            </div>
            {onResume && (
              <Button size="sm" variant="ghost" onClick={onStart}>
                Start review
              </Button>
            )}
          </EmptyContent>
        </Empty>
        <Separator />
        {state ? (
          <section aria-label="Branch commits" className="space-y-4">
            <header className="flex flex-wrap items-center gap-2">
              <HugeiconsIcon
                icon={GitBranchIcon}
                className="size-4 text-muted-foreground"
              />
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
                {state.branch ?? "Detached HEAD"}
              </h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh remote"
                disabled={busy}
                onClick={() => void fetch(true)}
              >
                {busy ? (
                  <Spinner />
                ) : (
                  <HugeiconsIcon icon={ArrowReloadHorizontalIcon} />
                )}
              </Button>
              {publish && state.remotes.length > 1 && (
                <Select
                  value={selectedRemote}
                  onValueChange={setRemote}
                  items={state.remotes.map((value) => ({
                    value,
                    label: value,
                  }))}
                >
                  <SelectTrigger aria-label="Publish remote" size="sm">
                    <SelectValue placeholder="Choose remote" />
                  </SelectTrigger>
                  <SelectContent>
                    {state.remotes.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                size="sm"
                disabled={
                  busy ||
                  !!blocked ||
                  !!state.remoteCheck.error ||
                  !state.branch ||
                  !state.head ||
                  (publish ? !selectedRemote : !state.ahead)
                }
                onClick={() =>
                  void mutate(() =>
                    commands.push(
                      state.repositoryId,
                      state.branch!,
                      publish ? selectedRemote : null
                    )
                  )
                }
              >
                {publish ? "Publish branch" : "Push commits"}
                <span className="flex items-center gap-1 text-xs tabular-nums">
                  <HugeiconsIcon icon={ArrowDown01Icon} className="size-3" />
                  {state.behind}
                  <HugeiconsIcon icon={ArrowUp01Icon} className="size-3" />
                  {state.ahead}
                </span>
              </Button>
            </header>
            {blocked && (
              <Alert variant="faded" size="sm">
                <AlertDescription>{blocked}</AlertDescription>
              </Alert>
            )}
            {state.remoteCheck.error && (
              <Alert variant="faded" size="sm">
                <AlertDescription>
                  Remote check failed: {state.remoteCheck.error}{" "}
                  {state.remoteCheck.checkedAt
                    ? `Showing the last known remote state (${new Date(state.remoteCheck.checkedAt).toLocaleString()}).`
                    : "Remote status is unknown."}
                </AlertDescription>
              </Alert>
            )}
            {lastOperation &&
              ["failed", "cancelled", "interrupted"].includes(
                lastOperation.status
              ) && (
                <Alert variant="faded" size="sm">
                  <AlertDescription>
                    {lastOperation.error ?? lastOperation.message}{" "}
                    {lastOperation.commits.length} commits completed. Remaining
                    staged changes are preserved.
                    <GitRecoveryActions
                      repositoryId={state.repositoryId}
                      error={lastOperation.error}
                      disabled={busy}
                      onRecovered={() => setLastOperation(null)}
                    />
                  </AlertDescription>
                </Alert>
              )}
            {!!state.localCommits.length && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Local · not pushed
                </p>
                {state.localCommits.map((commit) => (
                  <CommitCard
                    key={commit.oid}
                    repositoryId={state.repositoryId}
                    commit={commit}
                  />
                ))}
              </div>
            )}
            {!!state.remoteCommits.length && (
              <div aria-label="Last known remote commits" className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Remote · {state.upstream}
                  {!state.remoteCheck.checkedAt && " · not checked yet"}
                </p>
                {state.remoteCommits.map((commit, index) => (
                  <div
                    key={commit.oid}
                    className="flex items-center gap-3 rounded-2xl border bg-muted/30 px-4 py-3"
                    style={{
                      filter: `blur(${index}px)`,
                      opacity: 1 - index * 0.2,
                    }}
                  >
                    <HugeiconsIcon
                      icon={GitCommitIcon}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="flex-1 truncate text-sm opacity-60">
                      {commit.subject}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {commit.oid.slice(0, 7)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!state.localCommits.length && !state.remoteCommits.length && (
              <p className="text-sm text-muted-foreground">
                {state.head
                  ? "No local commits to push."
                  : "This branch has no commits yet."}
              </p>
            )}
          </section>
        ) : (
          <p
            role="status"
            className="text-center text-sm text-muted-foreground"
          >
            Reading branch state…
          </p>
        )}
      </div>
    </main>
  )
}
