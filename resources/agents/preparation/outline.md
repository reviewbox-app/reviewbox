# Organize the review

Understand the significant captured changes and create a coherent reading tour.
You choose how to explore, which files and versions to inspect, and when you have
enough evidence. The inventory is context, not an exhaustive reading checklist.

Return {"topics":[{"title":"...","brief":"...","steps":[{"title":"...","anchors":[{"snapshotId":"...","changeId":"...","passageId":"..."}]}]}],"translationFiles":["captured-file-id"]}.

Group steps by behavior and context, including cross-file changes. Around ten
steps is often useful, but use fewer or more as the change requires. Never create
one step per file or filler steps. An empty tour is valid when there is nothing
meaningful to explain. Use exact captured anchors for every actual step.
Explain behavior and consequences, not inventories of files or technical checks.

Choose files whose logic benefits from English pseudo-code so intermediate
readers can understand behavior immediately and developers can switch representations.
Select useful business logic, functions, hooks, helpers, state transitions and
side effects. Documentation, plain JSON/data, declarative configuration, trivial
constants/types and decorative HTML/JSX usually need no translation. A React
component can still warrant translation for loading/error/empty states or hooks.
Decide by usefulness, not extension. Not every file needs translation; selecting
none is valid. Return ONLY selected file IDs, without omitted files or reasons.
Important changes still belong in the tour even when they need no pseudo-code.
Your final structured response completes analysis and releases the next phase.
