import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReviewUpdateStatus } from "./ReviewUpdateStatus"
import { ReviewPreparationContent } from "../components/ReviewPreparationContent"
import type { useReviewUpdate } from "../hooks/useReviewUpdate"
import type {
  PreparationState,
  Workspace,
} from "@/lib/desktop/contracts.generated"

const action = async () => {}
const workspace = {
  review: {
    title: "Review",
    preparationId: "job",
    publication: { status: "draft" },
  },
  snapshot: { changes: [] },
} as unknown as Workspace
function controller(
  status: PreparationState["status"]
): ReturnType<typeof useReviewUpdate> {
  return {
    owner: "review",
    readyId: status === "ready" ? "update" : null,
    readyToOpen: status === "ready",
    startCreation: action,
    state: {
      id: "update",
      reviewId: "review",
      snapshotId: "next",
      provider: "codex",
      status,
      phase: "documents",
      canResume: true,
      phases: [],
      error: null,
      activeBatches: [],
      completedBatches: 1,
      totalBatches: 2,
      steps: [
        { id: "step:0:0", title: "The changed behavior", status: "ready" },
      ],
      events: [],
      startedAt: "0",
      updatedAt: "1",
    },
    progress: null,
    pending: false,
    active: status === "running",
    needsOpen: false,
    message: "",
    error: "",
    start: action,
    resume: action,
    cancel: action,
    discard: action,
    openReview: action,
  }
}
function render(status: PreparationState["status"], changed = false) {
  return renderToStaticMarkup(
    <ReviewUpdateStatus
      update={controller(status)}
      workspace={workspace}
      changed={changed}
      busy={false}
      onDelete={action}
      onRead={action}
    />
  )
}
test("progress uses one icon-only control without a persistent banner", () => {
  const html = render("running")
  expect(html).toContain('aria-label="Rev: In progress"')
  expect(html).toContain('data-slot="spinner"')
  expect(html).not.toContain("review-update-status")
  expect(html).not.toContain("View progress")
})
test("the control distinguishes ready, changed and interrupted reviews", () => {
  expect(render("ready")).toContain('aria-label="Rev: Review done"')
  expect(render("ready", true)).toContain('aria-label="Rev: Update with Rev"')
  expect(render("interrupted")).toContain(
    'aria-label="Rev: Review interrupted"'
  )
})
test("Rev uses semantic status colors and prioritizes a failed pass over stale code", () => {
  const failed = render("failed", true)
  expect(failed).toContain('aria-label="Rev: Review failed"')
  expect(failed).toContain('data-rev-status="failed"')
  expect(failed).toContain("bg-destructive/10")
  expect(failed).toContain("text-destructive")
  const stale = render("ready", true)
  expect(stale).toContain('data-rev-status="stale"')
  expect(stale).toContain("bg-review-attention-soft")
  expect(stale).toContain("text-review-attention")
  const done = render("ready")
  expect(done).toContain('data-rev-status="done"')
  expect(done).toContain("bg-review-validated-soft")
  expect(done).toContain("text-review-validated")
  const running = render("running", true)
  expect(running).toContain('data-rev-status="running"')
  expect(running).not.toContain("bg-review-attention-soft")
})
test("creation and adaptation share their phase rows and ready titles", () => {
  const renderContent = (
    updating: boolean,
    status: PreparationState["status"]
  ) =>
    renderToStaticMarkup(
      <ReviewPreparationContent
        workspace={workspace}
        preparation={{ ...controller(status), status: "Working" }}
        updating={updating}
        onStart={action}
        onLeave={action}
        onDiscard={action}
      />
    )
  for (const updating of [false, true]) {
    expect(renderContent(updating, "running")).toContain("Rev’s work")
    expect(renderContent(updating, "running")).toContain(
      "Writing the reading path"
    )
    expect(renderContent(updating, "ready")).toContain("The changed behavior")
    expect(renderContent(updating, "interrupted")).toContain(
      "Resume preparation"
    )
  }
  expect(renderContent(true, "interrupted")).toContain("Discard update")
})

test("ready dialogs distinguish stale sources, pending checks and worktree sync", () => {
  const doc = {
    ...workspace,
    review: {
      ...workspace.review,
      topics: [
        {
          steps: [
            { id: "one", title: "Changed behavior" },
            { id: "two", title: "Unchanged behavior" },
          ],
        },
      ],
    },
  } as unknown as Workspace
  const renderStatus = (needsUpdate: boolean, checking = false) =>
    renderToStaticMarkup(
      <ReviewPreparationContent
        workspace={doc}
        preparation={{ ...controller("ready"), status: "" }}
        updating
        onStart={action}
        onLeave={action}
        reviewStatus={{
          needsUpdate,
          checking,
          staleStepIds: needsUpdate ? ["one"] : [],
          busy: false,
          onUpdate: action,
        }}
      />
    )
  const stale = renderStatus(true)
  expect(stale).toContain("Your review needs an update")
  expect(stale).not.toContain("Preparation finished")
  expect(stale).not.toContain("Your review is updated")
  expect(stale.match(/line-through/g)).toHaveLength(1)
  expect(stale).toContain("opacity-60")
  expect(stale).toContain("text-review-attention")
  expect(stale.indexOf("Back to review")).toBeLessThan(
    stale.indexOf(">Update with Rev")
  )
  expect(stale).toContain("justify-end")
  expect(stale).not.toContain("py-16")
  const synced = renderStatus(false)
  expect(synced).toContain("Your review is updated")
  expect(synced).toContain("Preparation finished")
  expect(synced).not.toContain("line-through")
  expect(synced.indexOf(">Update with Rev")).toBeLessThan(
    synced.indexOf("Back to review")
  )
  const checking = renderStatus(false, true)
  expect(checking).toContain("Checking your review")
  expect(checking).not.toContain("Your review is updated")
  expect(checking).not.toContain("Preparation finished")
})
