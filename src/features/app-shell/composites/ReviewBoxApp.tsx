"use client"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AlertCircleIcon,
  Cancel01Icon,
  InformationCircleIcon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons"
import {
  useRevStatus,
  harnessNames,
} from "@/features/agents/hooks/useRevStatus"
import { WorkspaceTitleBar } from "../components/WorkspaceTitleBar"
import { CommandPalette } from "./CommandPalette"
import { RepositoryHome } from "@/features/repositories/composites/RepositoryHome"
import { NewReviewDialog } from "@/features/repositories/composites/NewReviewDialog"
import { preparationCommands } from "@/features/agents/services/preparation.commands"
import { PreparingReview } from "@/features/agents/composites/PreparingReview"
import { ReviewReader } from "@/features/review/composites/ReviewReader"
import { ResumeReviews } from "@/features/review/composites/ResumeReviews"
import { SettingsDialog } from "@/features/settings/composites/SettingsDialog"
import { UnderstandWorkspace } from "@/features/knowledge/composites/UnderstandWorkspace"
import { getReadingPreferences } from "@/features/settings/hooks/useReadingPreferences"
import { useAppearancePreferences } from "@/features/settings/hooks/useAppearancePreferences"
import { useReviewSession } from "@/features/review/hooks/useReviewSession"
import { useReviewWorkspaceStore } from "@/features/review/stores/useReviewWorkspace.store"
import {
  readerIdentity,
  readingUnits,
} from "@/features/review/helpers/review.helpers"
import {
  desktopAvailable,
  errorMessage,
  reviewCommands,
} from "@/lib/desktop/review.commands"
import type { ReadingLevel, Workspace } from "@/lib/desktop/contracts.generated"

