---
name: reviewbox-project-storage
description: Create and enrich portable ReviewBox reviews and tours through its local CLI or MCP, without validating code or modifying Git.
---

# ReviewBox project content

Use the ReviewBox executable directly; the desktop window need not be open.
The app and headless commands share domain validation and the project writer.

1. Run `reviewbox create --repo <path>` to capture a review.
2. Read `reviewbox context --repo <path> --review <id>` for its snapshot and anchors.
3. Write a request JSON file with `reviewId`, `snapshotId` and `content` following
   the topics, explanation or glossary contract under `resources/agents/contracts`.
4. Run `reviewbox enrich --repo <path> --from request.json` to add that content.
   Use `propose` instead when the user wants to approve it first.
5. Use `annotate` with `anchor`, `body` and optional `question: true` to attach a
   comment or open question. Use `tour` with an onboarding tour as `content` to
   create or update a path through current code. New steps use empty `quote`
   and `fingerprint`; ReviewBox captures their inclusive line range.

Do not fabricate anchors. Reread context after a stale snapshot error. Do not
validate passages, resolve human questions, change source files, execute tests
or manipulate Git through these operations. Preserve authorship and decisions.

Shared content is saved in `.reviewbox` and may be committed by the user. Keep
secrets, absolute machine paths and private transcripts out of content. Direct
file editing uses the versioned JSON schemas and ordered child references;
prefer the CLI for atomic, validated multi-file edits. Prompts and instructions
remain Markdown resources, with literal single-pass `{{var}}` substitution.
