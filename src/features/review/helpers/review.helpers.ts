import type {
  CodeAnchor,
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
export function passageStatus(workspace: Workspace, anchor: CodeAnchor) {
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
