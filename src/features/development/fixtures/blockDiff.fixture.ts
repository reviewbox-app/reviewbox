const context = (prefix: string) =>
  Array.from({ length: 16 }, (_, i) => `  const ${prefix}${i} = ${i};`).join(
    "\n"
  )

export const blockBefore = [
  "// previous-only heading",
  "export function example() {",
  context("start"),
  '  const mode = "previousOnlyValue";',
  '  const obsolete = "remove with replacement";',
  context("middle"),
  '  const removed = "deletionOnlyValue";',
  context("end"),
  "  return mode;",
  "}",
  "// previous-only ending",
].join("\n")
export const blockAfter = [
  "export function example() {",
  context("start"),
  '  const mode = "currentOnlyValue";',
  "  const result = mode.trim();",
  "  const longer = result.toUpperCase();",
  context("middle"),
  context("end"),
  '  const added = "addedOnlyValue";',
  "  return mode;",
  "}",
].join("\n")

export const largeBlockBefore = Array.from(
  { length: 600 },
  (_, i) => `const before${i} = "old${i}";`
).join("\n")
export const largeBlockAfter = Array.from(
  { length: 600 },
  (_, i) => `const after${i} = "new${i}";`
).join("\n")
