"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Book02Icon,
  CodeIcon,
  Cancel01Icon,
  InformationCircleIcon,
  MoreHorizontalIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
  TextIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { SidebarResizeHandle } from "@/components/ui/sidebar-resize-handle"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import { Hint } from "../components/Hint"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ReviewReferenceContent } from "@/features/markdown/components/ReviewMarkdown"
import type {
  CodeAnchor,
  DocumentReference,
  ReadingLevel,
  ReviewAction,
  ReviewFileContent,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import { DecisionBar } from "../components/DecisionBar"
import { ReviewContents, type UnitState } from "../components/ReviewContents"
import { ReviewFiles } from "../components/ReviewFiles"
import { ReviewSummary } from "../components/ReviewSummary"
import { StepDocument } from "../components/StepDocument"
import {
  currentUnit,
  guidedProgress,
  fileDecision,
  pseudoAvailable,
  readerCursorKey,
  readerIdentity,
  readingUnits,
  stepDecision,
} from "../helpers/review.helpers"
import { pseudoDiff, pseudoPassage } from "../helpers/pseudocode.helpers"
import { readerCommands } from "../services/reader.commands"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"
import { ReviewCodePane } from "./ReviewCodePane"
import { ReviewReferencePane } from "./ReviewReferencePane"

const HEADER = 56
const FOOTER = 64
const levelNames: Record<ReadingLevel, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  developer: "Developer",
}

