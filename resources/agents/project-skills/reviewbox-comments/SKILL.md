---
name: reviewbox-comments
description: Address ReviewBox manual-review comments while preserving their anchors and recording corrections and tests.
---

# Addressing review comments

Read `.reviewbox/.local/REVIEW_COMMENTS.md` and also check
`.reviewbox/REVIEW_COMMENTS.md` when it exists. The local file is the current
ReviewBox comment store; the shared file may contain earlier feedback. Follow the
review/capture identity supplied in the user's correction prompt; do not process
unrelated reviews merely because they share a file.

Comments are Markdown blocks delimited by `REVIEWBOX_START` and `REVIEWBOX_END`.
Preserve their identifiers, metadata, original comment and unrelated prose. Their
anchors describe captured source, including the before/after side, path, source
hash and excerpt. Lines and UTF-16 columns start at 1; the ending position is
exclusive. For renamed/deleted files, locate the corresponding current code or
explain why the correction no longer applies. Never apply a stale range blindly.

Implement relevant corrections within the user's scope and run appropriate tests.
For each completed correction, change its status from `open` to `addressed` and
record what changed and which tests actually ran in the `resolution` and `tests`
string fields of the opening marker's JSON metadata. The opening line has the
form `<!-- REVIEWBOX_START#startLine:startColumn<->endLine:endColumn {metadata} -->`;
the closing line is `<!-- REVIEWBOX_END#comment-id -->`. The original remark is
the Markdown between these markers. Preserve `id`, `reviewId`, `anchor` and
`createdAt`, update `updatedAt` to the current Unix time in milliseconds as a
string, and do not invent additional metadata keys. Preserve valid JSON escaping
when recording multiline evidence. Keep the original remark. Leave unresolved remarks open
with a clear explanation; do not silently remove them. Do not insert these marker
blocks into source files and do not alter native review/capture metadata.

An addressed status is not human validation. Summarize corrections for the user
and refresh `CURRENT_CHANGES.md` using `reviewbox-changes`.
