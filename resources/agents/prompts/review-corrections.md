Please address the human review comments for ReviewBox review `{{review_id}}`.

Read `.reviewbox/.local/REVIEW_COMMENTS.md` first. Also check `.reviewbox/REVIEW_COMMENTS.md` if present; it may contain additional shared comments. Use the ReviewBox skills in `.agents/skills/` when available and follow the project's AGENTS.md instructions.

Find the `REVIEWBOX_START` / `REVIEWBOX_END` blocks for this review. Each records the source path, captured snapshot and content hash, source side, selected excerpt, and range. Lines and UTF-16 columns are one-based; the end position is exclusive. A `before` source can refer to old or deleted code. Compare the captured excerpt and surrounding current code before changing anything: line numbers may have moved. Do not apply unrelated reviews' comments blindly.

Address comments whose status is `open`. Keep each comment and its original anchor, mark it `addressed`, and record the resolution and the checks actually performed in its metadata fields `resolution` and `tests`. Do not erase historical comments or claim checks you did not run. If a comment no longer applies, explain why; if it cannot be resolved, leave it open and explain the blocker. Preserve prose and other reviews' blocks in these files.

After corrections, summarize the changes and test results, and update `.reviewbox/.local/CURRENT_CHANGES.md` as described by the ReviewBox skills. This request does not authorize publishing or validating a review, staging, committing or pushing changes.