export function ReviewReader({
  workspace,
  selected,
  busy,
  onSelect,
  onSelectStep,
  onSelectFile,
  onAction,
  isCurrentCursor,
  onStep,
  onPrepare,
}: {
  workspace: Workspace
  selected: CodeAnchor | null
  busy: boolean
  onSelect: (anchor: CodeAnchor, stepId?: string) => void
  onSelectStep: (stepId: string) => void
  onSelectFile: (fileId: string, changeId?: string) => void
  onAction: (action: ReviewAction) => Promise<boolean>
  isCurrentCursor: (key: string) => boolean
  onStep: (direction: number) => void
  onPrepare: () => void
}) {
  const {
    view,
    setView,
    readerLevel: level,
    setReaderLevel,
    codeMode,
    setCodeMode,
    filesOpen,
    setFilesOpen,
    explanationRequested,
    setExplanationRequested,
    setSpace,
  } = useReviewWorkspaceStore()
  const { review, snapshot } = workspace
  const units = readingUnits(workspace)
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
  const [loaded, setLoaded] = useState<{
    key: string
    content: ReviewFileContent
  } | null>(null)
  const [fileFailure, setFileFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const [summary, setSummary] = useState(false)
  const [codeMenu, setCodeMenu] = useState(false)
  const codeTab = useRef<HTMLButtonElement>(null)
  const [pinned, setPinned] = useState<DocumentReference | null>(null)
  const [deciding, setDeciding] = useState(false)
  const decidingRef = useRef(false)
  const cursorKey = readerCursorKey(workspace)
  const scroller = useRef<HTMLDivElement>(null)
  const contentKey = file ? `${readerIdentity(workspace)}/${file.id}` : ""
  const manualWithoutDocument =
    review.mode === "manual" && !review.preparationId
  const fileContent =
    manualWithoutDocument && file
      ? {
          fileId: file.id,
          documents: null,
          translations: [],
          pseudocodeSkipReason: null,
        }
      : loaded?.key === contentKey
        ? loaded.content
        : null
  const fileError = fileFailure?.key === contentKey ? fileFailure.message : ""
  const fileId = file?.id
  const [stateCursor, setStateCursor] = useState(cursorKey)
  if (stateCursor !== cursorKey) {
    setStateCursor(cursorKey)
    setPinned(null)
    setSummary(false)
  }
  const representation = level === "intermediate" ? "pseudo" : codeMode
  const pseudo = change ? pseudoDiff(change, fileContent) : undefined
  const translatedPassage = change
    ? pseudoPassage(change, passage, fileContent)
    : undefined
  const decision = guided
    ? unit && stepDecision(review, unit.step.step.id)
    : file && fileDecision(review, file.id)
  const validated = !!decision
  const stale = !!unit && unit.anchors.length !== unit.step.step.anchors.length
  const unavailable =
    !guided &&
    (level === "intermediate" || representation === "pseudo") &&
    !!file &&
    !pseudoAvailable(file, snapshot)
  const showDecisionFooter = !summary && units.length > 0
  const footerHeight = showDecisionFooter ? FOOTER : 0
  const canDecide =
    showDecisionFooter &&
    (guided
      ? !!unit && !!unit.anchors.length && !stale
      : !!file && level !== "beginner" && !unavailable) &&
    !busy &&
    !deciding &&
    !summary
  const guideProgress = guidedProgress(review)
  const total = guided ? units.length : review.files.length
  const cursorIndex = guided ? index : fileIndex
  const rightDocument = guided && !!unit
  const showRight =
    level !== "beginner" &&
    view === "code" &&
    explanationRequested &&
    (!!pinned || rightDocument)
  const states: UnitState[] = units.map((item, i) =>
    i === index && guided
      ? "current"
      : stepDecision(review, item.step.step.id)
        ? "validated"
        : item.anchors.length !== item.step.step.anchors.length
          ? "stale"
          : "todo"
  )

  useEffect(() => {
    let alive = true
    if (fileId && !manualWithoutDocument)
      void readerCommands
        .file(review.id, fileId)
        .then((content) => {
          if (alive) {
            setLoaded({ key: contentKey, content })
            setFileFailure((current) =>
              current?.key === contentKey ? null : current
            )
          }
        })
        .catch((cause) => {
          if (alive)
            setFileFailure({ key: contentKey, message: errorMessage(cause) })
        })
    return () => {
      alive = false
    }
  }, [review.id, fileId, contentKey, manualWithoutDocument])
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [cursorKey])
  useEffect(() => {
    if (level === "beginner" && !guided) {
      const last =
        units.find((item) => item.step.step.id === review.position.stepId) ??
        units[0]
      if (last) onSelectStep(last.step.step.id)
    }
  }, [level, guided, review.position.stepId, units, onSelectStep])

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
              : { kind: "validateFile", fileId: file.id, level }
            : null
      if (!action) return
      decidingRef.current = true
      setDeciding(true)
      try {
        const saved = await onAction(action)
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
      level,
      onAction,
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
    if (level === "beginner") return
    setPinned(reference)
    setExplanationRequested(true)
    setView("code")
  }
  const selectFile = (fileId: string, changeId?: string) => {
    setPinned(null)
    onSelectFile(fileId, changeId)
    setView("code")
  }
  const document =
    guided && unit ? (
      <StepDocument
        workspace={workspace}
        unit={unit}
        index={index}
        total={units.length}
        selected={selected}
        stale={stale}
        validatedBy={decision || undefined}
        compact={view === "code" && level !== "beginner"}
        level={level}
        sourceMode={representation}
        onOpenCode={openCode}
        onOpenReference={pinReference}
      />
    ) : (
      <div className="space-y-3 py-16 text-center">
        <h1 className="text-xl font-medium">
          {guided ? "No guided steps yet" : "Explore the captured file"}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {level === "beginner"
            ? "Prepare a review with Rev to read the changes as a document."
            : "Use the code view to inspect the captured file."}
        </p>
        {review.mode === "manual" && (
          <Button onClick={onPrepare}>Prepare with Rev</Button>
        )}
        {level !== "beginner" && (
          <Button variant="secondary" onClick={() => setView("code")}>
            Open code
          </Button>
        )}
      </div>
    )
  const isDocument = level === "beginner" || view === "document" || !change

  return (
    <main
      className="relative min-w-0 flex-1 overflow-hidden rounded-panel border bg-card"
      aria-label="Review"
      data-resize-workspace
    >
      {summary ? (
        <div
          className="absolute inset-0 overflow-y-auto"
          style={{ paddingTop: HEADER, paddingBottom: footerHeight }}
        >
          <ReviewSummary
            workspace={workspace}
            level={level}
            onReturn={() => setSummary(false)}
            onHome={() => setSpace("resume")}
          />
        </div>
      ) : isDocument ? (
        <div
          ref={scroller}
          aria-label="Review document"
          className="absolute inset-0 overflow-y-auto"
          style={{ paddingTop: HEADER, paddingBottom: footerHeight }}
        >
          <div className="mx-auto w-full max-w-[720px] px-8 py-12">
            {document}
          </div>
        </div>
      ) : (
        <>
          <div
            className={cn(
              "absolute inset-y-0 left-0",
              filesOpen &&
                "min-[1100px]:left-[clamp(180px,var(--review-files-width,240px),35%)]"
            )}
            style={{ right: showRight ? "min(440px,40%)" : 0 }}
          >
            <div
              className={cn(
                "absolute inset-0",
                pinned && "pointer-events-none invisible"
              )}
              aria-hidden={!!pinned}
            >
              <ReviewCodePane
                key={`${snapshot.id}/${change.id}/${representation}`}
                snapshot={snapshot}
                change={change}
                passage={
                  representation === "pseudo" ? translatedPassage : passage
                }
                selection={selected}
                stepLabel={
                  guided && index >= 0 ? `Step ${index + 1}` : undefined
                }
                position={review.position}
                onPosition={(position) => {
                  void onAction({ kind: "savePosition", position })
                }}
                overlay={{ top: HEADER, bottom: footerHeight }}
                representation={representation}
                pseudo={pseudo}
              />
            </div>
            {pinned && (
              <div className="absolute inset-0">
                <ReviewReferencePane
                  workspace={workspace}
                  reference={pinned}
                  level={level}
                  representation={representation}
                  overlay={{ top: HEADER, bottom: footerHeight }}
                />
              </div>
            )}
          </div>
          {filesOpen && (
            <aside
              aria-label="Review files"
              className="absolute left-0 z-30 w-[clamp(180px,var(--review-files-width,240px),35%)] border-r bg-card max-[1100px]:shadow-xl"
              style={{ top: HEADER, bottom: footerHeight }}
            >
              <ReviewFiles
                workspace={workspace}
                selectedId={guided ? null : (file?.id ?? null)}
                level={level}
                onSelect={selectFile}
              />
              <SidebarResizeHandle
                name="review files"
                property="--review-files-width"
              />
            </aside>
          )}
          {showRight && (
            <aside
              ref={scroller}
              aria-label="Explanation"
              className="absolute inset-y-0 right-0 w-[min(440px,40%)] overflow-y-auto border-l"
              style={{ paddingTop: HEADER, paddingBottom: footerHeight }}
            >
              <div className="space-y-4 px-6 py-6">
                {pinned ? (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="text-sm font-medium">{pinned.label}</h2>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Close pinned reference"
                        onClick={() => setPinned(null)}
                      >
                        <HugeiconsIcon icon={Cancel01Icon} />
                      </Button>
                    </div>
                    <ReviewReferenceContent
                      reference={pinned}
                      level={level}
                      reviewId={review.id}
                      snapshotId={snapshot.id}
                      files={review.files}
                      sourceMode={representation}
                    />
                  </>
                ) : (
                  document
                )}
              </div>
            </aside>
          )}
        </>
      )}
      <header
        className="absolute inset-x-0 top-0 z-40 flex items-center gap-2 border-b glass-bar px-3"
        style={{ height: HEADER }}
      >
        {level !== "beginner" && view === "code" && (
          <Hint label={filesOpen ? "Hide files" : "Show files"}>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Files"
              aria-pressed={filesOpen}
              onClick={() => setFilesOpen(!filesOpen)}
            >
              <HugeiconsIcon icon={SidebarLeftIcon} />
            </Button>
          </Hint>
        )}
        <span
          className="min-w-0 truncate text-sm font-medium max-[1000px]:hidden"
          title={review.title}
        >
          {review.title}
        </span>
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {cursorIndex >= 0
            ? `${guided ? "Step" : "File"} ${cursorIndex + 1} of ${total}`
            : `${total} ${guided ? "steps" : "files"}`}
        </span>
        <div className="flex-1" />
        <Select
          value={level}
          onValueChange={(value) => {
            if (value) setReaderLevel(value as ReadingLevel)
          }}
        >
          <Hint label="Reading level">
            <SelectTrigger aria-label="Reading level">
              <SelectValue>{levelNames[level]}</SelectValue>
            </SelectTrigger>
          </Hint>
          <SelectContent>
            {(Object.keys(levelNames) as ReadingLevel[]).map((value) => (
              <SelectItem key={value} value={value}>
                {levelNames[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {level !== "beginner" && (
          <Tabs
            value={view}
            onValueChange={(value) => setView(value as "document" | "code")}
          >
            <TabsList className="h-8">
              <Hint label="Rev’s explanation" shortcut="D">
                <TabsTrigger value="document" aria-label="Document">
                  <HugeiconsIcon icon={Book02Icon} />
                  <span className="max-[1250px]:hidden">Document</span>
                </TabsTrigger>
              </Hint>
              <Hint
                label={
                  level === "developer" && view === "code"
                    ? "Click again to choose code or pseudo-code"
                    : representation === "pseudo"
                      ? "Changes as pseudo-code"
                      : "Changes as code"
                }
                shortcut="D"
              >
                <TabsTrigger
                  ref={codeTab}
                  value="code"
                  aria-label="Code"
                  aria-haspopup={level === "developer" ? "menu" : undefined}
                  aria-expanded={level === "developer" ? codeMenu : undefined}
                  className={cn(level === "developer" && "pr-2")}
                  onClick={() => {
                    // A second click on the selected tab chooses what it shows.
                    if (level === "developer" && view === "code")
                      setCodeMenu(true)
                  }}
                >
                  <HugeiconsIcon icon={CodeIcon} />
                  <span className="max-[1250px]:hidden">
                    {representation === "pseudo" ? "Pseudo-code" : "Code"}
                  </span>
                  {level === "developer" && (
                    <HugeiconsIcon
                      icon={MoreHorizontalIcon}
                      aria-hidden
                      className="size-3.5! opacity-60"
                    />
                  )}
                </TabsTrigger>
              </Hint>
              {level === "developer" && (
                <DropdownMenu open={codeMenu} onOpenChange={setCodeMenu}>
                  <DropdownMenuContent
                    anchor={codeTab}
                    align="end"
                    className="w-44"
                    aria-label="Code representation"
                  >
                    <DropdownMenuRadioGroup
                      value={codeMode}
                      onValueChange={(value) =>
                        setCodeMode(value as "real" | "pseudo")
                      }
                    >
                      <DropdownMenuRadioItem value="real" closeOnClick>
                        <HugeiconsIcon icon={CodeIcon} />
                        Code
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="pseudo" closeOnClick>
                        <HugeiconsIcon icon={TextIcon} />
                        Pseudo-code
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </TabsList>
          </Tabs>
        )}
        {level !== "beginner" && view === "code" && (
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
        <ReviewContents
          units={units}
          states={states}
          onSelect={(item) => onSelectStep(item.step.step.id)}
        />
      </header>
      {!summary && !isDocument && file && file.changeIds.length > 1 && (
        <div
          className="absolute top-[104px] right-2 z-20 flex gap-1 rounded-xl glass-bar p-1"
          style={{ right: showRight ? "calc(min(440px,40%) + 8px)" : 8 }}
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
      {(unavailable || fileError) && !summary && (
        <div
          className="absolute inset-x-3 z-30 mx-auto max-w-[640px]"
          style={{ bottom: footerHeight + 8 }}
        >
          <Alert size="sm" variant="faded">
            <HugeiconsIcon icon={InformationCircleIcon} />
            <AlertDescription>
              {fileError ||
                "Pseudocode is unavailable for part of this file. In Developer mode, choose Code to inspect and validate it."}
            </AlertDescription>
          </Alert>
        </div>
      )}
      {showDecisionFooter && (
        <footer
          className="absolute inset-x-0 bottom-0 z-40 border-t glass-bar"
          style={{ height: FOOTER }}
        >
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
            canNext={cursorIndex >= 0 && cursorIndex < total - 1 && !deciding}
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
  )
}
