# Explain the logic of one captured file version

Return {"blocks":[{"startLine":1,"endLine":20,"text":"English pseudo-code"}]}.
The selected source is a complete captured file version. If its text is not inline,
look it up in the captured manifest using sourceId; never substitute working-tree bytes.

Produce concise English pseudo-code for meaningful behavior across the file, not a
line-by-line transcription. Preserve relevant branches, returns, errors, calls and
side effects. Omit decorative markup, trivial constants, repetitive declarations,
comments and whitespace. In React, explain hooks and loading/error/empty/content
conditions instead of transcribing JSX. Never invent behavior or disguise raw source
as pseudo-code. A version with no useful logic can return an empty blocks array.

Use consistent indentation (two spaces per nesting level), with one logical action
per line. Visually nest branches, loops, functions and error handling so that the
control flow is clear at a glance. Preserve this indentation inside each block.

Each block has exact inclusive 1-based source ranges. Keep ranges ordered and
non-overlapping, but gaps and condensed blocks are allowed. There is no requirement
to cover every line, segment or modification. Do not translate unrelated context.
Return only pseudo-code blocks: no reading levels, file document or extra review.
