import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  MoreHorizontalIcon,
  Tick02Icon,
  Download01Icon,
  ViewIcon,
  AiMagicIcon,
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

/** Floating footer of the review: step navigation around the human decision. */
export function DecisionBar({
  unitLabel = "step",
  validated,
  disabled,
  label,
  binding,
  canPrevious,
  canNext,
  onValidate,
  onReopen,
  onExport,
  onExamine,
  onPrepare,
  onPrevious,
  onNext,
}: {
  unitLabel?: "step" | "file"
  validated: boolean
  disabled: boolean
  /** Describes the validation and its automatic navigation. */
  label: string
  /** "Bound to content a3f9c2 · lines 18–34." */
  binding: string
  canPrevious: boolean
  canNext: boolean
  onValidate: () => void
  onReopen: () => void
  onExport: () => void
  onExamine: () => void
  onPrepare?: () => void
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <div className="grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3">
      <div>
        <Button
          variant="ghost"
          disabled={!canPrevious}
          onClick={onPrevious}
          aria-label={`Previous ${unitLabel}`}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} />
          <span className="max-[900px]:hidden">Previous {unitLabel}</span>
        </Button>
      </div>
      <div className="flex items-center gap-2" title={binding}>
        <Kbd className="max-[900px]:hidden">V</Kbd>
        {validated ? (
          <Button
            variant="secondary"
            size="lg"
            disabled={disabled}
            onClick={(event) => {
              if (event.detail < 2) onReopen()
            }}
            onKeyDown={(event) => {
              if (event.repeat) event.preventDefault()
            }}
            aria-keyshortcuts="V"
          >
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} />
            {`Reopen ${unitLabel}`}
          </Button>
        ) : (
          <Button
            size="lg"
            disabled={disabled}
            onClick={(event) => {
              if (event.detail < 2) onValidate()
            }}
            onKeyDown={(event) => {
              if (event.repeat) event.preventDefault()
            }}
            aria-keyshortcuts="V"
          >
            <HugeiconsIcon icon={Tick02Icon} />
            {label}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="secondary"
                size="icon-lg"
                aria-label="More decisions"
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top" className="w-56">
            {onPrepare && (
              <DropdownMenuItem onClick={onPrepare}>
                <HugeiconsIcon icon={AiMagicIcon} size={16} />
                Prepare with Rev
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onExamine}>
              <HugeiconsIcon icon={ViewIcon} size={16} />
              Mark as examined
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExport}>
              <HugeiconsIcon icon={Download01Icon} size={16} />
              Export Markdown
            </DropdownMenuItem>
            {validated && (
              <DropdownMenuItem
                onClick={(event) => {
                  if (event.detail < 2) onReopen()
                }}
                onKeyDown={(event) => {
                  if (event.repeat) event.preventDefault()
                }}
              >
                <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} />
                Reopen
                <DropdownMenuShortcut>V</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex justify-end">
        <Button
          variant="ghost"
          disabled={!canNext}
          onClick={onNext}
          aria-label={`Next ${unitLabel}`}
        >
          <span className="max-[900px]:hidden">Next {unitLabel}</span>
          <HugeiconsIcon icon={ArrowRight01Icon} />
        </Button>
      </div>
    </div>
  )
}
