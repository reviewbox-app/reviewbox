"use client"
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FileAddIcon,
  FolderAddIcon,
  Edit02Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons"

import {
  canCreateProjectFile,
  editableProjectPath,
  isReviewBoxPath,
} from "../helpers/editorPaths"
import { EditorTabs } from "../components/EditorTabs"
import { useEditorMenu } from "../hooks/useEditorMenu"
import type { EditorSearchMatch } from "@/lib/desktop/contracts.generated"
import { EditorSearchResults } from "../components/EditorSearchResults"
import { useEditorContentSearch } from "../hooks/useEditorContentSearch"
import {
  findEditorFiles,
  indexEditorFiles,
} from "../helpers/editorSearch.helpers"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import { FileTreeToolbar } from "@/features/file-tree/components/FileTreeToolbar"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { SidebarResizeHandle } from "@/components/ui/sidebar-resize-handle"
import { FileMenu } from "@/features/file-tree/components/FileMenu"
import { useFileTreeNavigation } from "@/features/file-tree/hooks/useFileTreeNavigation"
import { FileTree } from "@/features/file-tree/components/FileTree"
import type { GitFileStatus } from "@/lib/git/file-status"
import { CodeDiffEditor } from "../components/CodeDiffEditor"
import { editorCommands } from "../services/editor.commands"
import {
  closeBuffer,
  keepEditorFile,
  moveEditorBuffer,
  dirty,
  editorError,
  getEditor,
  initializeEditor,
  openEditorFile,
  refreshEditor,
  saveAllEditors,
  saveBuffer,
  updateBuffer,
  updateEditor,
  useEditorStore,
} from "../stores/editor.store"
import { EditorFileView } from "./EditorFileView"
import { EditorFileDialog, type FileAction } from "./EditorFileDialog"
import { EditorWatchNotice } from "./EditorWatchNotice"
import { LanguageEditPreview } from "@/features/language-servers/composites/LanguageEditPreview"

