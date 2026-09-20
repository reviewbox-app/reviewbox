import { HugeiconsIcon } from "@hugeicons/react"
import { SourceCodeSquareIcon } from "@hugeicons/core-free-icons"
import { ThemeToggle } from "../components/ThemeToggle"

export function ReviewBoxHome() {
  return (
    <main className="relative flex min-h-svh items-center justify-center p-8">
      <div className="absolute top-5 right-5">
        <ThemeToggle />
      </div>
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <HugeiconsIcon
            icon={SourceCodeSquareIcon}
            size={28}
            aria-hidden="true"
          />
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">ReviewBox</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Un espace pour comprendre chaque changement.
          </p>
        </div>
      </div>
    </main>
  )
}
