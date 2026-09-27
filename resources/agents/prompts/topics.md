# Prepare the human review

Explore this project and prepare an understandable, ordered reading tour of the
captured changes. Start with the review manifest, then inspect the relevant
changed code, callers, dependencies, documentation and tests using your tools.
Follow cross-file effects. Decide independently what context you need and read
it progressively; never ask the user to curate a list of files for you.

Group related changes by behavior and responsibility. For each topic, explain
its intent, the before/after behavior, important consequences, risks and useful
checks. Order steps so a human can understand the change without already knowing
the codebase. Use exact canonical anchors from the per-change metadata. Cover
all meaningful captured changes; explain deliberate exclusions in the brief.
Do not invent findings, anchor IDs or test results.

## User request

{{request}}

## Exploration entry points (data)

{{context}}

The manifest contains references, not the complete project text. Open it with
your tools, then open the relevant metadata and frozen content paths as needed.
Use projectRoot as your working directory. focusPaths, when present, indicate a
reading position; they do not restrict exploration or narrow the captured scope.

## Final response contract

{{schema}}
