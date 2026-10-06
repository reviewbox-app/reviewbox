import { afterEach, expect, test } from "bun:test"
import { useReviewWorkspaceStore } from "./useReviewWorkspace.store"
import {
  initializeReviewTree,
  updateTreeNavigation,
  useTreeNavigation,
  treeNavigation,
} from "@/features/file-tree/services/navigation.service"

afterEach(() => {
  useReviewWorkspaceStore.setState(useReviewWorkspaceStore.getInitialState())
  useTreeNavigation.setState({ checkouts: {} })
})

test("Code navigation initializes all folders and preserves explicit closures across view switches and reviews", () => {
  useTreeNavigation.setState({
    checkouts: { repo: { revision: 0, trees: {} } },
  })
  initializeReviewTree("repo", "first", [
    "src/deep/a.ts",
    "src/b.ts",
    "README.md",
  ])
  expect(treeNavigation("repo", "review:first")?.expandedPaths).toEqual([
    "src",
    "src/deep",
  ])
  expect(treeNavigation("repo", "review:first")?.visible).toBe(true)
  updateTreeNavigation("repo", "review:first", (tree) => ({
    ...tree,
    expandedPaths: [],
    visible: false,
    scrollTop: 123,
  }))
  const actions = useReviewWorkspaceStore.getState()
  actions.setView("document")
  actions.setView("code")
  initializeReviewTree("repo", "first", ["src/deep/a.ts"])
  expect(treeNavigation("repo", "review:first")).toMatchObject({
    expandedPaths: [],
    visible: false,
    scrollTop: 123,
  })
  initializeReviewTree("repo", "second", ["lib/a.ts"])
  expect(treeNavigation("repo", "review:second")?.expandedPaths).toEqual([
    "lib",
  ])
})
