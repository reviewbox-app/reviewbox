"use client"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  ArrowReloadHorizontalIcon,
  ComputerTerminal01Icon,
  Download04Icon,
  FolderOpenIcon,
  InformationCircleIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import type { ProviderStatus } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { harnessNames } from "../hooks/useRevStatus"

/** Compact overview; advanced configuration lives in the options menu. */
export function HarnessCard({
  status,
  isDefault,
  busy,
  checking,
  onDetails,
  onUpdate,
  onDetect,
  onChooseExecutable,
}: {
  status: ProviderStatus
  isDefault: boolean
  busy: boolean
  checking: boolean
  onDetails: () => void
  onUpdate: () => void
  onDetect: () => void
  onChooseExecutable: () => void
}) {
  const name = harnessNames[status.provider] ?? status.provider
  const outdated = status.available && status.compatibility === "outdated"
  const label = outdated
    ? "Outdated"
    : status.ready
      ? "Connected"
      : !status.available
        ? "Not detected"
        : status.compatibility === "unknown"
          ? "Unknown version"
          : status.authentication === "signedOut"
            ? "Sign in required"
            : "Verification failed"
  return (
    <article
      aria-label={`${name} harness`}
      className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2 rounded-3xl border px-4 py-3"
    >
      <HugeiconsIcon
        icon={
          status.provider === "codex" ? AiMagicIcon : ComputerTerminal01Icon
        }
        size={18}
        className="shrink-0"
      />
      <h3 className="text-base font-medium">{name}</h3>
      {isDefault && <Badge variant="secondary">Default</Badge>}
      <span
        role="status"
        className={cn(
          "ml-auto flex items-center gap-2 text-sm text-muted-foreground",
          outdated && "text-review-attention"
        )}
      >
        {checking ? (
          <Spinner className="size-3" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full",
              outdated
                ? "bg-review-attention"
                : status.ready
                  ? "bg-review-validated"
                  : "bg-muted-foreground"
            )}
          />
        )}
        {checking ? "Checking…" : label}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${name} options`}
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onClick={onDetails}>
            <HugeiconsIcon icon={InformationCircleIcon} size={16} aria-hidden />
            Details
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy || checking || !status.available}
            onClick={onUpdate}
          >
            <HugeiconsIcon icon={Download04Icon} size={16} aria-hidden />
            Check updates
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy || checking} onClick={onDetect}>
            <HugeiconsIcon
              icon={ArrowReloadHorizontalIcon}
              size={16}
              aria-hidden
            />
            Redetect
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onClick={onChooseExecutable}>
            <HugeiconsIcon icon={FolderOpenIcon} size={16} aria-hidden />
            Choose another exec
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  )
}
