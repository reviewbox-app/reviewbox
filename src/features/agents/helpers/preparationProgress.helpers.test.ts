import { describe, expect, it } from "bun:test"
import type {
  AgentEvent,
  AgentProgress,
} from "@/lib/desktop/contracts.generated"
import {
  beginProgress,
  finishProgress,
  followsProgress,
  groupProgress,
  receiveProgress,
} from "./preparationProgress.helpers"

const event = (
  sequence: number,
  progress: AgentProgress,
  runId = "run"
): AgentEvent => ({ runId, sequence, kind: "progress", text: "", progress })
const activity = (id: string, status = "inProgress"): AgentProgress => ({
  type: "activity",
  id,
  category: "read",
  status: status as "inProgress" | "completed" | "failed",
})

describe("preparation progress", () => {
  it("tracks concurrent actions and groups repetitions without losing failures", () => {
    let state = beginProgress("run", 0)
    state = receiveProgress(state, event(1, activity("a")))
    state = receiveProgress(state, event(2, activity("b")))
    state = receiveProgress(state, event(3, activity("b", "failed")))
    state = receiveProgress(state, event(4, activity("a", "completed")))
    expect(groupProgress(state.entries)).toMatchObject([
      { count: 2, counts: { completed: 1, failed: 1, inProgress: 0 } },
    ])
    state = receiveProgress(
      state,
      event(5, { type: "message", id: "m", text: "**Next step**" })
    )
    state = receiveProgress(state, event(6, activity("c")))
    expect(groupProgress(state.entries)).toHaveLength(3)
    expect(finishProgress(state, "completed", 10).entries.at(-1)).toMatchObject(
      { status: "interrupted" }
    )
  })
  it("ignores duplicate, stale and post-cancellation events and resets on retry", () => {
    const state = receiveProgress(
      beginProgress("run"),
      event(2, activity("a", "completed"))
    )
    expect(receiveProgress(state, event(2, activity("a")))).toBe(state)
    expect(receiveProgress(state, event(3, activity("a"), "old"))).toBe(state)
    expect(
      receiveProgress(state, event(3, activity("a"))).entries[0]
    ).toMatchObject({ status: "completed" })
    const stopped = finishProgress(state, "cancelled")
    expect(receiveProgress(stopped, event(4, activity("b")))).toBe(stopped)
    const retry = beginProgress("retry")
    expect(retry.entries).toEqual([])
    expect(receiveProgress(retry, event(5, activity("a")))).toBe(retry)
  })
  it("replaces revised plans and preserves unfinished steps on failure", () => {
    let state = receiveProgress(
      beginProgress("run"),
      event(1, { type: "plan", steps: [{ text: "Old", status: "pending" }] })
    )
    state = receiveProgress(
      state,
      event(2, { type: "plan", steps: [{ text: "New", status: "inProgress" }] })
    )
    state = finishProgress(state, "failed")
    expect(state.plan).toEqual([{ text: "New", status: "inProgress" }])
  })
  it("bounds history and does not reinterpret final result text as activity", () => {
    let state = beginProgress("run")
    for (let i = 1; i <= 210; i++)
      state = receiveProgress(state, event(i, activity(String(i), "completed")))
    expect(state.entries).toHaveLength(200)
    expect(state.omitted).toBe(10)
    state = receiveProgress(state, {
      runId: "run",
      sequence: 211,
      kind: "delta",
      text: '{"kind":"topics"}',
    })
    expect(state.entries).toHaveLength(200)
    state = receiveProgress(
      state,
      { runId: "run", sequence: 212, kind: "completed", text: "" },
      1234
    )
    expect(state.endedAt).toBe(1234)
  })
  it("follows new activities only near the bottom", () => {
    expect(
      followsProgress({ scrollHeight: 900, clientHeight: 400, scrollTop: 495 })
    ).toBe(true)
    expect(
      followsProgress({ scrollHeight: 900, clientHeight: 400, scrollTop: 100 })
    ).toBe(false)
  })
})

it("keeps streamed draft outlines separate from activities and ignores later output after cancellation", () => {
  let state = beginProgress("run")
  state = receiveProgress(
    state,
    event(1, { type: "draft", characters: 800, topics: ["Storage"] })
  )
  expect(state.entries).toEqual([])
  expect(state.draft).toEqual({
    type: "draft",
    characters: 800,
    topics: ["Storage"],
  })
  state = receiveProgress(
    state,
    event(2, { type: "draft", characters: 1600, topics: ["Storage", "UI"] })
  )
  const stopped = finishProgress(state, "cancelled")
  expect(
    receiveProgress(
      stopped,
      event(3, { type: "draft", characters: 2000, topics: [] })
    )
  ).toBe(stopped)
  expect(beginProgress("retry").draft).toBeUndefined()
})

it("keeps concurrent plans, helper models and activities scoped to their batch", () => {
  let state = beginProgress("parallel")
  const event = (
    sequence: number,
    batchId: string,
    progress: AgentEvent["progress"]
  ): AgentEvent => ({
    runId: "parallel",
    sequence,
    batchId,
    kind: "progress",
    text: "",
    progress,
  })
  state = receiveProgress(
    state,
    event(1, "a", {
      type: "plan",
      steps: [{ text: "Explain the file", status: "inProgress" }],
    })
  )
  state = receiveProgress(
    state,
    event(2, "b", {
      type: "plan",
      steps: [{ text: "Translate the segment", status: "pending" }],
    })
  )
  state = receiveProgress(
    state,
    event(3, "a", {
      type: "plan",
      steps: [{ text: "Explain the file", status: "completed" }],
    })
  )
  expect(state.plans.b[0].status).toBe("pending")
  expect(state.plans.a[0].status).toBe("completed")
  state = receiveProgress(
    state,
    event(4, "a", {
      type: "delegation",
      id: "helper",
      parent: "coordinator",
      task: "Explain",
      model: "gpt-6-luna",
      status: "inProgress",
    })
  )
  state = receiveProgress(
    state,
    event(5, "a", {
      type: "delegation",
      id: "helper",
      parent: "coordinator",
      task: "Explain",
      model: null,
      status: "completed",
    })
  )
  expect(state.helpers.helper.model).toBe("gpt-6-luna")
  state = receiveProgress(
    state,
    event(6, "a", {
      type: "activity",
      id: "a:read",
      category: "read",
      status: "completed",
    })
  )
  state = receiveProgress(
    state,
    event(7, "b", {
      type: "activity",
      id: "b:read",
      category: "read",
      status: "inProgress",
    })
  )
  expect(groupProgress(state.entries)).toHaveLength(2)
  expect(finishProgress(state, "cancelled").helpers.helper.status).toBe(
    "completed"
  )
  expect(beginProgress("retry").helpers).toEqual({})
})
