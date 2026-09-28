"use client"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  BookOpen01Icon,
  Clock01Icon,
  CodeIcon,
  Folder01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { useReviewWorkspaceStore } from "@/features/review/stores/useReviewWorkspace.store"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import type { Workspace } from "@/lib/desktop/contracts.generated"

export interface PaletteActions {
  step: (direction: number) => void
  /** Switches the review between the document and the code. */
  view: () => void
  openChange: (changeId: string) => void
  space: (space: "understand" | "review" | "resume") => void
  newReview: () => void
  openRepository: () => void
  settings: () => void
}

/** ⌘K: reading actions with their shortcuts, plus the review files. */
export function CommandPalette({
  open,
  onOpenChange,
  workspace,
  actions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: Workspace | null
  actions: PaletteActions
}) {
  const level = useReviewWorkspaceStore((state) => state.readerLevel)
  const run = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Run a reading action or open a review file."
      className="sm:max-w-xl"
    >
      <Command className="bg-transparent">
        <CommandInput placeholder="Search actions and files…" />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {workspace && (
            <CommandGroup heading="Tour">
              <CommandItem onSelect={run(() => actions.step(1))}>
                <HugeiconsIcon icon={ArrowDown01Icon} />
                Next step
                <CommandShortcut>J</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={run(() => actions.step(-1))}>
                <HugeiconsIcon icon={ArrowUp01Icon} />
                Previous step
                <CommandShortcut>K</CommandShortcut>
              </CommandItem>
              {level !== "beginner" && (
                <CommandItem onSelect={run(actions.view)}>
                  <HugeiconsIcon icon={CodeIcon} />
                  Switch document / code
                  <CommandShortcut>D</CommandShortcut>
                </CommandItem>
              )}
            </CommandGroup>
          )}
          {workspace && level !== "beginner" && (
            <CommandGroup heading="Go to">
              {workspace.review.files.map((change) => (
                <CommandItem
                  key={change.id}
                  value={change.path}
                  onSelect={run(() => actions.openChange(change.changeIds[0]))}
                >
                  <FileIcon path={change.path} />
                  <span className="truncate">
                    {change.path.split("/").at(-1)}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {change.path.split("/").slice(0, -1).join("/")}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="ReviewBox">
            {workspace && (
              <>
                <CommandItem onSelect={run(() => actions.space("resume"))}>
                  <HugeiconsIcon icon={Clock01Icon} />
                  Home
                  <CommandShortcut>⌘1</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={run(() => actions.space("understand"))}>
                  <HugeiconsIcon icon={BookOpen01Icon} />
                  Code Explain
                  <CommandShortcut>⌘3</CommandShortcut>
                </CommandItem>
              </>
            )}
            <CommandItem onSelect={run(actions.newReview)}>
              <HugeiconsIcon icon={Add01Icon} />
              New review
              <CommandShortcut>⌘N</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(actions.openRepository)}>
              <HugeiconsIcon icon={Folder01Icon} />
              Open repository…
              <CommandShortcut>⌘O</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(actions.settings)}>
              <HugeiconsIcon icon={Settings01Icon} />
              Settings
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
