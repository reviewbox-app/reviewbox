"use client"
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
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
import type {
  OnboardingTour,
  OnboardingStep,
  CurrentTourStep,
  TourImportReport,
} from "@/lib/desktop/contracts.generated"
import { onboardingCommands } from "../services/onboarding.commands"
export function OnboardingWorkspace({
  repositoryId,
  onClose,
}: {
  repositoryId: string
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
      <aside className="flex w-[272px] shrink-0 flex-col gap-3 p-2">
        <Button variant="ghost" className="justify-start" onClick={onClose}>
          ← Back to files
        </Button>
        <h1 className="font-medium">Onboarding tours</h1>
        <form
          className="space-y-2"
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
            placeholder="Name a reading path…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !newTitle.trim()}
          >
            Create tour
          </Button>
        </form>
        <div className="min-h-0 flex-1 overflow-auto">
          {tours.map((item) => (
            <Button
              key={item.id}
              className="mb-2 w-full justify-start"
              variant={item.id === selected ? "secondary" : "ghost"}
              onClick={() => {
                setSelected(item.id)
                setIndex(0)
              }}
            >
              {item.title}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          onClick={() =>
            void onboardingCommands
              .import(repositoryId)
              .then(setReport)
              .catch((e) => setError(errorMessage(e)))
          }
        >
          Import CodeTour…
        </Button>
        {tour && (
          <Button
            variant="ghost"
            onClick={() =>
              void onboardingCommands
                .export(tour.id)
                .catch((e) => setError(errorMessage(e)))
            }
          >
            Export tour…
          </Button>
        )}
      </aside>
      <main className="flex min-w-0 flex-1 overflow-hidden rounded-[14px] border bg-card">
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 items-center gap-3 border-b px-4 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono">
              {step?.path ?? "Select a tour"}
            </span>
            <span className="text-muted-foreground">Current code</span>
          </header>
          {error && (
            <p
              role="alert"
              className="m-4 rounded-xl border border-destructive/30 p-3 text-sm"
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
                theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                onMount={(editor) => {
                  editor.revealLineInCenter(current.startLine)
                  editor.setSelection({
                    startLineNumber: current.startLine,
                    endLineNumber: current.endLine,
                    startColumn: 1,
                    endColumn: 1,
                  })
                }}
                options={{
                  readOnly: true,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontLigatures: false,
                  fontSize: 12,
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
        <aside className="w-[384px] shrink-0 space-y-5 overflow-auto border-l p-5">
          <h2 className="font-medium">{tour?.title ?? "Learn this project"}</h2>
          {tour && (
            <>
              <ol className="space-y-2">
                {tour.steps.map((s, i) => (
                  <li key={s.id}>
                    <Button
                      className="w-full justify-start"
                      size="sm"
                      variant={i === index ? "secondary" : "ghost"}
                      onClick={() => setIndex(i)}
                    >
                      {s.visited ? "✓" : i + 1} · {s.title}
                    </Button>
                  </li>
                ))}
              </ol>
              <Button
                variant="outline"
                size="sm"
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
                Add step
              </Button>
            </>
          )}
          {step && (
            <article className="space-y-4 border-t pt-5">
              <h3 className="font-medium">{step.title}</h3>
              <p className="text-sm leading-6 whitespace-pre-wrap">
                {step.explanation}
              </p>
              {current?.status === "stale" && (
                <p className="text-sm text-review-attention">
                  This anchor changed. Review the current code and repair the
                  line range.
                </p>
              )}
              {current?.status === "relocated" && (
                <p className="text-xs text-muted-foreground">
                  The exact passage moved to line {current.startLine}.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
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
                  Edit / repair anchor
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
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
                  Remove step
                </Button>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!index}
                  onClick={() => setIndex(index - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={index >= (tour?.steps.length ?? 0) - 1}
                  onClick={() => setIndex(index + 1)}
                >
                  Next
                </Button>
              </div>
            </article>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            Onboarding tours explain current code. Reading a step does not
            validate a review.
          </p>
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
