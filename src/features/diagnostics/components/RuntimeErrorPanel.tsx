"use client"
import { Button } from "@/components/ui/button"
import { CopyErrorDetailsButton } from "./CopyErrorDetailsButton"

export function RuntimeErrorPanel({
  error,
  retry,
}: {
  error: Error
  retry: () => void
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-8">
      <h1 className="text-xl font-semibold">
        ReviewBox could not display this view
      </h1>
      <p role="alert" className="text-sm text-muted-foreground">
        Try opening it again. You can copy the error details to investigate what
        happened.
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <Button onClick={retry}>Try again</Button>
        <CopyErrorDetailsButton
          error={error}
          source="frontend"
          operation="react.render"
        />
      </div>
    </main>
  )
}
