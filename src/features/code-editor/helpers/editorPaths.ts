/** Presentation mirrors native protection; Rust remains authoritative for every mutation. */
export function isReviewBoxPath(path: string) {
  return path.split("/")[0]?.toLowerCase() === ".reviewbox"
}
export function editableProjectPath(path: string) {
  if (!isReviewBoxPath(path)) return true
  const name = path.replace(/^\.reviewbox\/(\.local\/)?/, "")
  return (
    !name.includes("/") &&
    (name === ".gitignore" || name.toLowerCase().endsWith(".md"))
  )
}
export function canCreateProjectFile(folder: string) {
  return (
    !isReviewBoxPath(folder) ||
    folder === ".reviewbox" ||
    folder === ".reviewbox/.local"
  )
}
