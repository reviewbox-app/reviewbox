Please address the human code comments for checkout context `{{context_id}}`.

Read `.reviewbox/.local/REVIEW_COMMENTS.md` first and check `.reviewbox/REVIEW_COMMENTS.md` if present. Follow AGENTS.md and the project's ReviewBox skills when available.

Use only blocks whose `reviewId` matches this context. These are local code notes, not a review. Each `anchor.local` records the source layer (file, staged or unstaged), side, lookup path and version. The anchor preserves the original path, content hash, selected excerpt and one-based lines and UTF-16 columns (exclusive end). Compare the excerpt against current code before editing: files, index contents and line numbers may have changed. A before side may refer to renamed or deleted code.

Address open comments, retain their original anchors and text, and record status `addressed`, resolution and tests actually performed. Keep unresolved comments open and explain blockers. Preserve other contexts and prose. Do not claim checks you did not run.

Summarize corrections and actual checks, and update `.reviewbox/.local/CURRENT_CHANGES.md` according to the project skills. This does not authorize staging, committing, pushing, publishing or validating reviews.
