import { expect, test } from "bun:test"
import { canCreateProjectFile, editableProjectPath } from "./editorPaths"

test("metadata menus offer only free collaboration documents and preserve managed directories", () => {
  for (const path of [
    "src/a.ts",
    ".reviewbox/CURRENT_CHANGES.md",
    ".reviewbox/.local/REVIEW_COMMENTS.md",
    ".reviewbox/.gitignore",
  ])
    expect(editableProjectPath(path)).toBe(true)
  for (const path of [
    ".reviewbox",
    ".reviewbox/settings.json",
    ".reviewbox/published/review/explanation.md",
    ".reviewbox/.local/captures/a.md",
    ".reviewbox/.local",
  ])
    expect(editableProjectPath(path)).toBe(false)
  expect(canCreateProjectFile(".reviewbox/.local")).toBe(true)
  expect(canCreateProjectFile(".reviewbox/published")).toBe(false)
})
