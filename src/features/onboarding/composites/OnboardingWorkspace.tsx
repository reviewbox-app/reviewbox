"use client"
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CodeIcon,
  Download01Icon,
  Route01Icon,
  Tick02Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import { languageFor } from "@/features/review/helpers/review.helpers"
import { errorMessage } from "@/lib/desktop/review.commands"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import { cn } from "@/lib/utils"
import type {
  OnboardingTour,
  OnboardingStep,
  CurrentTourStep,
  TourImportReport,
} from "@/lib/desktop/contracts.generated"
import { onboardingCommands } from "../services/onboarding.commands"
export function OnboardingWorkspace({
  repositoryId,
  nav,
  onClose,
}: {
  repositoryId: string
  /** Navigation of the owning space, shown above the tour list. */
  nav?: React.ReactNode
  onClose: () => void
}) {
  const [tours, setTours] = useState<OnboardingTour[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [reading, setReading] = useState<{
    id: string
    value: CurrentTourStep
  } | null>(null)
  const [report, setReport] = useState<TourImportReport | null>(null)
  const [editing, setEditing] = useState<OnboardingStep | null>(null)
  const [newTitle, setNewTitle] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const tour = tours.find((t) => t.id === selected)
  const step = tour?.steps[index]
  const current = reading?.id === step?.id ? reading?.value : null
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    let alive = true
    const reload = () =>
      onboardingCommands
        .list(repositoryId)
        .then((v) => {
          if (alive) setTours(v)
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e))
        })
    reload()
    const timer = setInterval(reload, 2500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [repositoryId])
  useEffect(() => {
    let alive = true
    if (selected && step)
      onboardingCommands
        .read(selected, step.id)
        .then((value) => {
          if (alive) {
            setReading({ id: step.id, value })
            setError("")
          }
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e))
        })
    return () => {
      alive = false
    }
  }, [selected, step])
  const save = async (value: OnboardingTour) => {
    if (busy) return false
    setBusy(true)
    try {
      const saved = await onboardingCommands.save(value)
      setTours((items) => [saved, ...items.filter((t) => t.id !== saved.id)])
      setSelected(saved.id)
      setError("")
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
      <aside className="flex w-[272px] shrink-0 flex-col gap-3 pb-2 max-[1100px]:w-[220px]">
        {nav ?? (
          <Button variant="ghost" className="justify-start" onClick={onClose}>
            <HugeiconsIcon icon={ArrowLeft01Icon} />
            Back to files
          </Button>
        )}
        <form
          className="flex gap-1.5 px-1"
          onSubmit={(e) => {
            e.preventDefault()
            void save({
              id: crypto.randomUUID(),
              repositoryId,
              title: newTitle,
              steps: [],
              revision: 0,
            }).then((ok) => {
              if (ok) {
                setNewTitle("")
                setIndex(0)
              }
            })
          }}
        >
          <Input
            aria-label="New tour title"
            placeholder="Name a new tour…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <Button
            size="icon"
            variant="secondary"
            aria-label="Create tour"
            disabled={busy || !newTitle.trim()}
          >
            <HugeiconsIcon icon={Add01Icon} size={16} />
          </Button>
        </form>
        <nav
          aria-label="Onboarding tours"
          className="min-h-0 flex-1 space-y-0.5 overflow-auto px-1"
        >
          {tours.length === 0 && (
            <p className="px-2 text-sm leading-6 text-muted-foreground">
              Durable reading paths through the current code. Create one or
              import a CodeTour.
            </p>
          )}
          {tours.map((item) => {
            const visited = item.steps.filter((s) => s.visited).length
            return (
              <button
                key={item.id}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30",
                  item.id === selected && "bg-accent hover:bg-accent"
                )}
                onClick={() => {
                  setSelected(item.id)
                  setIndex(0)
                }}
              >
                <span className="flex h-5 items-center">
                  <HugeiconsIcon
                    icon={Route01Icon}
                    size={16}
                    className="text-muted-foreground"
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm">{item.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {item.steps.length} steps · {visited} read
                  </span>
                </span>
              </button>
            )
          })}
        </nav>
        <div className="flex flex-col gap-0.5 px-1">
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() =>
              void onboardingCommands
                .import(repositoryId)
                .then(setReport)
                .catch((e) => setError(errorMessage(e)))
            }
          >
            <HugeiconsIcon icon={Download01Icon} />
            Import CodeTour…
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            disabled={!tour}
            onClick={() =>
              tour &&
              void onboardingCommands
                .export(tour.id)
                .catch((e) => setError(errorMessage(e)))
            }
          >
            <HugeiconsIcon icon={Upload01Icon} />
            Export tour…
          </Button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 overflow-hidden rounded-panel border bg-card">
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b pr-3 pl-4">
            <HugeiconsIcon
              icon={CodeIcon}
              size={16}
              className="shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 truncate text-sm" title={step?.path}>
              {step ? (
                <>
                  <span className="text-muted-foreground">
                    {step.path.split("/").slice(0, -1).join("/")}
                    {step.path.includes("/") && "/"}
                  </span>
                  <span className="font-medium">
                    {step.path.split("/").at(-1)}
                  </span>
                </>
              ) : (
                "Select a tour"
              )}
            </span>
            <span className="flex-1" />
            <Badge variant="secondary">Current code</Badge>
          </header>
          {error && (
            <p
              role="alert"
              className="m-4 rounded-2xl bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {current && step ? (
            <div className="min-h-0 flex-1">
              <CodeEditor
                key={`${step.id}/${current.startLine}`}
                height="100%"
                path={`reviewbox-current://${tour?.id}/${step.path}`}
                value={current.content}
                language={languageFor(step.path)}
                theme={reviewboxTheme(resolvedTheme !== "light")}
                onMount={(editor) => {
                  editor.revealLineInCenter(current.startLine)
                  editor.createDecorationsCollection([
                    {
                      range: {
                        startLineNumber: current.startLine,
                        endLineNumber: current.endLine,
                        startColumn: 1,
                        endColumn: 1,
                      },
                      options: {
                        isWholeLine: true,
                        className: "review-passage",
                        marginClassName: "review-passage-margin",
                      },
                    },
                  ])
                }}
                options={{
                  readOnly: true,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontLigatures: false,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  lineHeight: 20,
                  padding: { top: 8 },
                  folding: false,
                  renderLineHighlight: "none",
                  scrollBeyondLastLine: false,
                }}
              />
            </div>
          ) : (
            <p className="p-8 text-sm text-muted-foreground">
              {step
                ? "Loading current source…"
                : "Create a tour and add source-linked steps."}
            </p>
          )}
        </section>
        <aside className="relative flex w-[384px] shrink-0 flex-col border-l max-[1200px]:w-[320px]">
          <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5 pb-32">
            <h2 className="text-lg font-medium">
              {tour?.title ?? "Learn this project"}
            </h2>
            {tour && (
              <ol className="space-y-0.5">
                {tour.steps.map((s, i) => (
                  <li key={s.id}>
                    <button
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30",
                        i === index && "bg-accent font-medium hover:bg-accent"
                      )}
                      onClick={() => setIndex(i)}
                    >
                      <span
                        className={cn(
                          "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground",
                          s.visited && "bg-review-validated text-background",
                          i === index &&
                            !s.visited &&
                            "bg-primary text-primary-foreground",
                          i === index &&
                            current?.status === "stale" &&
                            "bg-review-attention text-background"
                        )}
                      >
                        {s.visited ? (
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            size={11}
                            strokeWidth={2.5}
                          />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    </button>
                  </li>
                ))}
                <li>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() =>
                      setEditing({
                        id: crypto.randomUUID(),
                        title: "",
                        explanation: "",
                        path: "",
                        startLine: 1,
                        endLine: 1,
                        quote: "",
                        fingerprint: "",
                        visited: false,
                      })
                    }
                  >
                    <HugeiconsIcon icon={Add01Icon} />
                    Add step
                  </Button>
                </li>
              </ol>
            )}
            {step && (
              <article className="space-y-4 border-t pt-5">
                <h3 className="font-medium">{step.title}</h3>
                <p className="text-sm leading-6 whitespace-pre-wrap">
                  {step.explanation}
                </p>
                <p
                  className={cn(
                    "flex items-center gap-2 rounded-2xl p-3 text-xs",
                    current?.status === "stale"
                      ? "bg-review-attention-soft"
                      : "bg-muted/60 text-muted-foreground"
                  )}
                >
                  <HugeiconsIcon
                    icon={
                      current?.status === "stale" ? Alert02Icon : Tick02Icon
                    }
                    size={14}
                    className={
                      current?.status === "stale"
                        ? "text-review-attention"
                        : "text-review-validated"
                    }
                  />
                  {current?.status === "stale"
                    ? "This anchor changed. Review the current code and repair the line range."
                    : current?.status === "relocated"
                      ? `Anchor still valid · the exact passage moved to line ${current.startLine}.`
                      : `Anchor still valid · ${step.path.split("/").at(-1)} ${step.startLine}–${step.endLine}`}
                </p>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !current || current.status === "stale"}
                    onClick={() =>
                      tour &&
                      void save({
                        ...tour,
                        steps: tour.steps.map((s) =>
                          s.id === step.id ? { ...s, visited: !s.visited } : s
                        ),
                      })
                    }
                  >
                    {step.visited ? "Mark unread" : "Mark read"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditing({
                        ...step,
                        startLine: current?.startLine ?? step.startLine,
                        endLine: current?.endLine ?? step.endLine,
                        quote: "",
                        fingerprint: "",
                      })
                    }
                  >
                    {current?.status === "stale" ? "Repair anchor" : "Edit"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() =>
                      tour &&
                      void save({
                        ...tour,
                        steps: tour.steps.filter((s) => s.id !== step.id),
                      }).then((ok) => {
                        if (ok) setIndex(Math.max(0, index - 1))
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              </article>
            )}
          </div>
          <footer className="absolute inset-x-0 bottom-0 space-y-2.5 border-t glass-bar p-3">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={!step || !index}
                onClick={() => setIndex(index - 1)}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} />
                Previous
              </Button>
              <Button
                className="flex-1"
                disabled={!step || index >= (tour?.steps.length ?? 0) - 1}
                onClick={() => setIndex(index + 1)}
              >
                Next step
                <HugeiconsIcon icon={ArrowRight01Icon} />
              </Button>
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              Onboarding tours explain code — they don’t validate it.
            </p>
          </footer>
        </aside>
      </main>
      <Dialog
        open={!!editing}
        onOpenChange={(v) => {
          if (!v) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogTitle>Edit tour step</DialogTitle>
          <DialogDescription>
            The line range is checked against the current local file when saved.
          </DialogDescription>
          {editing && tour && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void save({
                  ...tour,
                  steps: tour.steps.some((s) => s.id === editing.id)
                    ? tour.steps.map((s) => (s.id === editing.id ? editing : s))
                    : [...tour.steps, editing],
                }).then((ok) => {
                  if (ok) setEditing(null)
                })
              }}
            >
              <Input
                aria-label="Step title"
                placeholder="Title"
                value={editing.title}
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
              />
              <Input
                aria-label="Relative source path"
                placeholder="src/example.ts"
                value={editing.path}
                onChange={(e) =>
                  setEditing({ ...editing, path: e.target.value })
                }
              />
              <Textarea
                aria-label="Step explanation"
                placeholder="Explain this code"
                value={editing.explanation}
                onChange={(e) =>
                  setEditing({ ...editing, explanation: e.target.value })
                }
              />
              <div className="flex gap-2">
                <Input
                  aria-label="First line"
                  type="number"
                  min={1}
                  value={editing.startLine}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      startLine: Number(e.target.value),
                    })
                  }
                />
                <Input
                  aria-label="Last line"
                  type="number"
                  min={editing.startLine}
                  value={editing.endLine}
                  onChange={(e) =>
                    setEditing({ ...editing, endLine: Number(e.target.value) })
                  }
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button
                disabled={busy || !editing.title.trim() || !editing.path.trim()}
              >
                Save current anchor
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!report}
        onOpenChange={(v) => {
          if (!v) setReport(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogTitle>Review imported tour</DialogTitle>
          <DialogDescription>
            {report?.tour.steps.length} supported steps. Source files and the
            original tour are not modified.
          </DialogDescription>
          {report?.warnings.map((warning, i) => (
            <p key={i} className="text-sm text-review-attention">
              {warning}
            </p>
          ))}
          {report?.tour.steps.map((s) => (
            <p key={s.id} className="text-sm">
              {s.title} ·{" "}
              <span className="font-mono text-xs">
                {s.path}:{s.startLine}–{s.endLine}
              </span>
            </p>
          ))}
          <Button
            disabled={busy || !report?.tour.steps.length}
            onClick={() =>
              report &&
              void save(report.tour).then((ok) => {
                if (ok) {
                  setReport(null)
                  setIndex(0)
                }
              })
            }
          >
            Import supported steps
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
