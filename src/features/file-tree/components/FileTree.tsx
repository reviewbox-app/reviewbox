"use client"
import { useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  InformationCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { FileIcon, FolderIcon } from "@/features/file-icons/components/FileIcon"
import { folderGitStatuses, type GitFileStatus } from "@/lib/git/file-status"
import { GitStatusBadge, gitStatusColor } from "./GitStatusBadge"

import { buildTree, type Folder } from "../helpers/tree.helpers"

export type FileMark = "validated" | "unavailable"

const markLabels: Record<FileMark, string> = {
  validated: "Validated",
  unavailable: "Pseudo-code unavailable",
}

/** Shared file tree with Git statuses and review decisions. */
export function FileTree({
  paths,
  allPaths = paths,
  selected,
  marks,
  statuses = {},
  reviewedPaths,
  ignoredPaths,
  dimmedLabel = "Reviewed.",
  alwaysExpanded = false,
  defaultExpanded = false,
  onSelect,
  selectedPaths,
  renderRow,
  toggledFolders,
  onToggleFolder,
}: {
  paths: string[]
  /** Full inventory keeps filtered-out files in folder ignore decisions. */
  allPaths?: string[]
  selected: string
  marks: Record<string, FileMark>
  statuses?: Record<string, GitFileStatus>
  reviewedPaths?: ReadonlySet<string>
  ignoredPaths?: ReadonlySet<string>
  dimmedLabel?: string
  alwaysExpanded?: boolean
  defaultExpanded?: boolean
  selectedPaths?: ReadonlySet<string>
  toggledFolders?: ReadonlySet<string>
  onToggleFolder?: (path: string) => void
  renderRow?: (
    row: React.ReactElement,
    target: { path: string; folder: boolean }
  ) => React.ReactNode
  onSelect: (
    path: string,
    event: React.MouseEvent,
    visiblePaths: string[]
  ) => void
}) {
  const tree = useMemo(() => buildTree(paths), [paths])
  const ignoredFolders = useMemo(() => {
    const folders = new Map<string, boolean>()
    for (const path of allPaths) {
      if (path.endsWith("/")) continue
      const ignored = ignoredPaths?.has(path) ?? false
      let end = path.lastIndexOf("/")
      while (end > 0) {
        const folder = path.slice(0, end)
        folders.set(folder, (folders.get(folder) ?? true) && ignored)
        end = path.lastIndexOf("/", end - 1)
      }
    }
    return folders
  }, [allPaths, ignoredPaths])
  const folderStatuses = useMemo(() => folderGitStatuses(statuses), [statuses])
  const [internalToggled, setToggled] = useState<Set<string>>(new Set())
  const toggled = toggledFolders ?? internalToggled
  const visiblePaths: string[] = []
  const collect = (folder: Folder) => {
    for (const child of [...folder.folders.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (alwaysExpanded || defaultExpanded !== toggled.has(child.path))
        collect(child)
    }
    visiblePaths.push(...folder.files)
  }
  collect(tree)
  const wrap = (row: React.ReactElement, path: string, folder: boolean) =>
    renderRow ? renderRow(row, { path, folder }) : row
  const toggle = (path: string) => {
    if (onToggleFolder) {
      onToggleFolder(path)
      return
    }
    setToggled((value) => {
      const next = new Set(value)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const row =
    "relative flex h-[22px] w-full items-center gap-0 rounded-md p-0 text-left text-[13px] leading-[22px] outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30"
  const render = (folder: Folder, depth: number): React.ReactNode => (
    <>
      {[...folder.folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => {
          const open =
            alwaysExpanded || defaultExpanded !== toggled.has(child.path)
          const content = (
            <>
              <HugeiconsIcon
                icon={open ? ArrowDown01Icon : ArrowRight01Icon}
                size={16}
                className="shrink-0 text-muted-foreground"
                style={{ marginLeft: 8 + depth * 8, marginRight: 6 }}
              />
              <FolderIcon path={child.path} open={open} size={16} />
              <span
                className={cn(
                  "ml-1.5 min-w-0 flex-1 truncate",
                  gitStatusColor(folderStatuses[child.path])
                )}
              >
                {child.name}
              </span>
            </>
          )
          return (
            <li key={child.path}>
              {wrap(
                alwaysExpanded ? (
                  <div
                    data-folder={child.path}
                    tabIndex={renderRow ? 0 : undefined}
                    className={cn(
                      row,
                      (ignoredPaths?.has(child.path) ||
                        ignoredFolders.get(child.path)) &&
                        "opacity-60"
                    )}
                  >
                    {content}
                  </div>
                ) : (
                  <button
                    data-folder={child.path}
                    aria-expanded={open}
                    className={cn(
                      row,
                      (ignoredPaths?.has(child.path) ||
                        ignoredFolders.get(child.path)) &&
                        "opacity-60"
                    )}
                    onClick={() => toggle(child.path)}
                  >
                    {content}
                  </button>
                ),
                child.path,
                true
              )}
              {open && <ul>{render(child, depth + 1)}</ul>}
            </li>
          )
        })}
      {folder.files.map((path) => (
        <li key={path}>
          {wrap(
            <button
              aria-current={path === selected ? "page" : undefined}
              title={path}
              className={cn(
                row,
                (selectedPaths ? selectedPaths.has(path) : path === selected) &&
                  "bg-accent hover:bg-accent"
              )}
              onClick={(event) => onSelect(path, event, visiblePaths)}
            >
              <span
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5",
                  ignoredPaths?.has(path)
                    ? "opacity-60"
                    : reviewedPaths?.has(path)
                      ? "opacity-50"
                      : statuses[path] === "D" && "opacity-75"
                )}
                style={{ marginLeft: 30 + depth * 8 }}
              >
                <FileIcon path={path} size={16} />
                {reviewedPaths?.has(path) && (
                  <span className="sr-only">{dimmedLabel}</span>
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    gitStatusColor(statuses[path])
                  )}
                >
                  {path.split("/").at(-1)}
                </span>
              </span>
              <GitStatusBadge status={statuses[path]} className="opacity-50" />
              {marks[path] === "validated" ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={14}
                  aria-label={markLabels.validated}
                  className="shrink-0 text-review-validated"
                />
              ) : marks[path] === "unavailable" ? (
                <HugeiconsIcon
                  icon={InformationCircleIcon}
                  size={14}
                  aria-label={markLabels.unavailable}
                  className="shrink-0 text-review-attention"
                />
              ) : null}
            </button>,
            path,
            false
          )}
        </li>
      ))}
    </>
  )
  return <ul>{render(tree, 0)}</ul>
}
