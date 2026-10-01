# Write three distinct reading levels

Use step.writingBrief as the coordinator's direction for what this step must
explain. Its anchors identify the changes; step.contextSourceIds identifies
additional captured context, included alongside anchored sources when available.
Pass this note and these source references to the helper writing all three levels.
Verify the note against captured evidence: it is guidance, not proof. Explore
further as needed and do not turn an inferred intention into an established fact.
Explain the subject in your own presentation for each level. Do not reproduce
the internal note, task instructions or source-selection rationale in the document,
reference explanations, illustrations or glossary.

Return one LevelDocuments object with essential, explained, technical and
glossary. The glossary contains {id,term,definition,context} entries shared by all
three variants; reuse knownGlossary entries without redefining them. The terms
array in each variant can be empty when using the common glossary.
Use contextSources for captured source IDs that informed the explanation beyond
its anchors and explicit references. List only context actually used; this is not
an obligation to read every file. The application records source fingerprints.
Each variant is a complete independently readable explanation of the SAME batch
subject, with the same intent and facts but genuinely different presentation.
Do not copy the same text into three levels.

Write ONLY the supplied reading step: one coherent context or behavior change,
possibly spanning several files. There are no separate file documents. Do not
turn the step into a list of files or create extra steps. Keep the explanation
focused, proportional to the change and readable without exhaustive inventories.

Each document: {"body":"Markdown","readingSeconds":60,"references":[{"id":"stable-local-id","label":"visible words","explanation":"simple explanation","sourceId":"catalogue id","startLine":1,"endLine":4}],"terms":[{"id":"stable-local-id","term":"visible words","definition":"short simple definition","context":"meaning here"}]}.
Reference ids are local to each variant; term ids identify the common review glossary.
IDs are unique and use letters/digits,
hyphens or underscores. Annotate technical terms that need a definition and cited source
symbols/files using [visible words](reviewbox:term/id) or
[visible words](reviewbox:ref/id). Never invent ranges. Do not use ordinary file
links or pretend an unverified source is clickable. Definitions are short and
specific to this review. Explain ambiguous meanings rather than guessing.

Essential: plain language, outcomes and before/after behavior; no raw source code.
Do not generate pseudo-code. Filenames and technical identifiers
are allowed when explained; provide glossary definitions for technical vocabulary.
References use meaningful labels and open a short explanation with an Open in code button.
Explained: explain the behavior with only the useful technical detail, define technical language, link
files and symbols when helpful. Explain behavior in prose and diagrams.
Technical: retain the explanations and glossary; discuss technical choices,
tradeoffs and risks. Exact source references provide an Open in code button for the actual captured source. Never
claim that Rev authored changes it only observes. Distinguish observed facts,
inferred intent and missing context; do not claim tests passed.

Supported Markdown: headings, paragraphs, lists, tables, links described above,
fenced `summary` for a short takeaway, fenced `before-after` containing exactly
{"before":["plain statement"],"after":["plain statement"]}, and fenced `mermaid` for concise diagrams. Essential and explained can use summary/before-after/mermaid/html,
but NEVER raw programming-language fences. Technical can additionally use a fenced
`source` block containing exactly one reference id. ReviewBox renders a button to open
that verified frozen reference in the full Code view; never copy programming-language source
into the document body. Keep diagrams and prose compact and meaningful.

You may include self-contained HTML illustrations, either raw HTML blocks or fenced
html blocks, with inline CSS, SVG and JavaScript for useful interactive explanations.
They run in an isolated frame: no network, file access, app storage, native commands,
external libraries, popups or parent navigation. Use accessible labels and keyboard
controls, theme variables --background/--foreground/--muted/--primary, and reduced motion.
window.reviewboxIllustration.openReference(id) and .openTerm(id) can open only IDs
belonging to this document. Keep surrounding prose sufficient if an illustration fails.
Do not display raw source code or pseudo-code in illustrations,
reference explanations, glossary entries or prose.

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
