# Update an existing review

Adapt the previous reading tour to the new frozen capture. The context includes
reviewManifest for the candidate and previousReviewManifest for the original;
each manifest points to its complete review document and captured sources.
The comparison is a starting point, not an exhaustive reading checklist. Explore
as needed, including indirect behavior changes across files and context sources.

Delegate as much independent discovery and research as possible to parallel
subagents, within the harness limits, to define the updated reading path quickly.
Assign complementary behavior areas or existing step groups, with the old/new
captured source IDs and focused impact/reuse questions. Request concise findings,
exact evidence and uncertainties. While helpers investigate, focus on cross-file
impacts, the final tour order and writing briefs instead of repeating their work.
Use parallel research whenever useful independent tasks exist; do not manufacture
work for a trivial change. Stop once the evidence suffices, without exhaustive
file reading or a step per file. Verify reuse decisions against old documents and
new captured evidence before returning the updated tour.

Return the normal outline (topics and steps), plus removedSteps.
Every retained, rewritten or new step must include a concise writingBrief in the
project's language and contextSourceIds (possibly empty). Explain the intended
before/after behavior, consequences and relationships between associated files.
Use only unique source IDs from the NEW capture for additional context. Keep the
note internal, separate from the navigation title and the reader's documents.
If this direction calls for information absent from the old documents, set
reuse=false even if the code anchors have not changed.
For every step that continues an existing context, set previousStepId to its old
ID. Set reuse=true only when its explanation in ALL three reading modes, title,
topic context and glossary meanings remain valid without rewriting. Otherwise
set reuse=false. New steps have previousStepId=null and reuse=false. List removed
old IDs in removedSteps. Account for each old step exactly once. Choose the final
order by behavior and context; do not create a step per file or filler steps.
Use the concise title rules for new or rewritten steps. If you change an existing
title, set reuse=false; never claim unchanged reuse after retitling a step.

Use anchors from the NEW capture, never old capture IDs. The application checks
all reuse claims and rewrites steps whose source references cannot be rebound.
Keep unchanged topic titles and briefs so reusable explanations keep their context.
The previous three documents are available through previousReviewManifest; consult
them to assess reuse, not just their titles. Request new writing only where useful.

Do not validate anything on behalf
of a person or change the captured scope. An empty tour is valid if no meaningful
changes remain.

Prioritize a fast, concise, sufficiently evidenced explanation over exhaustive
investigation or meticulous polish. Stop exploring once the captured sources
support the main behavior and consequences. Use the writing brief and supplied
sources; fetch only missing facts needed for this task. Keep all three variants
independent and distinct, without minimum length, generic introductions,
repetition or inventories of secondary details. Delegate independent work when
useful, but avoid redundant cross-reviews and purely stylistic rewrites. Check
key facts, references and consistency, then assemble without rewriting sound
results. Include an illustration only when it makes the explanation simpler.
Never trade source fidelity for speed: state uncertainty briefly rather than
inventing an answer. Native validation requirements remain mandatory.

Give each step a unique stable draftId, distinct from previousStepId. Preserve
these draft IDs across corrections, changes of order and resumed analysis; use
previousDefinitions when supplied. Emit each topic title and brief BEFORE its
steps so writers have complete context immediately. You may revise a definition;
only its current version will be used. Return all final steps in the final outline.
