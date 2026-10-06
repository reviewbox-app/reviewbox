import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  ReviewFinalization as Operation,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import type { ReviewFinalizationSession } from "../hooks/useReviewFinalization"
import { ReviewSummary } from "../components/ReviewSummary"
import { ReviewReader } from "./ReviewReader"

const workspace = {
  review: {
    id: "review",
    repositoryId: "repo",
    title: "Checkout",
    mode: "guided",
    publication: {
      status: "draft",
      completion: null,
      keepLocal: false,
      matchingCommitIds: [],
    },
    topics: [{ steps: [{ id: "last", title: "Last step" }] }],
    decisions: [],
  },
} as unknown as Workspace
const operation: Operation = {
  id: "finalization",
  repositoryId: "repo",
  reviewId: "review",
  sequence: 1,
  action: { kind: "validateStep", stepId: "last" },
  status: "running",
  error: null,
  steps: [
    {
      id: "save",
      title: "Save review decision",
      status: "running",
      startedAt: "1000",
      finishedAt: null,
      error: null,
    },
    {
      id: "archive",
      title: "Archive review",
      status: "queued",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
  ],
}
function render(value: Workspace, op: Operation | null, starting = false) {
  const finalization = {
    operation: op,
    starting,
    active: starting || op?.status === "running",
    error: "",
    retryAction: { kind: "retryPublication" },
  } as ReviewFinalizationSession
  return renderToStaticMarkup(
    <ReviewSummary
      workspace={value}
      level="explained"
      busy={false}
      finalization={finalization}
      finalizationStarting={starting}
      onReturn={() => {}}
      onHome={() => {}}
      onAction={() => {}}
    />
  )
}

test("summary can render while the native start command is still pending", () => {
  const html = render(workspace, null, true)
  expect(html).toContain("Finalizing review")
  expect(html).toContain("Saving your final review decision")
  expect(html).toContain("0 of 1 steps validated")
  expect(html).not.toContain("Review complete")
  expect(html).toMatch(/<button[^>]*>Back home<\/button>/)
  expect(html).toContain("Back to review")
})

test("durable validation does not announce finished finalization while publication runs", () => {
  const value = {
    ...workspace,
    review: {
      ...workspace.review,
      publication: {
        ...workspace.review.publication,
        status: "publicationPending",
        completion: {
          kind: "guided",
          author: "human:reviewer",
          completedAt: "1000",
          scope: "local",
        },
      },
    },
  } as Workspace
  const html = render(value, operation)
  expect(html).toContain("Your review decision is saved")
  expect(html).toContain("Finalizing review")
  expect(html).not.toContain("Review complete")
})

test("failed and skipped steps keep distinct statuses and expose retry", () => {
  const html = render(workspace, {
    ...operation,
    status: "failed",
    error: { code: "write", message: "Publication failed", retryable: true },
    steps: [
      { ...operation.steps[0], status: "completed", finishedAt: "2000" },
      { ...operation.steps[1], status: "skipped" },
    ],
  })
  expect(html).toContain("Review needs attention")
  expect(html).toContain("Your review decision is saved")
  expect(html).toContain("Not needed")
  expect(html).toContain("Publication failed")
  expect(html).toContain("Retry finalization")
  expect(html).not.toContain("Review complete")
})

test("returning to a review with a restored operation opens its summary", () => {
  const value = {
    ...workspace,
    snapshot: { id: "snapshot", changes: [] },
    review: {
      ...workspace.review,
      files: [],
      topics: [],
      position: { context: "guided", stepId: null },
    },
  } as unknown as Workspace
  const finalization = {
    operation,
    active: true,
    checking: false,
    starting: false,
    error: "",
  } as ReviewFinalizationSession
  const html = renderToStaticMarkup(
    <ReviewReader
      workspace={value}
      selected={null}
      busy
      finalization={finalization}
      onSelect={() => {}}
      onSelectStep={() => {}}
      onSelectFile={() => {}}
      onViewChange={() => {}}
      onAction={async () => true}
      isCurrentCursor={() => true}
      onStep={() => {}}
      onPrepare={() => {}}
    />
  )
  expect(html).toContain("Finalizing review")
  expect(html).toContain("Finalization steps")
  expect(html).toContain("Back to review")
})

test("a manual draft without a finalization still opens the captured review", () => {
  const value = {
    ...workspace,
    snapshot: { id: "snapshot", changes: [] },
    review: {
      ...workspace.review,
      mode: "manual",
      files: [],
      topics: [],
      position: { context: "files", fileId: null },
    },
  } as unknown as Workspace
  const html = renderToStaticMarkup(
    <ReviewReader
      workspace={value}
      selected={null}
      busy={false}
      onSelect={() => {}}
      onSelectStep={() => {}}
      onSelectFile={() => {}}
      onViewChange={() => {}}
      onAction={async () => true}
      isCurrentCursor={() => true}
      onStep={() => {}}
      onPrepare={() => {}}
    />
  )
  expect(html).toContain("End review")
  expect(html).not.toContain("Back to review")
  expect(html).not.toContain("Review finalization")
})
