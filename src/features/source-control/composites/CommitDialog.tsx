"use client"
import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  GitCommitIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type {
  GitOperation,
  LocalGitState,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { sourceControlCommands as commands } from "../services/source-control.commands"

import { GitRecoveryActions } from "../components/GitRecoveryActions"

export function CommitDialog({
  open,
  onOpenChange,
  state,
  onFinished,
  onCommitted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: LocalGitState
  onFinished: () => Promise<void>
  onCommitted?: () => void
}) {
  const [manual, setManual] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [operation, setOperation] = useState<GitOperation | null>(null)
  const running = useRef<string | null>(null)
  const active = operation?.status === "running"
  const close = () => {
    setManual(false)
    setMessage("")
    setOperation(null)
    setError("")
    onOpenChange(false)
  }
  const begin = async (message: string | null) => {
    if (running.current) return
    const id = crypto.randomUUID()
    running.current = id
    setError("")
    setOperation({
      id,
      repositoryId: state.repositoryId,
      status: "running",
      message:
        message === null ? "Rev is creating commits…" : "Creating commit…",
      commits: [],
      error: null,
    })
    try {
      const result = await commands.commit(
        {
          operationId: id,
          repositoryId: state.repositoryId,
          indexVersion: state.indexVersion,
          message,
        },
        (value) => {
          if (running.current === id) setOperation(value)
        },
        () => {}
      )
      setOperation(result)
      if (result.error) setError(result.error)
      let refreshed = true
      try {
        await onFinished()
      } catch (cause) {
        refreshed = false
        setError(
          `The Git operation finished, but the view could not refresh: ${errorMessage(cause)}`
        )
      }
      if (
        result.status === "completed" &&
        result.commits.length > 0 &&
        refreshed
      ) {
        close()
        onCommitted?.()
      }
    } catch (cause) {
      const cancelled =
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        cause.code === "cancelled"
      const status = cancelled ? "cancelled" : "failed"
      setError(errorMessage(cause))
      setOperation((value) =>
        value
          ? {
              ...value,
              status,
              message: cancelled ? "Commit cancelled" : "Commit failed",
            }
          : value
      )
      await onFinished().catch(() => {})
    } finally {
      running.current = null
    }
  }
  useEffect(
    () => () => {
      if (running.current) void commands.cancel(running.current).catch(() => {})
    },
    []
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!running.current) {
          if (value) onOpenChange(true)
          else close()
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Commit staged changes</DialogTitle>
          <DialogDescription>
            {state.files.filter((file) => file.stagedStatus).length} staged
            files. Unstaged changes stay in your working tree.
          </DialogDescription>
        </DialogHeader>
        <Separator />
        <div className="min-h-0 space-y-4 overflow-auto">
          {!active && !operation && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setManual(true)}>
                <HugeiconsIcon icon={GitCommitIcon} />
                Commit manually
              </Button>
              <Button onClick={() => void begin(null)}>
                <HugeiconsIcon icon={AiMagicIcon} />
                Commit with Rev
              </Button>
            </div>
          )}
          {manual && !active && (
            <form
              id="manual-commit"
              onSubmit={(event) => {
                event.preventDefault()
                void begin(message)
              }}
            >
              <Textarea
                autoFocus
                aria-label="Commit message"
                placeholder="Describe the staged changes"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={4}
                required
              />
            </form>
          )}
          {operation && (
            <div role="status" className="flex items-center gap-2 text-sm">
              {active ? (
                <Spinner />
              ) : operation.status === "completed" ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  className="text-review-validated"
                />
              ) : null}
              {operation.message}
            </div>
          )}
          {operation?.commits.map((commit) => (
            <p key={commit.oid} className="flex items-center gap-2 text-sm">
              <HugeiconsIcon
                icon={GitCommitIcon}
                className="shrink-0 text-primary"
              />
              <span className="font-mono text-xs text-muted-foreground">
                {commit.oid.slice(0, 7)}
              </span>
              {commit.subject}
            </p>
          ))}
          {error && (
            <Alert variant="destructive" size="sm">
              <AlertDescription>
                {error}
                <GitRecoveryActions
                  repositoryId={state.repositoryId}
                  error={error}
                  disabled={active}
                  onRecovered={() => {
                    setError("")
                    setOperation(null)
                  }}
                />
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          {active ? (
            <Button
              variant="secondary"
              onClick={() => {
                if (running.current)
                  void commands
                    .cancel(running.current)
                    .catch((cause) => setError(errorMessage(cause)))
              }}
            >
              Stop
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
              {manual && (
                <Button
                  type="submit"
                  form="manual-commit"
                  disabled={!message.trim()}
                >
                  Create commit
                </Button>
              )}
              {operation && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setManual(false)
                    setOperation(null)
                    setError("")
                  }}
                >
                  New commit
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
