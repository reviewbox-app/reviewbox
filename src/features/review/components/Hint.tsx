import type { ComponentProps, ReactElement } from "react"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Tooltip for a toolbar control; the child stays the rendered element. */
export function Hint({
  label,
  shortcut,
  side = "bottom",
  disableHoverablePopup = false,
  children,
}: {
  label: string
  shortcut?: string
  side?: ComponentProps<typeof TooltipContent>["side"]
  disableHoverablePopup?: boolean
  children: ReactElement
}) {
  return (
    <Tooltip disableHoverablePopup={disableHoverablePopup}>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
