import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, CommandLineIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import type { TerminalTab as Tab } from "../services/terminal.store"

export function TerminalTab({
  tab,
  active,
  onSelect,
  onClose,
  onRename,
}: {
  tab: Tab
  active: boolean
  onSelect: () => void
  onClose: () => void
  onRename: () => void
}) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id })
  return (
    <div
      ref={setNodeRef}
      className="group relative shrink-0"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <button
        {...attributes}
        {...listeners}
        role="tab"
        aria-selected={active}
        aria-controls={`terminal-${tab.id}`}
        onClick={onSelect}
        onDoubleClick={onRename}
        className={`flex h-8 max-w-56 items-center gap-2 rounded-lg pr-8 pl-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
      >
        <HugeiconsIcon icon={CommandLineIcon} size={14} />
        <span className="truncate">
          {tab.title}
          {tab.exited ? ` · Exit ${tab.exitCode ?? "?"}` : ""}
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-1 right-1 opacity-0 backdrop-blur-sm group-focus-within:opacity-100 group-hover:opacity-100"
        aria-label={`Close ${tab.title}`}
        onClick={onClose}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={12} />
      </Button>
    </div>
  )
}
