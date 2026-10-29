"use client"
import "@xterm/xterm/css/xterm.css"
import "../terminal.css"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core"
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
  RefreshIcon,
  CommandLineIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from "@/components/ui/empty"
import { TerminalTab } from "../components/TerminalTab"
import {
  useTerminalStore,
  selectTerminal,
  renameTerminal,
  reorderTerminals,
} from "../services/terminal.store"
import {
  closeTerminal,
  createTerminal,
  terminalRuntime,
  refreshTerminalThemes,
  initializeTerminals,
} from "../services/terminal.runtime"
import { desktopAvailable } from "@/lib/desktop/review.commands"

// Runtime availability is constant, but hydration must match the static export.
const subscribeToDesktop = () => () => {}
const serverDesktopAvailable = () => false

/** Mounted with the application: hiding a section never disposes its shell or parser. */
export function TerminalWorkspace({
  repositoryId,
  visible,
}: {
  repositoryId?: string
  visible: boolean
}) {
  const desktop = useSyncExternalStore(
    subscribeToDesktop,
    desktopAvailable,
    serverDesktopAvailable
  )
  const tabs = useTerminalStore((s) => s.tabs)
  const activeByRepository = useTerminalStore((s) => s.active)
  const creating = useTerminalStore((s) => s.creating)
  const error = useTerminalStore((s) => s.error)
  const active = repositoryId ? activeByRepository[repositoryId] : undefined
  const current = tabs.find((t) => t.id === active)
  const projectTabs = tabs.filter((t) => t.repositoryId === repositoryId)
  const viewport = useRef<HTMLDivElement>(null)
  const newViewport = useRef<HTMLDivElement>(null)
  const tabsViewport = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const visited = useRef(new Set<string>())
  const [find, setFind] = useState(false)
  const [query, setQuery] = useState("")
  const [closing, setClosing] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState("")
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const create = () => {
    if (repositoryId && newViewport.current)
      void createTerminal(repositoryId, newViewport.current)
  }
  const requestClose = (id: string) => {
    if (tabs.find((t) => t.id === id)?.exited) void closeTerminal(id)
    else setClosing(id)
  }
  useEffect(() => {
    if (desktopAvailable()) void initializeTerminals().catch(() => {})
  }, [])
  useEffect(() => {
    if (
      !visible ||
      !repositoryId ||
      !newViewport.current ||
      visited.current.has(repositoryId) ||
      !desktopAvailable()
    )
      return
    visited.current.add(repositoryId)
    if (
      !useTerminalStore
        .getState()
        .tabs.some((t) => t.repositoryId === repositoryId)
    )
      void createTerminal(repositoryId, newViewport.current)
  }, [visible, repositoryId])
  useEffect(() => {
    const runtime = active ? terminalRuntime(active) : undefined
    const container = viewport.current
    if (!runtime || !container || !visible) return
    container.replaceChildren(runtime.element)
    runtime.resize()
    runtime.terminal.focus()
    const observer = new ResizeObserver(() => runtime.resize())
    observer.observe(container)
    return () => observer.disconnect()
  }, [active, visible, tabs.length])
  useEffect(() => {
    const observer = new MutationObserver(refreshTerminalThemes)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const container = tabsViewport.current
    if (!container) return
    const wheel = (event: WheelEvent) => {
      if (
        Math.abs(event.deltaY) > Math.abs(event.deltaX) &&
        container.scrollWidth > container.clientWidth
      ) {
        event.preventDefault()
        container.scrollLeft += event.deltaY
      }
    }
    container.addEventListener("wheel", wheel, { passive: false })
    return () => container.removeEventListener("wheel", wheel)
  }, [])
  useEffect(() => {
    if (!visible) return
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector("[role=dialog]")) return
      const runtime = active ? terminalRuntime(active) : undefined
      if (
        (event.metaKey && event.key === "f") ||
        (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f")
      ) {
        event.preventDefault()
        event.stopPropagation()
        setFind(true)
        requestAnimationFrame(() => searchInput.current?.focus())
      }
      if (
        ((event.metaKey && !event.ctrlKey) ||
          (event.ctrlKey && event.shiftKey)) &&
        event.key.toLowerCase() === "c" &&
        runtime?.terminal.hasSelection()
      ) {
        event.preventDefault()
        event.stopPropagation()
        void navigator.clipboard
          .writeText(runtime.terminal.getSelection())
          .catch(() =>
            useTerminalStore.setState({
              error: "Could not copy the selection.",
            })
          )
      }
      if (event.metaKey && event.key === "w" && active) {
        event.preventDefault()
        setClosing(active)
      }
    }
    window.addEventListener("keydown", handler, true)
    return () => window.removeEventListener("keydown", handler, true)
  }, [active, visible])
  const search = (previous = false) => {
    const runtime = active ? terminalRuntime(active) : undefined
    if (previous) runtime?.search.findPrevious(query)
    else runtime?.search.findNext(query)
  }
  return (
    <section
      aria-label="Terminal workspace"
      className={
        visible
          ? "relative mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card"
          : "hidden"
      }
    >
      <div className="flex shrink-0 items-center gap-1 border-b p-1.5">
        <div ref={tabsViewport} className="min-w-0 flex-1 overflow-x-auto">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active: dragging, over }) => {
              if (over) reorderTerminals(String(dragging.id), String(over.id))
            }}
          >
            <SortableContext
              items={projectTabs.map((t) => t.id)}
              strategy={horizontalListSortingStrategy}
            >
              <div
                role="tablist"
                aria-label="Terminals"
                className="flex w-max gap-1"
              >
                {projectTabs.map((tab) => (
                  <TerminalTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === active}
                    onSelect={() => selectTerminal(tab.repositoryId, tab.id)}
                    onClose={() => requestClose(tab.id)}
                    onRename={() => {
                      setRenaming(tab.id)
                      setName(tab.title)
                    }}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New terminal"
          disabled={creating || !desktop}
          onClick={create}
        >
          <HugeiconsIcon icon={Add01Icon} size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Find in terminal"
          disabled={!active}
          onClick={() => {
            setFind(!find)
            requestAnimationFrame(() => searchInput.current?.focus())
          }}
        >
          <HugeiconsIcon icon={Search01Icon} size={16} />
        </Button>
      </div>
      {find && (
        <div className="flex items-center gap-1 border-b p-1.5">
          <Input
            ref={searchInput}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              if (active)
                terminalRuntime(active)?.search.findNext(event.target.value, {
                  incremental: true,
                })
            }}
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            className="h-7 max-w-xs text-xs"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                search(event.shiftKey)
              }
              if (event.key === "Escape") {
                setFind(false)
                if (active) terminalRuntime(active)?.terminal.focus()
              }
            }}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous match"
            onClick={() => search(true)}
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next match"
            onClick={() => search()}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close terminal search"
            onClick={() => setFind(false)}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} />
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="flex-1">{error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss terminal error"
            onClick={() => useTerminalStore.setState({ error: "" })}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} />
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={viewport}
          id={active ? `terminal-${active}` : undefined}
          role="tabpanel"
          aria-label={current?.title ?? "Terminal"}
          className={`h-full min-h-0 p-2 ${!active ? "hidden" : ""}`}
        />
        <div
          ref={newViewport}
          className={`absolute inset-0 p-2 ${creating ? "" : "pointer-events-none invisible"}`}
        />
        {!active && !creating && (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={CommandLineIcon} />
              </EmptyMedia>
              <EmptyTitle>Open a terminal</EmptyTitle>
              <EmptyDescription>
                {desktop
                  ? "Run commands in this project's shell."
                  : "Terminals are available in the desktop app."}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={create} disabled={!desktop}>
                New terminal
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </div>
      {current?.exited && (
        <div className="flex items-center justify-between border-t px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            Process exited
            {current.exitCode !== null ? ` with code ${current.exitCode}` : ""}.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (current) void closeTerminal(current.id).then(create)
            }}
          >
            <HugeiconsIcon icon={RefreshIcon} size={14} />
            Relaunch
          </Button>
        </div>
      )}
      <Dialog
        open={!!closing}
        onOpenChange={(value) => {
          if (!value) setClosing(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close terminal?</DialogTitle>
            <DialogDescription>
              Running commands in this terminal will stop.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const id = closing
                setClosing(null)
                if (id) void closeTerminal(id)
              }}
            >
              Close terminal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!renaming}
        onOpenChange={(value) => {
          if (!value) setRenaming(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename terminal</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (renaming) renameTerminal(renaming, name)
              setRenaming(null)
            }}
          >
            <Input
              autoFocus
              aria-label="Terminal name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
            <DialogFooter className="mt-4">
              <Button type="submit">Rename</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
