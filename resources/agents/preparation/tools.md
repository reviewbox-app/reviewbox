# Private preparation tools

## review_state

Read the current plan, documents, prior decisions and captured source catalogue. Follow nextOffset until null to read all catalogue entries.

## review_source

Read a captured source, never the live checkout.

## review_read_document

Read an existing document, with bounded pagination of its body.

## review_search

Search literal text in frozen sources. Results are bounded; ignored/live files are not searched.

## review_context_assess

Optionally record whether each author work brief is usable, stale or unverifiable against the capture.

## review_activity

Report your current intention or progress to the user.

## review_plan

Announce or revise the ordered document plan before writing. Explicitly remove steps before omitting them.

## review_document

Write one planned document with exact captured anchors. Plain Markdown and optional references/glossary are supported.

## review_decide

Explicitly keep an unchanged prior document or remove a planned/prior document.

## review_finish

Confirm that all planned documents are available and coherent. This does not validate or publish the human review.
