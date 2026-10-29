import { Channel } from "@tauri-apps/api/core"
import { call } from "@/lib/desktop/review.commands"
import type {
  TerminalEvent,
  TerminalLink,
  TerminalSession,
} from "@/lib/desktop/contracts.generated"

export const terminalCommands = {
  create(
    repositoryId: string,
    cols: number,
    rows: number,
    receive: (event: TerminalEvent) => void
  ) {
    const onEvent = new Channel<TerminalEvent>()
    onEvent.onmessage = receive
    return call<TerminalSession>("terminal_create", {
      repositoryId,
      cols,
      rows,
      onEvent,
    })
  },
  list: () => call<TerminalSession[]>("terminal_list"),
  write: (id: string, bytes: number[]) =>
    call<void>("terminal_write", { id, bytes }),
  resize: (id: string, cols: number, rows: number) =>
    call<void>("terminal_resize", { id, cols, rows }),
  ack: (id: string, sequence: number) =>
    call<void>("terminal_ack", { id, sequence }),
  close: (id: string) => call<void>("terminal_close", { id }),
  openUrl: (url: string) => call<void>("terminal_open_url", { url }),
  resolveFile: (id: string, path: string, line: number, column: number) =>
    call<TerminalLink>("terminal_resolve_file", { id, path, line, column }),
}
