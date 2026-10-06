"use client"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownRenderer } from "@/features/markdown/components/MarkdownRenderer"
import { errorMessage } from "@/lib/desktop/review.commands"
import {
  chatKey,
  useRevChatStore,
  setChatDraft,
  setChatOpen,
  sendRevQuestion,
  stopRevChat,
  resetRevChat,
  removeQueuedQuestion,
} from "../stores/revChat.store"

export function RevChat({
  repositoryId,
  reviewId,
}: {
  repositoryId: string
  reviewId: string
}) {
  const key = chatKey(repositoryId, reviewId)
  const chat = useRevChatStore((state) => state.chats[key])
  const scroll = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const pinned = useRef(true)
  const [localError, setLocalError] = useState("")
  useEffect(() => {
    if (chat?.open) input.current?.focus()
  }, [chat?.open])
  useEffect(() => {
    if (pinned.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight
  }, [chat?.messages, chat?.open])
  if (!chat) return null
  return (
    <aside
      aria-label="Ask Rev"
      className="pointer-events-none fixed right-4 bottom-20 z-50 flex w-[30rem] max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          setChatOpen(key, false)
        }
      }}
    >
      {chat.open && (
        <section
          aria-label="Rev conversation"
          className="pointer-events-auto flex max-h-[calc(100dvh-10rem)] w-full flex-col overflow-hidden rounded-3xl border bg-popover text-popover-foreground shadow-xl"
        >
          <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
            <h2 className="mr-auto text-sm font-semibold">Ask Rev</h2>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setLocalError("")
                void resetRevChat(key).catch((cause) =>
                  setLocalError(errorMessage(cause))
                )
              }}
            >
              New conversation
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setChatOpen(key, false)}
              aria-label="Minimize Rev chat"
            >
              Minimize
            </Button>
          </header>
          <div
            ref={scroll}
            role="log"
            aria-label="Conversation messages"
            aria-live="polite"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
            onScroll={() => {
              const el = scroll.current
              if (el)
                pinned.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 48
            }}
          >
            {!chat.messages.length && (
              <p className="text-sm text-muted-foreground">
                Ask about this passage. Rev can consult the captured code to
                explain it.
              </p>
            )}
            {chat.messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === "user"
                    ? "rounded-2xl bg-muted p-3"
                    : "space-y-2"
                }
              >
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {message.role === "user" ? "You" : "Rev"}
                  {message.failed ? " · Interrupted" : ""}
                </p>
                {message.attachment && (
                  <details className="mb-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      {message.attachment.title}
                    </summary>
                    <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">
                      {message.attachment.excerpt || "Full document attached"}
                    </p>
                  </details>
                )}
                <MarkdownRenderer allowHtml={false}>
                  {message.text}
                </MarkdownRenderer>
              </div>
            ))}
            {chat.operation && (
              <p role="status" className="text-xs text-muted-foreground">
                {chat.stopping
                  ? "Stopping…"
                  : chat.status || "Rev is answering…"}
              </p>
            )}
          </div>
          <form
            className="shrink-0 space-y-2 border-t p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void sendRevQuestion(key)
            }}
          >
            {chat.attachment && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer truncate">
                  Attached: {chat.attachment.title}
                </summary>
                <p className="max-h-20 overflow-auto pt-1 whitespace-pre-wrap">
                  {chat.attachment.excerpt || "Full document attached"}
                </p>
              </details>
            )}
            {chat.queue.map((question) => (
              <div
                key={question.id}
                className="flex items-center gap-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  Queued: {question.text}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => removeQueuedQuestion(key, question.id)}
                >
                  Cancel
                </Button>
              </div>
            ))}
            {(chat.error || localError) && (
              <p role="alert" className="text-xs text-destructive">
                {chat.error || localError}
              </p>
            )}
            {chat.retry && !chat.operation && (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => void sendRevQuestion(key, chat.retry)}
              >
                Retry
              </Button>
            )}
            <Textarea
              ref={input}
              aria-label="Message to Rev"
              placeholder="Ask Rev…"
              value={chat.draft}
              maxLength={65536}
              className="max-h-32 min-h-20 resize-none"
              onChange={(event) => setChatDraft(key, event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  void sendRevQuestion(key)
                }
              }}
            />
            <div className="flex justify-end">
              {chat.operation ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={chat.stopping}
                  onClick={() => void stopRevChat(key)}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  type="submit"
                  disabled={!chat.draft.trim() || !chat.attachment}
                >
                  Send
                </Button>
              )}
            </div>
          </form>
        </section>
      )}
      {!chat.open && (
        <Button
          className="pointer-events-auto rounded-full shadow-lg"
          onClick={() => setChatOpen(key, true)}
          aria-label={
            chat.unread ? "Ask Rev — unread response" : "Open Rev chat"
          }
        >
          Ask Rev
          {chat.operation ? " · Answering…" : chat.unread ? " · New reply" : ""}
        </Button>
      )}
    </aside>
  )
}
