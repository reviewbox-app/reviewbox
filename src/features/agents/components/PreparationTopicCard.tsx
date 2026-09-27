import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  Alert02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Snapshot } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import type { PreparedTopic, TopicChoice } from "../contracts/preparation.types"
import { anchorLabel } from "../helpers/preparation.helpers"

export function PreparationTopicCard({
  item,
  snapshot,
  disabled,
  onChoose,
  onEdit,
}: {
  item: PreparedTopic
  snapshot: Snapshot
  disabled: boolean
  onChoose: (choice: TopicChoice) => void
  onEdit: () => void
}) {
  const { topic, choice, diagnostics } = item
  return (
    <article
      data-topic-id={topic.id}
      className={cn(
        "space-y-2.5 rounded-3xl border px-4 py-3.5",
        choice === "accepted" && "bg-muted",
        choice === "rejected" && "opacity-60"
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-2.5">
        <HugeiconsIcon
          icon={AiMagicIcon}
          size={16}
          className="shrink-0 text-muted-foreground"
        />
        <h2
          className={cn(
            "min-w-0 flex-1 text-base font-medium wrap-anywhere",
            choice === "rejected" && "line-through"
          )}
        >
          {topic.title}
        </h2>
        <Badge variant="secondary">
          {topic.steps.length} {topic.steps.length === 1 ? "step" : "steps"}
        </Badge>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {choice !== "pending" ? (
            <>
              <Badge variant="secondary">
                {choice === "accepted" && <HugeiconsIcon icon={Tick02Icon} />}{" "}
                {choice === "accepted" ? "Accepted" : "Rejected"}
              </Badge>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChoose("pending")}
              >
                Undo
              </Button>
            </>
          ) : (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChoose("rejected")}
              >
                Reject
              </Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={disabled}
                onClick={onEdit}
              >
                Edit
              </Button>
              <Button
                size="xs"
                disabled={disabled || diagnostics.length > 0}
                onClick={() => onChoose("accepted")}
              >
                <HugeiconsIcon icon={Tick02Icon} />
                Accept
              </Button>
            </>
          )}
        </div>
      </header>
      <p className="pl-6.5 text-sm leading-5 wrap-anywhere whitespace-pre-wrap text-muted-foreground">
        {topic.brief}
      </p>
      {choice === "pending" && (
        <>
          <ol className="space-y-0.5 pl-6.5">
            {topic.steps.map((step, index) => {
              const issues = diagnostics.filter(
                (item) => item.stepIndex === index
              )
              return (
                <li
                  key={step.id}
                  className={cn(
                    "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl px-2 py-1.5",
                    issues.length > 0 && "bg-review-attention-soft"
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-sm wrap-anywhere">
                    {step.title}
                  </span>
                  <span
                    className={cn(
                      "max-w-full font-mono text-xs wrap-anywhere text-muted-foreground",
                      issues.length > 0 && "text-review-attention"
                    )}
                  >
                    {step.anchors
                      .map((anchor) => anchorLabel(snapshot, anchor))
                      .join(" · ") || "Missing anchor"}
                  </span>
                  {issues.length > 0 && (
                    <Button size="xs" variant="secondary" onClick={onEdit}>
                      Fix anchor
                    </Button>
                  )}
                </li>
              )
            })}
          </ol>
          {diagnostics.length > 0 && (
            <div
              className="flex gap-2 pl-6.5 text-xs text-review-attention"
              role="status"
            >
              <HugeiconsIcon
                icon={Alert02Icon}
                size={14}
                className="shrink-0"
              />
              <p>
                {diagnostics.length}{" "}
                {diagnostics.length === 1 ? "anchor needs" : "anchors need"}{" "}
                attention. This topic cannot be added until corrected.
              </p>
            </div>
          )}
        </>
      )}
    </article>
  )
}
