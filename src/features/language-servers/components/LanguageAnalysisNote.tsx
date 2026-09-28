"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { InformationCircleIcon } from "@hugeicons/core-free-icons"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export function LanguageAnalysisNote({ note }: { note: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Code intelligence: ${note}`}
        className="pointer-events-auto m-2 flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <HugeiconsIcon
          icon={InformationCircleIcon}
          aria-hidden
          className="size-3.5"
        />
      </TooltipTrigger>
      <TooltipContent>{note}</TooltipContent>
    </Tooltip>
  )
}
