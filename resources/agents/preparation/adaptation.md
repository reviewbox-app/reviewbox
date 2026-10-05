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

Return the normal flat outline (steps and removedSteps), without topic groups.
Every retained, rewritten or new step must include a concise writingBrief in the
project's language and contextSourceIds (possibly empty). Explain the intended
before/after behavior, consequences and relationships between associated files.
Use only unique source IDs from the NEW capture for additional context. Keep the
note internal, separate from the navigation title and the reader's documents.
If this direction calls for information absent from the old documents, set
reuse=false even if the code anchors have not changed.
For every step that continues an existing context, set previousStepId to its old
ID. Set reuse=true only when its explanation in ALL three reading modes, title,
journey context and glossary meanings remain valid without rewriting. Otherwise
set reuse=false. New steps have previousStepId=null and reuse=false. List removed
old IDs in removedSteps. Account for each old step exactly once. Choose the final
order by behavior and context; do not create a step per file or filler steps.
Use the concise title rules for new or rewritten steps. If you change an existing
title, set reuse=false; never claim unchanged reuse after retitling a step.

Use anchors from the NEW capture, never old capture IDs. The application checks
all reuse claims and rewrites steps whose source references cannot be rebound.
Preserve the context of reusable explanations.
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
previousDefinitions when supplied. Return all final steps in the final outline.

Use one step per coherent modification journey, spanning related files and layers.
There is no target number. Group tests with their behavior unless the testing
infrastructure changes independently. Finalize the entire plan before writers start.
Give each writingBrief clear ownership and the subjects covered elsewhere.
When merging old steps, create a new draftId, previousStepId=null and reuse=false;
list ALL absorbed old IDs in removedSteps. Write a new coherent explanation,
never concatenate the old documents or transfer their human validations.

Organize at the scale of a complete reader/user journey, not each independently
implemented capability. Changes to the same screen or workflow belong together:
for example, a dashboard's recent content and personal shortcuts form one dashboard
journey; browsing, contextual actions and manual editing form one editing journey.
Separate a durable cross-interface processing lifecycle when it merits its own
explanation. Small visual changes belong in the relevant journey, never a standalone
page. A small ancillary test-runner fix belongs as a short supporting note in a
relevant journey; only a substantial independent testing-infrastructure change
justifies a separate step. Independence of files, services or implementation
details alone never justifies another page. Before finalizing, merge adjacent
steps that share the same user goal and would repeat context.

## Private evidence handoff

Every step must include analysis: {"before":"observed previous behavior",
"after":"observed new behavior","relationships":"how files cooperate",
"consequences":"useful effects","uncertainties":[],"evidence":[
{"fact":"verified finding","sourceId":"exact captured source ID",
"startLine":1,"endLine":4}]}.
Reuse discoveries from analysis helpers in this dossier; do not repeat their
investigation. Associate the important claims with exact captured source ranges.
Include real uncertainties explicitly. Before/after sources are distinct.
The dossier is private, concise factual prose, not copied source code. Writers
will use it to produce all three modes without redoing discovery. Keep the plan
and dossier proportional to the changes, without quotas or exhaustive inventories.

## No automatic verification disclaimer

Absence of a test report, browser session or deployment check is the normal
condition for a source review. It is not itself a finding or uncertainty to list.
Describe what test code checks, without appending "not executed", "not proven",
"still to verify in the browser/production" or equivalent caveats. Never invent
successful execution either. Include an uncertainty only when a specific missing
fact changes the interpretation of this particular change, and explain its local
consequence. Do not put generic verification caveats into the analysis dossier,
the three modes, the glossary or closing paragraphs. A dossier uncertainty that
merely says no execution report exists must be omitted from reader-facing text.
Do not replace these caveats with repetitive summaries or a generic test section.

For a journey containing only binary or metadata changes (captured anchors have
zero text lines), analysis.evidence may be empty. Explain only the captured
metadata supported by those anchors; never invent text line references or infer
binary contents. Textual changes still require exact source evidence.
