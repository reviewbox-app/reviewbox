import type {
  AgentActivityKind,
  AgentActivityStatus,
  AgentEvent,
  AgentPlanStep,
  AgentProgress,
} from "@/lib/desktop/contracts.generated"

type Entry = Exclude<AgentProgress, { type: "plan" | "draft" }>
export type PreparationProgress = {
  runId: string
  sequence: number
  startedAt: number
  endedAt?: number
  outcome?: "completed" | "failed" | "cancelled"
  draft?: Extract<AgentProgress, { type: "draft" }>
  plan: AgentPlanStep[]
  entries: Entry[]
  omitted: number
}

export function beginProgress(
  runId: string,
  now = Date.now()
): PreparationProgress {
  return {
    runId,
    sequence: 0,
    startedAt: now,
    plan: [],
    entries: [],
    omitted: 0,
  }
}

export function finishProgress(
  state: PreparationProgress,
  outcome: NonNullable<PreparationProgress["outcome"]>,
  now = Date.now()
): PreparationProgress {
  if (state.outcome) return state
  return {
    ...state,
    outcome,
    endedAt: now,
    // Missing tool completions are not evidence of success, even on a successful turn.
    entries: state.entries.map((entry) =>
      entry.type === "activity" && entry.status === "inProgress"
        ? { ...entry, status: "interrupted" }
        : entry
    ),
  }
}

export function receiveProgress(
  state: PreparationProgress,
  event: AgentEvent,
  now = Date.now()
): PreparationProgress {
  if (
    state.outcome ||
    event.runId !== state.runId ||
    event.sequence <= state.sequence
  )
    return state
  const next = { ...state, sequence: event.sequence }
  if (["completed", "failed", "cancelled"].includes(event.kind))
    return finishProgress(
      next,
      event.kind as NonNullable<PreparationProgress["outcome"]>,
      now
    )
  const progress = event.progress
  if (!progress) return next
  if (progress.type === "draft") return { ...next, draft: progress }
  if (progress.type === "plan") return { ...next, plan: progress.steps }
  const index = next.entries.findIndex((entry) => entry.id === progress.id)
  const entries = [...next.entries]
  if (index >= 0) {
    // A replayed start must not revert a completed action.
    const old = entries[index]
    if (
      old.type === "activity" &&
      old.status !== "inProgress" &&
      progress.type === "activity" &&
      progress.status === "inProgress"
    )
      return next
    entries[index] = progress
  } else entries.push(progress)
  const excess = Math.max(0, entries.length - 200)
  return {
    ...next,
    entries: entries.slice(excess),
    omitted: next.omitted + excess,
  }
}

export type ActivityGroup = {
  type: "group"
  id: string
  category: AgentActivityKind
  counts: Record<AgentActivityStatus, number>
  count: number
}

export function groupProgress(
  entries: Entry[]
): (ActivityGroup | Extract<Entry, { type: "message" }>)[] {
  const groups: ReturnType<typeof groupProgress> = []
  for (const entry of entries) {
    if (entry.type === "message") {
      groups.push(entry)
      continue
    }
    const previous = groups.at(-1)
    const group: ActivityGroup =
      previous?.type === "group" && previous.category === entry.category
        ? previous
        : {
            type: "group",
            id: entry.id,
            category: entry.category,
            count: 0,
            counts: { inProgress: 0, completed: 0, failed: 0, interrupted: 0 },
          }
    if (group !== previous) groups.push(group)
    group.count++
    group.counts[entry.status]++
  }
  return groups
}

export const activityLabels: Record<AgentActivityKind, string> = {
  read: "Reading files",
  search: "Searching the project",
  listFiles: "Exploring project structure",
  command: "Exploring with project commands",
  tool: "Using project tools",
  fileChange: "Updating project files",
  webSearch: "Searching supporting context",
  compaction: "Organising context",
  draft: "Preparing suggestions",
}

export function groupStatus(group: ActivityGroup): AgentActivityStatus {
  if (group.counts.inProgress) return "inProgress"
  if (group.counts.failed) return "failed"
  if (group.counts.interrupted) return "interrupted"
  return "completed"
}

export function followsProgress(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">
) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 32
}
