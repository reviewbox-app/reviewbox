"use client"
import Image from "next/image"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Folder01Icon,
  FolderOpenIcon,
  ArrowRight01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Input } from "@/components/ui/input"
import { useState } from "react"
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
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center overflow-auto pt-18 pb-10">
      <div className="mb-5 flex size-16 items-center justify-center rounded-2xl border bg-card">
        <Image
          src="/brand/mark.svg"
          alt=""
          width={24}
          height={44}
          className="dark:invert-0"
          unoptimized
        />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">ReviewBox</h1>
      <p className="mt-3 px-6 text-center text-sm text-muted-foreground">
        Understand a change end to end, then keep a reliable record of what you
        checked.
      </p>
      <section
        className="mt-8 w-[min(590px,90vw)] rounded-2xl border border-dashed px-8 py-7 text-center"
        aria-label="Open repository"
      >
        <HugeiconsIcon
          icon={FolderOpenIcon}
          size={24}
          className="mx-auto text-muted-foreground"
        />
        <p className="mt-3 mb-4 text-sm">Drop a Git repository here</p>
        <Button disabled={busy} onClick={onChoose}>
          <HugeiconsIcon icon={Folder01Icon} size={16} />
          {busy ? "Opening…" : "Open repository"}
        </Button>
        <Kbd className="ml-2">⌘O</Kbd>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (path.trim()) onOpen(path.trim())
          }}
        >
          <Input
            aria-label="Repository path"
            placeholder="Or enter a local folder path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button variant="outline" disabled={!path.trim() || busy}>
            Open
          </Button>
        </form>
      </section>
      <section
        className="mt-8 w-[min(590px,90vw)]"
        aria-label="Recent repositories"
      >
        <h2 className="mb-3 px-3 text-xs text-muted-foreground">Recent</h2>
        {repositories.length === 0 ? (
          <p className="px-3 text-sm text-muted-foreground">
            Your repositories will appear here after you open one.
          </p>
        ) : (
          repositories.map((repo) => (
            <div
              key={repo.id}
              className="group flex items-center rounded-xl hover:bg-accent"
            >
              <button
                disabled={busy}
                onClick={() => onOpen(repo.path)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-primary"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <HugeiconsIcon icon={Folder01Icon} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {repo.name}
                    <HugeiconsIcon icon={GitBranchIcon} size={12} />
                    <span className="font-normal text-muted-foreground">
                      {repo.branch}
                    </span>
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {repo.path}
                  </span>
                </span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
              </button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onForget(repo.id)}
              >
                Remove
              </Button>
            </div>
          ))
        )}
      </section>
    </main>
  )
}
