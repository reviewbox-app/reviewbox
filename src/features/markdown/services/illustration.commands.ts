import { convertFileSrc } from "@tauri-apps/api/core"
import { call } from "@/lib/desktop/review.commands"

export const illustrationCommands = {
  register: (html: string) => call<string>("register_illustration", { html }),
  release: (id: string) => call<void>("release_illustration", { id }),
  url: (id: string) => convertFileSrc(id, "reviewbox-illustration"),
}
