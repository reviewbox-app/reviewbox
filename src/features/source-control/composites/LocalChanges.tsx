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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { FileTreeSearch } from "@/features/file-tree/components/FileTreeSearch"
import { FileMenu } from "@/features/file-tree/components/FileMenu"
import {
  treeNavigation,
  updateTreeNavigation,
} from "@/features/file-tree/services/navigation.service"
import { useFileTreeNavigation } from "@/features/file-tree/hooks/useFileTreeNavigation"
import { useEditorInventory } from "@/features/code-editor/hooks/useEditorInventory"
import { LocalSourceFile } from "../components/LocalSourceFile"
import { SidebarResizeHandle } from "@/components/ui/sidebar-resize-handle"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { FileTreeExpansion } from "@/features/file-tree/components/FileTreeExpansion"
import { folderPaths } from "@/features/file-tree/helpers/tree.helpers"
import { FileTree } from "@/features/file-tree/components/FileTree"
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
  Add01Icon,
  MinusSignIcon,
  ArrowLeft01Icon,
  GitCommitIcon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  availableLayer,
  fullyStagedPaths,
  localFileStatuses,
  localFileGroups,
} from "../helpers/local-files"
import type { SourceControlSession } from "../hooks/useSourceControl"
import { sourceControlCommands as commands } from "../services/source-control.commands"
import { LocalFileMenu } from "./LocalFileMenu"
import { selectFiles } from "../helpers/file-selection"
import { CommitDialog } from "./CommitDialog"

