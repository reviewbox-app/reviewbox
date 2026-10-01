"use client"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { SidebarResizeHandle } from "@/components/ui/sidebar-resize-handle"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FileTree } from "@/features/knowledge/components/FileTree"
import { ReviewCodePane } from "@/features/review/composites/ReviewCodePane"
import { reviewReaderLayout } from "@/features/review/reader.config"
import { useScrollEdgeMask } from "@/hooks/use-scroll-edge-mask"
import type {
  LocalFileDiff,
  ReadingPosition,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import {
  ArrowLeft01Icon,
  GitCommitIcon,
  Search01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useRef, useState } from "react"
import {
  availableLayer,
  fullyStagedPaths,
  localFileStatuses,
} from "../helpers/local-files"
import type { SourceControlSession } from "../hooks/useSourceControl"
import { sourceControlCommands as commands } from "../services/source-control.commands"
import { CommitDialog } from "./CommitDialog"

const initialPosition: ReadingPosition = {
  changeId: null,
  passageId: null,
  stepId: null,
  fileId: null,
  context: "files",
  split: false,
  line: 1,
  scrollTop: 0,
}

export function LocalChanges({
  git,
  onBack,
  onFinished,
}: {
  git: SourceControlSession
  onBack: () => void
  onFinished: () => void
}) {
  const { state, busy, mutate, reload, setError } = git
  const [chosen, setChosen] = useState("")
  const [preferredLayer, setPreferredLayer] = useState("unstaged")
  const [filter, setFilter] = useState("")
  const [tree, setTree] = useState(true)
  const [committing, setCommitting] = useState(false)
  const [loaded, setLoaded] = useState<LocalFileDiff | null>(null)
  const [position, setPosition] = useState(initialPosition)
  const panel = useRef<HTMLElement>(null)
  const scrollMask = useScrollEdgeMask<HTMLElement>()
  const file =
    state?.files.find((file) => file.path === chosen) ?? state?.files[0]
  const path = file?.path
  const version = file?.version
  const layer = availableLayer(file, preferredLayer)
  const repositoryId = state?.repositoryId
  useEffect(() => {
    if (!path || !version || !repositoryId) return
    let alive = true
    void commands
      .diff(repositoryId, path, layer, version)
      .then((value) => {
        if (alive) setLoaded(value)
      })
      .catch((cause) => {
        if (alive) {
          setError(errorMessage(cause))
          void reload().catch(() => {})
        }
      })
    return () => {
      alive = false
    }
  }, [path, version, repositoryId, layer, reload, setError])
  if (!state)
    return (
      <p role="status" className="m-auto text-sm text-muted-foreground">
        Reading local changes…
      </p>
    )
  const content =
    loaded && loaded.change.path === path && loaded.change.layer === layer
      ? loaded
      : null
  const staged = state.files.filter((file) => file.stagedStatus).length
  return (
    <div
      data-resize-workspace
      className="group/local flex min-h-0 flex-1 gap-0 px-2 pb-2"
    >
      <aside
        ref={panel}
        aria-label="Local files"
        aria-hidden={!tree}
        inert={!tree}
        className={cn(
          "flex shrink-0 flex-col gap-3 overflow-hidden transition-[width,opacity] duration-200 group-data-[resizing=true]/local:transition-none motion-reduce:transition-none",
          tree
            ? "w-[clamp(180px,var(--local-files-width,260px),35%)] pr-2 opacity-100"
            : "w-0 opacity-0"
        )}
      >
        <InputGroup>
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Filter local files"
            placeholder={`Filter ${state.files.length} files`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </InputGroup>
        <nav
          aria-label="Changed files"
          ref={scrollMask}
          className="min-h-0 flex-1 overflow-auto"
        >
          <FileTree
            paths={state.files
              .map((file) => file.path)
              .filter((path) =>
                path.toLowerCase().includes(filter.toLowerCase())
              )}
            selected={path ?? ""}
            marks={{}}
            statuses={localFileStatuses(state.files)}
            reviewedPaths={fullyStagedPaths(state.files)}
            dimmedLabel="Staged."
            dimmedFolderLabel="All files staged."
            alwaysExpanded
            onSelect={(value) => {
              setChosen(value)
              setPosition(initialPosition)
            }}
          />
        </nav>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-panel border bg-card">
        {tree && (
          <SidebarResizeHandle
            name="local files"
            property="--local-files-width"
            panelRef={panel}
            edge="left"
          />
        )}
        <header
          className="absolute inset-x-0 top-0 z-20 flex items-center gap-2 rounded-t-panel border-b glass-bar px-3"
          style={{ height: reviewReaderLayout.headerHeight }}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tree ? "Hide local files" : "Show local files"}
            onClick={() => setTree(!tree)}
          >
            <HugeiconsIcon icon={SidebarLeftIcon} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to review overview"
            onClick={onBack}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} />
          </Button>
          <h1 className="flex-1 truncate text-sm font-medium">Local changes</h1>
          {file?.stagedStatus && file.unstagedStatus && (
            <Tabs value={layer} onValueChange={setPreferredLayer}>
              <TabsList>
                <TabsTrigger value="unstaged">Unstaged</TabsTrigger>
                <TabsTrigger value="staged">Staged</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          <Button
            size="sm"
            disabled={!staged || busy}
            onClick={() => setCommitting(true)}
          >
            <HugeiconsIcon icon={GitCommitIcon} />
            Commit · {staged}
          </Button>
        </header>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-panel">
          {content ? (
            <ReviewCodePane
              key={content.change.id}
              snapshot={{ id: `local-${state.repositoryId}` }}
              change={content.change}
              source={content.content}
              modelScope="local"
              selection={null}
              position={position}
              onPosition={setPosition}
              overlay={{
                top: reviewReaderLayout.headerHeight,
                bottom: reviewReaderLayout.footerHeight,
              }}
            />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon icon={GitCommitIcon} />
                </EmptyMedia>
                <EmptyTitle>
                  {file ? "Loading changes" : "No local changes"}
                </EmptyTitle>
                <EmptyDescription>
                  {file
                    ? "Reading the current file versions…"
                    : "Your working tree is clean."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <footer
          className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center rounded-b-panel border-t glass-bar px-3"
          style={{ height: reviewReaderLayout.footerHeight }}
        >
          {file?.conflicted ? (
            <span className="text-sm text-review-attention">
              Resolve this conflict in another tool.
            </span>
          ) : (
            file && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !content || content.version !== file.version}
                onClick={() =>
                  void mutate(() =>
                    commands.stage(
                      state.repositoryId,
                      file.path,
                      file.version,
                      layer !== "staged"
                    )
                  )
                }
              >
                {layer === "staged" ? "Unstage file" : "Stage file"}
              </Button>
            )
          )}
        </footer>
      </main>
      <CommitDialog
        open={committing}
        onOpenChange={setCommitting}
        state={state}
        onFinished={async () => {
          const next = await reload()
          if (next && !next.files.length) onFinished()
        }}
      />
    </div>
  )
}
