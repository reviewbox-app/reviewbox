import { cn } from "@/lib/utils"
export function ReviewStatus({ status }: { status: string }) {
  return (
    <span
      role="img"
      aria-label={status}
      title={status}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
        status === "Validated" &&
          "border-transparent bg-review-validated text-background",
        status === "Question" &&
          "border-transparent bg-review-question text-background",
        status === "Re-review" &&
          "border-review-attention text-review-attention",
        status === "In progress" && "border-primary text-primary",
        status === "Unread" && "border-muted-foreground text-muted-foreground"
      )}
    >
      {status === "Validated"
        ? "✓"
        : status === "Question"
          ? "?"
          : status === "Re-review"
            ? "!"
            : status === "In progress"
              ? "•"
              : ""}
    </span>
  )
}
