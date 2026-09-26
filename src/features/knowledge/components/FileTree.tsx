"use client"
import { useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  File01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"

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

/** Snapshot files as a tree; a dot marks an explanation (blue) or an outdated one (amber). */
export function FileTree({
  paths,
  selected,
  marks,
  onSelect,
}: {
  paths: string[]
  selected: string
  marks: Record<string, "explained" | "outdated">
  onSelect: (path: string) => void
}) {
  const tree = useMemo(() => buildTree(paths), [paths])
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const toggle = (path: string) =>
    setClosed((value) => {
      const next = new Set(value)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const row =
    "flex w-full items-center gap-1.5 rounded-xl py-1 pr-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30"
  const render = (folder: Folder, depth: number): React.ReactNode => (
    <>
      {[...folder.folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => {
          const open = !closed.has(child.path)
          return (
            <li key={child.path}>
              <button
                aria-expanded={open}
                className={row}
                style={{ paddingLeft: 6 + depth * 14 }}
                onClick={() => toggle(child.path)}
              >
                <HugeiconsIcon
                  icon={open ? ArrowDown01Icon : ArrowRight01Icon}
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
                <HugeiconsIcon
                  icon={Folder01Icon}
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate">{child.name}</span>
              </button>
              {open && <ul>{render(child, depth + 1)}</ul>}
            </li>
          )
        })}
      {folder.files.map((path) => (
        <li key={path}>
          <button
            aria-current={path === selected ? "page" : undefined}
            title={path}
            className={cn(
              row,
              path === selected && "bg-accent hover:bg-accent"
            )}
            style={{ paddingLeft: 26 + depth * 14 }}
            onClick={() => onSelect(path)}
          >
            <HugeiconsIcon
              icon={File01Icon}
              size={16}
              className="shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate">
              {path.split("/").at(-1)}
            </span>
            {marks[path] && (
              <span
                aria-label={
                  marks[path] === "outdated"
                    ? "Explanation outdated"
                    : "Explained"
                }
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  marks[path] === "outdated"
                    ? "bg-review-attention"
                    : "bg-primary"
                )}
              />
            )}
          </button>
        </li>
      ))}
    </>
  )
  return <ul className="space-y-px">{render(tree, 0)}</ul>
}