export function CodeEditorWorkspace({
  repositoryId: id,
  statuses = {},
}: {
  repositoryId: string
  statuses?: Record<string, GitFileStatus>
}) {
  const session = useEditorStore((s) => s.sessions[id])
  useEditorMenu(id, session)
  const filesPanel = useRef<HTMLElement>(null)
  const navigationRequest = useRef(0)
  const entries = session?.entries
  const ignoredPaths = session?.ignoredPaths
  const query = session?.filter.trim() ?? ""
  const deferredQuery = useDeferredValue(query)
  const searching = !!query
  const {
    ref: attachTree,
    onScroll: saveTreeScroll,
    toggle: toggleTree,
    update: updateTree,
  } = useFileTreeNavigation(id, "editor", searching)
  const searchMode = session?.searchMode ?? "file"
  const fileIndex = useMemo(
    () => indexEditorFiles(entries ?? [], ignoredPaths ?? new Set()),
    [entries, ignoredPaths]
  )
  const fileResults = useMemo(
    () => findEditorFiles(fileIndex, deferredQuery),
    [fileIndex, deferredQuery]
  )
  const allPaths = useMemo(
    () => entries?.filter((e) => !e.directory).map((e) => e.path) ?? [],
    [entries]
  )
  const treePaths = useMemo(
    () => entries?.map((e) => e.path + (e.directory ? "/" : "")) ?? [],
    [entries]
  )
  const content = useEditorContentSearch(
    id,
    query,
    searching && searchMode === "content"
  )
  const selectMatch = async (match: EditorSearchMatch) => {
    const request = ++navigationRequest.current
    await openEditorFile(id, match.path, false)
    if (request !== navigationRequest.current) return
    updateEditor(id, (s) => ({
      ...s,
      active: match.path,
      buffers: s.buffers.map((b) =>
        b.path === match.path
          ? {
              ...b,
              preview: false,
              navigation: {
                line: match.line,
                column: match.column,
                length: match.length,
                token: crypto.randomUUID(),
              },
            }
          : b
      ),
    }))
  }
  const [action, setAction] = useState<FileAction | null>(null)
  const [closing, setClosing] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const report = (work: Promise<unknown>) =>
    void work.catch((e) => editorError(id, e))
  useEffect(() => {
    void initializeEditor(id).catch((e) => editorError(id, e))
  }, [id])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        const s = getEditor(id)
        const b = s?.buffers.find((b) => b.path === s.active)
        const work = event.shiftKey
          ? saveAllEditors(id)
          : b
            ? saveBuffer(id, b.id)
            : Promise.resolve()
        void work.catch((e) => editorError(id, e))
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [id])
  if (!session)
    return (
      <p role="status" className="p-6">
        Opening editor…
      </p>
    )
  const active = session.buffers.find((b) => b.path === session.active)
  const compare = session.buffers.find((b) => b.id === conflict)
  const chooseAction = async (kind: FileAction["kind"], path: string) => {
    const revision =
      kind === "rename" || kind === "trash"
        ? await editorCommands.revision(id, path)
        : ""
    setAction({ kind, path, revision })
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LanguageEditPreview />
      {session.watchHealthy === false && (
        <EditorWatchNotice repositoryId={id} />
      )}
      {session.error && (
        <div
          role="alert"
          className="flex items-center gap-2 px-4 py-2 text-sm text-destructive"
        >
          <span className="flex-1">{session.error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => updateEditor(id, (s) => ({ ...s, error: "" }))}
          >
            Dismiss
          </Button>
        </div>
      )}
      <div
        className="flex min-h-0 flex-1 gap-2 px-2 pb-2"
        data-resize-workspace
      >
        <aside
          ref={filesPanel}
          aria-label="Code Editor files"
          className="relative flex w-[clamp(180px,var(--explain-files-width,272px),30%)] shrink-0 flex-col gap-2"
        >
          <FileTreeToolbar
            value={session.filter}
            onChange={(filter) => updateEditor(id, (s) => ({ ...s, filter }))}
            mode={searchMode}
            onModeChange={(searchMode) =>
              updateEditor(id, (s) => ({ ...s, searchMode }))
            }
            paths={treePaths}
            expandedPaths={[...session.toggledFolders]}
            disabled={searching}
            onExpand={(expandedPaths) => {
              updateTree((tree) => ({ ...tree, expandedPaths }))
              updateEditor(id, (s) => ({
                ...s,
                toggledFolders: new Set(expandedPaths),
              }))
              report(
                refreshEditor(id, {
                  repositoryId: id,
                  paths: [],
                  tree: true,
                  git: false,
                  full: false,
                })
              )
            }}
            onNewFile={() =>
              setAction({ kind: "file", path: "", revision: "" })
            }
            onNewFolder={() =>
              setAction({ kind: "folder", path: "", revision: "" })
            }
          />
          <nav
            ref={attachTree}
            onScroll={saveTreeScroll}
            aria-label="Project files"
            className="min-h-0 flex-1 overflow-auto"
          >
            {searching && searchMode === "content" ? (
              <EditorSearchResults
                {...content}
                onSelect={(match) => report(selectMatch(match))}
              />
            ) : (
              <>
                {searching && (
                  <p
                    role="status"
                    className="px-2 py-1 text-xs text-muted-foreground"
                  >
                    {query !== deferredQuery
                      ? "Searching…"
                      : `${fileResults.paths.length}${fileResults.truncated ? "+" : ""} files · ignored files excluded`}
                    {fileResults.truncated ? " · Refine your search" : ""}
                  </p>
                )}
                <FileTree
                  alwaysExpanded={searching}
                  toggledFolders={session.toggledFolders}
                  onToggleFolder={(path) => {
                    toggleTree(path)
                    const opening = !session.toggledFolders.has(path)
                    updateEditor(id, (s) => {
                      const toggledFolders = new Set(s.toggledFolders)
                      if (toggledFolders.has(path)) toggledFolders.delete(path)
                      else toggledFolders.add(path)
                      return { ...s, toggledFolders }
                    })
                    if (
                      opening &&
                      session.entries.some(
                        (entry) => entry.path === path && entry.lazy
                      )
                    )
                      report(
                        refreshEditor(id, {
                          repositoryId: id,
                          paths: [],
                          tree: true,
                          git: false,
                          full: false,
                        })
                      )
                  }}
                  paths={searching ? fileResults.paths : treePaths}
                  selected={session.active}
                  marks={{}}
                  ignoredPaths={session.ignoredPaths}
                  allPaths={allPaths}
                  statuses={statuses}
                  onSelect={(path) => {
                    navigationRequest.current++
                    updateTree((tree) => ({
                      ...tree,
                      selectedPath: path,
                    }))
                    report(openEditorFile(id, path, true, true))
                  }}
                  onKeepOpen={(path) => report(openEditorFile(id, path))}
                  renderRow={(row, target) => (
                    <FileMenu
                      row={row}
                      repositoryId={id}
                      path={target.path}
                      onError={(e) => editorError(id, e)}
                      before={
                        <>
                          <ContextMenuItem
                            disabled={
                              !canCreateProjectFile(
                                target.folder
                                  ? target.path
                                  : target.path.slice(
                                      0,
                                      target.path.lastIndexOf("/")
                                    )
                              )
                            }
                            onClick={() =>
                              setAction({
                                kind: "file",
                                path: target.folder
                                  ? `${target.path}/`
                                  : target.path.slice(
                                      0,
                                      target.path.lastIndexOf("/") + 1
                                    ),
                                revision: "",
                              })
                            }
                          >
                            <HugeiconsIcon icon={FileAddIcon} />
                            New file
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={isReviewBoxPath(target.path)}
                            onClick={() =>
                              setAction({
                                kind: "folder",
                                path: target.folder
                                  ? `${target.path}/`
                                  : target.path.slice(
                                      0,
                                      target.path.lastIndexOf("/") + 1
                                    ),
                                revision: "",
                              })
                            }
                          >
                            <HugeiconsIcon icon={FolderAddIcon} />
                            New folder
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                        </>
                      }
                      after={
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            disabled={
                              (target.folder && isReviewBoxPath(target.path)) ||
                              !editableProjectPath(target.path)
                            }
                            onClick={() =>
                              report(chooseAction("rename", target.path))
                            }
                          >
                            <HugeiconsIcon icon={Edit02Icon} />
                            Rename
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={
                              (target.folder && isReviewBoxPath(target.path)) ||
                              !editableProjectPath(target.path)
                            }
                            onClick={() =>
                              report(chooseAction("trash", target.path))
                            }
                          >
                            <HugeiconsIcon icon={Delete02Icon} />
                            Move to Trash
                          </ContextMenuItem>
                        </>
                      }
                    />
                  )}
                />
              </>
            )}
          </nav>
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-panel border bg-card">
            <EditorTabs
              onKeepOpen={(path) => keepEditorFile(id, path)}
              onMove={(source, target, after) =>
                updateEditor(id, (s) => ({
                  ...s,
                  buffers: moveEditorBuffer(s.buffers, source, target, after),
                }))
              }
              buffers={session.buffers}
              active={session.active}
              onSelect={(path) => {
                navigationRequest.current++
                updateEditor(id, (s) => ({ ...s, active: path }))
              }}
              onClose={(buffer) =>
                dirty(buffer)
                  ? setClosing(buffer.id)
                  : closeBuffer(id, buffer.id)
              }
            />
            {active ? (
              <EditorFileView
                key={active.id}
                repositoryId={id}
                buffer={active}
                onSave={() =>
                  active.external !== undefined
                    ? setConflict(active.id)
                    : report(saveBuffer(id, active.id))
                }
                onConflict={() => setConflict(active.id)}
              />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={FileAddIcon} />
                  </EmptyMedia>
                  <EmptyTitle>
                    {session.ready
                      ? "Open a file to start editing"
                      : "Reading project files…"}
                  </EmptyTitle>
                  <EmptyDescription>
                    Select a file in the explorer or create one in this project.
                  </EmptyDescription>
                </EmptyHeader>
                {session.ready && (
                  <EmptyContent className="flex-row justify-center">
                    <Button
                      onClick={() =>
                        setAction({ kind: "file", path: "", revision: "" })
                      }
                    >
                      <HugeiconsIcon icon={FileAddIcon} />
                      New file
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setAction({ kind: "folder", path: "", revision: "" })
                      }
                    >
                      <HugeiconsIcon icon={FolderAddIcon} />
                      New folder
                    </Button>
                  </EmptyContent>
                )}
              </Empty>
            )}
          </main>
          <SidebarResizeHandle
            name="Code Editor files"
            property="--explain-files-width"
            maxRatio={0.3}
            panelRef={filesPanel}
            edge="left"
          />
        </div>
      </div>
      {action && (
        <EditorFileDialog
          key={`${action.kind}/${action.path}`}
          repositoryId={id}
          action={action}
          onClose={() => setAction(null)}
        />
      )}
      <Dialog
        open={!!closing}
        onOpenChange={(open) => {
          if (!open) setClosing(null)
        }}
      >
        <DialogContent>
          <DialogTitle>Save changes?</DialogTitle>
          <DialogDescription>
            This file contains unsaved changes.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                closeBuffer(id, closing!)
                setClosing(null)
              }}
            >
              Discard
            </Button>
            <Button
              onClick={() =>
                report(
                  saveBuffer(id, closing!).then(() => {
                    closeBuffer(id, closing!)
                    setClosing(null)
                  })
                )
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!compare}
        onOpenChange={(open) => {
          if (!open) setConflict(null)
        }}
      >
        <DialogContent className="flex h-[80vh] max-w-[90vw] flex-col sm:max-w-[90vw]">
          <DialogTitle>Compare external changes</DialogTitle>
          <DialogDescription>
            Disk on the left · your draft on the right
          </DialogDescription>
          {compare && (
            <div className="min-h-0 flex-1">
              <CodeDiffEditor
                height="100%"
                original={compare.external?.text ?? ""}
                modified={compare.text}
                options={{ readOnly: true, renderSideBySide: true }}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConflict(null)}>
              Keep my draft
            </Button>
            <Button
              variant="secondary"
              disabled={!compare?.external}
              onClick={() => {
                if (compare?.external)
                  updateBuffer(id, compare.id, (b) => ({
                    ...b,
                    ...compare.external!,
                    baseText: compare.external!.text,
                    version: b.version + 1,
                    external: undefined,
                  }))
                setConflict(null)
              }}
            >
              Reload from disk
            </Button>
            <Button
              onClick={() =>
                report(
                  (async () => {
                    if (!compare) return
                    if (compare.external === null) {
                      await editorCommands.mutate(id, {
                        kind: "create",
                        path: compare.path,
                        directory: false,
                      })
                      const file = await editorCommands.read(id, compare.path)
                      updateBuffer(id, compare.id, (b) => ({
                        ...b,
                        revision: file.revision,
                        baseText: "",
                        uri: file.uri,
                        external: undefined,
                      }))
                      await saveBuffer(id, compare.id)
                    } else await saveBuffer(id, compare.id, true)
                    setConflict(null)
                  })()
                )
              }
            >
              {compare?.external === null
                ? "Recreate file"
                : "Replace disk version"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
