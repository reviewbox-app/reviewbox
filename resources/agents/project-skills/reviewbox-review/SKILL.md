---
name: reviewbox-review
description: Prepare a change for human review in ReviewBox and distinguish captured code, live files and review decisions.
---

# Preparing work for review

Keep changes scoped to the user's request and preserve unrelated local work.
Report tests actually run and their results; distinguish fixtures from real
providers, browsers and native application validation. Use small coherent commits
when the user has requested commits.

ReviewBox captures the selected Git scope. The human may review that captured
version after the checkout has changed. Never assume a line number from a review
still identifies the same source text. Compare paths, before/after side, source
fingerprints and excerpts before applying a correction.

At the end of the work, follow `reviewbox-changes` to write a concise
`.reviewbox/.local/CURRENT_CHANGES.md`. Rev checks that document against the
captured changes and may ignore it when stale or unverifiable. It is context,
not a substitute for inspecting code or evidence of successful tests.

Review comments are separate from validation. An `addressed` comment records an
agent's correction, not human acceptance. `End review` only opens a summary;
completion/publication remains a separate human action in ReviewBox.
