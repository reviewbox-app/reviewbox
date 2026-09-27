"use client"
import { useRef } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  GitBranchIcon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { Repository } from "@/lib/desktop/contracts.generated"
import {
  useNewReviewWizard,
  type CreatedReview,
} from "../hooks/useNewReviewWizard"
import { NewReviewStepper } from "../components/NewReviewStepper"
import { ReviewScopeStep, fileCount } from "../components/ReviewScopeStep"
import {
  FrozenFilesNotice,
  ScopeExplanation,
  PreparationExplanation,
} from "../components/ReviewExplanation"
import { PreparationStep } from "../components/PreparationStep"
import { WizardColumns } from "../components/WizardColumns"
import { HarnessSetupStep } from "./HarnessSetupStep"

interface Props {
  repository: Repository
  open: boolean
  onClose: () => void
  onCreated: (result: CreatedReview) => void
}

export function NewReviewDialog(props: Props) {
  return props.open ? (
    <NewReviewWizard key={props.repository.id} {...props} />
  ) : null
}

const capturePhases: Record<string, string> = {
  preparing: "Preparing files",
  copying_head: "Reading the last commit",
  copying_index: "Reading staged files",
  copying_worktree: "Reading working files",
  copying_base: "Reading the base",
  copying_target: "Reading the target",
  comparing: "Comparing changes",
  verifying: "Checking the frozen files",
  publishing: "Saving the review",
  completed: "Review ready",
}

function NewReviewWizard({ repository, onCreated, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const wizard = useNewReviewWizard(repository.id, onCreated, onClose)
  const { step, capturing, progress } = wizard
  const publishing =
    progress?.phase === "publishing" || progress?.phase === "completed"
  const close = () => {
    if (!publishing) void wizard.close()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        ref={dialogRef}
        initialFocus={dialogRef}
        showCloseButton={false}
        backdropClassName="top-13 bg-transparent! backdrop-blur-none!"
        className="top-13! right-2 bottom-2 left-2! flex w-auto! max-w-none! translate-x-0! translate-y-0! flex-col gap-0 overflow-hidden bg-card! p-0 sm:max-w-none!"
        onKeyDownCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.key !== "Enter"
          )
            return
          const target =
            event.target instanceof HTMLElement ? event.target : null
          if (
            target?.closest(
              "button:not([role=radio]):not([role=checkbox]),input,textarea,[role=combobox],[role=listbox],[role=option]"
            )
          )
            return
          if (
            wizard.canNext &&
            ((step === "preparation" && (event.metaKey || event.ctrlKey)) ||
              (step !== "preparation" && !event.metaKey && !event.ctrlKey))
          ) {
            event.preventDefault()
            event.stopPropagation()
            void wizard.next()
          }
        }}
      >
        <header className="flex min-h-[62px] shrink-0 items-center gap-3 border-b py-4 pr-4 pl-6">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <DialogTitle className="truncate text-xl leading-7">
              New review
            </DialogTitle>
            <DialogDescription className="hidden min-w-0 items-center gap-1.5 text-xs min-[1150px]:flex">
              <HugeiconsIcon
                icon={GitBranchIcon}
                size={14}
                className="shrink-0"
              />
              <span className="truncate">
                {repository.name} · {repository.branch}
              </span>
            </DialogDescription>
          </div>
          {step !== "loading" && (
            <NewReviewStepper step={step} setup={wizard.setup} />
          )}
          <div className="flex min-w-7 flex-1 justify-end">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Close new review"
              disabled={publishing || wizard.cancelling}
              onClick={close}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={16} />
            </Button>
          </div>
        </header>
        {wizard.error && (
          <p
            role="alert"
            className="mx-5 mt-3 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {wizard.error}
          </p>
        )}
        {capturing ? (
          <div
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-6"
            aria-live="polite"
          >
            <Spinner className="size-5" />
            <h3 className="text-lg font-medium">Copying review files…</h3>
            <p className="text-xs text-muted-foreground">
              {fileCount(wizard.selected?.files ?? 0)} ·{" "}
              {capturePhases[progress?.phase ?? "preparing"] ??
                "Preparing files"}
            </p>
            <Progress
              aria-label="Capture progress"
              className="w-full max-w-[360px]"
              value={
                progress?.total
                  ? (100 * progress.completed) / progress.total
                  : null
              }
            />
            {progress?.total != null && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {progress.completed} / {progress.total}
              </p>
            )}
            <FrozenFilesNotice starting />
          </div>
        ) : step === "loading" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Checking review settings and harnesses…
          </div>
        ) : step === "rev" ? (
          <HarnessSetupStep
            provider={wizard.provider}
            providers={wizard.providers.providers}
            checking={wizard.providers.checking}
            error={wizard.providers.error}
            onSelect={wizard.setProvider}
            onDetect={() => void wizard.providers.refresh()}
          />
        ) : (
          <WizardColumns
            left={
              step === "scope" ? (
                <ReviewScopeStep
                  request={wizard.request}
                  preview={wizard.preview}
                  onChange={wizard.change}
                />
              ) : (
                <PreparationStep
                  mode={wizard.mode}
                  ready={wizard.ready}
                  scope={wizard.request.scope}
                  stats={wizard.selected}
                  onChange={wizard.setMode}
                  onBack={() => wizard.setStep("scope")}
                />
              )
            }
            right={
              <div className="w-full max-w-[480px]">
                {step === "scope" ? (
                  <ScopeExplanation
                    scope={wizard.request.scope}
                    stats={wizard.selected}
                    all={wizard.preview?.scopes ?? []}
                    base={wizard.request.base ?? "HEAD~1"}
                    target={wizard.request.target ?? "HEAD"}
                  />
                ) : (
                  <PreparationExplanation mode={wizard.mode} />
                )}
                {wizard.previewing && (
                  <p
                    role="status"
                    className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <Spinner />
                    Updating file counts…
                  </p>
                )}
                {wizard.selected?.error && (
                  <p role="alert" className="mt-4 text-sm text-destructive">
                    {wizard.selected.error}
                  </p>
                )}
                {!wizard.previewing &&
                  wizard.selected &&
                  !wizard.selected.error &&
                  wizard.selected.files === 0 && (
                    <p
                      role="status"
                      className="mt-4 text-sm text-muted-foreground"
                    >
                      No changes. Choose another scope or reference.
                    </p>
                  )}
              </div>
            }
            notice={<FrozenFilesNotice />}
          />
        )}
        <footer className="flex min-h-[57px] shrink-0 items-center gap-2.5 border-t glass-bar py-3 pr-4 pl-7">
          <HugeiconsIcon
            icon={SecurityCheckIcon}
            size={16}
            className="shrink-0 text-muted-foreground"
          />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Read-only: your source files and Git index stay unchanged.
          </p>
          {capturing ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={publishing || wizard.cancelling}
              onClick={close}
            >
              {wizard.cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          ) : (
            <>
              {step === "rev" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={wizard.advancing}
                  onClick={wizard.skip}
                >
                  Continue without Rev
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    step === "preparation"
                      ? wizard.setStep("scope")
                      : wizard.setup
                        ? wizard.setStep("rev")
                        : close()
                  }
                >
                  {step === "preparation" || (step === "scope" && wizard.setup)
                    ? "Back"
                    : "Cancel"}
                </Button>
              )}
              <Kbd>{step === "preparation" ? "⌘↵" : "↵"}</Kbd>
              <Button
                size="sm"
                disabled={!wizard.canNext}
                onClick={() => void wizard.next()}
              >
                {wizard.advancing && <Spinner />}
                {step === "preparation" ? "Start review" : "Next"}
              </Button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
