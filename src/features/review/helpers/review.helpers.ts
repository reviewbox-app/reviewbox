import type { ReadingStatus } from "../components/ReviewStatus"
import type {
  CodeAnchor,
  Change,
  Passage,
  Review,
  Snapshot,
  Workspace,
} from "@/lib/desktop/contracts.generated"
export function anchorFor(
  snapshot: Snapshot,
  changeId: string,
  passage: Passage
): CodeAnchor {
  return { snapshotId: snapshot.id, changeId, passageId: passage.id }
}
/** Several reading steps may deliberately discuss the same source passage. */
export function readingStep(
  review: Pick<Review, "topics" | "position">,
  anchor: CodeAnchor | null
) {
  const matches = review.topics.flatMap((topic) =>
    topic.steps.flatMap((step, index) =>
      step.anchors.some(
        (a) =>
          a.passageId === anchor?.passageId &&
          a.snapshotId === anchor.snapshotId &&
          a.changeId === anchor.changeId
      )
        ? [{ topic, step, index }]
        : []
    )
  )
  return (
    matches.find(({ step }) => step.id === review.position.stepId) ?? matches[0]
  )
}
export function isValidated(
  review: Review,
  anchor: CodeAnchor,
  fingerprint: string
) {
  return review.decisions.some(
    (d) =>
      d.anchor.snapshotId === anchor.snapshotId &&
      d.anchor.passageId === anchor.passageId &&
      d.fingerprint === fingerprint
  )
}
export function passageStatus(
  workspace: Workspace,
  anchor: CodeAnchor
): ReadingStatus {
  const passage = workspace.snapshot.changes
    .find((c) => c.id === anchor.changeId)
    ?.passages.find((p) => p.id === anchor.passageId)
  if (anchor.snapshotId !== workspace.snapshot.id || !passage)
    return "Re-review"
  if (
    workspace.review.annotations.some(
      (n) =>
        n.question && !n.resolved && n.anchor.passageId === anchor.passageId
    )
  )
    return "Question"
  if (isValidated(workspace.review, anchor, passage.fingerprint))
    return "Validated"
  return workspace.review.examined.includes(passage.id)
    ? "In progress"
    : "Unread"
}
export function languageFor(path: string) {
  const ext = path.split(".").at(-1) ?? ""
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        rs: "rust",
        py: "python",
        json: "json",
        md: "markdown",
        css: "css",
        html: "html",
        go: "go",
        java: "java",
        sh: "shell",
        yml: "yaml",
        yaml: "yaml",
        toml: "ini",
        cpp: "cpp",
        h: "cpp",
      } as Record<string, string>
    )[ext] ?? "plaintext"
  )
}

/** Aggregated state of a topic: attention first, then questions, then progress. */
export function topicStatus(statuses: ReadingStatus[]): ReadingStatus {
  if (statuses.includes("Re-review")) return "Re-review"
  if (statuses.includes("Question")) return "Question"
  if (statuses.length && statuses.every((s) => s === "Validated"))
    return "Validated"
  if (statuses.some((s) => s !== "Unread")) return "In progress"
  return "Unread"
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
/** Git status letter shown in file rows. */
export function changeLetter(change: Change) {
  if (change.binary) return "B"
  if (change.previousPath) return "R"
  if (!change.before) return change.layer === "untracked" ? "U" : "A"
  if (!change.after) return "D"
  return "M"
}
const languageNames: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  rust: "Rust",
  python: "Python",
  json: "JSON",
  markdown: "Markdown",
  css: "CSS",
  html: "HTML",
  go: "Go",
  java: "Java",
  shell: "Shell",
  yaml: "YAML",
  ini: "TOML",
  cpp: "C++",
  plaintext: "Plain text",
}
export function languageName(path: string) {
  const language = languageFor(path)
  return languageNames[language] ?? language
}
/** Agent notes are stored as `agent:<harness>:<run>`; humans as `human:<id>`. */
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
/** Plain text of a note body stored as Tiptap JSON (or legacy plain text). */
export function plainText(body: string) {
  try {
    const walk = (node: { text?: string; content?: unknown[] }): string =>
      (node.text ?? "") +
      (node.content ?? [])
        .map((child) => walk(child as { text?: string; content?: unknown[] }))
        .join(node.content && node.text === undefined ? " " : "")
    return walk(JSON.parse(body)).replace(/\s+/g, " ").trim()
  } catch {
    return body
  }
}

/** One row per captured path, even when staged and unstaged layers coexist. */
export function groupFileAnchors(snapshot: Snapshot, anchors: CodeAnchor[]) {
  const selected = new Set(
    anchors
      .filter((a) => a.snapshotId === snapshot.id)
      .map((a) => `${a.changeId}/${a.passageId}`)
  )
  const files = new Map<
    string,
    { path: string; anchors: CodeAnchor[]; layers: string[]; total: number }
  >()
  for (const change of snapshot.changes) {
    const group = files.get(change.path) ?? {
      path: change.path,
      anchors: [],
      layers: [],
      total: 0,
    }
    group.total += change.passages.length
    for (const passage of change.passages) {
      if (selected.has(`${change.id}/${passage.id}`)) {
        group.anchors.push(anchorFor(snapshot, change.id, passage))
        if (!group.layers.includes(change.layer))
          group.layers.push(change.layer)
      }
    }
    files.set(change.path, group)
  }
  return [...files.values()].filter((file) => file.anchors.length > 0)
}

export function outsideReviewFiles(workspace: Workspace) {
  const covered = new Set(
    workspace.review.topics
      .flatMap((topic) => topic.steps.flatMap((step) => step.anchors))
      .filter((a) => a.snapshotId === workspace.snapshot.id)
      .map((a) => `${a.changeId}/${a.passageId}`)
  )
  return groupFileAnchors(
    workspace.snapshot,
    workspace.snapshot.changes.flatMap((change) =>
      change.passages
        .filter((passage) => !covered.has(`${change.id}/${passage.id}`))
        .map((passage) => anchorFor(workspace.snapshot, change.id, passage))
    )
  )
}
