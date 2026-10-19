"use client"
import type { SourceSearchTarget } from "@/features/code-editor/contracts/sourceSelection.types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { SidebarResizeHandle } from "@/components/ui/sidebar-resize-handle"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InlineMarkdown } from "@/features/markdown/components/InlineMarkdown"
import { ReviewReferenceContent } from "@/features/markdown/components/ReviewMarkdown"
import type {
  CodeAnchor,
  DocumentReference,
  ReadingLevel,
  ReviewAction,
  ReviewCommentAnchor,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import {
  Book02Icon,
  Cancel01Icon,
  CodeIcon,
  InformationCircleIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { DecisionBar } from "../components/DecisionBar"
import { Hint } from "../components/Hint"
import { ReviewContents } from "../components/ReviewContents"
import type { UnitState } from "../components/ReviewSteps"
import { ReviewStepsPanel } from "../components/ReviewStepsPanel"
import { ReviewFiles } from "../components/ReviewFiles"
import { ReviewPublicationDetails } from "../components/ReviewPublicationDetails"
import { ReviewSummary } from "../components/ReviewSummary"
import { RevChat } from "@/features/rev-chat/components/RevChat"
import { CodeComments } from "../components/CodeComments"
import { useReviewComments } from "../hooks/useReviewComments"
import type { ReviewFinalizationSession } from "../hooks/useReviewFinalization"
import { isFinalizationAction } from "../helpers/reviewFinalization.helpers"
import { commentAnchor } from "../helpers/reviewComment.helpers"
import type { SourceSelection } from "@/features/code-editor/contracts/sourceSelection.types"
import { StepDocument } from "../components/StepDocument"
import {
  publicationLabel,
  reviewIsComplete,
} from "../helpers/publication.helpers"
import {
  currentUnit,
  fileDecision,
  guidedProgress,
  readerCursorKey,
  readerIdentity,
  readingUnits,
  stepDecision,
} from "../helpers/review.helpers"
import { useReviewMenu } from "../hooks/useReviewMenu"
import { readerCommands } from "../services/reader.commands"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"
import { reviewReaderLayout } from "../reader.config"
import { ReviewCodePane } from "./ReviewCodePane"
import { ReviewReferencePane } from "./ReviewReferencePane"

import { useFileTreeNavigation } from "@/features/file-tree/hooks/useFileTreeNavigation"
import { initializeReviewTree } from "@/features/file-tree/services/navigation.service"

const EXPLANATION_WIDTH =
  "clamp(280px,var(--review-explanation-width,440px),50%)"
const levelNames: Record<ReadingLevel, string> = {
  essential: "Essential",
  explained: "Explained",
  technical: "Technical",
}

export function ReviewReader({
  workspace,
  selected,
  busy,
  onSelect,
  onSelectStep,
  onSelectFile,
  onViewChange: setView,
  onAction,
  isCurrentCursor,
  onStep,
  onPrepare,
  onRefresh,
  onLocalChanges,
  staleStepIds = [],
  updatePending = false,
  menuEnabled = true,
  finalization,
  hasLocalChanges,
  onFinish,
  onConfigure,
}: {
  workspace: Workspace
  selected: CodeAnchor | null
  busy: boolean
  onSelect: (anchor: CodeAnchor, stepId?: string) => void
  onSelectStep: (stepId: string) => void
  onSelectFile: (fileId: string, changeId?: string) => void
  onViewChange: (view: "document" | "code") => void
  onAction: (action: ReviewAction) => Promise<boolean>
  isCurrentCursor: (key: string) => boolean
  onStep: (direction: number) => void
  onPrepare: () => void
  onRefresh?: () => void
  onLocalChanges?: () => void
  staleStepIds?: string[]
  updatePending?: boolean
  menuEnabled?: boolean
  hasLocalChanges?: boolean
  onFinish?: () => void
  finalization?: ReviewFinalizationSession
  onConfigure?: () => void
}) {
  const {
    view,
    setSplit,
    readerLevel: level,
    setReaderLevel,
    stepsOpen,
    setStepsOpen,
    explanationRequested,
    setExplanationRequested,
    setSpace,
  } = useReviewWorkspaceStore()
  const { review, snapshot } = workspace
  const filesNavigation = useFileTreeNavigation(
    review.repositoryId,
    `review:${review.id}`
  )
  const filesOpen = filesNavigation.value.visible ?? true
  const setFilesOpen = (visible: boolean) =>
    filesNavigation.update((tree) => ({ ...tree, visible }))
  useEffect(() => {
    if (filesNavigation.ready)
      initializeReviewTree(
        review.repositoryId,
        review.id,
        review.files.map((file) => file.path)
      )
  }, [filesNavigation.ready, review.repositoryId, review.id, review.files])

  const completed = reviewIsComplete(review)
  const comments = useReviewComments(review)
  const [commentSelection, setCommentSelection] = useState<{
    anchor?: ReviewCommentAnchor
    key: string
    value: SourceSelection
  } | null>(null)
  const units = readingUnits(workspace)
  const hasReviewDocuments = units.length > 0
  const current = currentUnit(workspace)
  const guided = review.position.context !== "files"
  const unit = current?.unit ?? null
  const index = current?.index ?? -1
  const file = review.files.find((item) =>
    guided
      ? item.changeIds.includes(review.position.changeId ?? "")
      : item.id === review.position.fileId
  )
  const fileIndex = review.files.findIndex((item) => item.id === file?.id)
  const change =
    snapshot.changes.find((item) => item.id === review.position.changeId) ??
    snapshot.changes.find((item) => item.id === file?.changeIds[0])
  const passage = change?.passages.find(
    (item) => item.id === selected?.passageId
  )
  const [fileFailure, setFileFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const navigationPanel = useRef<HTMLElement>(null)
  const [summary, setSummary] = useState(completed || !!finalization?.operation)
  const [details, setDetails] = useState(false)
  const [finalizationStarting, setFinalizationStarting] = useState(false)
  const act = useCallback(
    async (action: ReviewAction) => {
      const final = isFinalizationAction(review, action)
      if (final) {
        setDetails(false)
        setSummary(true)
        setFinalizationStarting(true)
      }
      try {
        return await onAction(action)
      } finally {
        if (final) setFinalizationStarting(false)
      }
    },
    [review, onAction]
  )
  const restoredFinalization = useRef<string | null>(null)
  const finalizationId = finalization?.operation?.id
  useEffect(() => {
    if (!finalizationId || restoredFinalization.current === finalizationId)
      return
    restoredFinalization.current = finalizationId
    setSummary(true)
  }, [finalizationId])
  const menuError = useReviewMenu({
    onLocalChanges,
    review,
    snapshotId: snapshot.id,
    hasDocuments: hasReviewDocuments,
    busy,
    updatePending,
    enabled: menuEnabled && !details,
    onRefresh,
    onAction: act,
    onDetails: () => setDetails(true),
    onSummary: () => setSummary(true),
  })
  const [pinned, setPinned] = useState<DocumentReference | null>(null)
  // The tree locates the displayed source independently of the decision scope.
  const displayedFile = pinned
    ? review.files.find(
        (item) =>
          pinned.sourceId === `file:${item.path}` ||
          item.changeIds.some(
            (id) =>
              pinned.sourceId === `change:${id}:before` ||
              pinned.sourceId === `change:${id}:after`
          )
      )
    : file
  const [deciding, setDeciding] = useState(false)
  const decidingRef = useRef(false)
  const cursorKey = readerCursorKey(workspace)
  const scroller = useRef<HTMLDivElement>(null)
  const contentKey = file ? `${readerIdentity(workspace)}/${file.id}` : ""
  const commentKey = `${readerIdentity(workspace)}/${pinned?.sourceId ?? change?.id ?? ""}`
  const currentCommentSelection =
    commentSelection?.key === commentKey ? commentSelection.value : null
  const fileError = fileFailure?.key === contentKey ? fileFailure.message : ""
  const [stateCursor, setStateCursor] = useState(cursorKey)
  if (stateCursor !== cursorKey) {
    setStateCursor(cursorKey)
    setPinned(null)
    setSummary(false)
    setDetails(false)
  }
  const decision = guided
    ? unit && stepDecision(review, unit.step.step.id)
    : file && fileDecision(review, file.id)
  const validated = !!decision
  const stale = !!unit && unit.anchors.length !== unit.step.step.anchors.length
  const showDecisionFooter =
    !summary &&
    hasReviewDocuments &&
    !completed &&
    !review.needsUpdateConfirmation
  const footerHeight = showDecisionFooter ? reviewReaderLayout.footerHeight : 0
  const canDecide =
    showDecisionFooter &&
    (guided ? !!unit && !!unit.anchors.length && !stale : !!file) &&
    !busy &&
    !deciding &&
    !summary
  const guideProgress = guidedProgress(review)
  const total = guided ? units.length : review.files.length
  const cursorIndex = guided ? index : fileIndex
  const rightDocument = guided && !!unit
  const showRight =
    hasReviewDocuments &&
    view === "code" &&
    explanationRequested &&
    (!!pinned || rightDocument)
  const states: UnitState[] = units.map((item, i) =>
    staleStepIds.includes(item.step.step.id) ||
    item.anchors.length !== item.step.step.anchors.length
      ? "stale"
      : i === index && guided
        ? "current"
        : stepDecision(review, item.step.step.id)
          ? "validated"
          : item.anchors.length !== item.step.step.anchors.length
            ? "stale"
            : "todo"
  )

  const run = useCallback(
    async (reopen = false) => {
      if (!canDecide || decidingRef.current) return
      const owner = cursorKey
      const action: ReviewAction | null =
        guided && unit
          ? {
              kind: reopen ? "reopenStep" : "validateStep",
              stepId: unit.step.step.id,
            }
          : file
            ? reopen
              ? { kind: "reopenFile", fileId: file.id }
              : { kind: "validateFile", fileId: file.id }
            : null
      if (!action) return
      decidingRef.current = true
      setDeciding(true)
      try {
        const saved = await act(action)
        if (!saved || reopen || !isCurrentCursor(owner)) return
        if (guided && guideProgress.validated === guideProgress.total - 1)
          setSummary(true)
        else if (cursorIndex < total - 1) onStep(1)
        else if (guided) setSummary(true)
      } finally {
        decidingRef.current = false
        setDeciding(false)
      }
    },
    [
      canDecide,
      guideProgress.validated,
      guideProgress.total,
      cursorKey,
      guided,
      unit,
      file,
      act,
      isCurrentCursor,
      cursorIndex,
      total,
      onStep,
    ]
  )
  const decide = useRef(run)
  const validatedRef = useRef(validated)
  useEffect(() => {
    decide.current = run
    validatedRef.current = validated
  }, [run, validated])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (
        event.key.toLowerCase() !== "v" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        event.repeat ||
        target?.isContentEditable ||
        target?.closest(
          "input,textarea,select,[role=combobox],.monaco-editor"
        ) ||
        window.document.querySelector("[role=dialog]")
      )
        return
      event.preventDefault()
      void decide.current(validatedRef.current)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const openCode = (anchor: CodeAnchor) => {
    setPinned(null)
    onSelect(anchor, unit?.step.step.id)
    setView("code")
  }
  const pinReference = (reference: DocumentReference) => {
    // Unified diffs render deletions as view zones, not addressable original
    // editor lines. Expose the original editor for exact before-side navigation.
    if (reference.sourceId.endsWith(":before")) setSplit(true)
    setPinned({ ...reference })
    setExplanationRequested(true)
    setView("code")
  }
  const [searchTarget, setSearchTarget] = useState<SourceSearchTarget>()
  const selectFile = (fileId: string, changeId?: string) => {
    setSearchTarget(undefined)
    setPinned(null)
    onSelectFile(fileId, changeId)
    setView("code")
  }
  const document =
    guided && unit ? (
      <StepDocument
        comments={comments}
        workspace={workspace}
        unit={unit}
        index={index}
        total={units.length}
        selected={selected}
        stale={stale}
        validatedBy={decision || undefined}
        compact={view === "code"}
        level={level}
        onOpenCode={openCode}
        onOpenReference={pinReference}
      />
    ) : (
      <Empty className="px-4 py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={guided ? Book02Icon : CodeIcon} aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h1>
              {guided ? "No guided steps yet" : "Explore the captured file"}
            </h1>
          </EmptyTitle>
          <EmptyDescription>
            Use the code view to inspect the captured file.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {review.mode === "manual" && !completed && (
            <Button onClick={onPrepare}>Prepare with Rev</Button>
          )}
          <Button variant="secondary" onClick={() => setView("code")}>
            Open code
          </Button>
        </EmptyContent>
      </Empty>
    )
  const isDocument = view === "document" || !change
  const documentPosition = useRef(review.position)
  useEffect(() => {
    documentPosition.current = review.position
  }, [review.position])
  useEffect(() => {
    if (!isDocument || summary) return
    const element = scroller.current
    if (!element) return
    element.scrollTo({ top: documentPosition.current.scrollTop })
    let timer: ReturnType<typeof setTimeout> | undefined
    const save = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void onAction({
          kind: "savePosition",
          position: {
            ...documentPosition.current,
            scrollTop: element.scrollTop,
          },
        })
      }, 250)
    }
    element.addEventListener("scroll", save, { passive: true })
    return () => {
      clearTimeout(timer)
      element.removeEventListener("scroll", save)
    }
  }, [cursorKey, isDocument, summary, onAction])

  const readingModeSwitch = hasReviewDocuments && (
    <div
      className="sticky z-30 mx-auto flex w-fit justify-center"
      style={{ top: 8 }}
    >
      <Tabs
        value={level}
        onValueChange={(value) => {
          if (
            value === "essential" ||
            value === "explained" ||
            value === "technical"
          ) {
            setReaderLevel(value)
          }
        }}
        className="rounded-full glass-bar"
      >
        <TabsList aria-label="Reading mode">
          {(Object.keys(levelNames) as ReadingLevel[]).map((value) => (
            <TabsTrigger key={value} value={value}>
              {levelNames[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )

  const showFiles = !isDocument && !summary && filesOpen
  const showSteps = isDocument && !summary && hasReviewDocuments && stepsOpen
  const showNavigation = showFiles || showSteps
  const navigationWidth = isDocument
    ? "clamp(180px,var(--review-steps-width,280px),35%)"
    : "clamp(180px,var(--review-files-width,240px),35%)"

  return (
    <div
      data-resize-workspace
      className="grid min-h-0 min-w-0 flex-1 transition-[grid-template-columns,column-gap] duration-200 ease-out data-[resizing=true]:transition-none motion-reduce:transition-none"
      style={{
        gridTemplateColumns: `${showNavigation ? navigationWidth : "0px"} minmax(0,1fr)`,
        columnGap: showNavigation ? 8 : 0,
      }}
    >
      <aside
        ref={navigationPanel}
        aria-label={isDocument ? "Review contents" : "Review files"}
        aria-hidden={!showNavigation}
        inert={!showNavigation}
        className={cn(
          "min-h-0 min-w-0 overflow-hidden transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
          !showNavigation && "-translate-x-3 opacity-0"
        )}
      >
        {isDocument ? (
          <ReviewStepsPanel
            units={units}
            states={states}
            onSelect={(item) => onSelectStep(item.step.step.id)}
            onClose={() => setStepsOpen(false)}
          />
        ) : (
          <ReviewFiles
            workspace={workspace}
            selectedId={displayedFile?.id ?? null}
            visible={showFiles}
            onSelect={selectFile}
            onMatch={(fileId, match) => {
              selectFile(fileId, match.changeId)
              setSearchTarget({ ...match, token: crypto.randomUUID() })
            }}
            onError={(message) => setFileFailure({ key: contentKey, message })}
          />
        )}
      </aside>
      <div className="relative flex min-h-0 min-w-0">
        <main
          className="relative min-w-0 flex-1 overflow-hidden rounded-panel border bg-card"
          aria-label="Review"
          data-resize-workspace
        >
          {summary ? (
            <div
              className="absolute inset-0 overflow-y-auto"
              style={{
                paddingTop: reviewReaderLayout.headerHeight,
                paddingBottom: footerHeight,
              }}
            >
              <ReviewSummary
                comments={comments}
                workspace={workspace}
                level={level}
                onReturn={() => setSummary(false)}
                onHome={() => setSpace("resume")}
                busy={busy}
                finalization={finalization}
                hasLocalChanges={hasLocalChanges}
                onFinish={onFinish}
                finalizationStarting={finalizationStarting}
                onConfigure={onConfigure}
                onAction={(action) => void act(action)}
              />
            </div>
          ) : isDocument ? (
            <div
              ref={scroller}
              aria-label="Review document"
              className={cn(
                "absolute inset-0 overflow-y-auto",
                !(guided && unit) && "flex flex-col"
              )}
              style={{
                paddingTop: reviewReaderLayout.headerHeight,
                paddingBottom: footerHeight,
              }}
            >
              {readingModeSwitch}
              <div
                className={cn(
                  "mx-auto w-full max-w-[720px] px-8 py-8",
                  !(guided && unit) && "my-auto"
                )}
              >
                {document}
              </div>
            </div>
          ) : (
            <>
              <div
                className="absolute inset-y-0 left-0"
                style={{ right: showRight ? EXPLANATION_WIDTH : 0 }}
              >
                <div
                  className={cn(
                    "absolute inset-0",
                    pinned && "pointer-events-none invisible"
                  )}
                  aria-hidden={!!pinned}
                >
                  <ReviewCodePane
                    onCommentSelection={
                      comments.editable
                        ? (value) =>
                            setCommentSelection(
                              value ? { key: commentKey, value } : null
                            )
                        : undefined
                    }
                    key={`${snapshot.id}/${change.id}`}
                    searchTarget={
                      searchTarget?.path === change.path
                        ? searchTarget
                        : undefined
                    }
                    snapshot={snapshot}
                    change={change}
                    passage={passage}
                    selection={selected}
                    stepLabel={
                      guided && index >= 0 ? `Step ${index + 1}` : undefined
                    }
                    position={review.position}
                    onPosition={(position) => {
                      void onAction({ kind: "savePosition", position })
                    }}
                    overlay={{
                      top: reviewReaderLayout.headerHeight,
                      bottom: footerHeight,
                    }}
                  />
                </div>
                {pinned && (
                  <div className="absolute inset-0">
                    <ReviewReferencePane
                      workspace={workspace}
                      reference={pinned}
                      onCommentSelection={
                        comments.editable
                          ? (value, anchor) =>
                              setCommentSelection(
                                value && anchor
                                  ? { key: commentKey, value, anchor }
                                  : null
                              )
                          : undefined
                      }
                      overlay={{
                        top: reviewReaderLayout.headerHeight,
                        bottom: footerHeight,
                      }}
                    />
                  </div>
                )}
              </div>
              {showRight && (
                <aside
                  aria-label="Explanation"
                  className="absolute inset-y-0 right-0 border-l"
                  style={{ width: EXPLANATION_WIDTH }}
                >
                  <SidebarResizeHandle
                    name="explanation"
                    property="--review-explanation-width"
                    side="right"
                    minWidth={280}
                    maxRatio={0.5}
                  />
                  <div
                    ref={scroller}
                    className="h-full overflow-y-auto"
                    style={{
                      paddingTop: reviewReaderLayout.headerHeight,
                      paddingBottom: footerHeight,
                    }}
                  >
                    {readingModeSwitch}
                    <div className="space-y-4 px-6 py-6">
                      {pinned ? (
                        <>
                          <div className="flex items-start justify-between gap-2">
                            <h2 className="text-sm font-medium">
                              {pinned.label}
                            </h2>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Close pinned reference"
                              onClick={() => setPinned(null)}
                            >
                              <HugeiconsIcon icon={Cancel01Icon} />
                            </Button>
                          </div>
                          <ReviewReferenceContent reference={pinned} />
                        </>
                      ) : (
                        document
                      )}
                    </div>
                  </div>
                </aside>
              )}
            </>
          )}
          <header
            className="absolute inset-x-0 top-0 z-40 flex items-center gap-2 border-b glass-bar px-3"
            style={{ height: reviewReaderLayout.headerHeight }}
          >
            {
              <CodeComments
                key={`${review.repositoryId}/${review.id}`}
                session={comments}
                snapshotId={snapshot.id}
                selection={
                  view === "code" &&
                  !summary &&
                  currentCommentSelection &&
                  (change || commentSelection?.anchor)
                    ? (() => {
                        const anchor =
                          commentSelection?.anchor ??
                          (change
                            ? commentAnchor(
                                snapshot.id,
                                change,
                                currentCommentSelection
                              )
                            : undefined)
                        return anchor
                          ? { value: currentCommentSelection, anchor }
                          : null
                      })()
                    : null
                }
              />
            }
            {(view === "code" || hasReviewDocuments) && (
              <Hint
                label={
                  view === "code"
                    ? filesOpen
                      ? "Hide files"
                      : "Show files"
                    : showSteps
                      ? "Hide review steps"
                      : "Show review steps"
                }
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={view === "code" ? "Files" : "Steps"}
                  aria-pressed={view === "code" ? filesOpen : showSteps}
                  onClick={() => {
                    if (view === "code") setFilesOpen(!filesOpen)
                    else {
                      setSummary(false)
                      setStepsOpen(!showSteps)
                    }
                  }}
                >
                  <HugeiconsIcon icon={SidebarLeftIcon} />
                </Button>
              </Hint>
            )}
            <span
              className="min-w-0 truncate text-sm font-medium max-[1000px]:hidden"
              title={review.title}
            >
              <InlineMarkdown>{review.title}</InlineMarkdown>
            </span>
            <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {cursorIndex >= 0
                ? `${guided ? "Step" : "File"} ${cursorIndex + 1} of ${total}`
                : `${total} ${guided ? "steps" : "files"}`}
            </span>
            {completed && (
              <span className="truncate text-xs text-muted-foreground max-[1250px]:hidden">
                {publicationLabel(review)}
              </span>
            )}
            <div className="flex-1" />
            {hasReviewDocuments && !showSteps && (
              <ReviewContents
                units={units}
                states={states}
                onSelect={(item) => onSelectStep(item.step.step.id)}
              />
            )}
            <Tabs
              value={view}
              onValueChange={(value) => setView(value as "document" | "code")}
            >
              <TabsList className="h-8">
                <Hint
                  label="Rev’s explanation"
                  shortcut="D"
                  side="top"
                  disableHoverablePopup
                >
                  <TabsTrigger value="document" aria-label="Document">
                    <HugeiconsIcon icon={Book02Icon} />
                    <span className="max-[1250px]:hidden">Document</span>
                  </TabsTrigger>
                </Hint>
                <Hint
                  label="Changes as code"
                  shortcut="D"
                  side="top"
                  disableHoverablePopup
                >
                  <TabsTrigger value="code" aria-label="Code">
                    <HugeiconsIcon icon={CodeIcon} />
                    <span className="max-[1250px]:hidden">Code</span>
                  </TabsTrigger>
                </Hint>
              </TabsList>
            </Tabs>
            {hasReviewDocuments && view === "code" && (
              <Hint
                label={
                  explanationRequested ? "Hide explanation" : "Show explanation"
                }
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Explanation"
                  aria-pressed={explanationRequested}
                  onClick={() => setExplanationRequested(!explanationRequested)}
                >
                  <HugeiconsIcon icon={SidebarRightIcon} />
                </Button>
              </Hint>
            )}
            {hasReviewDocuments && !summary && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSummary(true)}
              >
                Review summary
              </Button>
            )}
            {review.mode === "manual" && !summary && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setSummary(true)}
              >
                End review
              </Button>
            )}
            {review.needsUpdateConfirmation && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act({ kind: "completeUpdatedReview" })}
              >
                Complete updated review
              </Button>
            )}
          </header>
          <Dialog open={details} onOpenChange={setDetails}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  <InlineMarkdown>{review.title}</InlineMarkdown>
                </DialogTitle>
                <DialogDescription>
                  {publicationLabel(review)}
                </DialogDescription>
              </DialogHeader>
              <ReviewPublicationDetails
                review={review}
                busy={busy}
                onAction={(action) => void act(action)}
              />
            </DialogContent>
          </Dialog>
          {!summary && !isDocument && file && file.changeIds.length > 1 && (
            <div
              className="absolute top-[104px] right-2 z-20 flex gap-1 rounded-xl glass-bar p-1"
              style={{
                right: showRight ? `calc(${EXPLANATION_WIDTH} + 8px)` : 8,
              }}
              aria-label="File layers"
            >
              {file.changeIds.map((changeId) => {
                const item = snapshot.changes.find(
                  (candidate) => candidate.id === changeId
                )
                return (
                  item && (
                    <Button
                      key={changeId}
                      variant={changeId === change?.id ? "secondary" : "ghost"}
                      size="xs"
                      onClick={() => {
                        setPinned(null)
                        if (guided) {
                          const anchor = unit?.anchors.find(
                            (a) => a.changeId === changeId
                          )
                          if (anchor) openCode(anchor)
                          else
                            void onAction({
                              kind: "savePosition",
                              position: {
                                ...review.position,
                                changeId,
                                passageId: item.passages[0]?.id ?? null,
                                line: 0,
                                scrollTop: 0,
                              },
                            })
                        } else selectFile(file.id, changeId)
                      }}
                    >
                      {item.layer}
                    </Button>
                  )
                )
              })}
            </div>
          )}
          {(fileError || menuError || comments.error) && !summary && (
            <div
              className="absolute inset-x-3 z-30 mx-auto max-w-[640px]"
              style={{ bottom: footerHeight + 8 }}
            >
              <Alert size="sm" variant="faded">
                <HugeiconsIcon icon={InformationCircleIcon} />
                <AlertDescription>
                  {menuError || fileError || comments.error}
                </AlertDescription>
              </Alert>
            </div>
          )}
          {showDecisionFooter && (
            <footer
              className="absolute inset-x-0 bottom-0 z-40 border-t glass-bar px-3"
              style={{ height: reviewReaderLayout.footerHeight }}
            >
              {deciding && (
                <p
                  role="status"
                  className="absolute inset-x-0 bottom-full border-t bg-card p-2 text-center text-sm text-muted-foreground"
                >
                  Saving your decision and finalizing the review…
                </p>
              )}
              <DecisionBar
                unitLabel={guided ? "step" : "file"}
                validated={validated}
                disabled={!canDecide}
                label={
                  guided
                    ? "Validate step and continue"
                    : "Validate file and continue"
                }
                binding={
                  guided
                    ? "This decision belongs to the current step only."
                    : "This decision covers all captured changes of this file."
                }
                canPrevious={cursorIndex > 0 && !deciding}
                canNext={
                  cursorIndex >= 0 && cursorIndex < total - 1 && !deciding
                }
                onValidate={() => {
                  void run(false)
                }}
                onReopen={() => {
                  void run(true)
                }}
                onPrepare={review.mode === "manual" ? onPrepare : undefined}
                onExamine={() => {
                  if (guided && unit)
                    void onAction({
                      kind: "examineStep",
                      stepId: unit.step.step.id,
                    })
                  else if (file)
                    void onAction({ kind: "examineFile", fileId: file.id })
                }}
                onExport={() => {
                  void readerCommands
                    .exportSummary(review.id, level)
                    .catch((cause) =>
                      setFileFailure({
                        key: contentKey,
                        message: errorMessage(cause),
                      })
                    )
                }}
                onPrevious={() => onStep(-1)}
                onNext={() => onStep(1)}
              />
            </footer>
          )}
        </main>
        {showNavigation && (
          <SidebarResizeHandle
            key={isDocument ? "steps" : "files"}
            name={isDocument ? "review steps" : "review files"}
            property={
              isDocument ? "--review-steps-width" : "--review-files-width"
            }
            panelRef={navigationPanel}
            edge="left"
          />
        )}
      </div>
      <RevChat repositoryId={review.repositoryId} reviewId={review.id} />
    </div>
  )
}
