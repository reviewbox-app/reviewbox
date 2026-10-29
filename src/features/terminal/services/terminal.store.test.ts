import { afterEach, expect, test } from "bun:test"
import {
  reorderTerminals,
  renameTerminal,
  selectTerminal,
  useTerminalStore,
} from "./terminal.store"
const tab = (id: string, repositoryId = "a") => ({
  id,
  repositoryId,
  shell: "/bin/zsh",
  cwd: "/tmp",
  exited: false,
  exitCode: null,
  title: id,
})
afterEach(() =>
  useTerminalStore.setState({
    tabs: [],
    active: {},
    error: "",
    creating: false,
  })
)
test("terminal selection, names and sorting stay isolated per checkout", () => {
  useTerminalStore.setState({
    tabs: [tab("one"), tab("two"), tab("other", "b")],
  })
  selectTerminal("a", "one")
  selectTerminal("b", "other")
  reorderTerminals("one", "two")
  reorderTerminals("one", "other")
  renameTerminal("two", "Build")
  expect(useTerminalStore.getState().tabs.map((t) => t.id)).toEqual([
    "two",
    "one",
    "other",
  ])
  expect(useTerminalStore.getState().active).toEqual({ a: "one", b: "other" })
  expect(useTerminalStore.getState().tabs[0].title).toBe("Build")
})
