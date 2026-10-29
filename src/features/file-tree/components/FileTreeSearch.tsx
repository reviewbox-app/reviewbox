import { useEffect, useRef, type ReactNode } from "react"
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
  focusToken,
}: {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  children?: ReactNode
  focusToken?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusToken) {
      input.current?.focus()
      input.current?.select()
    }
  }, [focusToken])
  return (
    <div className="flex items-center gap-1">
      <InputGroup className="min-w-0 flex-1">
        <InputGroupAddon>
          <HugeiconsIcon icon={Search01Icon} size={14} />
        </InputGroupAddon>
        <InputGroupInput
          ref={input}
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
