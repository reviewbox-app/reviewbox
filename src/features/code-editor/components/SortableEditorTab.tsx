"use client"

import type { KeyboardEvent } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { useReducedMotion } from "motion/react"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import { dirty, type EditorBuffer } from "../stores/editor.store"

export function SortableEditorTab({
  buffer,
  selected,
  onSelect,
  onClose,
  onNavigate,
}: {
  buffer: EditorBuffer
  selected: boolean
  onSelect: (path: string) => void
  onClose: (buffer: EditorBuffer) => void
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const reducedMotion = useReducedMotion()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isSorting,
  } = useSortable({
    id: buffer.id,
    transition: reducedMotion ? null : undefined,
  })
  const unsaved = dirty(buffer)
  return (
    <div
      ref={setNodeRef}
      className="group relative h-7 shrink-0"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : undefined,
      }}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        role="tab"
        aria-selected={selected}
        aria-label={`${buffer.path}${unsaved ? " (unsaved)" : ""}`}
        tabIndex={selected ? 0 : -1}
        title={buffer.path}
        className={`flex h-full w-full min-w-0 touch-none items-center gap-2 rounded-lg p-1 pr-2 text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "bg-foreground/5" : "hover:bg-foreground/5"}`}
        onClick={() => onSelect(buffer.path)}
        onKeyDown={(event) => {
          listeners?.onKeyDown?.(event)
          if (!event.defaultPrevented && !isSorting) onNavigate(event)
        }}
      >
        <FileIcon path={buffer.path} size={20} />
        <span className="max-w-56 truncate">
          {buffer.path.split("/").at(-1)}
        </span>
      </button>
      {unsaved && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-3 right-2 size-1.5 rounded-full bg-current group-focus-within:hidden group-hover:hidden"
        />
      )}
      <button
        aria-label={`Close ${buffer.path}`}
        title={unsaved ? "Unsaved changes · Close" : "Close"}
        className="pointer-events-none absolute top-1 right-1 flex size-5 items-center justify-center rounded bg-popover/60 text-muted-foreground opacity-0 backdrop-blur-md group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onClose(buffer)}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={16} />
      </button>
    </div>
  )
}
