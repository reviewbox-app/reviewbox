import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  ArrowReloadHorizontalIcon,
  ComputerTerminal01Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ProviderStatus } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { harnessNames } from "../hooks/useRevStatus"

/** A harness Rev can run on. ReviewBox never shows the provider's credentials. */
export function HarnessCard({
  status,
  isDefault,
  executable,
  busy,
  onDetect,
}: {
  status: ProviderStatus
  isDefault: boolean
  executable?: string
  busy?: boolean
  onDetect: () => void
}) {
  const name = harnessNames[status.provider] ?? status.provider
  return (
    <article className="rounded-3xl border p-5">
      <header className="flex items-center gap-2.5">
        <HugeiconsIcon
          icon={
            status.provider === "codex" ? AiMagicIcon : ComputerTerminal01Icon
          }
          size={18}
        />
        <h3 className="font-medium">{name}</h3>
        {isDefault && <Badge variant="secondary">Default</Badge>}
        <span className="flex-1" />
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            className={cn(
              "size-2 rounded-full",
              status.available ? "bg-review-validated" : "bg-muted-foreground"
            )}
          />
          {status.available ? "Available" : "Not detected"}
        </span>
      </header>
      <dl className="mt-3 grid grid-cols-[112px_1fr] gap-x-4 gap-y-1.5 pl-7 text-xs">
        {status.version && (
          <>
            <dt className="text-muted-foreground">Runtime</dt>
            <dd>
              {name} {status.version}
              {executable ? ` · ${executable}` : ""}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Sign-in</dt>
        <dd>Handled by {name}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="text-muted-foreground">{status.message}</dd>
      </dl>
      <div className="mt-4 pl-7">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={onDetect}
        >
          <HugeiconsIcon icon={ArrowReloadHorizontalIcon} />
          Detect again
        </Button>
      </div>
    </article>
  )
}
