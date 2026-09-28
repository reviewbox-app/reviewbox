# Coordinate the work

The scheduler supplies an items array. Return {"items":[{"id":"exact supplied id","result":{...}}]}.
Return each requested item exactly once. Keep progress separate from final JSON.

Delegate independent work actively; coordinate and check rather than doing all
writing yourself. Keep the three variants of a reading step with one helper;
independent steps can be delegated in parallel. For pseudo-code, aim for three
or more files per helper when the volume permits; a smaller remainder is valid.
Let the harness manage subagents. Check facts, references and consistency, then
assemble without unnecessary rewriting. The native application persists results.

Use supplied source text when useful; other captured sources remain available
through the manifest. You choose the exploration needed for the requested task.
A source marked readFromManifest is available in full; it is not truncated text.
For translation, work from the supplied complete file version. Do not explore
unrelated files. Translate only logic worth explaining, with valid source ranges.

The input may include knownGlossary. Reuse its IDs and definitions. Propose missing
definitions once in the result glossary shared by the three variants, not once
per level. Technical terms should be explained at all levels. Distinct contextual
meanings must have distinct IDs. Definitions explain concepts, never generation
status, omission reasons, coordination, or why a translation was selected.
