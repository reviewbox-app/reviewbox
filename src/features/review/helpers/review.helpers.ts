import { resolveCodeLanguage } from "@/lib/code/languages"
import type {
  CodeAnchor,
  Passage,
  Review,
  Snapshot,
  Step,
  Topic,
  Workspace,
} from "@/lib/desktop/contracts.generated"
export function anchorFor(
  snapshot: Snapshot,
  changeId: string,
  passage: Passage
): CodeAnchor {
  return { snapshotId: snapshot.id, changeId, passageId: passage.id }
}
/** Guided order is independent of the optional file review. */
export type ReadingUnit = {
  key: string
  step: { topic: Topic; step: Step; index: number }
  anchors: CodeAnchor[]
}

export function readingUnits(workspace: Workspace): ReadingUnit[] {
  return workspace.review.topics.flatMap((topic) =>
    topic.steps.map((step, index) => ({
      key: `step:${step.id}`,
      step: { topic, step, index },
      anchors: step.anchors.filter(
        (anchor) =>
          anchor.snapshotId === workspace.snapshot.id &&
          workspace.snapshot.changes.some(
            (change) =>
              change.id === anchor.changeId &&
              change.passages.some((passage) => passage.id === anchor.passageId)
          )
      ),
    }))
  )
}

/** Only an explicit guided cursor may select a step, never anchor overlap. */
export function currentUnit(workspace: Workspace) {
  if (workspace.review.position.context === "files") return null
  const units = readingUnits(workspace)
  const index = units.findIndex(
    (unit) => unit.step.step.id === workspace.review.position.stepId
  )
  return index < 0 ? null : { unit: units[index], index }
}

export function readingStep(review: Pick<Review, "topics" | "position">) {
  if (review.position.context === "files") return undefined
  const steps = review.topics.flatMap((topic) =>
    topic.steps.map((step) => ({ topic, step }))
  )
  const index = steps.findIndex(
    ({ step }) => step.id === review.position.stepId
  )
  return index < 0 ? undefined : { ...steps[index], index, total: steps.length }
}

export function stepDecision(review: Review, stepId: string) {
  return review.decisions.findLast(
    (decision) =>
      decision.target.kind === "step" &&
      decision.target.stepId === stepId &&
      decision.state === "validated"
  )
}
export function fileDecision(review: Review, fileId: string) {
  return review.decisions.findLast(
    (decision) =>
      decision.target.kind === "file" &&
      decision.target.fileId === fileId &&
      decision.state === "validated"
  )
}

/** A file is visually done when every associated step is validated. */
export function reviewedTreePaths(workspace: Workspace) {
  const stepsByChange = new Map<string, Map<string, boolean>>()
  for (const unit of readingUnits(workspace)) {
    const step = unit.step.step
    const validated =
      !!stepDecision(workspace.review, step.id) &&
      unit.anchors.length === step.anchors.length
    for (const anchor of step.anchors) {
      const steps =
        stepsByChange.get(anchor.changeId) ?? new Map<string, boolean>()
      steps.set(step.id, validated)
      stepsByChange.set(anchor.changeId, steps)
    }
  }
  const reviewed = new Set<string>()
  const folders = new Map<string, boolean>()
  for (const file of workspace.review.files) {
    const associatedSteps = file.changeIds.flatMap((id) => [
      ...(stepsByChange.get(id)?.values() ?? []),
    ])
    const complete =
      !!fileDecision(workspace.review, file.id) ||
      (associatedSteps.length > 0 && associatedSteps.every(Boolean))
    if (complete) reviewed.add(file.path)
    const parts = file.path.split("/").slice(0, -1)
    for (let length = 1; length <= parts.length; length++) {
      const path = parts.slice(0, length).join("/")
      folders.set(path, (folders.get(path) ?? true) && complete)
    }
  }
  for (const [path, complete] of folders) if (complete) reviewed.add(path)
  return reviewed
}

export function guidedProgress(review: Review) {
  const steps = review.topics.flatMap((topic) => topic.steps)
  const validated = steps.filter((step) => stepDecision(review, step.id)).length
  return {
    total: steps.length,
    validated,
    complete: steps.length > 0 && validated === steps.length,
  }
}

/** Snapshot order is fixed; validation never reorders the file list. */
export function orderedReviewFiles(workspace: Workspace) {
  return workspace.review.files
}

export function previousFilePaths(changes: Snapshot["changes"]) {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.previousPath ? [change.previousPath] : []
      )
    ),
  ]
}

export function changeStatus(change: Snapshot["changes"][number]) {
  if (change.previousPath) return "R"
  if (!change.after) return "D"
  if (!change.before) return change.untracked ? "U" : "A"
  return "M"
}

export function readerIdentity(workspace: Workspace) {
  return `${workspace.review.repositoryId}/${workspace.review.id}/${workspace.snapshot.id}`
}

export function readerCursorKey(workspace: Workspace) {
  const position = workspace.review.position
  return `${readerIdentity(workspace)}/${position.context}/${position.context === "files" ? position.fileId : position.stepId}`
}

export function languageFor(path: string) {
  return resolveCodeLanguage(path).id
}

export function fileName(path: string) {
  return path.split("/").at(-1) ?? path
}
export function folderOf(path: string) {
  return path.split("/").slice(0, -1).join("/")
}
/** "18–34" for the side of the passage that exists in the snapshot. */
export function lineRange(passage: Passage) {
  const start = passage.newLines ? passage.newStart : passage.oldStart
  const count = Math.max(passage.newLines || passage.oldLines, 1)
  return count === 1 ? `${start}` : `${start}–${start + count - 1}`
}
/** "line 4" or "lines 18–34". */
export function linesLabel(passage: Passage) {
  const range = lineRange(passage)
  return range.includes("–") ? `lines ${range}` : `line ${range}`
}
export function anchorLabel(workspace: Workspace, anchor?: CodeAnchor) {
  const change = workspace.snapshot.changes.find(
    (c) => c.id === anchor?.changeId
  )
  const passage = change?.passages.find((p) => p.id === anchor?.passageId)
  if (!change || !passage) return null
  return `${fileName(change.path)} · ${lineRange(passage)}`
}
export function languageName(path: string) {
  return resolveCodeLanguage(path).name
}
/** Agent content is attributed as `agent:<harness>:<run>`; humans as `human:<id>`. */
export function authorOf(author: string) {
  if (author.startsWith("agent:")) return { name: "Rev", agent: true }
  return {
    name: "Reviewer",
    agent: false,
    id: author.split(":")[1]?.slice(0, 4),
  }
}
export function shortTime(timestamp: string | number) {
  const date = new Date(Number(timestamp))
  const today = new Date()
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

export function nextReaderTarget(
  workspace: Workspace,
  direction: number
): { kind: "step"; stepId: string } | { kind: "file"; fileId: string } | null {
  const position = workspace.review.position
  if (position.context === "files") {
    const files = orderedReviewFiles(workspace)
    const index = files.findIndex((file) => file.id === position.fileId)
    const target = files[index + direction]
    return target ? { kind: "file", fileId: target.id } : null
  }
  const units = readingUnits(workspace)
  const index = currentUnit(workspace)?.index ?? -1
  const target = units[index + direction]
  return target ? { kind: "step", stepId: target.step.step.id } : null
}
