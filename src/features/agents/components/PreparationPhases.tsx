import { Spinner } from "@/components/ui/spinner"
import { InlineMarkdown } from "@/features/markdown/components/InlineMarkdown"
import type { PreparationState } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import {
  Alert02Icon,
  DashedLineCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { ReviewPreparationView } from "../contracts/preparation.types"

type RowState = "done" | "busy" | "todo" | "failed"

const phases = [
  { phase: "context", title: "Preparing the captured context" },
  { phase: "outline", title: "Understanding the changes" },
  { phase: "documents", title: "Writing the reading path" },
  { phase: "checking", title: "Verifying and saving the review" },
] as const

const rowIcons = {
  done: { icon: Tick02Icon, size: 14 },
  failed: { icon: Alert02Icon, size: 14 },
  todo: {
    icon: DashedLineCircleIcon,
    size: 18,
    className: "text-muted-foreground",
  },
}

function phaseState({
  counts,
  working,
  complete,
  failed,
  index,
  currentIndex,
}: {
  counts: PreparationState["phases"][number] | undefined
  working: boolean
  complete: boolean
  failed: boolean
  index: number
  currentIndex: number
}): RowState {
  if (complete) return "done"
  if (counts) {
    if (counts.total > 0 && counts.completed === counts.total) return "done"
    if (!working) return "todo"
    return failed ? "failed" : "busy"
  }
  if (index < currentIndex) return "done"
  if (index === currentIndex) return failed ? "failed" : "busy"
  return "todo"
}

function PhaseRow({
  state,
  title,
  detail,
}: {
  state: RowState
  title: string
  detail?: string
}) {
  return (
    <li className="flex min-w-0 items-start gap-3 py-2.5">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full",
          state === "done" && "bg-review-validated-soft text-review-validated",
          state === "failed" && "bg-destructive/10 text-destructive"
        )}
      >
        {state === "busy" ? (
          <Spinner className="size-4" />
        ) : (
          <HugeiconsIcon {...rowIcons[state]} />
        )}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p
          className={cn(
            "text-sm font-medium",
            state === "todo" && "text-muted-foreground"
          )}
        >
          <InlineMarkdown>{title}</InlineMarkdown>
        </p>
        {detail && (
          <p className="mt-0.5 text-xs leading-4 wrap-anywhere text-muted-foreground">
            {detail}
          </p>
        )}
      </div>
    </li>
  )
}

export function PreparationPhases({
  preparation,
  complete = false,
  failed = false,
}: {
  preparation: Pick<ReviewPreparationView, "state" | "status">
  complete?: boolean
  failed?: boolean
}) {
  const { state, status } = preparation
  const currentIndex = state
    ? phases.findIndex(({ phase }) => phase === state.phase)
    : 0
  return (
    <ol className="divide-y rounded-3xl border px-4" aria-label="Rev’s work">
      {phases.map(({ phase, title }, index) => {
        const counts = state?.phases?.find((item) => item.phase === phase)
        const working = !!state?.activeBatches?.some(
          (item) => item.phase === phase
        )
        const rowState = phaseState({
          counts,
          working,
          complete,
          failed,
          index,
          currentIndex,
        })
        let detail = index === currentIndex ? status : undefined
        if (counts)
          detail = `${counts.completed} of ${counts.total} results ready`
        return (
          <PhaseRow
            key={phase}
            title={title}
            state={rowState}
            detail={detail}
          />
        )
      })}
    </ol>
  )
}
