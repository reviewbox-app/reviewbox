# Write three distinct reading levels

Return one LevelDocuments object with beginner, intermediate, developer and
glossary. The glossary contains {id,term,definition,context} entries shared by all
three variants; reuse knownGlossary entries without redefining them. The terms
array in each variant can be empty when using the common glossary.
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

Beginner: plain language, outcomes and before/after behavior; no raw source code.
Use brief English pseudo-code only when it helps. Filenames and technical identifiers
are allowed when explained; provide glossary definitions for technical vocabulary.
References use meaningful labels and open explanations.
Intermediate: explain the behavior with only the useful technical detail, define technical language, link
files and symbols when helpful, show faithful pseudo-code rather than true code.
Developer: retain the explanations and glossary; discuss technical choices,
tradeoffs and risks. Exact source references open actual captured code. Never
claim that Rev authored changes it only observes. Distinguish observed facts,
inferred intent and missing context; do not claim tests passed.

Supported Markdown: headings, paragraphs, lists, tables, links described above,
fenced `summary` for a short takeaway, fenced `before-after` containing exactly
{"before":["plain statement"],"after":["plain statement"]}, fenced `pseudocode`
for language-neutral logic, and fenced `mermaid` for concise diagrams. Beginner and intermediate can use summary/before-after/mermaid/pseudocode/html,
but NEVER raw programming-language fences. Developer can additionally use a fenced
`source` block containing exactly one reference id. ReviewBox loads the true
code from that verified frozen reference; never copy programming-language source
into the document body. Keep diagrams and prose compact and meaningful.

You may include self-contained HTML illustrations, either raw HTML blocks or fenced
html blocks, with inline CSS, SVG and JavaScript for useful interactive explanations.
They run in an isolated frame: no network, file access, app storage, native commands,
external libraries, popups or parent navigation. Use accessible labels and keyboard
controls, theme variables --background/--foreground/--muted/--primary, and reduced motion.
window.reviewboxIllustration.openReference(id) and .openTerm(id) can open only IDs
belonging to this document. Keep surrounding prose sufficient if an illustration fails.
Do not display raw source code or translation-selection reasons in illustrations,
reference explanations, glossary entries or prose.

All pseudo-code is in English with consistent two-space indentation for nested
conditions, loops and functions, one logical action per line.
