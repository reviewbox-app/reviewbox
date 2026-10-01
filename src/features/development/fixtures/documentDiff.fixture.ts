export const documentBefore = [
  "# Captured guide",
  "",
  "The result is **41** for this review.",
  "A second line stays visible.",
  "",
  "- Parent item",
  "  - Nested old value",
  "",
  "| Setting | Value |",
  "| --- | --- |",
  "| Attempts | 3 |",
  "| Storage | Private application data |",
  "",
  "> A quoted explanation.",
  "",
  "[Reference documentation][guide]",
  "",
  "```typescript",
  "const result = 41",
  "```",
  "",
  ...Array.from({ length: 70 }, (_, index) => [
    `## Section ${index + 1}`,
    "",
    `Paragraph ${index + 1}: This is the captured documentation, with enough context to read the entire file. ${index === 49 ? "Needle outcome." : "Unchanged context."}`,
    "",
  ]).flat(),
  "End of captured document.",
  "",
  "[guide]: https://example.com/old",
].join("\n")

export const documentAfter = documentBefore
  .replace("**41**", "**42**")
  .replace("const result = 41", "const result = 42")
  .replace("Nested old value", "Nested fresh content")
  .replace("| Attempts | 3 |", "| Attempts | 4 |")
  .replace("Private application data", "Local only")
  .replace(
    "> A quoted explanation.",
    "> A quoted explanation.\n\nA newly added paragraph needs no inline highlight."
  )
  .replace("https://example.com/old", "https://example.com/new")
