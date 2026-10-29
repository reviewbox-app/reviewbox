import { create } from "zustand"
import type { RevChatContext } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { revChatCommands } from "../services/revChat.commands"

export type ChatAttachment = {
  context: RevChatContext
  title: string
  excerpt: string
}
export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  attachment?: ChatAttachment
  failed?: boolean
}
type Question = { text: string; attachment: ChatAttachment }
export type Chat = {
  id: string
  repositoryId: string
  reviewId: string
  open: boolean
  unread: boolean
  draft: string
  attachment?: ChatAttachment
  messages: ChatMessage[]
  operation?: string
  stopping?: boolean
  status?: string
  error?: string
  queue: (Question & { id: string })[]
  retry?: Question
}
type Store = { chats: Record<string, Chat> }
export const useRevChatStore = create<Store>(() => ({ chats: {} }))
export const chatKey = (repository: string, review: string) =>
  `${repository}/${review}`
function update(key: string, change: (chat: Chat) => Chat) {
  useRevChatStore.setState((state) =>
    state.chats[key]
      ? { chats: { ...state.chats, [key]: change(state.chats[key]) } }
      : state
  )
}
export function openRevChat(
  repositoryId: string,
  reviewId: string,
  attachment: ChatAttachment,
  message?: string
) {
  const key = chatKey(repositoryId, reviewId)
  if (!useRevChatStore.getState().chats[key]) {
    useRevChatStore.setState((state) => ({
      chats: {
        ...state.chats,
        [key]: {
          id: crypto.randomUUID(),
          repositoryId,
          reviewId,
          open: true,
          unread: false,
          draft: "",
          messages: [],
          queue: [],
        },
      },
    }))
  }
  update(key, (chat) => ({ ...chat, open: true, unread: false, attachment }))
  if (message) {
    const question = { text: message, attachment }
    if (useRevChatStore.getState().chats[key].operation)
      update(key, (chat) => ({
        ...chat,
        queue: [...chat.queue, { ...question, id: crypto.randomUUID() }],
      }))
    else void sendRevQuestion(key, question)
  }
}
export const setChatDraft = (key: string, draft: string) =>
  update(key, (chat) => ({ ...chat, draft }))
export const setChatOpen = (key: string, open: boolean) =>
  update(key, (chat) => ({ ...chat, open, unread: open ? false : chat.unread }))
export const removeQueuedQuestion = (key: string, id: string) =>
  update(key, (chat) => ({
    ...chat,
    queue: chat.queue.filter((q) => q.id !== id),
  }))
export async function sendRevQuestion(key: string, question?: Question) {
  const chat = useRevChatStore.getState().chats[key]
  if (!chat || chat.operation) return
  const value =
    question ??
    (chat.attachment
      ? { text: chat.draft.trim(), attachment: chat.attachment }
      : undefined)
  if (!value?.text) return
  const operation = crypto.randomUUID()
  const reply = crypto.randomUUID()
  update(key, (state) => ({
    ...state,
    operation,
    stopping: false,
    error: undefined,
    retry: undefined,
    draft: question ? state.draft : "",
    messages: [
      ...state.messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: value.text,
        attachment: value.attachment,
      },
      { id: reply, role: "assistant", text: "" },
    ],
  }))
  const current = () =>
    useRevChatStore.getState().chats[key]?.operation === operation
  try {
    const text = await revChatCommands.send(
      {
        conversationId: chat.id,
        operationId: operation,
        repositoryId: chat.repositoryId,
        reviewId: chat.reviewId,
        context: value.attachment.context,
        message: value.text,
      },
      (event) => {
        if (
          !current() ||
          event.runId !== operation ||
          useRevChatStore.getState().chats[key].stopping
        )
          return
        update(key, (state) => ({
          ...state,
          status: event.kind === "status" ? event.text : state.status,
          messages: state.messages.map((message) =>
            message.id !== reply
              ? message
              : {
                  ...message,
                  text:
                    event.kind === "textStart"
                      ? ""
                      : event.kind === "textDelta"
                        ? message.text + event.text
                        : event.kind === "delta"
                          ? event.text
                          : message.text,
                }
          ),
        }))
      }
    )
    if (current())
      update(key, (state) => ({
        ...state,
        messages: state.messages.map((m) =>
          m.id === reply ? { ...m, text: state.stopping ? m.text : text } : m
        ),
        unread: !state.open,
      }))
  } catch (cause) {
    if (current())
      update(key, (state) => ({
        ...state,
        error: state.stopping ? undefined : errorMessage(cause),
        retry: value,
        draft: !question && !state.draft ? value.text : state.draft,
        messages: state.messages.map((m) =>
          m.id === reply
            ? {
                ...m,
                failed: true,
                text:
                  m.text ||
                  (state.stopping
                    ? "Response stopped."
                    : "Rev could not answer."),
              }
            : m
        ),
      }))
  } finally {
    if (current()) {
      const stopped = useRevChatStore.getState().chats[key].stopping
      update(key, (state) => ({
        ...state,
        operation: undefined,
        stopping: false,
        status: undefined,
      }))
      const state = useRevChatStore.getState().chats[key]
      if (!stopped && !state.error && state.queue.length) {
        const next = state.queue[0]
        removeQueuedQuestion(key, next.id)
        void sendRevQuestion(key, next)
      }
    }
  }
}
export async function stopRevChat(key: string) {
  const chat = useRevChatStore.getState().chats[key]
  if (!chat?.operation) return
  update(key, (state) => ({ ...state, stopping: true }))
  try {
    await revChatCommands.cancel(chat.id)
  } catch (cause) {
    update(key, (state) => ({
      ...state,
      stopping: false,
      error: errorMessage(cause),
    }))
  }
}
export async function resetRevChat(key: string) {
  const chat = useRevChatStore.getState().chats[key]
  if (!chat) return
  await revChatCommands.close(chat.id)
  update(key, (state) => ({
    ...state,
    id: crypto.randomUUID(),
    operation: undefined,
    stopping: false,
    messages: [],
    queue: [],
    draft: "",
    error: undefined,
    retry: undefined,
    unread: false,
  }))
}
