import { afterEach, expect, test } from "bun:test"
import { useReviewWorkspaceStore } from "./useReviewWorkspace.store"

afterEach(() =>
  useReviewWorkspaceStore.setState(useReviewWorkspaceStore.getInitialState())
)

test("entering Code opens files, while remaining in Code respects an explicit close", () => {
  const actions = useReviewWorkspaceStore.getState()
  actions.setView("code")
  expect(useReviewWorkspaceStore.getState().filesOpen).toBe(true)
  actions.setFilesOpen(false)
  actions.setView("code")
  expect(useReviewWorkspaceStore.getState().filesOpen).toBe(false)
  actions.setView("document")
  actions.setView("code")
  expect(useReviewWorkspaceStore.getState().filesOpen).toBe(true)
})
