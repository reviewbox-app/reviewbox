"use client"

import { useEffect, useId, useRef, useState } from "react"
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Modifier,
} from "@dnd-kit/core"
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import { type EditorBuffer } from "../stores/editor.store"
import { SortableEditorTab } from "./SortableEditorTab"

const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 })

export function EditorTabs({
  buffers,
  active,
  onSelect,
  onClose,
  onMove,
}: {
  buffers: EditorBuffer[]
  active: string
  onSelect: (path: string) => void
  onClose: (buffer: EditorBuffer) => void
  onMove: (source: string, target: string, after: boolean) => void
}) {
  const id = useId()
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const dragged = buffers.find((buffer) => buffer.id === draggedId)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      scrollBehavior: "auto",
    })
  )
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = strip.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.deltaY === 0 ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
        element.scrollWidth <= element.clientWidth
      )
        return
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientWidth
            : 1
      element.scrollLeft += event.deltaY * unit
      event.preventDefault()
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [])
  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[horizontalOnly]}
      onDragStart={({ active: source }) => setDraggedId(String(source.id))}
      onDragCancel={() => setDraggedId(null)}
      onDragEnd={({ active: source, over }) => {
        setDraggedId(null)
        if (!over || source.id === over.id) return
        const sourceIndex = buffers.findIndex(
          (buffer) => buffer.id === source.id
        )
        const targetIndex = buffers.findIndex((buffer) => buffer.id === over.id)
        if (sourceIndex < 0 || targetIndex < 0) return
        onMove(String(source.id), String(over.id), sourceIndex < targetIndex)
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press Space to reorder this tab. Use Left and Right to move it, Space to drop, or Escape to cancel.",
        },
      }}
    >
      <div
        ref={strip}
        role="tablist"
        aria-label="Open files"
        className="flex shrink-0 gap-1 overflow-x-auto border-b p-2"
      >
        <SortableContext
          items={buffers.map((buffer) => buffer.id)}
          strategy={horizontalListSortingStrategy}
        >
          {buffers.map((buffer, index) => (
            <SortableEditorTab
              key={buffer.id}
              buffer={buffer}
              selected={buffer.path === active}
              onSelect={onSelect}
              onClose={onClose}
              onNavigate={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % buffers.length
                    : event.key === "ArrowLeft"
                      ? (index + buffers.length - 1) % buffers.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buffers.length - 1
                          : -1
                if (next < 0) return
                event.preventDefault()
                onSelect(buffers[next].path)
                strip.current
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus()
              }}
            />
          ))}
        </SortableContext>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragged && (
          <div
            aria-hidden
            className="flex h-7 items-center gap-2 rounded-lg bg-popover p-1 pr-2 text-xs shadow-sm"
          >
            <FileIcon path={dragged.path} size={20} />
            <span className="max-w-56 truncate">
              {dragged.path.split("/").at(-1)}
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
