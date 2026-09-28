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
5. Use `tour` for Code Explain onboarding paths. These are separate from the
   guided review prepared by the native preparation manager.

Do not fabricate anchors or human decisions. Reread context after a stale
snapshot error. These operations cannot annotate, ask questions, execute tests,
validate files or steps, modify source files or manipulate Git.

Shared content is saved in `.reviewbox` and may be committed by the user. Keep
secrets, absolute machine paths and private transcripts out of content. Direct
file editing uses the version 3 JSON schemas and bounded indexed content packs;
prefer the CLI for atomic, validated multi-file edits. Prompts and instructions
remain Markdown resources, with literal single-pass `{{var}}` substitution.
