"use client"
import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Folder01Icon,
  FolderOpenIcon,
  ArrowRight01Icon,
  GitBranchIcon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Input } from "@/components/ui/input"
import { ReviewBoxMark } from "@/features/app-shell/components/ReviewBoxMark"
import type { Repository } from "@/lib/desktop/contracts.generated"

export function RepositoryHome({
  repositories,
  busy,
  onOpen,
  onChoose,
  onForget,
}: {
  repositories: Repository[]
  busy: boolean
  onOpen: (path: string) => void
  onChoose: () => void
  onForget: (id: string) => void
}) {
  const [path, setPath] = useState("")
  const [typing, setTyping] = useState(false)
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-4 pt-16 pb-10">
      <div className="mb-6 flex size-16 items-center justify-center rounded-[20px] border bg-card">
        <ReviewBoxMark className="h-7" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">ReviewBox</h1>
      <p className="mt-3 text-center text-sm text-muted-foreground">
        Understand a change end to end, then keep a reliable record of what you
        checked.
      </p>
      <section
        className="mt-8 flex w-full max-w-[600px] flex-col items-center rounded-3xl border border-dashed border-foreground/15 px-8 py-7 text-center"
        aria-label="Open repository"
      >
        <HugeiconsIcon
          icon={FolderOpenIcon}
          size={22}
          className="text-muted-foreground"
        />
        <p className="mt-3 mb-4 text-sm font-medium">
          Drop a Git repository here
        </p>
        <div className="flex items-center gap-2">
          <Button disabled={busy} onClick={onChoose}>
            <HugeiconsIcon icon={Folder01Icon} size={16} />
            {busy ? "Opening…" : "Open repository…"}
          </Button>
          <Kbd>⌘O</Kbd>
        </div>
        {typing ? (
          <form
            className="mt-4 flex w-full gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (path.trim()) onOpen(path.trim())
            }}
          >
            <Input
              autoFocus
              aria-label="Repository path"
              placeholder="~/path/to/repository"
              className="font-mono text-xs"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={!path.trim() || busy}
            >
              Open
            </Button>
          </form>
        ) : (
          <Button
            variant="link"
            size="xs"
            className="mt-2 text-muted-foreground"
            onClick={() => setTyping(true)}
          >
            or enter a path
          </Button>
        )}
      </section>
      <section
        className="mt-8 w-full max-w-[600px]"
        aria-label="Recent repositories"
      >
        <h2 className="mb-2 px-3 text-xs text-muted-foreground">Recent</h2>
        {repositories.length === 0 ? (
          <p className="px-3 text-sm text-muted-foreground">
            Your repositories will appear here after you open one.
          </p>
        ) : (
          repositories.map((repo) => (
            <div
              key={repo.id}
              className="group relative flex items-center rounded-2xl transition-colors hover:bg-accent"
            >
              <button
                disabled={busy}
                onClick={() => onOpen(repo.path)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <HugeiconsIcon icon={Folder01Icon} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {repo.name}
                    <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                      <HugeiconsIcon icon={GitBranchIcon} size={12} />
                      {repo.branch}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                    {repo.path}
                  </span>
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={16}
                  className="mr-1 text-muted-foreground group-focus-within:opacity-0 group-hover:opacity-0"
                />
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${repo.name} from recents`}
                title="Remove from recents"
                className="absolute right-2.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                onClick={() => onForget(repo.id)}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} />
              </Button>
            </div>
          ))
        )}
      </section>
    </main>
  )
}
