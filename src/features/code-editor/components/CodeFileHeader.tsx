import type { ComponentProps, ReactNode } from "react"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import { cn } from "@/lib/utils"

export const codeFileHeaderHeight = 36

/** File identity is shared by live files, captured diffs and referenced sources. */
export function CodeFileHeader({
  path,
  previousPath,
  children,
  className,
  style,
  ...props
}: {
  path: string
  previousPath?: string | null
  children?: ReactNode
} & ComponentProps<"header">) {
  const slash = path.lastIndexOf("/")
  return (
    <header
      {...props}
      className={cn(
        "flex shrink-0 items-center gap-2 overflow-hidden border-b px-2 text-xs",
        className
      )}
      style={{ ...style, height: codeFileHeaderHeight }}
    >
      <FileIcon path={path} size={16} />
      <span
        className="min-w-0 flex-1 truncate"
        title={previousPath ? `${previousPath} → ${path}` : path}
      >
        {slash >= 0 && (
          <span className="opacity-50">{path.slice(0, slash + 1)}</span>
        )}
        <span className="font-medium opacity-100">{path.slice(slash + 1)}</span>
      </span>
      {children}
    </header>
  )
}
