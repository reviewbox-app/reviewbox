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
  for (const topic of review.topics) {
    const index = topic.steps.findIndex(
      (step) => step.id === review.position.stepId
    )
    if (index >= 0) return { topic, step: topic.steps[index], index }
  }
  return undefined
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

export function pseudoAvailable(
  file: Workspace["review"]["files"][number],
  snapshot: Snapshot
) {
  if (file.pseudocodeSelected === false || file.pseudocodeSkipReason?.trim())
    return true
  const sources = snapshot.changes
    .filter((change) => file.changeIds.includes(change.id))
    .flatMap((change) => [
      ...(change.before ? [`change:${change.id}:before`] : []),
      ...(change.after ? [`change:${change.id}:after`] : []),
    ])
  return (
    sources.length > 0 &&
    sources.every((sourceId) =>
      file.translations.some(
        (translation) =>
          translation.sourceId === sourceId && translation.available
      )
    )
  )
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