export function ReviewBoxApp() {
  useAppearancePreferences()
  const session = useReviewSession()
  const rev = useRevStatus()
  const {
    space,
    setSpace,
    view,
    setView,
    setReaderLevel,
    setCodeMode,
    settings,
    setSettings,
    palette,
    setPalette,
    split,
    setSplit,
  } = useReviewWorkspaceStore()
  const initialLevels = useRef(new Map<string, ReadingLevel>())
  const dismissedPreparations = useRef(new Set<string>())
  const initializedReview = useRef<string | null>(null)
  const [preparing, setPreparing] = useState<{
    repositoryId: string
    reviewId: string
    snapshotId: string
    provider: string
  } | null>(null)
  const {
    workspace,
    selected,
    repository,
    busy,
    action,
    next,
    nextTopic,
    choose,
    setNewReview,
  } = session
  /** Opens the first step of a review Rev has just written. */
  const startReading = (value: Workspace) => {
    const first = readingUnits(value)[0]
    if (first) session.selectStep(first.step.step.id)
    setView("document")
    setSpace("review")
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const typing =
        !!target?.isContentEditable ||
        !!target?.closest("input,textarea,select,[role=combobox]")
      if (event.isComposing) return
      const meta = event.metaKey || event.ctrlKey
      if (document.querySelector("[role=dialog]")) return
      if (meta && event.key.toLowerCase() === "o") {
        event.preventDefault()
        void choose()
        return
      }
      if (settings || palette || session.newReview || preparing) return
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
            ? "resume"
            : event.key === "2"
              ? "review"
              : "understand"
        )
      } else if (meta && event.key === "\\") {
        event.preventDefault()
        setSplit(!split)
      } else if (
        !typing &&
        !meta &&
        space === "review" &&
        !target?.closest(".monaco-editor")
      ) {
        if (event.key === "j") next(1)
        if (event.key === "k") next(-1)
        if (event.key === "]") nextTopic(1)
        if (event.key === "[") nextTopic(-1)
        if (event.key === "d")
          setView(view === "document" ? "code" : "document")
      }
    }
    // Capture phase: Monaco claims ⌘K as a chord prefix once the code has focus.
    window.addEventListener("keydown", handler, true)
    return () => window.removeEventListener("keydown", handler, true)
  }, [
    choose,
    repository,
    setNewReview,
    setPalette,
    setSpace,
    next,
    split,
    setSplit,
    view,
    setView,
    setReaderLevel,
    setCodeMode,
    settings,
    palette,
    session.newReview,
    preparing,
    space,
    nextTopic,
  ])
  // A review Rev has written opens on its document; one without a tour
  // (prepared by the reader) has nothing to read yet, so it opens on the code.
  const openedReview = workspace?.review.id
  const readingIdentity = workspace ? readerIdentity(workspace) : null
  const written =
    workspace?.review.mode === "guided" &&
    !!workspace.review.topics.some((t) => t.steps.length)
  useEffect(() => {
    if (readingIdentity && initializedReview.current !== readingIdentity) {
      initializedReview.current = readingIdentity
      setView(written ? "document" : "code")
      if (!written) setCodeMode("real")
      setReaderLevel(
        initialLevels.current.get(readingIdentity) ??
          (written ? getReadingPreferences().level : "developer")
      )
    }
  }, [readingIdentity, written, setView, setReaderLevel, setCodeMode])
  if (
    preparing &&
    workspace &&
    (preparing.repositoryId !== workspace.review.repositoryId ||
      preparing.reviewId !== workspace.review.id ||
      preparing.snapshotId !== workspace.snapshot.id)
  )
    setPreparing(null)
  const preparationRepositoryId = workspace?.review.repositoryId
  const preparationSnapshotId = workspace?.snapshot.id
  const preparationStepId = workspace?.review.position.stepId
  const preparationError = session.setError
  useEffect(() => {
    if (
      !openedReview ||
      !preparationRepositoryId ||
      !readingIdentity ||
      space !== "review" ||
      dismissedPreparations.current.has(readingIdentity)
    )
      return
    let alive = true
    void preparationCommands
      .get(openedReview)
      .then((job) => {
        if (!alive || !job || job.snapshotId !== preparationSnapshotId) return
        if (job.status !== "ready" || !preparationStepId)
          setPreparing({
            repositoryId: preparationRepositoryId,
            reviewId: openedReview,
            snapshotId: job.snapshotId,
            provider: job.provider,
          })
      })
      .catch((cause) => preparationError(errorMessage(cause)))
    return () => {
      alive = false
    }
  }, [
    openedReview,
    preparationStepId,
    preparationSnapshotId,
    preparationRepositoryId,
    readingIdentity,
    space,
    preparationError,
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
      <WorkspaceTitleBar
        repository={repository}
        rev={rev}
        onHome={session.home}
      />
      {session.error && (
        <div
          role="alert"
          className="mx-2 mb-2 flex items-center gap-2.5 rounded-2xl bg-destructive/10 py-2 pr-2 pl-3 text-sm text-destructive"
        >
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={16}
            className="shrink-0"
          />
          <span className="flex-1">{session.error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={() => session.setError("")}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} />
          </Button>
        </div>
      )}
      {session.changed && workspace && (
        <div
          role="status"
          className="mx-2 mb-2 flex items-center gap-2.5 rounded-2xl bg-review-attention-soft py-1.5 pr-1.5 pl-3 text-sm"
        >
          <HugeiconsIcon
            icon={InformationCircleIcon}
            size={16}
            className="shrink-0 text-review-attention"
          />
          <span className="flex-1">
            The repository changed outside ReviewBox. Your snapshot is
            untouched.
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void session.refresh()}
          >
            Refresh snapshot
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
      ) : workspace &&
        preparing?.repositoryId === workspace.review.repositoryId &&
        preparing?.reviewId === workspace.review.id &&
        preparing?.snapshotId === workspace.snapshot.id ? (
        <PreparingReview
          key={`${readingIdentity}/${preparing.provider}`}
          workspace={workspace}
          provider={preparing.provider}
          onApplied={() =>
            reviewCommands.load(workspace.review.id).then((value) => {
              if (readerIdentity(value) === readerIdentity(workspace))
                session.acceptCurrent(value)
            })
          }
          onStart={() => {
            dismissedPreparations.current.add(readerIdentity(workspace))
            setPreparing(null)
            startReading(workspace)
          }}
          onLeave={() => {
            setPreparing(null)
            setSpace("resume")
          }}
        />
      ) : space === "resume" ? (
        <ResumeReviews
          repository={repository}
          onOpen={(id) => void session.load(id)}
          onDeleted={session.deleted}
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
              .then((value) => {
                if (readerIdentity(value) === readerIdentity(workspace))
                  session.acceptCurrent(value)
              })
              .catch((e) => session.setError(errorMessage(e)))
          }
          onError={session.setError}
        />
      ) : workspace ? (
        <div className="flex min-h-0 flex-1 px-2 pb-2">
          <ReviewReader
            key={readingIdentity}
            workspace={workspace}
            selected={selected}
            busy={busy}
            onSelect={session.select}
            onSelectStep={session.selectStep}
            onSelectFile={session.selectFile}
            onAction={action}
            isCurrentCursor={session.isCurrentCursor}
            onStep={next}
            onPrepare={() => {
              dismissedPreparations.current.delete(readerIdentity(workspace))
              setPreparing({
                repositoryId: workspace.review.repositoryId,
                reviewId: workspace.review.id,
                snapshotId: workspace.snapshot.id,
                provider: rev.harness?.provider ?? "codex",
              })
            }}
          />
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
        <footer className="flex h-10 shrink-0 items-center justify-between gap-4 border-t px-5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <HugeiconsIcon icon={SecurityCheckIcon} size={14} />
            Local only · no account · reviews are stored on this Mac
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={
                rev.state === "ready"
                  ? "size-1.5 rounded-full bg-review-validated"
                  : "size-1.5 rounded-full bg-review-attention"
              }
            />
            {rev.harness
              ? `Rev · ${harnessNames[rev.harness.provider] ?? rev.harness.provider}${rev.harness.version ? ` ${rev.harness.version}` : ""} · ${rev.state}`
              : "Rev · harness unknown"}
          </span>
        </footer>
      )}
      {repository && (
        <NewReviewDialog
          repository={repository}
          open={session.newReview}
          onClose={() => setNewReview(false)}
          onCreated={({
            workspace: created,
            preparation,
            provider,
            warning,
            readingLevel,
          }) => {
            initialLevels.current.set(readerIdentity(created), readingLevel)
            session.install(created)
            setReaderLevel(readingLevel)
            session.setError(warning)
            setPreparing(
              preparation === "rev"
                ? {
                    repositoryId: created.review.repositoryId,
                    reviewId: created.review.id,
                    snapshotId: created.snapshot.id,
                    provider,
                  }
                : null
            )
            setNewReview(false)
          }}
        />
      )}
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        workspace={workspace}
        actions={{
          step: next,
          view: () => {
            setSpace("review")
            setView(view === "document" ? "code" : "document")
          },
          openChange: (changeId) => {
            const target = workspace?.snapshot.changes.find(
              (c) => c.id === changeId
            )
            if (!workspace || !target) return
            const file = workspace.review.files.find((item) =>
              item.changeIds.includes(changeId)
            )
            if (file) session.selectFile(file.id, changeId)
            setView("code")
            setSpace("review")
          },
          space: setSpace,
          newReview: () => repository && setNewReview(true),
          openRepository: () => void choose(),
          settings: () => setSettings(true),
        }}
      />
    </div>
  )
}
