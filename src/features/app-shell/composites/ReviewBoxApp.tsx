"use client"
import { useEditorExtensions } from "@/features/editor-extensions/services/extensions.store"
import { useEditorEngineStatus } from "@/features/editor-extensions/services/engines"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AlertCircleIcon,
  Cancel01Icon,
  InformationCircleIcon,
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
import { useReviewUpdate } from "@/features/agents/hooks/useReviewUpdate"
import { ReviewUpdateStatus } from "@/features/agents/composites/ReviewUpdateStatus"
import { PreparingReview } from "@/features/agents/composites/PreparingReview"
import { ReviewReader } from "@/features/review/composites/ReviewReader"
import { ResumeReviews } from "@/features/review/composites/ResumeReviews"
import { SettingsDialog } from "@/features/settings/composites/SettingsDialog"
import { CodeEditorWorkspace } from "@/features/code-editor/composites/CodeEditorWorkspace"
import { EditorLifecycle } from "@/features/code-editor/composites/EditorLifecycle"
import { useReviewNotifications } from "@/features/notifications/hooks/useReviewNotifications"
import { useRepositoryGitMenu } from "@/features/source-control/hooks/useRepositoryGitMenu"
import { useSourceControl } from "@/features/source-control/hooks/useSourceControl"
import { LocalChanges } from "@/features/source-control/composites/LocalChanges"
import { ReviewOverview } from "@/features/source-control/composites/ReviewOverview"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import type {
  ReadingLevel,
  ReviewNotificationTarget,
  Workspace,
} from "@/lib/desktop/contracts.generated"

