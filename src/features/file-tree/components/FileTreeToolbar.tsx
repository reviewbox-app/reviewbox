import { useEffect, useLayoutEffect, useRef } from "react"
import { useExplorerSearch } from "./ExplorerSearchProvider"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  MoreHorizontalIcon,
  FileAddIcon,
  FolderAddIcon,
  CollapseIcon,
  ExpandIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { folderPaths } from "../helpers/tree.helpers"
import { FileTreeSearch } from "./FileTreeSearch"

/** Identical explorer controls; callers own the source and allowed mutations. */
export function FileTreeToolbar({
  value,
  onChange,
  mode,
  onModeChange,
  paths,
  expandedPaths,
  onExpand,
  onNewFile,
  onNewFolder,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  mode: "file" | "content"
  onModeChange: (mode: "file" | "content") => void
  paths: string[]
  expandedPaths: string[]
  onExpand: (paths: string[]) => void
  onNewFile?: () => void
  onNewFolder?: () => void
  disabled?: boolean
}) {
  const request = useExplorerSearch()?.request
  const change = useRef(onChange)
  useLayoutEffect(() => {
    change.current = onChange
  })
  useEffect(() => {
    if (request) change.current(request.text)
  }, [request])
  const folders = folderPaths(paths)
  const expanded = folders.some(
    (path) => !path.includes("/") && expandedPaths.includes(path)
  )
  return (
    <>
      <FileTreeSearch
        focusToken={request?.token}
        value={value}
        onChange={onChange}
        label={mode === "content" ? "Search file contents" : "Filter files"}
        placeholder={mode === "content" ? "Search contents…" : "Search files…"}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Explorer actions"
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {onNewFile && (
              <DropdownMenuItem onClick={onNewFile}>
                <HugeiconsIcon icon={FileAddIcon} />
                New file
              </DropdownMenuItem>
            )}
            {onNewFolder && (
              <DropdownMenuItem onClick={onNewFolder}>
                <HugeiconsIcon icon={FolderAddIcon} />
                New folder
              </DropdownMenuItem>
            )}
            {(onNewFile || onNewFolder) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              disabled={disabled || !folders.length}
              onClick={() => onExpand(expanded ? [] : folders)}
            >
              <HugeiconsIcon icon={expanded ? CollapseIcon : ExpandIcon} />
              {expanded ? "Collapse all" : "Expand all"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </FileTreeSearch>
      {!!value.trim() && (
        <Tabs
          value={mode}
          onValueChange={(value) =>
            onModeChange(value === "content" ? "content" : "file")
          }
        >
          <TabsList aria-label="Search mode" className="w-full">
            <TabsTrigger value="file">File</TabsTrigger>
            <TabsTrigger value="content">Content</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
    </>
  )
}
