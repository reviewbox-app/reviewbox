"use client"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { LicenseIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

export function MarkdownPreviewToggle({
  active,
  disabled,
  onToggle,
}: {
  active: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Markdown preview"
              aria-pressed={active}
              data-active={active}
              className="data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
              disabled={disabled}
              onClick={onToggle}
            />
          }
        >
          <HugeiconsIcon icon={LicenseIcon} size={16} />
        </TooltipTrigger>
        <TooltipContent>
          {active ? "Show source code" : "Show Markdown preview"}
        </TooltipContent>
      </Tooltip>
      <Separator
        orientation="vertical"
        className="h-6 data-vertical:self-auto"
      />
    </>
  )
}
