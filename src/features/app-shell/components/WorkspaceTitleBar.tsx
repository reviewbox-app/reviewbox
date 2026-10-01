"use client"
import { useRef, type ReactNode } from "react"
import { reviewCommands, desktopAvailable } from "@/lib/desktop/review.commands"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Settings01Icon,
  Search01Icon,
  GitBranchIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Kbd } from "@/components/ui/kbd"
import { RevStatusBadge } from "@/features/agents/components/RevStatusBadge"
import type { RevStatus } from "@/features/agents/hooks/useRevStatus"
import { useReviewWorkspaceStore } from "@/features/review/stores/useReviewWorkspace.store"
import type { Repository } from "@/lib/desktop/contracts.generated"
import { ReviewBoxMark } from "./ReviewBoxMark"

export function WorkspaceTitleBar({
  repository,
  rev,
  onHome,
  onReviewOverview,
  reviewControl,
}: {
  repository: Repository | null
  rev: RevStatus
  reviewControl?: ReactNode
  onHome: () => void
  onReviewOverview: () => void
}) {
  const { space, setSpace, setSettings, setPalette } = useReviewWorkspaceStore()
  const reviewWasActive = useRef(false)
  return (
    <header
      data-tauri-drag-region
      className="flex h-[52px] shrink-0 items-center justify-between gap-3 pr-3.5 pl-[88px]"
    >
      <div className="flex min-w-0 flex-1 items-center">
        {repository && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onHome}
            title="Switch repository"
            className="h-[30px] min-w-0 gap-2 pr-2 pl-1.5"
          >
            <ReviewBoxMark />
            <span className="truncate">{repository.name}</span>
            <span className="flex min-w-0 items-center gap-1 font-normal text-muted-foreground">
              <HugeiconsIcon icon={GitBranchIcon} size={14} />
              <span className="truncate">{repository.branch}</span>
            </span>
            <HugeiconsIcon
              icon={UnfoldMoreIcon}
              size={14}
              className="text-muted-foreground"
            />
          </Button>
        )}
      </div>
      {repository ? (
        <div className="relative shrink-0" data-testid="workspace-navigation">
          <Tabs
            value={space}
            onValueChange={(value) => setSpace(value as typeof space)}
          >
            <TabsList>
              <TabsTrigger value="resume">Home</TabsTrigger>
              <TabsTrigger
                value="review"
                onPointerDown={() => {
                  // Tabs can activate on focus before the subsequent click.
                  reviewWasActive.current = space === "review"
                }}
                onClick={(event) => {
                  const repeated =
                    event.detail === 0
                      ? space === "review"
                      : reviewWasActive.current
                  if (repeated) onReviewOverview()
                }}
              >
                Review
              </TabsTrigger>
              <TabsTrigger value="understand">Code Explain</TabsTrigger>
            </TabsList>
          </Tabs>
          {reviewControl && (
            <div
              className="absolute top-1/2 left-full ml-2 -translate-y-1/2"
              data-testid="rev-control"
            >
              {reviewControl}
            </div>
          )}
        </div>
      ) : (
        <span className="text-sm font-medium text-muted-foreground">
          ReviewBox
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2 pl-10">
        <RevStatusBadge status={rev} />
        {repository && (
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex h-7 items-center gap-2 rounded-full bg-muted py-1 pr-[5px] pl-2.5 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <HugeiconsIcon icon={Search01Icon} size={14} />
            <span className="max-lg:hidden">Search</span>
            <Kbd>⌘K</Kbd>
          </button>
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
