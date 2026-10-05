import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon } from "@hugeicons/core-free-icons"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"

export function FileTreeSearch({
  value,
  onChange,
  label = "Filter files",
  placeholder = "Search files…",
  children,
}: {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  children?: ReactNode
}) {
  return (
    <div className="flex items-center gap-1">
      <InputGroup className="min-w-0 flex-1">
        <InputGroupAddon>
          <HugeiconsIcon icon={Search01Icon} size={14} />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={label}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onChange("")
          }}
        />
      </InputGroup>
      {children}
    </div>
  )
}
