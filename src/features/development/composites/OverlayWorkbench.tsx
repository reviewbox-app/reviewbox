"use client"

import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import { ReviewMarkdown } from "@/features/markdown/components/ReviewMarkdown"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Toaster, toast } from "@/components/ui/toast"

const rows = Array.from({ length: 60 }, (_, index) => `Passage ${index + 1}`)
const scrollable = "max-h-64 overflow-y-auto"

/** Recreate parent props as native polling does, without changing the document. */
function LiveReviewDocument() {
  const [revision, setRevision] = useState(0)
  const [openedSource, setOpenedSource] = useState("")
  useEffect(() => {
    const timer = setInterval(() => setRevision((value) => value + 1), 800)
    return () => clearInterval(timer)
  }, [])
  return (
    <section className="mt-8" data-testid="live-review-document">
      <p role="status" data-testid="document-refresh-count">
        {revision}
      </p>
      <output data-testid="opened-source">{openedSource}</output>
      <ReviewMarkdown
        onOpenReference={(reference) =>
          setOpenedSource(
            `${reference.sourceId}:${reference.startLine}-${reference.endLine}`
          )
        }
        reviewId="fixture"
        snapshotId="snapshot"
        level="essential"
        files={[]}
        glossary={[
          {
            id: "snapshot",
            term: "Snapshot",
            definition: "A frozen copy of the reviewed changes.",
            context: `Definition context at update ${revision}.`,
          },
        ]}
        document={{
          body: "[Snapshot](reviewbox:term/snapshot) and [Captured behavior](reviewbox:ref/behavior).\n\n```summary\n[Embedded definition](reviewbox:term/snapshot).\n```",
          readingSeconds: 10,
          termAliases: {},
          terms: [],
          references: [
            {
              id: "behavior",
              label: "Captured behavior",
              explanation:
                "A reference keeps its dialog open while progress updates.",
              sourceId: "file:fixture.ts",
              startLine: 1,
              endLine: 1,
            },
          ],
        }}
      />
    </section>
  )
}

function ReadingContent() {
  return rows.map((row) => (
    <p key={row} className="py-2">
      {row}: the surface stays blurred while this text scrolls.
    </p>
  ))
}

