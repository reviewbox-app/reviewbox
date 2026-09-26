"use client"
import { useEffect, useState } from "react"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { WorkspaceTitleBar } from "../components/WorkspaceTitleBar"
import { RepositoryHome } from "@/features/repositories/composites/RepositoryHome"
import { NewReviewDialog } from "@/features/repositories/composites/NewReviewDialog"
import { ReviewHistoryDialog } from "@/features/review/composites/ReviewHistoryDialog"
import { ReviewSidebar } from "@/features/review/components/ReviewSidebar"
import { ReviewCodePane } from "@/features/review/composites/ReviewCodePane"
import { ReviewInspector } from "@/features/review/composites/ReviewInspector"
import { CoveragePanel } from "@/features/review/composites/CoveragePanel"
import { TopicEditorDialog } from "@/features/review/composites/TopicEditorDialog"
import { ResumeReviews } from "@/features/review/composites/ResumeReviews"
import { SettingsDialog } from "@/features/settings/composites/SettingsDialog"
import { UnderstandWorkspace } from "@/features/knowledge/composites/UnderstandWorkspace"
import { useReviewSession } from "@/features/review/hooks/useReviewSession"
import { useReviewWorkspaceStore } from "@/features/review/stores/useReviewWorkspace.store"
import { anchorFor } from "@/features/review/helpers/review.helpers"
import {
  desktopAvailable,
  errorMessage,
  reviewCommands,
} from "@/lib/desktop/review.commands"
import type { Topic } from "@/lib/desktop/contracts.generated"

