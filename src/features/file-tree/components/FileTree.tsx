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

interface Folder {
  name: string
  path: string
  folders: Map<string, Folder>
  files: string[]
}

function buildTree(paths: string[]) {
  const root: Folder = { name: "", path: "", folders: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split("/")
    let node = root
    for (const part of parts.slice(0, -1)) {
      const next = node.path ? `${node.path}/${part}` : part
      if (!node.folders.has(part))
        node.folders.set(part, {
          name: part,
          path: next,
          folders: new Map(),
          files: [],
        })
      node = node.folders.get(part)!
    }
    node.files.push(path)
  }
  // Collapse single-child chains ("src-tauri/src") like the prototype.
  const compact = (folder: Folder): Folder => {
    folder.folders.forEach((child, key) =>
      folder.folders.set(key, compact(child))
    )
    if (folder.name && folder.folders.size === 1 && folder.files.length === 0) {
      const only = [...folder.folders.values()][0]
      return { ...only, name: `${folder.name}/${only.name}` }
    }
    return folder
  }
  return compact(root)
}

export type FileMark = "validated" | "unavailable"

const markLabels: Record<FileMark, string> = {
  validated: "Validated",
  unavailable: "Pseudo-code unavailable",
}

/** Shared file tree with Git statuses and review decisions. */
export function FileTree({
  paths,
  selected,
  marks,
  statuses = {},
  reviewedPaths,
  dimmedLabel = "Reviewed.",
  alwaysExpanded = false,
  defaultExpanded = false,
  onSelect,
  selectedPaths,
  renderRow,
}: {
  paths: string[]
  selected: string
  marks: Record<string, FileMark>
  statuses?: Record<string, GitFileStatus>
  reviewedPaths?: ReadonlySet<string>
  dimmedLabel?: string
  alwaysExpanded?: boolean
  defaultExpanded?: boolean
  selectedPaths?: ReadonlySet<string>
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
  const folderStatuses = useMemo(() => folderGitStatuses(statuses), [statuses])
  const [toggled, setToggled] = useState<Set<string>>(new Set())
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
  const toggle = (path: string) =>
    setToggled((value) => {
      const next = new Set(value)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const row =
    "relative flex w-full items-center gap-1.5 rounded-xl py-1 pr-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30"
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
                size={14}
                className="shrink-0 text-muted-foreground"
              />
              <FolderIcon path={child.path} open={open} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
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
                    className={row}
                    style={{ paddingLeft: 6 + depth * 14 }}
                  >
                    {content}
                  </div>
                ) : (
                  <button
                    data-folder={child.path}
                    aria-expanded={open}
                    className={row}
                    style={{ paddingLeft: 6 + depth * 14 }}
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
              style={{ paddingLeft: 26 + depth * 14 }}
              onClick={(event) => onSelect(path, event, visiblePaths)}
            >
              <span
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5",
                  reviewedPaths?.has(path)
                    ? "opacity-50"
                    : statuses[path] === "D" && "opacity-75"
                )}
              >
                <FileIcon path={path} />
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
  return <ul className="space-y-px">{render(tree, 0)}</ul>
}