import { CodeComments } from "@/features/review/components/CodeComments"
import { useCodeComments } from "@/features/review/hooks/useReviewComments"
import { commentAnchor } from "@/features/review/helpers/reviewComment.helpers"
import type { ReviewCommentAnchor } from "@/lib/desktop/contracts.generated"
import type { SourceSelection } from "@/features/code-editor/contracts/sourceSelection.types"

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
}: {
  git: SourceControlSession
  onBack: () => void
}) {
  const { state, busy, mutate, reload, setError } = git
  const comments = useCodeComments(state?.repositoryId ?? "", null)
  const [commentSelection, setCommentSelection] = useState<{
    key: string
    value: SourceSelection
    anchor: ReviewCommentAnchor
  } | null>(null)
  const [selection, setSelection] = useState({
    layer: "",
    paths: new Set<string>(),
    anchor: "",
  })
  const [preferredLayer, setPreferredLayer] = useState("unstaged")
  const [filter, setFilter] = useState("")
  const [searchExpansion, setSearchExpansion] = useState({
    key: "",
    paths: [] as string[],
  })
  const [tree, setTree] = useState(true)
  const [committing, setCommitting] = useState(false)
  const [loaded, setLoaded] = useState<LocalFileDiff | null>(null)
  const [position, setPosition] = useState(initialPosition)
  const panel = useRef<HTMLElement>(null)
  const scrollMask = useScrollEdgeMask<HTMLElement>()
  const navigation = useFileTreeNavigation(
    state?.repositoryId ?? "",
    "local",
    !!filter.trim()
  )
  const noChanges = !!state && state.files.length === 0
  const allFiles = noChanges || navigation.value.mode !== "changes"
  useEffect(() => {
    if (
      noChanges &&
      navigation.ready &&
      state &&
      navigation.value.mode !== "all"
    )
      updateTreeNavigation(state.repositoryId, "local", (tree) => ({
        ...tree,
        mode: "all",
      }))
  }, [noChanges, navigation.ready, navigation.value.mode, state])
  const inventory = useEditorInventory(
    state?.repositoryId,
    navigation.value.expandedPaths,
    allFiles && navigation.ready
  )
  const chosen = navigation.value.selectedPath ?? ""
  const setChosen = (path: string) =>
    navigation.update((tree) => ({ ...tree, selectedPath: path }))
  const existing = inventory.entries.some(
    (entry) => !entry.directory && entry.path === chosen
  )
  const activePath =
    allFiles && existing
      ? chosen
      : (state?.files.find((file) => file.path === chosen)?.path ??
        state?.files[0]?.path ??
        inventory.entries.find((entry) => !entry.directory)?.path)
  const file = state?.files.find((file) => file.path === activePath)
  const path = file?.path
  const ignoredPaths = useMemo(
    () =>
      new Set(
        inventory.entries
          .filter((entry) => entry.ignored)
          .map((entry) => entry.path)
      ),
    [inventory.entries]
  )
  const paths = useMemo(() => {
    const paths = inventory.entries
      .filter(
        (entry) =>
          !filter.trim() ||
          (!entry.directory &&
            !entry.excluded &&
            entry.path.toLowerCase().includes(filter.trim().toLowerCase()))
      )
      .map((entry) => entry.path + (entry.directory ? "/" : ""))
    // Removed files have no filesystem entry but still belong to the reviewable tree.
    for (const file of state?.files ?? [])
      if (
        !filter.trim() ||
        file.path.toLowerCase().includes(filter.trim().toLowerCase())
      )
        paths.push(file.path)
    return [...new Set(paths)]
  }, [inventory.entries, state?.files, filter])
  const searchKey = `${state?.repositoryId}/${filter}`
  const expandedPaths = filter.trim()
    ? searchExpansion.key === searchKey
      ? searchExpansion.paths
      : folderPaths(paths)
    : navigation.value.expandedPaths
  const updateExpanded = (update: (paths: string[]) => string[]) => {
    if (filter.trim()) {
      setSearchExpansion({ key: searchKey, paths: update(expandedPaths) })
    } else {
      navigation.update((tree) => ({
        ...tree,
        expandedPaths: update(tree.expandedPaths),
      }))
    }
  }
  const toggleFolder = (path: string) =>
    updateExpanded((paths) =>
      paths.includes(path)
        ? paths.filter((value) => value !== path)
        : [...paths, path]
    )
  const attachNavigation = navigation.ref
  const attachTree = useCallback(
    (node: HTMLElement | null) => {
      attachNavigation(node)
      scrollMask(node)
    },
    [attachNavigation, scrollMask]
  )
  useEffect(() => {
    const repository = state?.repositoryId
    if (
      !repository ||
      !navigation.ready ||
      !activePath ||
      treeNavigation(repository, "local")
    )
      return
    const parts = activePath.split("/")
    updateTreeNavigation(repository, "local", (tree) => ({
      ...tree,
      selectedPath: activePath,
      expandedPaths: parts
        .slice(0, -1)
        .map((_, index) => parts.slice(0, index + 1).join("/")),
    }))
  }, [state?.repositoryId, navigation.ready, activePath])
  const sourceKey = `${state?.repositoryId}/${activePath}/${file?.version ?? "file"}/${availableLayer(file, preferredLayer)}`
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
  const groups = localFileGroups(state.files)
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
          "flex shrink-0 flex-col gap-2 overflow-hidden transition-[width,opacity] duration-200 group-data-[resizing=true]/local:transition-none motion-reduce:transition-none",
          tree
            ? "w-[clamp(180px,var(--local-files-width,272px),35%)] pr-2 opacity-100"
            : "w-0 opacity-0"
        )}
      >
        <FileTreeSearch
          value={filter}
          onChange={(value) => {
            setFilter(value)
            setSearchExpansion({ key: "", paths: [] })
          }}
          label="Filter local files"
          placeholder={
            allFiles ? "Search files…" : `Filter ${state.files.length} files`
          }
        />
        <div className="flex items-center gap-2">
          <Select
            disabled={noChanges}
            value={allFiles ? "all" : "changes"}
            onValueChange={(mode) =>
              navigation.update((tree) => ({
                ...tree,
                mode: mode === "changes" ? "changes" : "all",
              }))
            }
          >
            <SelectTrigger
              aria-label="Review file mode"
              size="sm"
              className="w-full bg-transparent text-xs text-muted-foreground"
            >
              <SelectValue>
                {allFiles ? "All files" : "Local changes"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All files</SelectItem>
              <SelectItem value="changes">Local changes</SelectItem>
            </SelectContent>
          </Select>
          {allFiles && (
            <FileTreeExpansion
              paths={paths}
              expandedPaths={expandedPaths}
              onChange={updateExpanded}
              disabled={!navigation.ready}
            />
          )}
        </div>
        <nav
          aria-label="Changed files"
          ref={attachTree}
          onScroll={navigation.onScroll}
          className="min-h-0 flex-1 overflow-auto"
        >
          {allFiles ? (
            <>
              {inventory.error && (
                <p role="alert" className="px-2 text-xs text-destructive">
                  {inventory.error}
                </p>
              )}
              <FileTree
                paths={paths}
                allPaths={inventory.entries
                  .filter((entry) => !entry.directory)
                  .map((entry) => entry.path)}
                selected={activePath ?? ""}
                marks={{}}
                statuses={localFileStatuses(state.files)}
                ignoredPaths={ignoredPaths}
                toggledFolders={new Set(expandedPaths)}
                onToggleFolder={toggleFolder}
                onSelect={setChosen}
                renderRow={(row, target) => (
                  <FileMenu
                    row={row}
                    repositoryId={state.repositoryId}
                    path={target.path}
                    onError={setError}
                  />
                )}
              />
            </>
          ) : (
            <div className="space-y-6 pb-3">
              {(["unstaged", "staged"] as const).map((group) => {
                const files = groups[group]
                const visible = files.filter((file) =>
                  file.path.toLowerCase().includes(filter.toLowerCase())
                )
                return (
                  <section
                    key={group}
                    aria-label={
                      group === "unstaged" ? "Unstaged files" : "Staged files"
                    }
                  >
                    <div className="mb-2 flex items-center justify-between px-2">
                      <h2 className="text-xs font-medium opacity-50">
                        {group === "unstaged" ? "Unstaged" : "Staged"} ·{" "}
                        {visible.length}
                      </h2>
                      <div className="flex items-center gap-2">
                        <FileTreeExpansion
                          paths={visible.map((file) => file.path)}
                          expandedPaths={expandedPaths}
                          onChange={updateExpanded}
                          disabled={!navigation.ready}
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="size-4 rounded-sm p-0"
                                aria-label={
                                  group === "unstaged"
                                    ? "Stage all changes"
                                    : "Unstage all changes"
                                }
                                disabled={
                                  busy ||
                                  !files.length ||
                                  files.some((file) => file.conflicted)
                                }
                                onClick={() =>
                                  void mutate(() =>
                                    commands.stageFiles(
                                      state.repositoryId,
                                      files.map(({ path, version }) => ({
                                        path,
                                        version,
                                      })),
                                      group === "unstaged"
                                    )
                                  )
                                }
                              />
                            }
                          >
                            <HugeiconsIcon
                              icon={
                                group === "unstaged" ? Add01Icon : MinusSignIcon
                              }
                              className="size-3"
                            />
                          </TooltipTrigger>
                          <TooltipContent>
                            {group === "unstaged"
                              ? "Stage all changes"
                              : "Unstage all changes"}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <FileTree
                      paths={visible.map((file) => file.path)}
                      selected={layer === group ? (path ?? "") : ""}
                      selectedPaths={
                        selection.layer === group ? selection.paths : undefined
                      }
                      renderRow={(row, target) => (
                        <LocalFileMenu
                          row={row}
                          path={target.path}
                          folder={target.folder}
                          staged={group === "staged"}
                          git={git}
                          targets={() =>
                            files.filter((file) =>
                              target.folder
                                ? file.path.startsWith(target.path + "/")
                                : selection.layer === group &&
                                    selection.paths.has(target.path)
                                  ? selection.paths.has(file.path)
                                  : file.path === target.path
                            )
                          }
                          select={(selected) =>
                            setSelection({
                              layer: group,
                              paths: new Set(selected.map((file) => file.path)),
                              anchor: target.path,
                            })
                          }
                        />
                      )}
                      marks={{}}
                      statuses={localFileStatuses(files, group)}
                      reviewedPaths={
                        group === "staged"
                          ? fullyStagedPaths(
                              files.map((file) => ({
                                ...file,
                                unstagedStatus: null,
                              }))
                            )
                          : undefined
                      }
                      dimmedLabel="Staged."
                      toggledFolders={new Set(expandedPaths)}
                      onToggleFolder={toggleFolder}
                      onSelect={(value, event, visiblePaths) => {
                        const sameLayer = selection.layer === group
                        setSelection({
                          layer: group,
                          paths: selectFiles(
                            sameLayer ? selection.paths : new Set(),
                            sameLayer ? selection.anchor : "",
                            value,
                            visiblePaths,
                            event
                          ),
                          anchor:
                            event.shiftKey && sameLayer
                              ? selection.anchor
                              : value,
                        })
                        setChosen(value)
                        setPreferredLayer(group)
                        setPosition(initialPosition)
                      }}
                    />
                  </section>
                )
              })}
            </div>
          )}
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
          <h1 className="flex-1 truncate text-sm font-medium">
            {allFiles ? "Project files" : "Local changes"}
          </h1>
          <CodeComments
            key={state.repositoryId}
            session={comments}
            selection={
              commentSelection?.key === sourceKey ? commentSelection : null
            }
          />
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
          {allFiles && activePath && !file ? (
            <LocalSourceFile
              key={activePath}
              repositoryId={state.repositoryId}
              path={activePath}
              onSelection={(source, value) =>
                setCommentSelection(
                  value
                    ? {
                        key: sourceKey,
                        value,
                        anchor: {
                          snapshotId: "",
                          sourceId: "",
                          path: source.path,
                          contentHash: source.revision,
                          range: value.range,
                          excerpt: value.excerpt,
                          local: {
                            path: source.path,
                            layer: "file",
                            side: "after",
                            version: source.revision,
                          },
                        },
                      }
                    : null
                )
              }
            />
          ) : content ? (
            <ReviewCodePane
              key={content.change.id}
              onCommentSelection={(value) => {
                const anchor = value && commentAnchor("", content.change, value)
                setCommentSelection(
                  value && anchor
                    ? {
                        key: sourceKey,
                        value,
                        anchor: {
                          ...anchor,
                          sourceId: "",
                          local: {
                            path: content.change.path,
                            layer: content.change.layer,
                            side: value.side,
                            version: content.version,
                          },
                        },
                      }
                    : null
                )
              }}
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
          await reload()
        }}
      />
    </div>
  )
}
