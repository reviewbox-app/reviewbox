"use client"
import { reviewCommands, desktopAvailable } from "@/lib/desktop/review.commands"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Settings01Icon,
  Search01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Kbd } from "@/components/ui/kbd"
import { useReviewWorkspaceStore } from "@/features/review/stores/useReviewWorkspace.store"
import type { Repository } from "@/lib/desktop/contracts.generated"

export function WorkspaceTitleBar({
  repository,
  onHome,
}: {
  repository: Repository | null
  onHome: () => void
}) {
  const { space, setSpace, setSettings, setPalette } = useReviewWorkspaceStore()
  return (
    <header
      data-tauri-drag-region
      className="flex h-[52px] shrink-0 items-center justify-between gap-3 pr-3 pl-20"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {repository && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onHome}
              className="min-w-0 gap-2"
            >
              <span className="truncate">{repository.name}</span>
            </Button>
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={14}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-xs text-muted-foreground">
              {repository.branch}
            </span>
          </>
        )}
      </div>
      {repository ? (
        <Tabs
          value={space}
          onValueChange={(value) => setSpace(value as typeof space)}
        >
          <TabsList>
            <TabsTrigger value="understand">Understand</TabsTrigger>
            <TabsTrigger value="review">Review</TabsTrigger>
            <TabsTrigger value="resume">Resume</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : (
        <span className="text-sm text-muted-foreground">ReviewBox</span>
      )}
      <div className="flex flex-1 items-center justify-end gap-2">
        {repository && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPalette(true)}
          >
            <HugeiconsIcon icon={Search01Icon} size={14} />
            <span className="hidden xl:inline">Search</span>
            <Kbd>⌘K</Kbd>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          onClick={() => {
            if (desktopAvailable())
              void reviewCommands.openSettings().catch(() => setSettings(true))
            else setSettings(true)
          }}
        >
          <HugeiconsIcon icon={Settings01Icon} size={16} />
        </Button>
      </div>
    </header>
  )
}
