"use client"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  AiMagicIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  BookOpen01Icon,
  Clock01Icon,
  DashedLine01Icon,
  File01Icon,
  Folder01Icon,
  NoteEditIcon,
  Quiz02Icon,
  Settings01Icon,
  Tick02Icon,
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
import type { Workspace } from "@/lib/desktop/contracts.generated"

export interface PaletteActions {
  step: (direction: number) => void
  validate: () => void
  comment: (kind: "note" | "question") => void
  openChange: (changeId: string) => void
  space: (space: "understand" | "review" | "resume") => void
  coverage: () => void
  askRev: () => void
  newReview: () => void
  openRepository: () => void
  settings: () => void
}

/** ⌘K: every reading action with its shortcut, plus files of the frozen snapshot. */
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
  const run = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Run a reading action or open a file of the snapshot."
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
              <CommandItem onSelect={run(actions.validate)}>
                <HugeiconsIcon icon={Tick02Icon} />
                Validate passage
                <CommandShortcut>V</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={run(() => actions.comment("question"))}>
                <HugeiconsIcon icon={Quiz02Icon} />
                Ask a question
                <CommandShortcut>Q</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={run(() => actions.comment("note"))}>
                <HugeiconsIcon icon={NoteEditIcon} />
                Add a note
                <CommandShortcut>N</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={run(actions.coverage)}>
                <HugeiconsIcon icon={DashedLine01Icon} />
                Coverage and changes outside the tour
              </CommandItem>
            </CommandGroup>
          )}
          {workspace && (
            <CommandGroup heading="Go to">
              {workspace.snapshot.changes.map((change) => (
                <CommandItem
                  key={change.id}
                  value={change.path}
                  onSelect={run(() => actions.openChange(change.id))}
                >
                  <HugeiconsIcon icon={File01Icon} />
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
          <CommandGroup heading="Review & agent">
            {workspace && (
              <>
                <CommandItem onSelect={run(actions.askRev)}>
                  <HugeiconsIcon icon={AiMagicIcon} />
                  Ask Rev about this passage
                  <CommandShortcut>⌘L</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={run(() => actions.space("understand"))}>
                  <HugeiconsIcon icon={BookOpen01Icon} />
                  Understand
                  <CommandShortcut>⌘1</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={run(() => actions.space("resume"))}>
                  <HugeiconsIcon icon={Clock01Icon} />
                  Resume
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
