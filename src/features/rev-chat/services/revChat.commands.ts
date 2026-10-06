import { Channel } from "@tauri-apps/api/core"
import { call } from "@/lib/desktop/review.commands"
import type {
  AgentEvent,
  RevChatRequest,
} from "@/lib/desktop/contracts.generated"
export const revChatCommands = {
  send: (request: RevChatRequest, receive: (event: AgentEvent) => void) => {
    const channel = new Channel<AgentEvent>()
    channel.onmessage = receive
    return call<string>("rev_chat_send", { request, channel })
  },
  cancel: (conversationId: string) =>
    call<void>("rev_chat_cancel", { conversationId }),
  close: (conversationId: string) =>
    call<void>("rev_chat_close", { conversationId }),
}
