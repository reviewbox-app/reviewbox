"use client"
import type { SourceSearchTarget } from "@/features/code-editor/contracts/sourceSelection.types"
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
import { FileTreeToolbar } from "@/features/file-tree/components/FileTreeToolbar"
import { FileTreeSearchResults } from "@/features/file-tree/components/FileTreeSearchResults"
import { useEditorContentSearch } from "@/features/code-editor/hooks/useEditorContentSearch"
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
import {
  folderPaths,
  orderedTreeFiles,
} from "@/features/file-tree/helpers/tree.helpers"
import { groupFiles } from "@/features/file-tree/helpers/groupFiles.helpers"
import { GroupedFileTree } from "@/features/file-tree/components/GroupedFileTree"
import { FileTree } from "@/features/file-tree/components/FileTree"
import { ReviewCodePane } from "@/features/review/composites/ReviewCodePane"
import { reviewReaderLayout } from "@/features/review/reader.config"
import { useScrollEdgeMask } from "@/hooks/use-scroll-edge-mask"
import type {
  LocalFileDiff,
  LocalGitState,
  LocalFile,
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
  nextLocalFileInLayer,
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const changedGroups = useMemo(
    () => groupFiles(state?.files.map((file) => file.path) ?? []),
    [state?.files]
  )
  const [fileLayout, setFileLayout] = useState("grouped")
  const ChangesTree = fileLayout === "grouped" ? GroupedFileTree : FileTree
  const [preferredLayer, setPreferredLayer] = useState("unstaged")
  const [searchTarget, setSearchTarget] = useState<SourceSearchTarget>()
  const [filter, setFilter] = useState("")
  const [searchMode, setSearchMode] = useState<"file" | "content">("file")
  const contentSearch = useEditorContentSearch(
    state?.repositoryId ?? "",
    filter.trim(),
    !!state && !!filter.trim() && searchMode === "content",
    false
  )
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
  const stagedTree = useFileTreeNavigation(
    state?.repositoryId ?? "",
    "local:staged:tree",
    !!filter.trim()
  )
  const stagedGroups = useFileTreeNavigation(
    state?.repositoryId ?? "",
    "local:staged:groups",
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
    (allFiles || !!filter.trim()) && navigation.ready
  )
  const [finishedStaging, setFinishedStaging] = useState<string>()
  const chosen = navigation.value.selectedPath ?? ""
  const setChosen = (path: string) => {
    setSearchTarget(undefined)
    setFinishedStaging(undefined)
    navigation.update((tree) => ({ ...tree, selectedPath: path }))
  }
  const existing = inventory.entries.some(
    (entry) => !entry.directory && entry.path === chosen
  )
  const activePath =
    finishedStaging === state?.repositoryId && !chosen
      ? undefined
      : allFiles && existing
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
            !entry.ignored &&
            entry.path.toLowerCase().includes(filter.trim().toLowerCase()))
      )
      .map((entry) => entry.path + (entry.directory ? "/" : ""))
    // Removed files have no filesystem entry but still belong to the reviewable tree.
    for (const file of state?.files ?? [])
      if (
        !filter.trim() ||
        (!ignoredPaths.has(file.path) &&
          file.path.toLowerCase().includes(filter.trim().toLowerCase()))
      )
        paths.push(file.path)
    return [...new Set(paths)]
  }, [inventory.entries, state?.files, filter, ignoredPaths])
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
          // A commit can invalidate a passive diff read before Git's refresh
          // arrives. Refresh that read; mutation errors still remain visible.
          const stale =
            cause &&
            typeof cause === "object" &&
            "code" in cause &&
            cause.code === "git_changed"
          if (!stale) setError(errorMessage(cause))
          void reload().catch(() => {})
        }
      })
    return () => {
      alive = false
    }
  }, [path, version, repositoryId, layer, reload, setError])
  const stageSelection = async (files: LocalFile[], staged: boolean) => {
    if (
      !state ||
      busy ||
      !files.length ||
      files.some((file) => file.conflicted)
    )
      return
    const removed = new Set(files.map((file) => file.path))
    const stagingLayer = staged ? "staged" : "unstaged"
    const order =
      !allFiles && fileLayout === "grouped"
        ? changedGroups.flatMap((group) => group.paths)
        : orderedTreeFiles(state.files.map((entry) => entry.path))
    const visibleOrder = order.filter(
      (candidate) =>
        !filter.trim() ||
        candidate === path ||
        (searchMode === "content"
          ? contentSearch.result?.matches.some(
              (match) => match.path === candidate
            )
          : candidate.toLowerCase().includes(filter.trim().toLowerCase()))
    )
    const selectedBefore = chosen
    let updated: LocalGitState | undefined
    const ok = await mutate(async () => {
      updated = await commands.stageFiles(
        state.repositoryId,
        files.map(({ path, version }) => ({ path, version })),
        !staged
      )
      return updated
    })
    const next =
      updated &&
      nextLocalFileInLayer(
        visibleOrder,
        updated.files,
        path ?? "",
        stagingLayer,
        removed
      )
    // Do not steal navigation if the user selected another file during the write.
    if (
      ok &&
      removed.has(path ?? "") &&
      layer === stagingLayer &&
      (treeNavigation(state.repositoryId, "local")?.selectedPath ?? "") ===
        selectedBefore
    ) {
      if (!next && staged) return
      setChosen(next ?? "")
      setFinishedStaging(next ? undefined : state.repositoryId)
      setPreferredLayer(stagingLayer)
      setSelection({
        layer: stagingLayer,
        paths: new Set(next ? [next] : []),
        anchor: next ?? "",
      })
      setPosition(initialPosition)
    }
  }
  const stageCurrent = async () => {
    if (
      !file ||
      !loaded ||
      loaded.change.path !== file.path ||
      loaded.change.layer !== layer ||
      loaded.version !== file.version
    )
      return
    await stageSelection([file], layer === "staged")
  }
  const stageAction = useRef(stageCurrent)
  useEffect(() => {
    stageAction.current = stageCurrent
  })
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.code !== "KeyS" ||
        document.querySelector('[role="dialog"]')
      )
        return
      event.preventDefault()
      event.stopPropagation()
      void stageAction.current()
    }
    window.addEventListener("keydown", key, true)
    return () => window.removeEventListener("keydown", key, true)
  }, [])
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
        <FileTreeToolbar
          value={filter}
          onChange={(value) => {
            setFilter(value)
            setSearchExpansion({ key: "", paths: [] })
          }}
          mode={searchMode}
          onModeChange={setSearchMode}
          paths={allFiles ? paths : state.files.map((file) => file.path)}
          expandedPaths={
            !allFiles && fileLayout === "grouped"
              ? changedGroups
                  .filter(
                    (group) =>
                      !collapsedGroups.has(group.path) ||
                      stagedGroups.value.expandedPaths.includes(group.path)
                  )
                  .flatMap((group) =>
                    group.path
                      .split("/")
                      .map((_, i, parts) => parts.slice(0, i + 1).join("/"))
                  )
              : !allFiles && !filter.trim()
                ? [
                    ...new Set([
                      ...expandedPaths,
                      ...stagedTree.value.expandedPaths,
                    ]),
                  ]
                : expandedPaths
          }
          onExpand={(paths) => {
            if (!allFiles && !filter.trim()) {
              const target =
                fileLayout === "grouped" ? stagedGroups : stagedTree
              target.update((value) => ({
                ...value,
                expandedPaths: paths.length
                  ? fileLayout === "grouped"
                    ? changedGroups.map((group) => group.path)
                    : paths
                  : [],
              }))
            }
            if (!allFiles && fileLayout === "grouped")
              setCollapsedGroups(
                new Set(
                  changedGroups
                    .filter(
                      (group) =>
                        !(
                          paths.includes(group.path) ||
                          (!group.path && paths.length > 0)
                        )
                    )
                    .map((group) => group.path)
                )
              )
            else updateExpanded(() => paths)
          }}
          disabled={!navigation.ready}
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
        </div>
        {!allFiles && (
          <Tabs value={fileLayout} onValueChange={setFileLayout}>
            <TabsList className="w-full" aria-label="File layout">
              <TabsTrigger value="grouped">Grouped</TabsTrigger>
              <TabsTrigger value="tree">Tree</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        <nav
          aria-label="Changed files"
          ref={attachTree}
          onScroll={navigation.onScroll}
          className="min-h-0 flex-1 overflow-auto"
        >
          {filter.trim() && searchMode === "content" ? (
            <FileTreeSearchResults
              {...contentSearch}
              result={
                contentSearch.result && {
                  ...contentSearch.result,
                  matches: contentSearch.result.matches.filter(
                    (match) =>
                      allFiles ||
                      state.files.some((file) => file.path === match.path)
                  ),
                }
              }
              scopeLabel="Saved files · ignored files excluded"
              onSelect={(match) => {
                setChosen(match.path)
                setPreferredLayer("unstaged")
                setSearchTarget({
                  ...match,
                  side: "after",
                  token: crypto.randomUUID(),
                })
              }}
            />
          ) : allFiles ? (
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
                const visible = files.filter(
                  (file) =>
                    (!filter.trim() || !ignoredPaths.has(file.path)) &&
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
                    <ChangesTree
                      staged={group === "staged"}
                      collapsedGroups={
                        group === "staged"
                          ? new Set(
                              changedGroups
                                .filter(
                                  (item) =>
                                    !stagedGroups.value.expandedPaths.includes(
                                      item.path
                                    )
                                )
                                .map((item) => item.path)
                            )
                          : collapsedGroups
                      }
                      onToggleGroup={(path: string) =>
                        group === "staged"
                          ? stagedGroups.toggle(path)
                          : setCollapsedGroups((old) => {
                              const next = new Set(old)
                              if (next.has(path)) next.delete(path)
                              else next.add(path)
                              return next
                            })
                      }
                      alwaysExpanded={!!filter.trim()}
                      allPaths={state.files.map((file) => file.path)}
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
                          onStage={stageSelection}
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
                      toggledFolders={
                        new Set(
                          group === "staged"
                            ? stagedTree.value.expandedPaths
                            : expandedPaths
                        )
                      }
                      onToggleFolder={
                        group === "staged" ? stagedTree.toggle : toggleFolder
                      }
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
              searchTarget={
                searchTarget?.path === activePath ? searchTarget : undefined
              }
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
              inspectionRepositoryId={state.repositoryId}
              searchTarget={
                searchTarget?.path === content.change.path
                  ? searchTarget
                  : undefined
              }
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
                  {file
                    ? "Loading changes"
                    : finishedStaging === state.repositoryId
                      ? "No more unstaged files"
                      : "No local changes"}
                </EmptyTitle>
                <EmptyDescription>
                  {file
                    ? "Reading the current file versions…"
                    : finishedStaging === state.repositoryId
                      ? "No unstaged files remain in this view. Staged files are still available in the explorer."
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
                title="Stage / unstage and open next file (⌘⇧S / Ctrl+Shift+S)"
                aria-keyshortcuts="Meta+Shift+S Control+Shift+S"
                onClick={() => void stageCurrent()}
              >
                {layer === "staged" ? "Unstage file" : "Stage file"}
                <kbd className="ml-2 text-xs opacity-60">⌘⇧S / Ctrl⇧S</kbd>
              </Button>
            )
          )}
        </footer>
      </main>
      <CommitDialog
        open={committing}
        onOpenChange={setCommitting}
        state={state}
        onCommitted={onBack}
        onFinished={async () => {
          await reload()
        }}
      />
    </div>
  )
}
