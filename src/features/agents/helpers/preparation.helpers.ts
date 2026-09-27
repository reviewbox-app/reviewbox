import type { CodeAnchor, Snapshot } from "@/lib/desktop/contracts.generated"
import type { PreparedTopic } from "../contracts/preparation.types"

export function anchorLabel(snapshot: Snapshot, anchor: CodeAnchor) {
  if (anchor.snapshotId !== snapshot.id) return "Another snapshot"
  const change = snapshot.changes.find((item) => item.id === anchor.changeId)
  const passage = change?.passages.find((item) => item.id === anchor.passageId)
  if (!change || !passage) return "Unresolved passage"
  const start = passage.newLines ? passage.newStart : passage.oldStart
  const count = passage.newLines || passage.oldLines
  return `${change.path} · ${change.layer} · ${start}–${Math.max(start, start + count - 1)}`
}

/** Coverage reflects only the topics the user chose to add, never validation. */
export function outsidePreparation(
  snapshot: Snapshot,
  topics: PreparedTopic[]
) {
  const accepted = new Set(
    topics
      .filter((item) => item.choice === "accepted" && !item.diagnostics.length)
      .flatMap((item) => item.topic.steps)
      .flatMap((step) => step.anchors)
      .filter((anchor) => anchor.snapshotId === snapshot.id)
      .map((anchor) => `${anchor.changeId}/${anchor.passageId}`)
  )
  return snapshot.changes.flatMap((change) =>
    change.passages
      .filter((passage) => !accepted.has(`${change.id}/${passage.id}`))
      .map((passage) => ({
        snapshotId: snapshot.id,
        changeId: change.id,
        passageId: passage.id,
      }))
  )
}
