"use client"

import { useMemo, useState, type ComponentProps } from "react"
import { FileIcon, FolderIcon } from "@/features/file-icons/components/FileIcon"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons"
import { folderGitStatuses } from "@/lib/git/file-status"
import { cn } from "@/lib/utils"
import { GitStatusBadge, gitStatusColor } from "./GitStatusBadge"
import type { FileTree } from "./FileTree"
import { treeRowOpacity } from "../helpers/treeRowOpacity"
import { groupFiles } from "../helpers/groupFiles.helpers"

export function GroupedFileTree({
  paths,
  visiblePaths = paths,
  allPaths = paths,
  selectedPaths,
  ignoredPaths,
  alwaysExpanded = false,
  collapsedGroups,
  onToggleGroup,
  renderRow,
  onKeepOpen,
  selected,
  statuses,
  staged = false,
  onSelect,
}: Omit<ComponentProps<typeof FileTree>, "marks"> & {
  collapsedGroups?: ReadonlySet<string>
  onToggleGroup?: (path: string) => void
  visiblePaths?: string[]
  marks?: ComponentProps<typeof FileTree>["marks"]
}) {
  const groups = useMemo(() => groupFiles(allPaths), [allPaths])
  const folderStatuses = useMemo(
    () => folderGitStatuses(statuses ?? {}),
    [statuses]
  )
  const visible = useMemo(() => new Set(visiblePaths), [visiblePaths])
  const [internalClosed, setClosed] = useState<Set<string>>(
    () => new Set(staged ? groups.map((group) => group.path) : [])
  )
  const closed = collapsedGroups ?? internalClosed
  const filtering = alwaysExpanded || visiblePaths.length !== paths.length
  const selectionOrder = groups.flatMap((group) =>
    filtering || !closed.has(group.path)
      ? group.paths.filter((path) => visible.has(path))
      : []
  )
  const wrap = (row: React.ReactElement, path: string, folder = false) =>
    renderRow && path ? renderRow(row, { path, folder }) : row
  return (
    <div className="space-y-4" aria-label="Grouped files">
      {groups.map((group) => {
        const files = group.paths.filter((path) => visible.has(path))
        if (!files.length) return null
        const open = filtering || !closed.has(group.path)
        return (
          <section key={group.path} data-file-group={group.path}>
            {wrap(
              <button
                data-folder={group.path}
                type="button"
                aria-expanded={open}
                onClick={() =>
                  onToggleGroup
                    ? onToggleGroup(group.path)
                    : setClosed((old) => {
                        const next = new Set(old)
                        if (next.has(group.path)) next.delete(group.path)
                        else next.add(group.path)
                        return next
                      })
                }
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                  treeRowOpacity(staged, selected === group.path)
                )}
              >
                <HugeiconsIcon
                  icon={open ? ArrowDown01Icon : ArrowRight01Icon}
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
                <FolderIcon path={group.path} open={open} size={16} />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[13px] font-medium",
                      gitStatusColor(folderStatuses[group.path])
                    )}
                  >
                    {group.path.split("/").at(-1) || "Repository"}
                  </span>
                  <span
                    className="block truncate text-[11px] text-muted-foreground"
                    title={group.path}
                  >
                    {group.path || "Root files and isolated changes"}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {files.length}
                </span>
              </button>,
              group.path,
              true
            )}
            {open && (
              <ul>
                {files.map((path) => {
                  const relative = path.slice(
                    group.path ? group.path.length + 1 : 0
                  )
                  const directory = relative.includes("/")
                    ? relative.slice(0, relative.lastIndexOf("/"))
                    : ""
                  return (
                    <li key={path}>
                      {wrap(
                        <button
                          type="button"
                          title={path}
                          aria-current={selected === path ? "page" : undefined}
                          onClick={(event) =>
                            onSelect(path, event, selectionOrder)
                          }
                          onDoubleClick={() => onKeepOpen?.(path)}
                          className={cn(
                            "flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left text-[13px] hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                            treeRowOpacity(
                              staged,
                              selectedPaths
                                ? selectedPaths.has(path)
                                : selected === path,
                              ignoredPaths?.has(path)
                            ),
                            (selectedPaths
                              ? selectedPaths.has(path)
                              : selected === path) && "bg-accent"
                          )}
                        >
                          <FileIcon path={path} size={16} />
                          <span
                            className={cn(
                              "min-w-0 shrink truncate",
                              gitStatusColor(statuses?.[path])
                            )}
                          >
                            {path.split("/").at(-1)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                            {directory}
                          </span>
                          <GitStatusBadge status={statuses?.[path]} />
                        </button>,
                        path
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
