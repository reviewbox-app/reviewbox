import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowReloadHorizontalIcon,
  HelpCircleIcon,
  MoreHorizontalIcon,
  Tick02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** Human decision on the current passage. Rev never validates. */
export function DecisionBar({
  validated,
  disabled,
  binding,
  onValidate,
  onReopen,
  onQuestion,
  onExamine,
}: {
  validated: boolean
  disabled: boolean
  /** "Bound to content a3f9c2 · lines 18–34." */
  binding: string
  onValidate: () => void
  onReopen: () => void
  onQuestion: () => void
  onExamine: () => void
}) {
  return (
    <div className="space-y-2.5 p-3">
      <div className="flex gap-2">
        {validated ? (
          <Button
            variant="secondary"
            size="lg"
            className="flex-1"
            disabled={disabled}
            onClick={onReopen}
          >
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} />
            Reopen passage
          </Button>
        ) : (
          <Button
            size="lg"
            className="flex-1"
            disabled={disabled}
            onClick={onValidate}
          >
            <HugeiconsIcon icon={Tick02Icon} />
            Validate passage
          </Button>
        )}
        <Button
          variant="secondary"
          size="lg"
          disabled={disabled}
          onClick={onQuestion}
        >
          <HugeiconsIcon icon={HelpCircleIcon} />
          Question
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="secondary"
                size="icon-lg"
                aria-label="More decisions"
                disabled={disabled}
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-56">
            <DropdownMenuItem onClick={onExamine}>
              <HugeiconsIcon icon={ViewIcon} size={16} />
              Mark as examined
            </DropdownMenuItem>
            {validated && (
              <DropdownMenuItem onClick={onReopen}>
                <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} />
                Reopen passage
                <DropdownMenuShortcut>V</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="flex items-start gap-2 px-1 text-xs leading-4 text-muted-foreground">
        <Kbd>V</Kbd>
        <span>{binding} It goes back to review if this passage changes.</span>
      </p>
    </div>
  )
}
