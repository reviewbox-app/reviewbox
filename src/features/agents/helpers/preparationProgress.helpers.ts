import type {
  AgentActivityKind,
  AgentActivityStatus,
  AgentEvent,
  AgentPlanStep,
  AgentProgress,
} from "@/lib/desktop/contracts.generated"

type Entry = Extract<AgentProgress, { type: "activity" | "message" }> & {
  batchId?: string
}
export type PreparationProgress = {
  runId: string
  sequence: number
  startedAt: number
  endedAt?: number
  outcome?: "completed" | "failed" | "cancelled"
  draft?: Extract<AgentProgress, { type: "draft" }>
  plans: Record<string, AgentPlanStep[]>
  helpers: Record<string, Extract<AgentProgress, { type: "delegation" }>>
  usage: Record<string, Extract<AgentProgress, { type: "usage" }>>
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
    plans: {},
    helpers: {},
    usage: {},
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
    helpers: Object.fromEntries(
      Object.entries(state.helpers).map(([key, helper]) => [
        key,
        helper.status === "inProgress"
          ? { ...helper, status: "interrupted" }
          : helper,
      ])
    ),
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
  if (progress.type === "plan") {
    const plans = Object.fromEntries(
      Object.entries({
        ...next.plans,
        [event.batchId ?? "main"]: progress.steps,
      }).slice(-12)
    )
    return { ...next, plans, plan: Object.values(plans).flat() }
  }
  if (progress.type === "usage")
    return {
      ...next,
      usage: Object.fromEntries(
        Object.entries({ ...next.usage, [progress.id]: progress }).slice(-200)
      ),
    }
  if (progress.type === "delegation") {
    const old = next.helpers[progress.id]
    if (old && old.status !== "inProgress" && progress.status === "inProgress")
      return next
    const helper = {
      ...progress,
      model: progress.model ?? old?.model ?? null,
      task:
        progress.task === "Delegated preparation work"
          ? (old?.task ?? progress.task)
          : progress.task,
    }
    return {
      ...next,
      helpers: Object.fromEntries(
        Object.entries({ ...next.helpers, [progress.id]: helper }).slice(-200)
      ),
    }
  }
  const entry = { ...progress, batchId: event.batchId }
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
    entries[index] = entry
  } else entries.push(entry)
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
  batchId?: string
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
      previous?.type === "group" &&
      previous.category === entry.category &&
      previous.batchId === entry.batchId
        ? previous
        : {
            type: "group",
            id: entry.id,
            category: entry.category,
            batchId: entry.batchId,
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
