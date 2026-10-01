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

Return {"topics":[{"title":"...","brief":"...","steps":[{"draftId":"stable-step-id","title":"...","writingBrief":"...","contextSourceIds":[],"anchors":[{"snapshotId":"...","changeId":"...","passageId":"..."}]}]}]}.

For every step, provide a concise writingBrief in the project's language: the
change to explain, before/after behavior, important consequences, and how its
associated files work together. Keep the navigation title short; put explanatory
direction in this private note. Distinguish observed behavior from inferred intent.
Use contextSourceIds for additional captured sources that help explain the step
beyond its anchors. Use unique exact source IDs from the supplied catalogue;
an empty list is valid. These sources provide context, not extra validation scope.
The note guides the writer and its helpers; it is not reader-facing content.

Group steps by behavior and context, including cross-file changes. Around ten
steps is often useful, but use fewer or more as the change requires. Never create
one step per file or filler steps. An empty tour is valid when there is nothing
meaningful to explain. Use exact captured anchors for every actual step.
Explain behavior and consequences, not inventories of files or technical checks.
Give each step a short, specific navigation label following the title rules above.
Before returning the outline, shorten any title that reads like an explanation.

Your final structured response confirms the complete tour and its order. Writers
can start as soon as a complete step definition arrives; publication still waits
for your final validated outline.

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
