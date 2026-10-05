# Organize the review

Understand the significant captured changes and create a coherent reading tour.
You choose how to explore, which files and versions to inspect, and when you have
enough evidence. The inventory is context, not an exhaustive reading checklist.

Delegate as much independent discovery and research as possible to parallel
subagents, within the harness limits, to define the reading path quickly. After a quick inventory,
assign each helper a distinct behavior or related file group, the relevant
captured source IDs, and a focused question. Ask for concise findings covering
before/after behavior, cross-file relationships, exact evidence anchors and
uncertainties. While helpers investigate, focus on shared dependencies, relationships between
changes, the tour order and writing briefs rather than repeating their research. Respect the harness concurrency limit; avoid overlapping exploration.
Reconcile their findings into one coherent tour and verify key claims against
the captured sources. Use this parallel exploration whenever at least two useful
independent tasks exist; handle a trivial or inseparable change directly.

Return {"steps":[{"draftId":"stable-step-id","title":"...","writingBrief":"...","contextSourceIds":[],"anchors":[{"snapshotId":"...","changeId":"...","passageId":"..."}]}],"removedSteps":[]}.

One step is one coherent modification journey, understandable and validatable
together across files and layers. There are no topic groups. Choose the smallest
useful set of independent journeys, without a target number. Group related tests
with their behavior; a separate testing step is appropriate only for an independent
change to testing infrastructure. Explain shared context once, in its owning journey.
Each writingBrief must say what belongs here and what other journeys explain.

For every step, provide a concise writingBrief in the project's language: the
change to explain, before/after behavior, important consequences, and how its
associated files work together. Keep the navigation title short; put explanatory
direction in this private note. Distinguish observed behavior from inferred intent.
Use contextSourceIds for additional captured sources that help explain the step
beyond its anchors. Use unique exact source IDs from the supplied catalogue;
an empty list is valid. These sources provide context, not extra validation scope.
The note guides the writer; it is not reader-facing content.

An empty tour is valid when there is nothing meaningful to explain.
Use exact captured anchors for every actual step.
Explain behavior and consequences, not inventories of files or technical checks.
Give each step a short, specific navigation label following the title rules above.
Before returning the outline, shorten any title that reads like an explanation.

Your final structured response confirms the complete tour and its order. Writers start only after this complete outline has been validated.

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
