import { Channel } from "@tauri-apps/api/core"
import { call as invoke } from "@/lib/desktop/review.commands"
import type { AgentEvent, TestRun } from "@/lib/desktop/contracts.generated"
export const evidenceCommands = {
  prepare: (reviewId: string, command: string[]) =>
    invoke<TestRun>("prepare_test", { reviewId, command }),
  answer(id: string, approved: boolean, onEvent: (event: AgentEvent) => void) {
    const channel = new Channel<AgentEvent>()
    channel.onmessage = onEvent
    return invoke<TestRun>("answer_test_permission", { id, approved, channel })
  },
  cancel: (id: string) => invoke<void>("cancel_test", { id }),
  list: (reviewId: string) => invoke<TestRun[]>("list_test_runs", { reviewId }),
}
