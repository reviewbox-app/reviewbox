"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { errorMessage } from "@/lib/desktop/review.commands"
import { sourceControlCommands as commands } from "../services/source-control.commands"

export function GitRecoveryActions({
  repositoryId,
  error,
  onRecovered,
  onRetry,
  disabled = false,
}: {
  repositoryId: string
  error?: string | null
  onRecovered: () => void | Promise<void>
  onRetry?: () => void | Promise<void>
  disabled?: boolean
}) {
  const [working, setWorking] = useState(false)
  const [feedback, setFeedback] = useState("")
  const locked = /index.*(busy|lock)|index\.lock/i.test(error ?? "")
  const run = async (
    action: () => Promise<void>,
    message: string,
    recovered = true
  ) => {
    setWorking(true)
    setFeedback("")
    try {
      await action()
      setFeedback(message)
      if (recovered) await onRecovered()
    } catch (cause) {
      setFeedback(errorMessage(cause))
    } finally {
      setWorking(false)
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-2">
        {locked && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || working}
            onClick={() =>
              void run(
                () => commands.recoverLock(repositoryId),
                "Inactive lock removed. A backup was kept in Git's directory."
              )
            }
          >
            Recover Git lock
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || working}
          onClick={() =>
            void run(
              () => commands.clearPlans(repositoryId),
              "Previous plans cleared. Existing commits and staged files are preserved."
            )
          }
        >
          Clear previous plans
        </Button>
        {onRetry && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || working}
            onClick={() =>
              void run(
                async () => {
                  await onRetry()
                },
                "",
                false
              )
            }
          >
            Retry
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Clearing plans keeps your commits and staged changes.
      </p>
      {feedback && <p role="status">{feedback}</p>}
    </div>
  )
}
