import { cn } from "@/lib/utils"

/** One setting: label and help on the left, control on the right. */
export function SettingRow({
  title,
  description,
  children,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-6 border-b py-4 last:border-b-0",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {description && (
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  )
}
