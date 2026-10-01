import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import * as React from "react"

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-2xl border text-left has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] *:[svg]:row-span-2 *:[svg]:text-current",
  {
    variants: {
      size: {
        default:
          "px-4 py-3 text-sm has-[>svg]:gap-x-2.5 *:[svg]:translate-y-0.5 *:[svg:not([class*='size-'])]:size-4",
        sm: "rounded-xl px-3 py-2 text-xs has-[>svg]:gap-x-2 *:[svg]:translate-y-px *:[svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default: "bg-card text-card-foreground",
        faded: "bg-input text-card-foreground",
        destructive:
          "border-destructive/10 bg-destructive/5 text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-size={size}
      role="alert"
      className={cn(alertVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground group-data-[size=sm]/alert:text-xs md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4 group-data-[size=sm]/alert:[&_p:not(:last-child)]:mb-2",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        "absolute top-2.5 right-3 group-data-[size=sm]/alert:top-2 group-data-[size=sm]/alert:right-2.5",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertAction, AlertDescription, AlertTitle }
