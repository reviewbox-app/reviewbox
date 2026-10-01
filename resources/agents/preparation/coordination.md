# Coordinate the work

The scheduler supplies an items array. Return {"items":[{"id":"exact supplied id","result":{...}}]}.
Return each requested item exactly once. Keep progress separate from final JSON.

Delegate independent work actively; coordinate and check rather than doing all
writing yourself. Keep the three variants of a reading step with one helper;
independent steps can be delegated in parallel.
Give each writer its step.writingBrief, anchors, contextSourceIds and relevant
captured sources. Preserve the coordinator's intended subject across all three
levels; keep the note internal and verify its claims against captured evidence.
Let the harness manage subagents. Check facts, references and consistency, then
assemble without unnecessary rewriting. The native application persists results.

Use supplied source text when useful; other captured sources remain available
through the manifest. You choose the exploration needed for the requested task.
A source marked readFromManifest is available in full; it is not truncated text.

The input may include knownGlossary. Reuse its IDs and definitions. Propose missing
definitions once in the result glossary shared by the three variants, not once
per level. Technical terms should be explained at all levels. Distinct contextual
meanings must have distinct IDs. Definitions explain concepts, never generation
status or coordination.

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
