import { call } from "@/lib/desktop/review.commands"

export const fileTreeCommands = {
  reveal: (repositoryId: string, path: string) =>
    call<void>("reveal_local_path", { repositoryId, path }),
}