function ModelOptions() {
  return (
    <Combobox items={rows}>
      <ComboboxInput aria-label="Find a passage" />
      <ComboboxContent>
        <ComboboxList>
          {(row: string) => (
            <ComboboxItem key={row} value={row}>
              {row}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

/** Real shared primitives, excluded from normal exports by the .dev.tsx route. */
export function OverlayWorkbench() {
  const { setTheme } = useTheme()
  return (
    <main className="min-h-screen p-12">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[repeating-linear-gradient(90deg,var(--background)_0px,var(--background)_8px,var(--primary)_8px,var(--primary)_16px)]"
      />
      <h1 className="mb-4 text-xl">Overlay scroll validation</h1>
      <LiveReviewDocument />
      <div className="mb-4 flex gap-2">
        <Button onClick={() => setTheme("light")}>Light</Button>
        <Button onClick={() => setTheme("dark")}>Dark</Button>
      </div>
      <div
        data-testid="overlay-triggers"
        className="relative max-h-48 overflow-auto rounded-xl border bg-background/80 p-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Dialog>
            <DialogTrigger render={<Button />}>Dialog</DialogTrigger>
            <DialogContent className={scrollable}>
              <DialogTitle>Scrollable dialog</DialogTitle>
              <DialogDescription>
                Nested controls remain usable.
              </DialogDescription>
              <ModelOptions />
              <Popover>
                <PopoverTrigger render={<Button />}>
                  Nested popover
                </PopoverTrigger>
                <PopoverContent className={scrollable}>
                  <PopoverTitle>Nested reading</PopoverTitle>
                  <ReadingContent />
                </PopoverContent>
              </Popover>
              <ReadingContent />
            </DialogContent>
          </Dialog>
          <AlertDialog>
            <AlertDialogTrigger render={<Button />}>
              Alert dialog
            </AlertDialogTrigger>
            <AlertDialogContent className={scrollable}>
              <AlertDialogTitle>Scrollable alert</AlertDialogTitle>
              <AlertDialogDescription>
                Long confirmation content.
              </AlertDialogDescription>
              <ReadingContent />
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogContent>
          </AlertDialog>
          <Sheet>
            <SheetTrigger render={<Button />}>Sheet</SheetTrigger>
            <SheetContent className="overflow-y-auto p-6">
              <SheetTitle>Scrollable sheet</SheetTitle>
              <SheetDescription>
                Reading content in a side panel.
              </SheetDescription>
              <ReadingContent />
            </SheetContent>
          </Sheet>
          <Popover>
            <PopoverTrigger render={<Button />}>Popover</PopoverTrigger>
            <PopoverContent className={scrollable}>
              <PopoverTitle>Scrollable popover</PopoverTitle>
              <ReadingContent />
            </PopoverContent>
          </Popover>
          <HoverCard>
            <HoverCardTrigger render={<Button />}>Hover card</HoverCardTrigger>
            <HoverCardContent className={scrollable}>
              <ReadingContent />
            </HoverCardContent>
          </HoverCard>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button />}>
              Dropdown
            </DropdownMenuTrigger>
            <DropdownMenuContent className={scrollable}>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>More passages</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={scrollable}>
                  {rows.map((row) => (
                    <DropdownMenuItem key={row}>{row}</DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {rows.map((row) => (
                <DropdownMenuItem key={row}>{row}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ContextMenu>
            <ContextMenuTrigger render={<Button />}>
              Context menu
            </ContextMenuTrigger>
            <ContextMenuContent className={scrollable}>
              <ContextMenuSub>
                <ContextMenuSubTrigger>More context</ContextMenuSubTrigger>
                <ContextMenuSubContent className={scrollable}>
                  {rows.map((row) => (
                    <ContextMenuItem key={row}>{row}</ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
              {rows.map((row) => (
                <ContextMenuItem key={row}>{row}</ContextMenuItem>
              ))}
            </ContextMenuContent>
          </ContextMenu>
          <Menubar>
            <MenubarMenu>
              <MenubarTrigger>Menubar</MenubarTrigger>
              <MenubarContent className={scrollable}>
                <MenubarSub>
                  <MenubarSubTrigger>More menu items</MenubarSubTrigger>
                  <MenubarSubContent className={scrollable}>
                    {rows.map((row) => (
                      <MenubarItem key={row}>{row}</MenubarItem>
                    ))}
                  </MenubarSubContent>
                </MenubarSub>
                {rows.map((row) => (
                  <MenubarItem key={row}>{row}</MenubarItem>
                ))}
              </MenubarContent>
            </MenubarMenu>
          </Menubar>
          <Select defaultValue={rows[0]}>
            <SelectTrigger aria-label="Select passage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={scrollable} alignItemWithTrigger={false}>
              {rows.map((row) => (
                <SelectItem key={row} value={row}>
                  {row}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ModelOptions />
          <Drawer>
            <DrawerTrigger render={<Button />}>Drawer</DrawerTrigger>
            <DrawerContent>
              <div className="max-h-64 overflow-y-auto p-6">
                <DrawerTitle>Scrollable drawer</DrawerTitle>
                <DrawerDescription>
                  The full-window backdrop stays fixed.
                </DrawerDescription>
                <ReadingContent />
              </div>
            </DrawerContent>
          </Drawer>
          <Button
            onClick={() =>
              toast.add({
                title: "Overlay notification",
                description: "The background stays blurred.",
                timeout: 0,
              })
            }
          >
            Toast
          </Button>
        </div>
        <div aria-hidden className="h-96" />
      </div>
      <Toaster />
    </main>
  )
}
