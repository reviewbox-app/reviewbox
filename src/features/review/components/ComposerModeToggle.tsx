import { HugeiconsIcon } from "@hugeicons/react"
import { NoteEditIcon, Quiz02Icon } from "@hugeicons/core-free-icons"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const modes = [
  {
    value: "note",
    label: "Note",
    shortcut: "N",
    icon: NoteEditIcon,
    active: "bg-primary/20 text-primary",
  },
  {
    value: "question",
    label: "Question",
    shortcut: "Q",
    icon: Quiz02Icon,
    active: "bg-review-question/20 text-review-question",
  },
] as const

/** RB/Composer mode: a note is blue, an open question is purple. */
export function ComposerModeToggle({
  value,
  onChange,
}: {
  value: "note" | "question"
  onChange: (value: "note" | "question") => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Kind of comment"
      className="flex gap-0.5 rounded-full bg-secondary p-0.5"
    >
      {modes.map((mode) => (
        <Tooltip key={mode.value}>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={value === mode.value}
                aria-label={mode.label}
                onClick={() => onChange(mode.value)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30",
                  value === mode.value && mode.active,
                  value === mode.value && "hover:text-current"
                )}
              />
            }
          >
            <HugeiconsIcon icon={mode.icon} size={18} />
          </TooltipTrigger>
          <TooltipContent>
            {mode.label} · {mode.shortcut}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