export function ReviewBoxApp() {
  const session = useReviewSession()
  const {
    space,
    setSpace,
    coverage,
    setCoverage,
    settings,
    setSettings,
    palette,
    setPalette,
    fileSearch,
    setFileSearch,
    setInspector,
    setNoteKind,
    split,
    setSplit,
  } = useReviewWorkspaceStore()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [topic, setTopic] = useState<Topic | null | undefined>(undefined)
  const {
    workspace,
    selected,
    repository,
    busy,
    action,
    next,
    choose,
    setNewReview,
  } = session
  const change = workspace?.snapshot.changes.find(
    (c) => c.id === selected?.changeId
  )
  const passage = change?.passages.find((p) => p.id === selected?.passageId)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing =
        target?.isContentEditable ||
        !!target?.closest("input,textarea,select,[role=combobox]")
      if (event.isComposing) return
      const meta = event.metaKey || event.ctrlKey
      if (document.querySelector("[role=dialog]")) return
      if (meta && event.key.toLowerCase() === "o") {
        event.preventDefault()
        void choose()
        return
      }
      if (settings || palette || topic !== undefined || session.newReview)
        return
      if (meta && event.key.toLowerCase() === "n" && repository) {
        event.preventDefault()
        setNewReview(true)
      } else if (
        meta &&
        (event.key.toLowerCase() === "k" || event.key.toLowerCase() === "p")
      ) {
        event.preventDefault()
        setPalette(true)
      } else if (meta && ["1", "2", "3"].includes(event.key)) {
        event.preventDefault()
        setSpace(
          event.key === "1"
            ? "understand"
            : event.key === "2"
              ? "review"
              : "resume"
        )
      } else if (meta && event.key.toLowerCase() === "l") {
        event.preventDefault()
        setInspector("ask")
      } else if (meta && event.key === "\\") {
        event.preventDefault()
        setSplit(!split)
      } else if (!typing && !meta && space === "review") {
        if (event.key === "j") next(1)
        if (event.key === "k") next(-1)
        if (event.key === "v" && selected)
          void action({ kind: "validate", anchor: selected })
        if (event.key === "n" || event.key === "q") {
          setNoteKind(event.key === "q" ? "question" : "note")
          setInspector("notes")
        }
        if (event.key === "Escape") setCoverage(false)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [
    choose,
    repository,
    setNewReview,
    setPalette,
    setSpace,
    next,
    selected,
    action,
    setInspector,
    setNoteKind,
    split,
    setSplit,
    setCoverage,
    settings,
    palette,
    topic,
    session.newReview,
    space,
  ])
  const { open: openRepository, setError: reportError } = session
  useEffect(() => {
    if (!desktopAvailable()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().onDragDropEvent((event) => {
          if (event.payload.type === "drop" && event.payload.paths[0])
            void openRepository(event.payload.paths[0])
        })
      )
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch((e) => reportError(errorMessage(e)))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [openRepository, reportError])
  return (
    <div className="flex h-svh min-h-[500px] flex-col overflow-hidden bg-background text-foreground">
      <WorkspaceTitleBar repository={repository} onHome={session.home} />
      {session.error && (
        <div
          role="alert"
          className="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
        >
          <span className="flex-1">{session.error}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => session.setError("")}
          >
            Dismiss
          </Button>
        </div>
      )}
      {session.changed && workspace && (
        <div
          role="status"
          className="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-review-attention/30 px-4 py-2 text-xs"
        >
          <span className="flex-1">
            The repository changed. You are still reading your frozen snapshot.
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void session.refresh()}
          >
            Capture a new version
          </Button>
        </div>
      )}
      {!repository ? (
        <RepositoryHome
          repositories={session.repositories}
          busy={busy}
          onOpen={(path) => void session.open(path)}
          onChoose={() => void choose()}
          onForget={(id) => void session.forget(id)}
        />
      ) : space === "resume" ? (
        <ResumeReviews
          repository={repository}
          onOpen={(id) => void session.load(id)}
          onNew={() => setNewReview(true)}
          onError={session.setError}
        />
      ) : workspace && space === "understand" ? (
        <UnderstandWorkspace
          key={workspace.snapshot.id}
          snapshot={workspace.snapshot}
          reviewId={workspace.review.id}
          onApplied={() =>
            void reviewCommands
              .load(workspace.review.id)
              .then(session.accept)
              .catch((e) => session.setError(errorMessage(e)))
          }
          onError={session.setError}
        />
      ) : workspace ? (
        <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
          <ReviewSidebar
            workspace={workspace}
            coverage={session.coverage}
            selected={selected}
            onSelect={session.select}
            onTopic={(t) => setTopic(t ?? null)}
            onCoverage={() => setCoverage(true)}
            onNew={() => setNewReview(true)}
            onHistory={() => setHistoryOpen(true)}
            onPropose={() => setInspector("ask")}
            onExport={() =>
              void reviewCommands
                .exportTour(workspace.review.id)
                .catch((e) => session.setError(errorMessage(e)))
            }
            onImport={() =>
              void reviewCommands
                .importTour(workspace.review.id, workspace.review.revision)
                .then((value) => {
                  if (value) session.install(value)
                })
                .catch((e) => session.setError(errorMessage(e)))
            }
          />
          <main className="flex min-w-0 flex-1 overflow-hidden rounded-[14px] border bg-card">
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel
                id="code"
                minSize="240px"
                className="flex min-h-0"
              >
                {coverage ? (
                  <CoveragePanel
                    workspace={workspace}
                    onSelect={session.select}
                    onClose={() => setCoverage(false)}
                  />
                ) : change ? (
                  <ReviewCodePane
                    key={`${workspace.snapshot.id}/${change.id}`}
                    snapshot={workspace.snapshot}
                    change={change}
                    passage={passage}
                    position={workspace.review.position}
                    onPosition={(position) =>
                      void action({ kind: "savePosition", position })
                    }
                  />
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                    <h2 className="text-lg font-medium">
                      {selected
                        ? "This passage needs a new anchor"
                        : "No changes in this snapshot"}
                    </h2>
                    <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                      {selected
                        ? "The old reading step stays in your history. Select a current passage or edit its topic."
                        : "Choose a different scope or use Understand to explore the captured source files."}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => setNewReview(true)}
                    >
                      Choose changes
                    </Button>
                  </div>
                )}
              </ResizablePanel>
              {!coverage && (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    id="inspector"
                    defaultSize="384px"
                    minSize="260px"
                    maxSize="60%"
                    className="flex min-h-0"
                  >
                    <ReviewInspector
                      key={selected?.passageId ?? "empty"}
                      workspace={workspace}
                      anchor={selected}
                      busy={busy}
                      onAction={(value) => void action(value)}
                      onNext={next}
                      onApplied={() =>
                        void reviewCommands
                          .load(workspace.review.id)
                          .then(session.accept)
                          .catch((e) => session.setError(errorMessage(e)))
                      }
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </main>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-muted-foreground">
            Choose the changes you want to understand.
          </p>
          <Button disabled={busy} onClick={() => setNewReview(true)}>
            {busy ? "Capturing snapshot…" : "Start a review"}
          </Button>
        </div>
      )}
      {!repository && (
        <footer className="flex h-10 shrink-0 items-center justify-between border-t px-5 text-xs text-muted-foreground">
          <span>Local only · no account · reviews are stored on this Mac</span>
          <span>ReviewBox</span>
        </footer>
      )}
      {repository && (
        <NewReviewDialog
          repository={repository}
          open={session.newReview}
          busy={busy}
          onClose={() => setNewReview(false)}
          onCreate={(value) => void session.create(value)}
        />
      )}
      {workspace && topic !== undefined && (
        <TopicEditorDialog
          key={topic?.id ?? "new"}
          snapshot={workspace.snapshot}
          topic={topic ?? undefined}
          open
          onClose={() => setTopic(undefined)}
          onSave={(value) => {
            const topics = workspace.review.topics.some(
              (t) => t.id === value.id
            )
              ? workspace.review.topics.map((t) =>
                  t.id === value.id ? value : t
                )
              : [...workspace.review.topics, value]
            return action({ kind: "saveTopics", topics })
          }}
        />
      )}
      {workspace && historyOpen && (
        <ReviewHistoryDialog
          workspace={workspace}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
      <Dialog open={palette} onOpenChange={setPalette}>
        <DialogContent>
          <DialogTitle>Find a changed file</DialogTitle>
          <DialogDescription>
            Open a passage in the current frozen snapshot.
          </DialogDescription>
          <Input
            autoFocus
            aria-label="Search changed files"
            value={fileSearch}
            onChange={(e) => setFileSearch(e.target.value)}
            placeholder="Search files…"
          />
          <div className="max-h-80 overflow-auto">
            {workspace?.snapshot.changes
              .filter((c) =>
                c.path.toLowerCase().includes(fileSearch.toLowerCase())
              )
              .map((c) => (
                <Button
                  key={c.id}
                  variant="ghost"
                  className="w-full justify-start font-mono text-xs"
                  onClick={() => {
                    session.select(
                      anchorFor(workspace.snapshot, c.id, c.passages[0])
                    )
                    setSpace("review")
                    setPalette(false)
                  }}
                >
                  {c.path} · {c.layer}
                </Button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
