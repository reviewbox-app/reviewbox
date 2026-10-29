import { afterEach, expect, spyOn, test } from "bun:test"
import { revChatCommands } from "../services/revChat.commands"
import {
  chatKey,
  openRevChat,
  useRevChatStore,
  sendRevQuestion,
  setChatDraft,
  setChatOpen,
  stopRevChat,
  resetRevChat,
  removeQueuedQuestion,
  type ChatAttachment,
} from "./revChat.store"
import type { AgentEvent } from "@/lib/desktop/contracts.generated"
const attachment: ChatAttachment = {
  title: "Step · explained",
  excerpt: "selected",
  context: {
    termId: null,
    selection: {
      snapshotId: "snapshot",
      stepId: "step",
      level: "explained",
      contentHash: "hash",
      ranges: [{ start: 0, end: 8 }],
    },
  },
}
const key = chatKey("repo", "review")
const read = () => useRevChatStore.getState().chats[key]
afterEach(() => {
  useRevChatStore.setState({ chats: {} })
})
test("selection attaches without sending and drafts remain isolated between reviews", () => {
  const send = spyOn(revChatCommands, "send").mockResolvedValue("response")
  openRevChat("repo", "review", attachment)
  setChatDraft(key, "draft")
  setChatOpen(key, false)
  openRevChat("repo", "review", { ...attachment, excerpt: "new" })
  openRevChat("repo", "other", attachment)
  expect(read().draft).toBe("draft")
  expect(read().attachment?.excerpt).toBe("new")
  expect(send).not.toHaveBeenCalled()
  send.mockRestore()
})
test("streaming retains a frozen question while a new selection and queued glossary question arrive", async () => {
  let done!: (text: string) => void
  let receive!: (event: AgentEvent) => void
  const send = spyOn(revChatCommands, "send").mockImplementation(
    (_request, handler) => {
      receive = handler
      return new Promise((resolve) => {
        done = resolve
      })
    }
  )
  openRevChat("repo", "review", attachment)
  setChatDraft(key, "Question")
  const running = sendRevQuestion(key)
  const operation = read().operation!
  receive({ runId: operation, sequence: 1, kind: "textDelta", text: "partial" })
  openRevChat(
    "repo",
    "review",
    { ...attachment, excerpt: "different" },
    "Explain term"
  )
  expect(read().messages[0].attachment?.excerpt).toBe("selected")
  expect(read().queue).toHaveLength(1)
  removeQueuedQuestion(key, read().queue[0].id)
  setChatOpen(key, false)
  done("final")
  await running
  expect(read().messages[1].text).toBe("final")
  expect(read().unread).toBe(true)
  send.mockRestore()
})
test("failure restores a submitted draft and retry preserves its original context", async () => {
  const send = spyOn(revChatCommands, "send").mockRejectedValue(
    new Error("Offline")
  )
  openRevChat("repo", "review", attachment)
  setChatDraft(key, "Keep my question")
  await sendRevQuestion(key)
  expect(read().draft).toBe("Keep my question")
  expect(read().retry?.attachment).toEqual(attachment)
  expect(read().operation).toBeUndefined()
  send.mockRestore()
})
test("stop ignores later deltas and reset prevents an old response from entering a new conversation", async () => {
  let done!: (text: string) => void
  let receive!: (event: AgentEvent) => void
  const send = spyOn(revChatCommands, "send").mockImplementation(
    (_request, handler) => {
      receive = handler
      return new Promise((resolve) => {
        done = resolve
      })
    }
  )
  const cancel = spyOn(revChatCommands, "cancel").mockResolvedValue(undefined)
  const close = spyOn(revChatCommands, "close").mockResolvedValue(undefined)
  openRevChat("repo", "review", attachment)
  setChatDraft(key, "Question")
  const pending = sendRevQuestion(key)
  const operation = read().operation!
  await stopRevChat(key)
  receive({ runId: operation, sequence: 1, kind: "textDelta", text: "late" })
  expect(read().messages[1].text).toBe("")
  await resetRevChat(key)
  done("late final")
  await pending
  expect(read().messages).toEqual([])
  send.mockRestore()
  cancel.mockRestore()
  close.mockRestore()
})