export function ReviewBoxApp() {
  useAppearancePreferences()
  useEditorExtensions()
  useEditorEngineStatus()
  const session = useReviewSession()
  const rev = useRevStatus()
  const {
    space,
    setSpace,
    view,
    setReaderLevel,
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
    selectView: setView,
  } = session
  const git = useSourceControl(repository?.id)
  const [surface, setSurface] = useState<{
    repositoryId: string
    mode: "local" | "overview"
  } | null>(null)
  const local =
    surface?.repositoryId === repository?.id && surface?.mode === "local"
  const overview =
    surface?.repositoryId === repository?.id && surface?.mode === "overview"
  const openLocal = useCallback(() => {
    if (repository) {
      setSurface({ repositoryId: repository.id, mode: "local" })
      setSpace("review")
    }
  }, [repository, setSpace])
  useRepositoryGitMenu(repository?.id, openLocal)
  const showOverview = () => {
    if (repository)
      setSurface({ repositoryId: repository.id, mode: "overview" })
  }
  const [dismissedChange, setDismissedChange] = useState<string | null>(null)
  const update = useReviewUpdate(
    workspace,
    preparing?.provider ?? rev.harness?.provider ?? "codex",
    (value) => {
      // An adaptation preserves the chosen view and reading mode, including forks.
      initializedReview.current = `${value.review.repositoryId}/${value.review.id}`
      session.install(value, false)
    },
    !!preparing &&
      preparing.reviewId === workspace?.review.id &&
      preparing.snapshotId === workspace?.snapshot.id
  )
  const updating = update.active || update.pending
  const { openNotification, selectStep, setError } = session
  const openNotifiedReview = useCallback(
    async (target: ReviewNotificationTarget) => {
      const value = await openNotification(target)
      if (!value) return
      dismissedPreparations.current.add(readerIdentity(value))
      setPreparing(null)
      setSurface(null)
      setSettings(false)
      setPalette(false)
      setSpace("review")
      setView("document")
      if (!value.review.position.stepId) {
        const first = readingUnits(value)[0]
        if (first) selectStep(first.step.step.id)
      }
    },
    [openNotification, selectStep, setSettings, setPalette, setSpace, setView]
  )
  useReviewNotifications(openNotifiedReview, setError)
  const refresh = () =>
    workspace?.review.preparationId || workspace?.review.mode === "guided"
      ? update.start()
      : session.refresh()
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
        !local &&
        !overview &&
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
    settings,
    palette,
    session.newReview,
    preparing,
    space,
    nextTopic,
    local,
    overview,
  ])
  // A review Rev has written opens on its document; one without a tour
  // (prepared by the reader) has nothing to read yet, so it opens on the code.
  const openedReview = workspace?.review.id
  const readingIdentity = workspace ? readerIdentity(workspace) : null
  const written =
    workspace?.review.mode === "guided" &&
    !!workspace.review.topics.some((t) => t.steps.length)
  useEffect(() => {
    const selection = workspace
      ? `${workspace.review.repositoryId}/${workspace.review.id}`
      : null
    if (selection && initializedReview.current !== selection) {
      initializedReview.current = selection
      setView(written ? "document" : "code")
      setReaderLevel(
        initialLevels.current.get(readingIdentity ?? "") ??
          (written ? getReadingPreferences().level : "technical")
      )
    }
  }, [readingIdentity, workspace, written, setView, setReaderLevel])
  if (
    preparing &&
    workspace &&
    (preparing.repositoryId !== workspace.review.repositoryId ||
      preparing.reviewId !== workspace.review.id ||
      preparing.snapshotId !== workspace.snapshot.id)
  )
    setPreparing(null)
  const preparationIsDraft = workspace?.review.publication.status === "draft"
  const preparationRepositoryId = workspace?.review.repositoryId
  const preparationSnapshotId = workspace?.snapshot.id
  const preparationStepId = workspace?.review.position.stepId
  const preparationError = session.setError
  useEffect(() => {
    if (
      !preparationIsDraft ||
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
        if (
          !alive ||
          !job ||
          job.adaptation ||
          job.snapshotId !== preparationSnapshotId
        )
          return
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
    preparationIsDraft,
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
      <EditorLifecycle />
      <WorkspaceTitleBar
        repository={repository}
        rev={rev}
        onHome={session.home}
        onReviewOverview={showOverview}
        reviewControl={
          workspace && (
            <ReviewUpdateStatus
              key={workspace.review.id}
              workspace={workspace}
              update={update}
              changed={session.changed}
              freshnessChecked={session.freshnessChecked}
              onCheck={session.checkFreshness}
              staleStepIds={session.staleStepIds}
              busy={busy}
              onRead={() => {
                if (update.state && !update.state.adaptation) {
                  dismissedPreparations.current.add(readerIdentity(workspace))
                  setPreparing(null)
                  if (!workspace.review.position.stepId) startReading(workspace)
                  else setSpace("review")
                } else setSpace("review")
              }}
              onDelete={async () => {
                await reviewCommands.delete(workspace.review.id)
                session.deleted(workspace.review.id)
                setPreparing(null)
                setSpace("resume")
              }}
            />
          )
        }
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
      {space === "review" &&
        !local &&
        !overview &&
        session.changed &&
        workspace &&
        dismissedChange !== readingIdentity && (
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
              disabled={
                busy ||
                updating ||
                (!!update.state && update.state.status !== "ready")
              }
              onClick={() => void refresh()}
            >
              {workspace.review.preparationId ||
              workspace.review.mode === "guided"
                ? "Update with Rev"
                : "Refresh"}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss repository changes"
              onClick={() => setDismissedChange(readingIdentity)}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} />
            </Button>
          </div>
        )}
      {git.error &&
        repository &&
        space === "review" &&
        (local || overview || !workspace) && (
          <Alert className="mx-2 mb-2 w-auto" variant="destructive" size="sm">
            <AlertDescription>{git.error}</AlertDescription>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss Git error"
              onClick={() => git.setError("")}
            >
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          </Alert>
        )}
      {!repository ? (
        <RepositoryHome
          repositories={session.repositories}
          busy={busy}
          onOpen={(path) => void session.open(path)}
          onChoose={() => void choose()}
          onForget={(id) => void session.forget(id)}
        />
      ) : space === "review" &&
        !local &&
        !overview &&
        workspace &&
        workspace.review.publication.status === "draft" &&
        preparing?.repositoryId === workspace.review.repositoryId &&
        preparing?.reviewId === workspace.review.id &&
        preparing?.snapshotId === workspace.snapshot.id ? (
        <PreparingReview
          key={`${readingIdentity}/${preparing.provider}`}
          workspace={workspace}
          preparation={{
            ...update,
            error: update.error || update.state?.error?.message || "",
            status: update.active ? "Rev is working…" : "Loading preparation…",
            start: update.startCreation,
          }}
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
          lockedReviewId={updating ? workspace?.review.id : undefined}
          onOpen={(id) => {
            setSurface(null)
            void session.load(id)
          }}
          onDeleted={session.deleted}
          onNew={() => setNewReview(true)}
          onError={session.setError}
        />
      ) : space === "understand" ? (
        <CodeEditorWorkspace
          key={repository.id}
          repositoryId={repository.id}
          statuses={Object.fromEntries(
            (git.state?.files ?? []).map((file) => [
              file.path,
              file.unstagedStatus === "?"
                ? "U"
                : file.stagedStatus === "A"
                  ? "A"
                  : file.previousPath
                    ? "R"
                    : file.unstagedStatus === "D"
                      ? "D"
                      : "M",
            ])
          )}
        />
      ) : local ? (
        <LocalChanges
          key={repository.id}
          git={git}
          onBack={showOverview}
          onFinished={showOverview}
        />
      ) : overview || !workspace ? (
        <ReviewOverview
          git={git}
          onLocal={openLocal}
          onStart={() => setNewReview(true)}
          onResume={workspace ? () => setSurface(null) : undefined}
        />
      ) : workspace ? (
        <div className="flex min-h-0 flex-1 px-2 pb-2">
          <ReviewReader
            key={readingIdentity}
            workspace={workspace}
            selected={selected}
            busy={busy || updating}
            menuEnabled={!session.newReview && !settings && !palette}
            onRefresh={() => void refresh()}
            onLocalChanges={openLocal}
            staleStepIds={session.staleStepIds}
            updatePending={!!update.state && update.state.status !== "ready"}
            onSelect={session.select}
            onSelectStep={session.selectStep}
            onSelectFile={session.selectFile}
            onViewChange={setView}
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
        <ReviewOverview
          git={git}
          onLocal={openLocal}
          onStart={() => setNewReview(true)}
        />
      )}
      {!repository && (
        <footer className="flex h-10 shrink-0 items-center justify-end gap-4 border-t px-5 text-xs text-muted-foreground">
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
            setSurface(null)
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
            setSurface(null)
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
